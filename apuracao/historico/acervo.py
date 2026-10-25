"""Consultas do acervo para a plataforma: candidatos (histórico político), eleições (resumos) e
disponibilidade do lake. Tudo lê o Parquet via DuckDB (historico.consulta.conectar).

Chave de pessoa: o TSE não publica um identificador estável entre eleições sem dados sensíveis
(o CPF fica fora do lake). Usamos (nm_candidato, dt_nascimento), que na prática identifica a
pessoa; homônimos com a mesma data de nascimento são raríssimos e aparecem juntos.
"""

from __future__ import annotations

from typing import Any

from historico.consulta import _lit, conectar, para_dicts, particoes_disponiveis

CARGOS = {
    1: "Presidente",
    3: "Governador",
    5: "Senador",
    6: "Deputado Federal",
    7: "Deputado Estadual",
    8: "Deputado Distrital",
    11: "Prefeito",
    13: "Vereador",
}


def _tem(tabela: str) -> bool:
    return bool(particoes_disponiveis(tabela))


def estado() -> dict[str, Any]:
    """O que existe no lake, para o site saber o que oferecer."""
    from historico.pesquisas import eleicoes_disponiveis

    def anos(tabela: str) -> list[int]:
        return sorted({a for a, _ in particoes_disponiveis(tabela)})

    return {
        "candidatos": anos("consulta_cand"),
        "votacao": anos("votacao_candidato_munzona"),
        "detalhe": anos("detalhe_votacao_munzona"),
        "pesquisas": eleicoes_disponiveis(),
        "cargos": CARGOS,
    }


def _sem_acento(expr: str) -> str:
    return f"lower(strip_accents({expr}))"


def buscar_candidatos(
    q: str,
    *,
    ano: int | None = None,
    cargo: int | None = None,
    uf: str | None = None,
    limite: int = 30,
) -> list[dict[str, Any]]:
    """Candidaturas cujo nome de urna ou nome completo contém `q` (sem acento, sem maiúsculas).
    Uma linha por candidatura (pessoa × ano × cargo), com a situação final e a soma de votos
    quando o ano tem a tabela de votação."""
    if not _tem("consulta_cand"):
        return []
    termo = " ".join(q.split()).strip()
    if len(termo) < 2:
        return []
    con = conectar()
    padrao = _lit("%" + termo.lower() + "%")
    filtros = [
        f"({_sem_acento('c.nm_urna_candidato')} LIKE {padrao} OR {_sem_acento('c.nm_candidato')} LIKE {padrao})"
    ]
    if ano:
        filtros.append(f"c.ano = {int(ano)}")
    if cargo:
        filtros.append(f"c.cd_cargo = {int(cargo)}")
    if uf:
        filtros.append(f"c.sg_uf = {_lit(uf.upper())}")
    votos_sql = _votos_por_candidatura(con)
    rel = con.execute(
        f"""
        WITH c AS (
            SELECT * FROM consulta_cand c WHERE {" AND ".join(filtros)}
        ),
        ult AS (  -- a situação final é a do último turno em que a pessoa aparece
            SELECT ano, sq_candidato, max(turno) AS turno FROM c GROUP BY ALL
        )
        SELECT c.ano, c.turno, c.sq_candidato, c.nm_urna_candidato, c.nm_candidato, c.nr_candidato,
               c.sg_partido, c.cd_cargo, c.ds_cargo, c.sg_uf, c.sg_ue, c.nm_ue, c.ds_sit_tot_turno,
               c.ds_situacao_candidatura, c.dt_nascimento, v.votos
        FROM c JOIN ult USING (ano, sq_candidato, turno)
        LEFT JOIN ({votos_sql}) v ON v.ano = c.ano AND v.sq_candidato = c.sq_candidato AND v.turno = c.turno
        ORDER BY (c.cd_cargo = 1) DESC, v.votos DESC NULLS LAST, c.ano DESC
        LIMIT {int(limite)}
        """
    )
    return _datas(para_dicts(rel))


def _votos_por_candidatura(con) -> str:
    """Subconsulta (ano, turno, sq_candidato, votos) ou vazia quando não há votação no lake."""
    if _tem("votacao_candidato_munzona"):
        return (
            "SELECT ano, turno, sq_candidato, sum(qt_votos_nominais) AS votos "
            "FROM votacao_candidato_munzona GROUP BY ALL"
        )
    return "SELECT NULL::BIGINT AS ano, NULL::BIGINT AS turno, NULL::VARCHAR AS sq_candidato, NULL::BIGINT AS votos WHERE false"


def historico_pessoa(sq_candidato: str, ano: int) -> dict[str, Any] | None:
    """Perfil público e todas as candidaturas da pessoa dona de (sq_candidato, ano)."""
    if not _tem("consulta_cand"):
        return None
    con = conectar()
    chave = con.execute(
        f"SELECT nm_candidato, dt_nascimento FROM consulta_cand WHERE ano = {int(ano)} AND sq_candidato = {_lit(sq_candidato)} LIMIT 1"
    ).fetchone()
    if not chave:
        return None
    nome, nasc = chave
    cond = f"nm_candidato = {_lit(nome)} AND " + (
        f"dt_nascimento = DATE {_lit(nasc.isoformat())}" if nasc else "dt_nascimento IS NULL"
    )
    votos_sql = _votos_por_candidatura(con)
    rel = con.execute(
        f"""
        WITH c AS (SELECT * FROM consulta_cand WHERE {cond})
        SELECT c.ano, c.turno, c.sq_candidato, c.nm_urna_candidato, c.nr_candidato, c.sg_partido, c.nm_partido,
               c.cd_cargo, c.ds_cargo, c.sg_uf, c.sg_ue, c.nm_ue, c.ds_situacao_candidatura, c.ds_sit_tot_turno,
               c.nm_coligacao, c.ds_composicao_coligacao, c.st_reeleicao, v.votos
        FROM c LEFT JOIN ({votos_sql}) v ON v.ano = c.ano AND v.sq_candidato = c.sq_candidato AND v.turno = c.turno
        ORDER BY c.ano, c.turno
        """
    )
    candidaturas = _datas(para_dicts(rel))
    perfil = con.execute(
        f"""
        SELECT nm_candidato, nm_urna_candidato, nm_social_candidato, dt_nascimento, ds_genero, ds_grau_instrucao,
               ds_ocupacao, ds_cor_raca, sg_uf_nascimento, nm_municipio_nascimento
        FROM consulta_cand WHERE {cond} ORDER BY ano DESC, turno DESC LIMIT 1
        """
    )
    p = _datas(para_dicts(perfil))[0]
    eleito = sum(
        1
        for c in candidaturas
        if c["ds_sit_tot_turno"] and c["ds_sit_tot_turno"].upper().startswith("ELEITO")
    )
    return {
        "perfil": p,
        "resumo": {
            "candidaturas": len({(c["ano"], c["sq_candidato"]) for c in candidaturas}),
            "eleicoes_vencidas": eleito,
            "partidos": sorted({c["sg_partido"] for c in candidaturas if c["sg_partido"]}),
            "primeiro_ano": min((c["ano"] for c in candidaturas), default=None),
            "ultimo_ano": max((c["ano"] for c in candidaturas), default=None),
        },
        "candidaturas": candidaturas,
    }


def resumo_eleicao(
    ano: int, cargo: int, turno: int = 1, uf: str | None = None, limite: int = 40
) -> dict[str, Any] | None:
    """Votos por candidato (soma dos municípios) para uma eleição, mais totais quando houver."""
    if (ano, turno) not in particoes_disponiveis("votacao_candidato_munzona"):
        return None
    con = conectar()
    filtros = [f"ano = {int(ano)}", f"turno = {int(turno)}", f"cd_cargo = {int(cargo)}"]
    if uf:
        filtros.append(f"sg_uf = {_lit(uf.upper())}")
    rel = con.execute(
        f"""
        SELECT sq_candidato, any_value(nm_urna_candidato) AS nm_urna_candidato, any_value(nr_candidato) AS nr_candidato,
               any_value(sg_partido) AS sg_partido, any_value(ds_sit_tot_turno) AS ds_sit_tot_turno,
               sum(qt_votos_nominais) AS votos
        FROM votacao_candidato_munzona WHERE {" AND ".join(filtros)}
        GROUP BY sq_candidato ORDER BY votos DESC LIMIT {int(limite)}
        """
    )
    linhas = para_dicts(rel)
    total = sum(r["votos"] or 0 for r in linhas)
    for r in linhas:
        r["pct"] = round(100 * (r["votos"] or 0) / total, 2) if total else None
    totais: dict[str, Any] | None = None
    if (ano, turno) in particoes_disponiveis("detalhe_votacao_munzona"):
        f2 = [f"ano = {int(ano)}", f"turno = {int(turno)}", f"cd_cargo = {int(cargo)}"]
        if uf:
            f2.append(f"sg_uf = {_lit(uf.upper())}")
        t = con.execute(
            f"SELECT sum(qt_aptos), sum(qt_comparecimento), sum(qt_abstencoes), sum(qt_votos_brancos), "
            f"sum(qt_total_votos_nulos), sum(qt_votos_nominais_validos) FROM detalhe_votacao_munzona WHERE {' AND '.join(f2)}"
        ).fetchone()
        if t and t[0]:
            totais = {
                "aptos": t[0],
                "comparecimento": t[1],
                "abstencoes": t[2],
                "brancos": t[3],
                "nulos": t[4],
                "validos_nominais": t[5],
            }
    return {
        "ano": ano,
        "cargo": cargo,
        "cargo_nome": CARGOS.get(cargo, str(cargo)),
        "turno": turno,
        "uf": uf,
        "candidatos": linhas,
        "totais": totais,
    }


def resumo_por_uf(ano: int, cargo: int, turno: int, limite_cands: int = 2) -> list[dict[str, Any]]:
    """Para o mapa: por UF, os `limite_cands` mais votados e o total, numa eleição."""
    if (ano, turno) not in particoes_disponiveis("votacao_candidato_munzona"):
        return []
    con = conectar()
    rel = con.execute(
        f"""
        WITH v AS (
            SELECT sg_uf, sq_candidato, any_value(nm_urna_candidato) AS nome, any_value(sg_partido) AS partido,
                   sum(qt_votos_nominais) AS votos
            FROM votacao_candidato_munzona WHERE ano = {int(ano)} AND turno = {int(turno)} AND cd_cargo = {int(cargo)}
            GROUP BY sg_uf, sq_candidato
        ), r AS (
            SELECT *, row_number() OVER (PARTITION BY sg_uf ORDER BY votos DESC) AS pos,
                   sum(votos) OVER (PARTITION BY sg_uf) AS total FROM v
        )
        SELECT sg_uf, sq_candidato, nome, partido, votos, total, pos FROM r WHERE pos <= {int(limite_cands)} ORDER BY sg_uf, pos
        """
    )
    return para_dicts(rel)


def _datas(linhas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for r in linhas:
        for k, v in list(r.items()):
            if hasattr(v, "isoformat"):
                r[k] = v.isoformat()
    return linhas
