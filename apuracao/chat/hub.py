"""Hub de conexões: broadcast, histórico, presença e mensagens de sistema (placar).

Em memória por padrão (1 processo). Com ``redis_url``:
- ``PUBLISH chat:sala`` leva cada mensagem a todos os processos;
- ``LPUSH/LTRIM chat:hist`` guarda o histórico compartilhado;
- ``SET chat:presenca:<proc> <n> EX 15`` por processo; o total é a soma das chaves.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from collections import deque
from datetime import datetime, timedelta, timezone

import httpx
import orjson
from starlette.websockets import WebSocket

log = logging.getLogger("apuracao.chat.hub")
BRT = timezone(timedelta(hours=-3))

CANAL = "chat:sala"
HIST = "chat:hist"
PRESENCA = "chat:presenca:"


def agora_iso() -> str:
    return datetime.now(BRT).replace(microsecond=0).isoformat()


def novo_id() -> str:
    # ordenável no tempo + aleatório: ms em hex (12) + 6 bytes
    return f"{int(time.time() * 1000):012x}{secrets.token_hex(6)}"


class Hub:
    def __init__(
        self,
        *,
        historico: int = 50,
        redis_url: str | None = None,
        dados_base: str | None = None,
        db=None,
    ) -> None:
        self.historico_n = historico
        self.redis_url = redis_url
        self.dados_base = dados_base
        self.db = db
        self._conexoes: dict[WebSocket, dict] = {}
        self._hist: deque[dict] = deque(maxlen=historico)
        self._redis = None
        self._proc = secrets.token_hex(4)
        self._tasks: list[asyncio.Task] = []
        self._presenca_cache = (0.0, 0)
        self._ultimo_idg: str | None = None

    # ------------------------------------------------------------------ ciclo de vida
    async def iniciar(self) -> None:
        if self.redis_url:
            import redis.asyncio as aioredis

            self._redis = aioredis.from_url(self.redis_url, decode_responses=False)
            await self._redis.ping()
            self._tasks.append(asyncio.create_task(self._assinar_redis()))
            log.info("hub com redis (%s), proc=%s", self.redis_url, self._proc)
        else:
            for m in self.db.ultimas(self.historico_n) if self.db else []:
                self._hist.append({"tipo": "msg", **m})
        self._tasks.append(asyncio.create_task(self._loop_presenca()))
        if self.dados_base:
            self._tasks.append(asyncio.create_task(self._loop_placar()))

    async def parar(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        if self._redis is not None:
            with contextlib.suppress(Exception):
                await self._redis.delete(PRESENCA + self._proc)
                await self._redis.aclose()

    # ------------------------------------------------------------------ conexões
    async def entrar(self, ws: WebSocket, claims: dict) -> None:
        # Envia histórico antes de registrar a conexão, para o loop de presença não
        # entregar um frame antes do "historico".
        historico = await self.ultimas(claims.get("sub"))
        self._conexoes[ws] = claims
        await self._atualizar_presenca()
        await ws.send_text(orjson.dumps({"tipo": "historico", "mensagens": historico}).decode())
        await ws.send_text(
            orjson.dumps({"tipo": "presenca", "online": await self.online()}).decode()
        )

    def sair(self, ws: WebSocket) -> None:
        if self._conexoes.pop(ws, None) is not None and self._redis is not None:
            with contextlib.suppress(RuntimeError):
                asyncio.get_running_loop().create_task(self._atualizar_presenca())

    async def _atualizar_presenca(self) -> None:
        if self._redis is not None:
            with contextlib.suppress(Exception):
                await self._redis.set(PRESENCA + self._proc, self.locais, ex=15)
        self._presenca_cache = (0.0, 0)  # invalida o cache

    @property
    def locais(self) -> int:
        return len(self._conexoes)

    # ------------------------------------------------------------------ mensagens
    async def publicar_msg(self, sub: str, apelido: str, texto: str) -> dict:
        msg = {
            "tipo": "msg",
            "id": novo_id(),
            "sub": sub,
            "apelido": apelido,
            "texto": texto,
            "t": agora_iso(),
        }
        if self.db:
            self.db.gravar_mensagem(msg["id"], sub, apelido, texto, msg["t"])
        await self._publicar(msg)
        return msg

    async def publicar_sistema(self, texto: str) -> None:
        await self._publicar({"tipo": "sistema", "id": novo_id(), "texto": texto, "t": agora_iso()})

    async def _publicar(self, msg: dict) -> None:
        if self._redis is not None:
            raw = orjson.dumps(msg)
            pipe = self._redis.pipeline()
            pipe.publish(CANAL, raw)
            if msg["tipo"] == "msg":
                pipe.lpush(HIST, raw)
                pipe.ltrim(HIST, 0, self.historico_n - 1)
            await pipe.execute()
        else:
            await self._entregar(msg)

    async def _entregar(self, msg: dict) -> None:
        if msg["tipo"] == "msg":
            self._hist.append(msg)
        sub = msg.get("sub")
        publico = {k: v for k, v in msg.items() if k != "sub"}
        if msg["tipo"] == "msg":
            raw_outros = orjson.dumps({**publico, "eu": False}).decode()
            raw_eu = orjson.dumps({**publico, "eu": True}).decode()
        else:
            raw_outros = raw_eu = orjson.dumps(publico).decode()
        mortas: list[WebSocket] = []
        for ws, claims in list(self._conexoes.items()):
            try:
                await ws.send_text(raw_eu if sub and claims.get("sub") == sub else raw_outros)
            except Exception:  # noqa: BLE001 — conexão fechada
                mortas.append(ws)
        for ws in mortas:
            self.sair(ws)

    async def ultimas(self, sub: str | None = None) -> list[dict]:
        if self._redis is not None:
            raws = await self._redis.lrange(HIST, 0, self.historico_n - 1)
            itens = [orjson.loads(r) for r in reversed(raws)]
        else:
            itens = list(self._hist)
        return [
            {**{k: v for k, v in m.items() if k != "sub"}, "eu": bool(sub) and m.get("sub") == sub}
            for m in itens
        ]

    # ------------------------------------------------------------------ presença
    async def online(self) -> int:
        if self._redis is None:
            return self.locais
        t, n = self._presenca_cache
        if time.monotonic() - t < 2:
            return n
        total = 0
        async for chave in self._redis.scan_iter(match=PRESENCA + "*"):
            v = await self._redis.get(chave)
            total += int(v or 0)
        self._presenca_cache = (time.monotonic(), total)
        return total

    async def _loop_presenca(self) -> None:
        while True:
            try:
                await self._atualizar_presenca()
                n = await self.online()
                raw = orjson.dumps({"tipo": "presenca", "online": n}).decode()
                for ws in list(self._conexoes):
                    with contextlib.suppress(Exception):
                        await ws.send_text(raw)
            except Exception:
                log.exception("presença")
            await asyncio.sleep(5)

    # ------------------------------------------------------------------ redis
    async def _assinar_redis(self) -> None:
        assert self._redis is not None
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(CANAL)
        async for item in pubsub.listen():
            if item.get("type") != "message":
                continue
            try:
                msg = orjson.loads(item["data"])
            except orjson.JSONDecodeError:
                continue
            await self._entregar(msg)

    # ------------------------------------------------------------------ placar
    async def _loop_placar(self) -> None:
        """Lê ``br.json`` publicado pelo coletor e emite mensagem de sistema quando muda."""
        base = (self.dados_base or "").rstrip("/")
        async with httpx.AsyncClient(timeout=10) as cli:
            while True:
                try:
                    ativo = (
                        await cli.get(f"{base}/ativo.json", headers={"Cache-Control": "no-cache"})
                    ).json()
                    pref = ativo["prefixo"]
                    meta = (await cli.get(f"{base}/{pref}/meta.json")).json()
                    st = (
                        await cli.get(
                            f"{base}/{pref}/status.json", headers={"Cache-Control": "no-cache"}
                        )
                    ).json()
                    idg = st.get("fonte_idg")
                    if idg and idg != self._ultimo_idg:
                        br = (
                            await cli.get(
                                f"{base}/{pref}/br.json", headers={"Cache-Control": "no-cache"}
                            )
                        ).json()
                        # só o primeiro processo a ver o idg publica (lock curto no redis)
                        primeiro = self._redis is None or await self._redis.set(
                            f"chat:placar:{idg}", 1, ex=600, nx=True
                        )
                        if primeiro and self._ultimo_idg is not None:  # não anuncia na partida
                            await self.publicar_sistema(frase_placar(meta, br))
                    self._ultimo_idg = idg
                except Exception as exc:  # noqa: BLE001
                    log.debug("placar indisponível: %s", exc)
                await asyncio.sleep(10)


def frase_placar(meta: dict, br: dict) -> str:
    """``Flavio Bolsonaro 50,4% × Lula 49,6% — 71,2% das seções totalizadas``."""
    cands = br.get("cands") or []
    pcts = br.get("pct") or []
    nomes = meta.get("candidatos") or {}
    pares = sorted(zip(cands, pcts, strict=False), key=lambda x: -x[1])[:2]
    partes = [
        f"{titulo(nomes.get(c, {}).get('nome', c))} {p:.1f}%".replace(".", ",") for c, p in pares
    ]
    sec = f"{br.get('secoes', {}).get('pct', 0):.1f}".replace(".", ",")
    frase = " × ".join(partes) + f" — {sec}% das seções totalizadas"
    if br.get("definido") and br.get("vencedor"):
        frase = f"🏁 {titulo(nomes.get(br['vencedor'], {}).get('nome', ''))} eleito. " + frase
    return frase


def titulo(nome: str) -> str:
    minus = {"de", "da", "do", "dos", "das", "e"}
    return " ".join(p if p in minus else p.capitalize() for p in nome.lower().split())
