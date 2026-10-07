"""Consulta ao CKAN do TSE (dadosabertos.tse.jus.br) com cache em disco.

Datasets de resultados chamam-se `resultados-YYYY` (1933..2026), além de variantes como
`resultados-YYYY-boletim-de-urna` e `resultados-eleicoes-suplementares-YYYY`.
O CKAN do TSE **não informa `size`** nos recursos; use `tamanho_remoto()` (HEAD) quando
precisar do tamanho real.
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx

from historico import CATALOGO_DIR, TABELAS, url_cdn

CKAN_BASE = "https://dadosabertos.tse.jus.br/api/3/action"
TTL_PADRAO_S = 6 * 3600
_HEADERS = {"User-Agent": "apuracao-historico/0.1 (+https://github.com/)"}


@dataclass(frozen=True)
class Recurso:
    nome: str
    url: str
    formato: str | None
    tamanho: int | None          # bytes, conforme o CKAN (quase sempre None no TSE)
    arquivo: str                 # último segmento da URL (ex.: votacao_candidato_munzona_2022.zip)
    tabela: str | None           # chave de TABELAS, quando reconhecida
    dataset: str

    def para_dict(self) -> dict:
        return asdict(self)


def nome_dataset(ano: int, sufixo: str | None = None) -> str:
    return f"resultados-{ano}" + (f"-{sufixo}" if sufixo else "")


def _caminho_cache(dataset: str) -> Path:
    return CATALOGO_DIR / f"{dataset}.json"


def package_show(dataset: str, *, ttl_s: int = TTL_PADRAO_S, forcar: bool = False) -> dict:
    """Retorna o `result` de `package_show`, usando cache em disco (TTL em segundos)."""
    cache = _caminho_cache(dataset)
    if not forcar and cache.exists() and (time.time() - cache.stat().st_mtime) < ttl_s:
        try:
            return json.loads(cache.read_text("utf-8"))
        except json.JSONDecodeError:
            pass
    with httpx.Client(timeout=60, headers=_HEADERS, follow_redirects=True) as c:
        r = c.get(f"{CKAN_BASE}/package_show", params={"id": dataset})
    if r.status_code == 404:
        raise LookupError(f"dataset {dataset!r} não existe no CKAN do TSE")
    r.raise_for_status()
    corpo = r.json()
    if not corpo.get("success"):
        raise RuntimeError(f"CKAN package_show falhou: {corpo.get('error')}")
    resultado = corpo["result"]
    CATALOGO_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(resultado, ensure_ascii=False, indent=1), "utf-8")
    return resultado


def identificar_tabela(arquivo: str) -> str | None:
    """Mapeia o nome do arquivo no CDN para uma chave de TABELAS (ou None)."""
    base = arquivo.lower()
    # ordem importa: 'detalhe_votacao_secao' antes de 'votacao_secao' etc.
    for chave in sorted(TABELAS, key=len, reverse=True):
        if base.startswith(chave + "_"):
            return chave
    return None


def listar_recursos(ano: int, *, sufixo: str | None = None, forcar: bool = False) -> list[Recurso]:
    """Lista os recursos (ZIPs) do dataset `resultados-{ano}[-{sufixo}]`."""
    dataset = nome_dataset(ano, sufixo)
    pkg = package_show(dataset, forcar=forcar)
    saida: list[Recurso] = []
    for r in pkg.get("resources", []):
        url = r.get("url") or ""
        arquivo = url.rsplit("/", 1)[-1]
        tam = r.get("size")
        saida.append(
            Recurso(
                nome=r.get("name") or arquivo,
                url=url,
                formato=r.get("format"),
                tamanho=int(tam) if tam not in (None, "", 0, "0") else None,
                arquivo=arquivo,
                tabela=identificar_tabela(arquivo),
                dataset=dataset,
            )
        )
    return saida


def recurso_da_tabela(ano: int, tabela: str, *, uf: str | None = None) -> Recurso:
    """Recurso de `tabela` para `ano`. Se o CKAN ainda não listar (caso comum logo após a
    eleição), cai para a URL canônica do CDN — o download confirma a existência via HEAD."""
    if tabela not in TABELAS:
        raise KeyError(f"tabela desconhecida: {tabela!r}; opções: {sorted(TABELAS)}")
    alvo = TABELAS[tabela]["arquivo"].format(ano=ano, uf=(uf or "").upper()).lower()
    try:
        for r in listar_recursos(ano):
            if r.arquivo.lower() == alvo:
                return r
    except LookupError:
        pass
    url = url_cdn(tabela, ano, uf)
    return Recurso(
        nome=f"{tabela} {ano}{' ' + uf.upper() if uf else ''} (URL canônica do CDN, fora do CKAN)",
        url=url,
        formato="CSV",
        tamanho=None,
        arquivo=url.rsplit("/", 1)[-1],
        tabela=tabela,
        dataset=nome_dataset(ano),
    )


def tamanho_remoto(url: str) -> tuple[int | None, bool]:
    """(Content-Length, existe?) via HEAD. Content-Length pode ser None."""
    with httpx.Client(timeout=60, headers=_HEADERS, follow_redirects=True) as c:
        r = c.head(url)
    if r.status_code == 404:
        return None, False
    r.raise_for_status()
    cl = r.headers.get("content-length")
    return (int(cl) if cl is not None else None), True
