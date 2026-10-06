"""API HTTP.

Em produção o público lê os snapshots direto do CDN (bucket S3/R2) — esta API **não** fica no
caminho do tráfego de massa. Ela existe para:

1. Desenvolvimento local: servir ``data/latest`` em ``/dados/*`` com os mesmos cabeçalhos de
   cache que o CDN usaria.
2. O acervo histórico (produto por assinatura): ``/api/v1/historico/*`` com autenticação por
   chave de API (``X-API-Key``). Hoje as chaves vêm de ``APURACAO_API_KEYS`` (lista separada
   por vírgula) — a troca por banco + billing é um passo da fase 2 (ver docs/ARQUITETURA.md).
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

RAIZ = Path(__file__).resolve().parent.parent.parent
DATA_DIR = Path(os.environ.get("APURACAO_DATA_DIR", RAIZ / "data" / "latest"))
WEB_DIR = Path(os.environ.get("APURACAO_WEB_DIR", RAIZ / "web" / "public"))

app = FastAPI(title="Apuração BR", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])


@app.get("/health")
def health() -> dict:
    status = DATA_DIR / "ativo.json"
    return {"ok": True, "ativo": status.exists()}


def _servir(base: Path, rel: str, max_age: int) -> FileResponse:
    p = (base / rel).resolve()
    if base.resolve() not in p.parents or not p.is_file():
        raise HTTPException(404)
    return FileResponse(
        p,
        media_type="application/json" if p.suffix == ".json" else None,
        headers={"Cache-Control": f"public, max-age={max_age}, stale-while-revalidate=30"},
    )


@app.get("/dados/{rel:path}")
def dados(rel: str) -> FileResponse:
    """Snapshots publicados pelo coletor (espelho local do bucket)."""
    max_age = 5 if rel.endswith("status.json") else 30 if rel.endswith("mun.json") else 10
    return _servir(DATA_DIR, rel, max_age)


@app.get("/ref/{rel:path}")
def ref(rel: str) -> FileResponse:
    return _servir(WEB_DIR / "ref", rel, 86400)


@app.get("/geo/{rel:path}")
def geo(rel: str) -> FileResponse:
    return _servir(WEB_DIR / "geo", rel, 86400)


# ----------------------------------------------------------------------------- acervo (pago)
def _chaves() -> set[str]:
    return {k.strip() for k in os.environ.get("APURACAO_API_KEYS", "").split(",") if k.strip()}


def exigir_chave(x_api_key: str | None = Header(default=None)) -> str:
    chaves = _chaves()
    if not chaves:
        raise HTTPException(503, "Acervo não configurado (APURACAO_API_KEYS vazio)")
    if not x_api_key or x_api_key not in chaves:
        raise HTTPException(401, "Chave de API inválida ou ausente (X-API-Key)")
    return x_api_key


@app.get("/api/v1/historico/particoes", dependencies=[Depends(exigir_chave)])
def historico_particoes(tabela: str = "votacao_candidato_munzona") -> JSONResponse:
    from historico.consulta import particoes_disponiveis

    return JSONResponse(
        {"tabela": tabela, "particoes": [{"ano": a, "turno": t} for a, t in particoes_disponiveis(tabela)]}
    )


@app.get("/api/v1/historico/municipio/{ibge}", dependencies=[Depends(exigir_chave)])
def historico_municipio(
    ibge: str,
    cargo: int = Query(1, description="1=Presidente, 3=Governador, 11=Prefeito..."),
    turno: int | None = Query(None),
) -> JSONResponse:
    from historico.consulta import serie_historica_municipio

    return JSONResponse(
        {
            "ibge": ibge,
            "cargo": cargo,
            "serie": serie_historica_municipio(ibge, cargo=cargo, turno=turno),
        }
    )


@app.get("/api/v1/historico/resultado", dependencies=[Depends(exigir_chave)])
def historico_resultado(
    ano: int,
    turno: int = 1,
    cargo: int = 1,
    uf: str | None = None,
    limite: int = Query(5000, le=50000),
) -> JSONResponse:
    from historico.consulta import resultado_por_municipio

    return JSONResponse(
        {
            "ano": ano,
            "turno": turno,
            "cargo": cargo,
            "linhas": resultado_por_municipio(ano, turno, cargo, uf=uf, limite=limite),
        }
    )
