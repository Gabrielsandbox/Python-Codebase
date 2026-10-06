"""historico — ETL do acervo histórico de resultados eleitorais (TSE / dados abertos).

Camadas:
  catalogo  -> consulta o CKAN (dadosabertos.tse.jus.br) e lista recursos por ano
  download  -> baixa ZIPs para data/historico/raw/{ano}/ (idempotente, com guarda de tamanho)
  etl       -> CSV (latin-1, ';') -> Parquet particionado em data/historico/parquet/
  consulta  -> consultas prontas sobre o lake Parquet (DuckDB)
"""
from __future__ import annotations

import os
from pathlib import Path

__all__ = [
    "CATALOGO_DIR",
    "DATA_DIR",
    "PARQUET_DIR",
    "RAIZ",
    "RAW_DIR",
    "REF_MUNICIPIOS",
    "TABELAS",
]

# Raiz do projeto `apuracao/` (pai deste pacote). Pode ser sobrescrita por env.
RAIZ = Path(os.environ.get("APURACAO_RAIZ", Path(__file__).resolve().parent.parent))
DATA_DIR = Path(os.environ.get("APURACAO_HISTORICO_DIR", RAIZ / "data" / "historico"))
RAW_DIR = DATA_DIR / "raw"            # dados brutos NÃO confiáveis (ZIP/CSV do TSE)
PARQUET_DIR = DATA_DIR / "parquet"    # lake normalizado
CATALOGO_DIR = DATA_DIR / "catalogo"  # cache do JSON do CKAN
REF_MUNICIPIOS = RAIZ / "data" / "ref" / "tse-municipios-2026.json"

# Famílias de recursos conhecidas. `arquivo` é o padrão do nome do ZIP no CDN do TSE;
# `por_uf=True` indica um ZIP por UF ({uf}) em vez de um único ZIP nacional.
TABELAS: dict[str, dict] = {
    "votacao_candidato_munzona": {
        "arquivo": "votacao_candidato_munzona_{ano}.zip",
        "pasta_cdn": "votacao_candidato_munzona",
        "por_uf": False,
        "descricao": "Votos por candidato x município x zona (tabela principal)",
    },
    "detalhe_votacao_munzona": {
        "arquivo": "detalhe_votacao_munzona_{ano}.zip",
        "pasta_cdn": "detalhe_votacao_munzona",
        "por_uf": False,
        "descricao": "Aptos, comparecimento, abstenção, brancos e nulos por município x zona",
    },
    "votacao_partido_munzona": {
        "arquivo": "votacao_partido_munzona_{ano}.zip",
        "pasta_cdn": "votacao_partido_munzona",
        "por_uf": False,
        "descricao": "Votos de legenda por partido x município x zona",
    },
    # Fora de escopo por enquanto (muito grande), mas já modelada: um ZIP por UF.
    "votacao_secao": {
        "arquivo": "votacao_secao_{ano}_{uf}.zip",
        "pasta_cdn": "votacao_secao",
        "por_uf": True,
        "descricao": "Votos por candidato x seção eleitoral (um ZIP por UF)",
    },
    "detalhe_votacao_secao": {
        "arquivo": "detalhe_votacao_secao_{ano}.zip",
        "pasta_cdn": "detalhe_votacao_secao",
        "por_uf": False,
        "descricao": "Detalhe da apuração por seção eleitoral",
    },
}

CDN_BASE = "https://cdn.tse.jus.br/estatistica/sead/odsele"


def url_cdn(tabela: str, ano: int, uf: str | None = None) -> str:
    """URL canônica no CDN do TSE (útil quando o CKAN ainda não lista o recurso)."""
    t = TABELAS[tabela]
    nome = t["arquivo"].format(ano=ano, uf=(uf or "").upper())
    return f"{CDN_BASE}/{t['pasta_cdn']}/{nome}"
