"""Camada fina de consulta ao lake Parquet (DuckDB). Sem pandas: retorna listas de dicts
ou relações DuckDB (`duckdb.DuckDBPyRelation`), à escolha de quem chama.

Os caminhos usam glob com hive partitioning, logo `ano` e `turno` vêm do diretório:
    data/historico/parquet/{tabela}/ano=*/turno=*/*.parquet
"""
from __future__ import annotations

import re
from typing import Any

import duckdb

from historico import PARQUET_DIR, TABELAS

CARGOS: dict[int, str] = {
    1: "Presidente",
    2: "Vice-Presidente",
    3: "Governador",
    4: "Vice-Governador",
    5: "Senador",
    6: "Deputado Federal",
    7: "Deputado Estadual",
    8: "Deputado Distrital",
    9: "1º Suplente",
    10: "2º Suplente",
    11: "Prefeito",
    12: "Vice-Prefeito",
    13: "Vereador",
}
_CARGO_POR_NOME = {v.lower(): k for k, v in CARGOS.items()}


def _lit(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def glob_tabela(tabela: str, ano: int | str = "*", turno: int | str = "*") -> str:
    return str(PARQUET_DIR / tabela / f"ano={ano}" / f"turno={turno}" / "*.parquet")


def particoes_disponiveis(tabela: str) -> list[tuple[int, int]]:
    """[(ano, turno), ...] existentes no lake para `tabela`."""
    base = PARQUET_DIR / tabela
    saida: list[tuple[int, int]] = []
    if not base.exists():
        return saida
    for p in sorted(base.glob("ano=*/turno=*/part.parquet")):
        m_ano = re.fullmatch(r"ano=(\d+)", p.parent.parent.name)
        m_turno = re.fullmatch(r"turno=(\d+)", p.parent.name)
        if m_ano and m_turno:
            saida.append((int(m_ano.group(1)), int(m_turno.group(1))))
    return saida


def conectar(somente_leitura: bool = True) -> duckdb.DuckDBPyConnection:
    """Conexão em memória com uma VIEW por tabela existente no lake."""
    con = duckdb.connect()
    for tabela in TABELAS:
        if (PARQUET_DIR / tabela).exists() and particoes_disponiveis(tabela):
            con.execute(
                f"CREATE OR REPLACE VIEW {tabela} AS SELECT * FROM read_parquet("
                f"{_lit(glob_tabela(tabela))}, hive_partitioning=true, union_by_name=true)"
            )
    return con


def para_dicts(rel: duckdb.DuckDBPyRelation | duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    cols = [d[0] for d in rel.description]
    return [dict(zip(cols, linha)) for linha in rel.fetchall()]


def codigo_cargo(cargo: int | str) -> int:
    if isinstance(cargo, int):
        return cargo
    s = str(cargo).strip()
    if s.isdigit():
        return int(s)
    try:
        return _CARGO_POR_NOME[s.lower()]
    except KeyError:
        raise ValueError(f"cargo desconhecido: {cargo!r}; use um código ({CARGOS}) ou nome") from None


def _filtro_municipio(cd_ibge: str | None, cd_municipio: str | None, uf: str | None, alias: str = "v") -> str:
    partes = []
    if cd_ibge:
        partes.append(f"{alias}.cd_municipio_ibge = {_lit(str(cd_ibge))}")
    if cd_municipio:
        partes.append(f"{alias}.cd_municipio = {_lit(str(cd_municipio).zfill(5))}")
    if uf:
        partes.append(f"{alias}.sg_uf = {_lit(uf.upper())}")
    return (" AND " + " AND ".join(partes)) if partes else ""


# --------------------------------------------------------------------------- consultas

def resultado_por_municipio(
    ano: int,
    turno: int,
    cargo: int | str,
    *,
    uf: str | None = None,
    cd_ibge: str | None = None,
    cd_municipio: str | None = None,
    limite: int | None = None,
    con: duckdb.DuckDBPyConnection | None = None,
    como_relacao: bool = False,
) -> list[dict[str, Any]] | duckdb.DuckDBPyRelation:
    """Votos por candidato em cada município (soma das zonas) para ano/turno/cargo.

    `qt_votos` = QT_VOTOS_NOMINAIS; `qt_votos_validos` = QT_VOTOS_NOMINAIS_VALIDOS (NULL em
    2002–2014, quando a coluna não existia). `pct_validos` usa o total de votos nominais
    do cargo no município como denominador (aproximação; votos de legenda não entram).
    """
    con = con or conectar()
    cd_cargo = codigo_cargo(cargo)
    sql = f"""
        WITH v AS (
            SELECT * FROM read_parquet({_lit(glob_tabela("votacao_candidato_munzona", ano, turno))},
                                       hive_partitioning=true, union_by_name=true) v
            WHERE cd_cargo = {cd_cargo} {_filtro_municipio(cd_ibge, cd_municipio, uf)}
        ),
        agg AS (
            SELECT ano, turno, sg_uf, cd_municipio, cd_municipio_ibge, any_value(nm_municipio) AS nm_municipio,
                   cd_cargo, any_value(ds_cargo) AS ds_cargo,
                   sq_candidato, any_value(nr_candidato) AS nr_candidato,
                   any_value(nm_urna_candidato) AS nm_urna_candidato,
                   any_value(nm_candidato) AS nm_candidato,
                   any_value(sg_partido) AS sg_partido,
                   any_value(ds_sit_tot_turno) AS ds_sit_tot_turno,
                   sum(qt_votos_nominais) AS qt_votos,
                   sum(qt_votos_nominais_validos) AS qt_votos_validos
            FROM v
            GROUP BY ano, turno, sg_uf, cd_municipio, cd_municipio_ibge, cd_cargo, sq_candidato
        )
        SELECT *, round(100.0 * qt_votos / NULLIF(sum(qt_votos) OVER (PARTITION BY cd_municipio), 0), 2) AS pct_nominais
        FROM agg
        ORDER BY sg_uf, cd_municipio, qt_votos DESC
        {f'LIMIT {int(limite)}' if limite else ''}
    """
    rel = con.sql(sql)
    return rel if como_relacao else para_dicts(rel)


def serie_historica_municipio(
    cd_ibge: str,
    cargo: int | str,
    *,
    turno: int | None = None,
    top: int = 5,
    con: duckdb.DuckDBPyConnection | None = None,
    como_relacao: bool = False,
) -> list[dict[str, Any]] | duckdb.DuckDBPyRelation:
    """Para um município (código IBGE) e cargo, os `top` candidatos mais votados em cada
    ano/turno disponível no lake, com percentual sobre os votos nominais do município."""
    con = con or conectar()
    cd_cargo = codigo_cargo(cargo)
    filtro_turno = f"AND turno = {int(turno)}" if turno else ""
    sql = f"""
        WITH v AS (
            SELECT * FROM read_parquet({_lit(glob_tabela("votacao_candidato_munzona"))},
                                       hive_partitioning=true, union_by_name=true)
            WHERE cd_cargo = {cd_cargo} AND cd_municipio_ibge = {_lit(str(cd_ibge))} {filtro_turno}
        ),
        agg AS (
            SELECT ano, turno, any_value(sg_uf) AS sg_uf, any_value(nm_municipio) AS nm_municipio,
                   sq_candidato, any_value(nr_candidato) AS nr_candidato,
                   any_value(nm_urna_candidato) AS nm_urna_candidato,
                   any_value(sg_partido) AS sg_partido,
                   any_value(ds_sit_tot_turno) AS ds_sit_tot_turno,
                   sum(qt_votos_nominais) AS qt_votos
            FROM v GROUP BY ano, turno, sq_candidato
        ),
        rk AS (
            SELECT *, round(100.0 * qt_votos / NULLIF(sum(qt_votos) OVER (PARTITION BY ano, turno), 0), 2) AS pct_nominais,
                   row_number() OVER (PARTITION BY ano, turno ORDER BY qt_votos DESC) AS posicao
            FROM agg
        )
        SELECT * FROM rk WHERE posicao <= {int(top)} ORDER BY ano, turno, posicao
    """
    rel = con.sql(sql)
    return rel if como_relacao else para_dicts(rel)


def detalhe_municipio(
    ano: int,
    turno: int,
    cargo: int | str,
    *,
    cd_ibge: str | None = None,
    cd_municipio: str | None = None,
    uf: str | None = None,
    con: duckdb.DuckDBPyConnection | None = None,
    como_relacao: bool = False,
) -> list[dict[str, Any]] | duckdb.DuckDBPyRelation:
    """Aptos, comparecimento, abstenções, brancos e nulos por município (soma das zonas)."""
    con = con or conectar()
    cd_cargo = codigo_cargo(cargo)
    sql = f"""
        SELECT ano, turno, sg_uf, cd_municipio, cd_municipio_ibge, any_value(nm_municipio) AS nm_municipio,
               cd_cargo, any_value(ds_cargo) AS ds_cargo,
               sum(qt_aptos) AS qt_aptos, sum(qt_comparecimento) AS qt_comparecimento,
               sum(qt_abstencoes) AS qt_abstencoes, sum(qt_votos) AS qt_votos,
               sum(qt_total_votos_validos) AS qt_validos, sum(qt_votos_nominais_validos) AS qt_nominais_validos,
               sum(qt_votos_brancos) AS qt_brancos, sum(qt_total_votos_nulos) AS qt_nulos,
               sum(qt_total_secoes) AS qt_secoes,
               round(100.0 * sum(qt_comparecimento) / NULLIF(sum(qt_aptos), 0), 2) AS pct_comparecimento
        FROM read_parquet({_lit(glob_tabela("detalhe_votacao_munzona", ano, turno))},
                          hive_partitioning=true, union_by_name=true) v
        WHERE cd_cargo = {cd_cargo} {_filtro_municipio(cd_ibge, cd_municipio, uf)}
        GROUP BY ano, turno, sg_uf, cd_municipio, cd_municipio_ibge, cd_cargo
        ORDER BY sg_uf, cd_municipio
    """
    rel = con.sql(sql)
    return rel if como_relacao else para_dicts(rel)


def sql(query: str, *, con: duckdb.DuckDBPyConnection | None = None) -> list[dict[str, Any]]:
    """Executa SQL livre com as views `votacao_candidato_munzona`, `detalhe_votacao_munzona`..."""
    con = con or conectar()
    return para_dicts(con.sql(query))
