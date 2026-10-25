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


@app.on_event("startup")
def _preparar_acervo() -> None:
    """Com APURACAO_ACERVO_ANOS (ex.: "2018,2022") sincroniza/gera o lake numa thread (ver historico.sync)."""
    from historico.sync import garantir_em_segundo_plano

    garantir_em_segundo_plano(log=lambda m: print(m, flush=True))


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
        {
            "tabela": tabela,
            "particoes": [{"ano": a, "turno": t} for a, t in particoes_disponiveis(tabela)],
        }
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


# ----------------------------------------------------------------------------- acervo (plataforma)
# Leitura pública por enquanto (o site da plataforma consome daqui); o corte por conta/assinatura
# entra quando a plataforma abrir (docs/PLATAFORMA.md). Respostas cacheáveis por 5 min.
_CACHE_ACERVO = {"Cache-Control": "public, max-age=300, stale-while-revalidate=600"}


def _acervo():
    from historico import acervo

    return acervo


@app.get("/api/v1/acervo/estado")
def acervo_estado() -> JSONResponse:
    return JSONResponse(_acervo().estado(), headers=_CACHE_ACERVO)


@app.get("/api/v1/acervo/candidatos")
def acervo_candidatos(
    q: str = Query(min_length=2, max_length=80),
    ano: int | None = None,
    cargo: int | None = None,
    uf: str | None = Query(None, min_length=2, max_length=2),
    limite: int = Query(30, ge=1, le=100),
) -> JSONResponse:
    """Busca candidaturas por nome (de urna ou completo), sem acento e sem maiúsculas."""
    return JSONResponse(
        {
            "q": q,
            "itens": _acervo().buscar_candidatos(q, ano=ano, cargo=cargo, uf=uf, limite=limite),
        },
        headers=_CACHE_ACERVO,
    )


@app.get("/api/v1/acervo/candidato")
def acervo_candidato(
    sq: str = Query(min_length=3, max_length=40), ano: int = Query(ge=1990, le=2030)
) -> JSONResponse:
    """Perfil público e histórico político (todas as candidaturas) da pessoa."""
    h = _acervo().historico_pessoa(sq, ano)
    if h is None:
        raise HTTPException(404, "candidatura não encontrada")
    return JSONResponse(h, headers=_CACHE_ACERVO)


@app.get("/api/v1/acervo/eleicao")
def acervo_eleicao(
    ano: int = Query(ge=1990, le=2030),
    cargo: int = Query(1),
    turno: int = Query(1, ge=1, le=2),
    uf: str | None = Query(None, min_length=2, max_length=2),
    limite: int = Query(40, ge=1, le=500),
) -> JSONResponse:
    """Resultado de uma eleição: votos por candidato (soma dos municípios) e totais."""
    r = _acervo().resumo_eleicao(ano, cargo, turno, uf=uf, limite=limite)
    if r is None:
        raise HTTPException(404, "eleição não disponível no acervo")
    return JSONResponse(r, headers=_CACHE_ACERVO)


@app.get("/api/v1/acervo/eleicao/ufs")
def acervo_eleicao_ufs(
    ano: int = Query(ge=1990, le=2030), cargo: int = Query(1), turno: int = Query(1, ge=1, le=2)
) -> JSONResponse:
    """Para o mapa: os dois mais votados em cada UF."""
    return JSONResponse(
        {"itens": _acervo().resumo_por_uf(ano, cargo, turno)}, headers=_CACHE_ACERVO
    )


@app.get("/api/v1/acervo/pesquisas")
def acervo_pesquisas(
    ano: int = Query(ge=1990, le=2030),
    cargo: int = Query(1),
    uf: str = Query("BR", min_length=2, max_length=2),
    turno: int | None = Query(None, ge=1, le=2),
    cenario: str | None = Query(None, max_length=120),
) -> JSONResponse:
    from historico.pesquisas import listar

    return JSONResponse(
        {
            "ano": ano,
            "cargo": cargo,
            "uf": uf.upper(),
            "pontos": listar(ano=ano, cargo=cargo, uf=uf, turno=turno, cenario=cenario),
        },
        headers=_CACHE_ACERVO,
    )
