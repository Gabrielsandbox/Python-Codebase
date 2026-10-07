"""Cliente HTTP assíncrono para o CDN de resultados do TSE.

Características importantes para o dia da apuração:

* **GET condicional** (``If-None-Match`` / ``If-Modified-Since``): o CDN do TSE devolve
  ``ETag`` e ``Last-Modified`` e um ``304`` quando nada mudou — isso corta a banda e
  deixa claro o que precisa ser republicado.
* **Limite de taxa**: o TSE anuncia ``x-ratelimit-limit: 2000;w=1`` (2000 req/s). Usamos um
  *token bucket* bem abaixo disso (padrão 150 req/s) e concorrência limitada.
* **Retentativas** com *backoff* exponencial para 5xx, 429 e erros de rede; 404 não é
  retentado (o arquivo simplesmente ainda não existe — comum antes do início da totalização).
* ``cache-control: max-age≈57`` no CDN: não adianta consultar o mesmo arquivo mais de ~1x/min.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Self

import httpx
import orjson

log = logging.getLogger(__name__)

USER_AGENT = "apuracao-br/0.1 (+https://github.com/Gabrielsandbox/Python-Codebase)"


class TokenBucket:
    """Limitador de taxa simples: ``rate`` tokens por segundo, capacidade ``burst``."""

    def __init__(self, rate: float, burst: int | None = None) -> None:
        self.rate = float(rate)
        self.capacity = float(burst or max(1, int(rate)))
        self._tokens = self.capacity
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self._tokens = min(self.capacity, self._tokens + (now - self._last) * self.rate)
                self._last = now
                if self._tokens >= 1:
                    self._tokens -= 1
                    return
                await asyncio.sleep((1 - self._tokens) / self.rate)


@dataclass(slots=True)
class CacheEntry:
    etag: str | None = None
    last_modified: str | None = None
    body: bytes | None = None


@dataclass(slots=True)
class FetchResult:
    url: str
    status: int
    changed: bool
    body: bytes | None
    etag: str | None = None
    last_modified: str | None = None
    error: str | None = None
    elapsed_ms: float = 0.0

    @property
    def ok(self) -> bool:
        return self.status in (200, 304) and self.error is None

    def json(self) -> dict | None:
        if self.body is None:
            return None
        return orjson.loads(self.body)


@dataclass
class TSEClient:
    """Cliente com cache condicional em memória por URL."""

    rate_per_s: float = 150.0
    concurrency: int = 40
    timeout_s: float = 15.0
    max_retries: int = 3
    keep_bodies: bool = True
    _cache: dict[str, CacheEntry] = field(default_factory=dict, init=False, repr=False)
    _client: httpx.AsyncClient | None = field(default=None, init=False, repr=False)
    _sem: asyncio.Semaphore | None = field(default=None, init=False, repr=False)
    _bucket: TokenBucket | None = field(default=None, init=False, repr=False)

    async def __aenter__(self) -> Self:
        self._client = httpx.AsyncClient(
            http2=False,
            timeout=httpx.Timeout(self.timeout_s),
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            limits=httpx.Limits(
                max_connections=self.concurrency, max_keepalive_connections=self.concurrency
            ),
            follow_redirects=True,
        )
        self._sem = asyncio.Semaphore(self.concurrency)
        self._bucket = TokenBucket(self.rate_per_s)
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def cached(self, url: str) -> CacheEntry | None:
        return self._cache.get(url)

    def forget(self, url: str) -> None:
        self._cache.pop(url, None)

    async def fetch(self, url: str, *, conditional: bool = True) -> FetchResult:
        """Busca ``url``; devolve ``changed=False`` em 304 ou se o corpo não mudou."""
        assert self._client is not None and self._sem is not None and self._bucket is not None
        entry = self._cache.get(url)
        headers: dict[str, str] = {}
        if conditional and entry is not None:
            if entry.etag:
                headers["If-None-Match"] = entry.etag
            if entry.last_modified:
                headers["If-Modified-Since"] = entry.last_modified

        attempt = 0
        t0 = time.monotonic()
        while True:
            attempt += 1
            async with self._sem:
                await self._bucket.acquire()
                try:
                    resp = await self._client.get(url, headers=headers)
                except (httpx.TransportError, httpx.TimeoutException) as exc:
                    if attempt <= self.max_retries:
                        await asyncio.sleep(min(8.0, 0.5 * 2**attempt))
                        continue
                    return FetchResult(
                        url,
                        0,
                        False,
                        None,
                        error=f"{type(exc).__name__}: {exc}",
                        elapsed_ms=(time.monotonic() - t0) * 1000,
                    )

            if resp.status_code == 304:
                return FetchResult(
                    url,
                    304,
                    False,
                    entry.body if entry else None,
                    etag=entry.etag if entry else None,
                    last_modified=entry.last_modified if entry else None,
                    elapsed_ms=(time.monotonic() - t0) * 1000,
                )
            if resp.status_code == 200:
                body = resp.content
                etag = resp.headers.get("etag")
                lm = resp.headers.get("last-modified")
                changed = entry is None or entry.body != body
                self._cache[url] = CacheEntry(etag, lm, body if self.keep_bodies else None)
                return FetchResult(
                    url,
                    200,
                    changed,
                    body,
                    etag=etag,
                    last_modified=lm,
                    elapsed_ms=(time.monotonic() - t0) * 1000,
                )
            if resp.status_code == 404:
                return FetchResult(url, 404, False, None, elapsed_ms=(time.monotonic() - t0) * 1000)
            if resp.status_code in (429, 500, 502, 503, 504) and attempt <= self.max_retries:
                retry_after = resp.headers.get("retry-after")
                delay = (
                    float(retry_after)
                    if retry_after and retry_after.isdigit()
                    else 0.5 * 2**attempt
                )
                await asyncio.sleep(min(10.0, delay))
                continue
            return FetchResult(
                url,
                resp.status_code,
                False,
                None,
                error=f"HTTP {resp.status_code}",
                elapsed_ms=(time.monotonic() - t0) * 1000,
            )

    async def fetch_many(self, urls: list[str], *, conditional: bool = True) -> list[FetchResult]:
        return await asyncio.gather(*(self.fetch(u, conditional=conditional) for u in urls))
