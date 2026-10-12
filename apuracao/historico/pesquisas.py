"""Pesquisas eleitorais centralizadas (intenção de voto).

Não existe fonte aberta e estruturada com os resultados das pesquisas (o TSE publica só o
registro: quem fez, quando, amostra). Por isso o acervo guarda as pesquisas numa tabela
própria alimentada por CSV, que a equipe importa a partir dos agregadores/institutos. Formato
(uma linha por candidato por cenário por pesquisa; separador vírgula; UTF-8):

    instituto,data_divulgacao,data_inicio,data_fim,ano_eleicao,turno,cargo,uf,cenario,
    candidato,partido,percentual,amostra,margem,registro_tse,fonte_url

- `cargo`: 1 presidente, 3 governador, 5 senador, 11 prefeito; `uf`: BR para nacional.
- `cenario`: ex. "estimulada", "espontânea", "2º turno: A x B".
- `percentual`: 0-100 com ponto decimal; `margem` em pontos percentuais.

O importador valida, normaliza nomes e grava `parquet/pesquisas/part.parquet` (substitui).
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import duckdb

from historico import PARQUET_DIR

COLUNAS = {
    "instituto": "VARCHAR",
    "data_divulgacao": "DATE",
    "data_inicio": "DATE",
    "data_fim": "DATE",
    "ano_eleicao": "BIGINT",
    "turno": "BIGINT",
    "cargo": "BIGINT",
    "uf": "VARCHAR",
    "cenario": "VARCHAR",
    "candidato": "VARCHAR",
    "partido": "VARCHAR",
    "percentual": "DOUBLE",
    "amostra": "BIGINT",
    "margem": "DOUBLE",
    "registro_tse": "VARCHAR",
    "fonte_url": "VARCHAR",
}
OBRIGATORIAS = (
    "instituto",
    "data_divulgacao",
    "ano_eleicao",
    "cargo",
    "uf",
    "candidato",
    "percentual",
)


def caminho_parquet() -> Path:
    return PARQUET_DIR / "pesquisas" / "part.parquet"


def _lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def importar_csv(csv: Path) -> dict:
    """Valida e grava o CSV no lake. Lança ValueError com a lista de problemas."""
    con = duckdb.connect()
    con.execute(
        f"CREATE TEMP TABLE bruto AS SELECT * FROM read_csv({_lit(str(csv))}, header=true, "
        f"all_varchar=true, union_by_name=true, delim=',', quote='\"')"
    )
    presentes = {r[0].strip().lower() for r in con.execute("DESCRIBE bruto").fetchall()}
    faltam = [c for c in OBRIGATORIAS if c not in presentes]
    if faltam:
        raise ValueError(f"colunas obrigatórias ausentes no CSV: {', '.join(faltam)}")
    sel = []
    for nome, tipo in COLUNAS.items():
        if nome not in presentes:
            sel.append(f"NULL::{tipo} AS {nome}")
            continue
        base = f"NULLIF(TRIM(\"{nome}\"), '')"
        if tipo == "DATE":
            sel.append(
                f"COALESCE(TRY_CAST({base} AS DATE), TRY_STRPTIME({base}, '%d/%m/%Y')::DATE) AS {nome}"
            )
        elif tipo == "DOUBLE":
            sel.append(f"TRY_CAST(REPLACE({base}, ',', '.') AS DOUBLE) AS {nome}")
        elif tipo == "BIGINT":
            sel.append(f"TRY_CAST({base} AS BIGINT) AS {nome}")
        elif nome == "uf":
            sel.append(f"UPPER({base}) AS {nome}")
        else:
            sel.append(f"{base} AS {nome}")
    con.execute(f"CREATE TEMP TABLE limpo AS SELECT {', '.join(sel)} FROM bruto")
    problemas = con.execute(
        "SELECT count(*) FILTER (WHERE instituto IS NULL OR data_divulgacao IS NULL OR candidato IS NULL), "
        "count(*) FILTER (WHERE percentual IS NULL OR percentual < 0 OR percentual > 100), "
        "count(*) FILTER (WHERE ano_eleicao IS NULL OR cargo IS NULL OR uf IS NULL), count(*) FROM limpo"
    ).fetchone()
    if problemas[0] or problemas[1] or problemas[2]:
        raise ValueError(
            f"linhas inválidas: {problemas[0]} sem instituto/data/candidato, "
            f"{problemas[1]} com percentual fora de 0-100, {problemas[2]} sem ano/cargo/uf"
        )
    destino = caminho_parquet()
    destino.parent.mkdir(parents=True, exist_ok=True)
    tmp = destino.with_suffix(".tmp.parquet")
    con.execute(
        f"COPY (SELECT * FROM limpo ORDER BY ano_eleicao, cargo, uf, data_divulgacao) TO {_lit(str(tmp))} (FORMAT PARQUET)"
    )
    tmp.replace(destino)
    meta = {
        "linhas": problemas[3],
        "origem": csv.name,
        "gerado_em": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    (destino.parent / "_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), "utf-8"
    )
    return meta


def listar(
    *, ano: int, cargo: int, uf: str = "BR", turno: int | None = None, cenario: str | None = None
) -> list[dict]:
    """Pontos (data, instituto, candidato, percentual) para a eleição pedida, em ordem de data."""
    p = caminho_parquet()
    if not p.exists():
        return []
    con = duckdb.connect()
    filtros = [f"ano_eleicao = {int(ano)}", f"cargo = {int(cargo)}", f"uf = {_lit(uf.upper())}"]
    if turno is not None:
        filtros.append(f"turno = {int(turno)}")
    if cenario:
        filtros.append(f"cenario = {_lit(cenario)}")
    rel = con.execute(
        f"SELECT instituto, data_divulgacao, data_fim, turno, cenario, candidato, partido, percentual, amostra, margem, registro_tse, fonte_url "
        f"FROM read_parquet({_lit(str(p))}) WHERE {' AND '.join(filtros)} ORDER BY data_divulgacao, instituto, percentual DESC"
    )
    cols = [d[0] for d in rel.description]
    out = []
    for row in rel.fetchall():
        d = dict(zip(cols, row, strict=True))
        for k in ("data_divulgacao", "data_fim"):
            if d[k] is not None:
                d[k] = d[k].isoformat()
        out.append(d)
    return out


def eleicoes_disponiveis() -> list[dict]:
    p = caminho_parquet()
    if not p.exists():
        return []
    con = duckdb.connect()
    rows = con.execute(
        f"SELECT ano_eleicao, cargo, uf, count(*) AS pontos, min(data_divulgacao), max(data_divulgacao) "
        f"FROM read_parquet({_lit(str(p))}) GROUP BY ALL ORDER BY 1 DESC, 2, 3"
    ).fetchall()
    return [
        {
            "ano": r[0],
            "cargo": r[1],
            "uf": r[2],
            "pontos": r[3],
            "de": r[4].isoformat(),
            "ate": r[5].isoformat(),
        }
        for r in rows
    ]
