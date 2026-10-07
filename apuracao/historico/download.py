"""Download em streaming dos ZIPs do TSE para data/historico/raw/{ano}/{arquivo}.

Idempotente: se o arquivo já existe com o mesmo tamanho do Content-Length, não baixa de novo.
Retomável: se existir um `.part` menor que o total, continua com `Range`.
`max_mb` é uma guarda contra baixar acidentalmente centenas de MB.

Os arquivos baixados são dados NÃO confiáveis: ficam isolados em RAW_DIR e nunca são
executados/importados — apenas lidos como CSV pelo DuckDB.
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

from historico import RAW_DIR
from historico.catalogo import Recurso, recurso_da_tabela

_HEADERS = {"User-Agent": "apuracao-historico/0.1"}
_CHUNK = 1024 * 1024


class LimiteExcedido(RuntimeError):
    pass


@dataclass
class ResultadoDownload:
    caminho: Path
    bytes_total: int | None
    baixado_agora: int
    pulado: bool
    segundos: float


def destino_raw(ano: int, arquivo: str) -> Path:
    return RAW_DIR / str(ano) / arquivo


def baixar_url(
    url: str,
    destino: Path,
    *,
    max_mb: float | None = None,
    progresso: Callable[[int, int | None], None] | None = None,
    timeout: float = 120,
) -> ResultadoDownload:
    destino.parent.mkdir(parents=True, exist_ok=True)
    parcial = destino.with_suffix(destino.suffix + ".part")
    t0 = time.time()

    with httpx.Client(timeout=timeout, headers=_HEADERS, follow_redirects=True) as c:
        h = c.head(url)
        if h.status_code == 404:
            raise FileNotFoundError(f"recurso inexistente (404): {url}")
        h.raise_for_status()
        cl = h.headers.get("content-length")
        total = int(cl) if cl is not None else None
        aceita_range = h.headers.get("accept-ranges", "").lower() == "bytes"

        if max_mb is not None and total is not None and total > max_mb * 1024 * 1024:
            raise LimiteExcedido(
                f"{url} tem {total / 1e6:.1f} MB, acima do limite de {max_mb} MB (--max-mb)"
            )

        if destino.exists() and total is not None and destino.stat().st_size == total:
            return ResultadoDownload(destino, total, 0, True, time.time() - t0)

        inicio = 0
        if parcial.exists() and aceita_range and total is not None:
            inicio = parcial.stat().st_size
            if inicio >= total:
                inicio = 0
                parcial.unlink()
        headers = {"Range": f"bytes={inicio}-"} if inicio else {}
        modo = "ab" if inicio else "wb"
        baixado = 0
        with c.stream("GET", url, headers=headers) as r:
            if inicio and r.status_code != 206:
                # servidor ignorou o Range: recomeça do zero
                inicio, modo = 0, "wb"
            r.raise_for_status()
            with open(parcial, modo) as f:
                for chunk in r.iter_bytes(_CHUNK):
                    f.write(chunk)
                    baixado += len(chunk)
                    if max_mb is not None and (inicio + baixado) > max_mb * 1024 * 1024:
                        raise LimiteExcedido(f"download de {url} ultrapassou {max_mb} MB")
                    if progresso:
                        progresso(inicio + baixado, total)

    tam = parcial.stat().st_size
    if total is not None and tam != total:
        raise OSError(f"tamanho final {tam} != Content-Length {total} para {url}; .part mantido")
    parcial.replace(destino)
    return ResultadoDownload(destino, total, baixado, False, time.time() - t0)


def baixar_tabela(
    ano: int,
    tabela: str,
    *,
    uf: str | None = None,
    max_mb: float | None = None,
    progresso: Callable[[int, int | None], None] | None = None,
) -> tuple[Recurso, ResultadoDownload]:
    rec = recurso_da_tabela(ano, tabela, uf=uf)
    res = baixar_url(rec.url, destino_raw(ano, rec.arquivo), max_mb=max_mb, progresso=progresso)
    return rec, res
