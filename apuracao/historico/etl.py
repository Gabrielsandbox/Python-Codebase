"""CSV do TSE (latin-1, ';', aspas) -> Parquet particionado.

Layout de saída:
    data/historico/parquet/{tabela}/ano={YYYY}/turno={N}/part.parquet
    data/historico/parquet/{tabela}/ano={YYYY}/turno={N}/_meta.json

Estratégia:
  * Extrai do ZIP apenas o(s) CSV(s) necessário(s) para um diretório temporário sob RAW_DIR.
    Os ZIPs do TSE trazem um CSV por UF **mais** `_BRASIL.csv` (união de todos) e, em anos
    com eleição federal, `_BR.csv` (linhas da eleição presidencial). Ler tudo duplicaria os
    votos — por isso lemos **só** `_BRASIL.csv` quando ele existe.
  * Lê com DuckDB `read_csv(..., all_varchar=true, encoding='latin-1')`: o sniffer de tipos é
    desligado de propósito porque CD_MUNICIPIO aparece ora com aspas ("01120") ora sem (74330)
    no mesmo arquivo e perderia zeros à esquerda.
  * Normaliza nomes para minúsculas e tipa as colunas por prefixo (qt_ -> BIGINT, cd_/nr_ ->
    BIGINT com -1/-3 => NULL, dt_ -> DATE, hh_ -> TIME, sq_ -> VARCHAR). Colunas
    desconhecidas são mantidas como VARCHAR. Marcadores do TSE (#NE, #NULO, #NULO#) => NULL.
  * Garante um conjunto fixo de colunas por tabela (NULL tipado quando o ano não traz a coluna),
    para que consultas funcionem igual de 1994 a 2026.
  * Adiciona `cd_municipio_ibge` (7 dígitos) via data/ref/tse-municipios-2026.json.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path

import duckdb

from historico import PARQUET_DIR, RAW_DIR, REF_MUNICIPIOS, TABELAS

MARCADORES_NULOS = ("#NE", "#NE#", "#NULO", "#NULO#", "")
CODIGOS_NULOS = ("-1", "-3", "-4")

# Colunas garantidas por tabela (nome normalizado -> tipo DuckDB). Se o CSV do ano não
# trouxer a coluna, ela é criada como NULL tipado.
_COMUNS: dict[str, str] = {
    "ano_eleicao": "BIGINT",
    "cd_tipo_eleicao": "BIGINT",
    "nm_tipo_eleicao": "VARCHAR",
    "nr_turno": "BIGINT",
    "cd_eleicao": "BIGINT",
    "ds_eleicao": "VARCHAR",
    "dt_eleicao": "DATE",
    "tp_abrangencia": "VARCHAR",
    "sg_uf": "VARCHAR",
    "sg_ue": "VARCHAR",
    "nm_ue": "VARCHAR",
    "cd_municipio": "VARCHAR",
    "nm_municipio": "VARCHAR",
    "nr_zona": "BIGINT",
    "cd_cargo": "BIGINT",
    "ds_cargo": "VARCHAR",
    "st_voto_em_transito": "VARCHAR",
}
COLUNAS_GARANTIDAS: dict[str, dict[str, str]] = {
    "votacao_candidato_munzona": {
        **_COMUNS,
        "sq_candidato": "VARCHAR",
        "nr_candidato": "BIGINT",
        "nm_candidato": "VARCHAR",
        "nm_urna_candidato": "VARCHAR",
        "nm_social_candidato": "VARCHAR",
        "cd_situacao_candidatura": "BIGINT",
        "ds_situacao_candidatura": "VARCHAR",
        "cd_detalhe_situacao_cand": "BIGINT",
        "ds_detalhe_situacao_cand": "VARCHAR",
        "tp_agremiacao": "VARCHAR",
        "nr_partido": "BIGINT",
        "sg_partido": "VARCHAR",
        "nm_partido": "VARCHAR",
        "nr_federacao": "BIGINT",
        "nm_federacao": "VARCHAR",
        "sg_federacao": "VARCHAR",
        "ds_composicao_federacao": "VARCHAR",
        "sq_coligacao": "VARCHAR",
        "nm_coligacao": "VARCHAR",
        "ds_composicao_coligacao": "VARCHAR",
        "qt_votos_nominais": "BIGINT",
        "nm_tipo_destinacao_votos": "VARCHAR",
        "qt_votos_nominais_validos": "BIGINT",
        "cd_sit_tot_turno": "BIGINT",
        "ds_sit_tot_turno": "VARCHAR",
    },
    "detalhe_votacao_munzona": {
        **_COMUNS,
        "qt_aptos": "BIGINT",
        "qt_secoes_principais": "BIGINT",
        "qt_secoes_agregadas": "BIGINT",
        "qt_secoes_nao_instaladas": "BIGINT",
        "qt_total_secoes": "BIGINT",
        "qt_comparecimento": "BIGINT",
        "qt_eleitores_secoes_nao_instaladas": "BIGINT",
        "qt_abstencoes": "BIGINT",
        "qt_votos": "BIGINT",
        "qt_votos_concorrentes": "BIGINT",
        "qt_total_votos_validos": "BIGINT",
        "qt_votos_nominais_validos": "BIGINT",
        "qt_total_votos_leg_validos": "BIGINT",
        "qt_votos_leg_validos": "BIGINT",
        "qt_votos_nom_convr_leg_validos": "BIGINT",
        "qt_total_votos_anulados": "BIGINT",
        "qt_votos_nominais_anulados": "BIGINT",
        "qt_votos_legenda_anulados": "BIGINT",
        "qt_total_votos_anul_subjud": "BIGINT",
        "qt_votos_nominais_anul_subjud": "BIGINT",
        "qt_votos_legenda_anul_subjud": "BIGINT",
        "qt_votos_brancos": "BIGINT",
        "qt_total_votos_nulos": "BIGINT",
        "qt_votos_nulos": "BIGINT",
        "qt_votos_nulos_tecnicos": "BIGINT",
        "qt_votos_anulados_apu_sep": "BIGINT",
        "hh_ultima_totalizacao": "TIME",
        "dt_ultima_totalizacao": "DATE",
    },
}
# Códigos que devem continuar texto (preservam zeros à esquerda / são identificadores).
_SEMPRE_TEXTO = {"cd_municipio", "sg_ue", "sq_candidato", "sq_coligacao"}


@dataclass
class ResultadoEtl:
    tabela: str
    ano: int
    zip: str
    csvs_lidos: list[str]
    linhas: int
    particoes: list[dict] = field(default_factory=list)   # [{ano, turno, linhas, caminho}]
    colunas: int = 0
    colunas_ausentes: list[str] = field(default_factory=list)
    sem_ibge: int = 0            # linhas com cd_municipio sem correspondência IBGE
    segundos: float = 0.0

    def para_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------- utilidades

def normalizar_nome(col: str) -> str:
    c = col.strip().strip('"').lower()
    c = re.sub(r"[^\w]+", "_", c, flags=re.UNICODE).strip("_")
    return c or "col"


def _q(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def _lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def expr_coluna(raw: str, nome: str, tipo_garantido: str | None) -> str:
    """Expressão SQL que converte a coluna VARCHAR `raw` para o tipo normalizado `nome`."""
    col = _q(raw)
    limpo = f"NULLIF(TRIM({col}), '')"
    for m in MARCADORES_NULOS[:-1]:
        limpo = f"NULLIF({limpo}, {_lit(m)})"

    tipo = tipo_garantido
    if tipo is None:  # inferir pelo prefixo
        if nome in _SEMPRE_TEXTO:
            tipo = "VARCHAR"
        elif nome.startswith(("qt_", "cd_", "nr_")):
            tipo = "BIGINT"
        elif nome.startswith("dt_"):
            tipo = "DATE"
        elif nome.startswith("hh_"):
            tipo = "TIME"
        else:
            tipo = "VARCHAR"

    if nome == "cd_municipio":
        return f"LPAD({limpo}, 5, '0')"
    if tipo == "BIGINT":
        base = limpo
        if nome.startswith(("cd_", "nr_")):
            for c in CODIGOS_NULOS:
                base = f"NULLIF({base}, {_lit(c)})"
        return f"TRY_CAST({base} AS BIGINT)"
    if tipo == "DATE":
        return f"COALESCE(TRY_STRPTIME({limpo}, '%d/%m/%Y')::DATE, TRY_CAST({limpo} AS DATE))"
    if tipo == "TIME":
        return f"TRY_CAST({limpo} AS TIME)"
    return limpo


def localizar_zip(ano: int, tabela: str, uf: str | None = None) -> Path:
    nome = TABELAS[tabela]["arquivo"].format(ano=ano, uf=(uf or "").upper())
    p = RAW_DIR / str(ano) / nome
    if not p.exists():
        raise FileNotFoundError(f"ZIP não encontrado: {p} (rode `historico baixar {ano} --tabela {tabela}`)")
    return p


def _membros_csv(zf: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    """Escolhe os CSVs a ler: só `_BRASIL.csv` se existir; senão todos os .csv."""
    csvs = []
    for zi in zf.infolist():
        nome = zi.filename
        # defesa contra zip-slip / nomes estranhos: só arquivos simples na raiz do ZIP
        if zi.is_dir() or "/" in nome or "\\" in nome or nome.startswith(".") or ".." in nome:
            continue
        if nome.lower().endswith((".csv", ".txt")):
            csvs.append(zi)
    brasil = [zi for zi in csvs if zi.filename.lower().endswith("_brasil.csv")]
    if brasil:
        return brasil
    # sem _BRASIL: lê UFs + BR (não se sobrepõem)
    return csvs


def carregar_ref_municipios(con: duckdb.DuckDBPyConnection, caminho: Path = REF_MUNICIPIOS) -> int:
    """Cria a tabela temporária ref_municipio(cd_tse, cd_ibge, uf, nome)."""
    con.execute("CREATE OR REPLACE TEMP TABLE ref_municipio(cd_tse VARCHAR, cd_ibge VARCHAR, uf VARCHAR, nome VARCHAR)")
    if not caminho.exists():
        return 0
    doc = json.loads(caminho.read_text("utf-8"))
    vistos: dict[str, tuple] = {}
    for uf in doc.get("abr", []):
        sg = (uf.get("cd") or "").upper()
        for mu in uf.get("mu", []):
            cd = str(mu.get("cd", "")).zfill(5)
            cdi = str(mu.get("cdi") or "") or None
            if cd and cd not in vistos:
                vistos[cd] = (cd, cdi, sg, mu.get("nm"))
    if vistos:
        con.executemany("INSERT INTO ref_municipio VALUES (?, ?, ?, ?)", list(vistos.values()))
    return len(vistos)


def _configurar(con: duckdb.DuckDBPyConnection, threads: int | None, memoria: str | None, tmp: Path) -> None:
    con.execute(f"SET temp_directory = {_lit(str(tmp / 'duckdb_tmp'))}")
    con.execute("SET preserve_insertion_order = false")
    if threads:
        con.execute(f"SET threads = {int(threads)}")
    if memoria:
        con.execute(f"SET memory_limit = {_lit(memoria)}")


# --------------------------------------------------------------------------- principal

def executar_etl(
    ano: int,
    tabela: str,
    *,
    uf: str | None = None,
    zip_path: Path | None = None,
    threads: int | None = None,
    memoria: str | None = None,
    ignorar_erros: bool = False,
    manter_temporarios: bool = False,
) -> ResultadoEtl:
    if tabela not in TABELAS:
        raise KeyError(f"tabela desconhecida: {tabela!r}")
    t0 = time.time()
    zip_path = zip_path or localizar_zip(ano, tabela, uf)

    tmp_base = RAW_DIR / "_tmp"
    tmp_base.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f"{tabela}_{ano}_", dir=tmp_base))
    try:
        with zipfile.ZipFile(zip_path) as zf:
            membros = _membros_csv(zf)
            if not membros:
                raise RuntimeError(f"nenhum CSV dentro de {zip_path}")
            caminhos: list[Path] = []
            for zi in membros:
                zf.extract(zi, tmp)
                caminhos.append(tmp / zi.filename)

        con = duckdb.connect()
        _configurar(con, threads, memoria, tmp)

        arquivos_sql = "[" + ", ".join(_lit(str(p)) for p in caminhos) + "]"
        read_csv = (
            f"read_csv({arquivos_sql}, delim=';', header=true, quote='\"', escape='\"', "
            f"encoding='latin-1', all_varchar=true, union_by_name=true, null_padding=true, "
            f"ignore_errors={'true' if ignorar_erros else 'false'})"
        )
        colunas_raw = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {read_csv} LIMIT 0").fetchall()]

        garantidas = COLUNAS_GARANTIDAS.get(tabela, _COMUNS)
        selecao: list[str] = []
        presentes: set[str] = set()
        usados: set[str] = set()
        for raw in colunas_raw:
            nome = normalizar_nome(raw)
            if nome in usados:  # colisão improvável após normalização
                i = 2
                while f"{nome}_{i}" in usados:
                    i += 1
                nome = f"{nome}_{i}"
            usados.add(nome)
            presentes.add(nome)
            selecao.append(f"{expr_coluna(raw, nome, garantidas.get(nome))} AS {_q(nome)}")
        ausentes = [c for c in garantidas if c not in presentes]
        for c in ausentes:
            selecao.append(f"NULL::{garantidas[c]} AS {_q(c)}")

        con.execute(f"CREATE TEMP TABLE stg AS SELECT {', '.join(selecao)} FROM {read_csv}")
        n_ref = carregar_ref_municipios(con)

        con.execute(
            """
            CREATE TEMP TABLE final AS
            SELECT s.*, r.cd_ibge AS cd_municipio_ibge
            FROM stg s LEFT JOIN ref_municipio r ON s.cd_municipio = r.cd_tse
            """
        )
        con.execute("DROP TABLE stg")
        total = con.execute("SELECT count(*) FROM final").fetchone()[0]
        sem_ibge = 0
        if n_ref:
            sem_ibge = con.execute(
                "SELECT count(*) FROM final WHERE cd_municipio_ibge IS NULL AND cd_municipio IS NOT NULL"
            ).fetchone()[0]

        parts = con.execute(
            "SELECT ano_eleicao, nr_turno, count(*) FROM final GROUP BY 1, 2 ORDER BY 1, 2"
        ).fetchall()
        particoes: list[dict] = []
        for ano_p, turno_p, n in parts:
            if ano_p is None or turno_p is None:
                raise RuntimeError(f"linhas sem ano/turno ({n}) em {zip_path}; abortando")
            destino = PARQUET_DIR / tabela / f"ano={int(ano_p)}" / f"turno={int(turno_p)}"
            destino.mkdir(parents=True, exist_ok=True)
            final_path = destino / "part.parquet"
            tmp_path = destino / f".part.{os.getpid()}.tmp.parquet"
            con.execute(
                f"COPY (SELECT * EXCLUDE (ano_eleicao, nr_turno) FROM final "
                f"WHERE ano_eleicao = {int(ano_p)} AND nr_turno = {int(turno_p)}) "
                f"TO {_lit(str(tmp_path))} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 500000)"
            )
            tmp_path.replace(final_path)
            meta = {
                "tabela": tabela,
                "ano": int(ano_p),
                "turno": int(turno_p),
                "linhas": int(n),
                "origem_zip": zip_path.name,
                "origem_zip_bytes": zip_path.stat().st_size,
                "origem_zip_mtime": int(zip_path.stat().st_mtime),
                "csvs": [p.name for p in caminhos],
                "gerado_em": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "duckdb": duckdb.__version__,
            }
            (destino / "_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
            particoes.append({"ano": int(ano_p), "turno": int(turno_p), "linhas": int(n), "caminho": str(final_path)})

        n_cols = len(con.execute("DESCRIBE final").fetchall())
        con.close()
        return ResultadoEtl(
            tabela=tabela,
            ano=ano,
            zip=str(zip_path),
            csvs_lidos=[p.name for p in caminhos],
            linhas=int(total),
            particoes=particoes,
            colunas=n_cols,
            colunas_ausentes=ausentes,
            sem_ibge=int(sem_ibge),
            segundos=time.time() - t0,
        )
    finally:
        if not manter_temporarios:
            shutil.rmtree(tmp, ignore_errors=True)
