"""Caminho para a vitória: aritmética sobre os votos que ainda faltam (docs/RECURSOS.md §1).

Base: o 1º turno do mesmo município (seções totais, votos válidos e votos dos dois finalistas),
gravada em ``data/ref/base-1turno.json`` por ``apuracao base-1turno``. Para cada município no 2º
turno: ``restante = (secoes_total - secoes_totalizadas) * (validos_1t / secoes_total_1t)``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..tse.eleicoes import Municipio
from ..tse.parse import Resultado

REGIAO_POR_UF = {
    "AC": "Norte", "AM": "Norte", "AP": "Norte", "PA": "Norte", "RO": "Norte", "RR": "Norte", "TO": "Norte",
    "AL": "Nordeste", "BA": "Nordeste", "CE": "Nordeste", "MA": "Nordeste", "PB": "Nordeste",
    "PE": "Nordeste", "PI": "Nordeste", "RN": "Nordeste", "SE": "Nordeste",
    "DF": "Centro-Oeste", "GO": "Centro-Oeste", "MS": "Centro-Oeste", "MT": "Centro-Oeste",
    "ES": "Sudeste", "MG": "Sudeste", "RJ": "Sudeste", "SP": "Sudeste",
    "PR": "Sul", "RS": "Sul", "SC": "Sul",
    "ZZ": "Exterior",
}  # fmt: skip
REGIOES = ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul", "Exterior"]


@dataclass(slots=True)
class Base:
    """Referência do 1º turno por município (chave: código IBGE ou sintético 99+TSE)."""

    eleicao: str
    cands: list[str]  # os dois finalistas, na ordem canônica (número de urna)
    por_mun: dict[str, tuple[int, int, list[int]]]  # ibge → (secoes_total, validos, [v_a, v_b])

    @classmethod
    def carregar(cls, path: Path) -> Base | None:
        if not path.exists():
            return None
        d = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            eleicao=str(d["eleicao"]),
            cands=list(d["cands"]),
            por_mun={k: (v[0], v[1], list(v[2])) for k, v in d["por_mun"].items()},
        )


def construir_base(meta: dict, mun: dict, br: dict) -> dict:
    """Monta ``base-1turno.json`` a partir dos snapshots do 1º turno (meta/mun/br)."""
    finalistas = [c for c in meta["cands"] if br.get("situacao", {}).get(c) == "2º turno"]
    if len(finalistas) != 2:
        # fallback: os dois mais votados
        pares = sorted(zip(br["cands"], br["v"], strict=True), key=lambda x: -x[1])[:2]
        finalistas = [c for c, _ in pares]
        finalistas.sort(key=lambda c: int(meta["candidatos"][c]["numero"]))
    idx = [mun["cands"].index(c) for c in finalistas]
    campos = mun["campos"]
    i_ibge, i_st, i_val, i_v = (campos.index(k) for k in ("ibge", "secoes_total", "validos", "v"))
    por_mun = {}
    for linha in mun["linhas"]:
        ibge = linha[i_ibge]
        if not ibge:
            continue
        por_mun[ibge] = [linha[i_st], linha[i_val], [linha[i_v][j] for j in idx]]
    return {
        "schema": 1,
        "eleicao": meta["eleicao"],
        "descricao": f"comparecimento e votos válidos do 1º turno de {meta['data_eleicao'][:4]}",
        "cands": finalistas,
        "candidatos": {c: meta["candidatos"][c].get("nome", c) for c in finalistas},
        "por_mun": por_mun,
    }


def _pct_par(v: list[int]) -> list[float]:
    s = sum(v)
    if s <= 0:
        return [50.0, 50.0]
    return [round(100 * x / s, 1) for x in v]


def calcular_caminho(
    base: Base,
    cands: list[str],
    br: Resultado | None,
    muns: dict[str, tuple[Municipio, Resultado]],
    municipios: list[Municipio],
    atualizado_em: str,
) -> dict:
    """Produz o ``caminho.json``. ``cands`` é a ordem canônica do 2º turno."""
    # alinha a base à ordem de cands do 2º turno
    if set(base.cands) != set(cands) or len(cands) != 2:
        # 2º turno com outros ids (não deveria acontecer) → sem base útil
        ordem = [0, 1]
    else:
        ordem = [base.cands.index(c) for c in cands]

    tot_votos = 0.0
    tot_secoes = 0
    tot_secoes_total = 0
    abertos = 0
    por_regiao: dict[str, dict] = {
        r: {"votos_est": 0.0, "secoes": 0, "secoes_total": 0, "base_v": [0, 0]} for r in REGIOES
    }
    por_uf: dict[str, dict] = {}
    maiores: list[dict] = []

    for m in municipios:
        chave = m.ibge or f"99{m.tse}"
        ref = base.por_mun.get(chave)
        res = muns.get(m.tse, (None, None))[1]
        if ref is None:
            continue
        st_1t, val_1t, v_1t = ref
        v_1t = [v_1t[i] for i in ordem]
        if res is None:
            # município ainda sem arquivo: tudo em aberto, usa seções do 1º turno
            secoes_total, secoes_tot = st_1t, 0
        else:
            secoes_total, secoes_tot = res.secoes_total or st_1t, res.secoes_totalizadas
        faltam = max(0, secoes_total - secoes_tot)
        por_secao = (val_1t / st_1t) if st_1t else 0.0
        votos_est = faltam * por_secao
        reg = REGIAO_POR_UF.get(m.uf, "Exterior")
        r = por_regiao[reg]
        r["votos_est"] += votos_est
        r["secoes"] += faltam
        r["secoes_total"] += secoes_total
        r["base_v"][0] += v_1t[0]
        r["base_v"][1] += v_1t[1]
        u = por_uf.setdefault(
            m.uf, {"votos_est": 0.0, "secoes": 0, "secoes_total": 0, "base_v": [0, 0]}
        )
        u["votos_est"] += votos_est
        u["secoes"] += faltam
        u["secoes_total"] += secoes_total
        u["base_v"][0] += v_1t[0]
        u["base_v"][1] += v_1t[1]
        tot_votos += votos_est
        tot_secoes += faltam
        tot_secoes_total += secoes_total
        if faltam > 0:
            abertos += 1
            maiores.append(
                {
                    "ibge": chave,
                    "nome": _titulo(m.nome),
                    "uf": m.uf,
                    "votos_est": round(votos_est),
                    "pct_secoes": round(100 * secoes_tot / secoes_total, 1)
                    if secoes_total
                    else 0.0,
                    "base_pct": _pct_par(v_1t),
                }
            )
    maiores.sort(key=lambda x: -x["votos_est"])
    maiores = maiores[:15]

    def fechar(d: dict) -> dict:
        return {
            "votos_est": round(d["votos_est"]),
            "secoes": d["secoes"],
            "pct_secoes_restantes": round(100 * d["secoes"] / d["secoes_total"], 1)
            if d["secoes_total"]
            else 0.0,
            "base_pct": _pct_par(d["base_v"]),
        }

    restante_votos = round(tot_votos)
    necessario: dict[str, float | None] = {c: None for c in cands}
    definido_mat: str | None = None
    if br is not None and br.candidatos and len(cands) == 2:
        por_id = {c.id: c for c in br.candidatos}
        va, vb = (por_id[c].votos if c in por_id else 0 for c in cands)
        if restante_votos > 0:
            # x = votos que b precisa dos restantes para empatar com a
            if va >= vb:
                x = (va - vb + restante_votos) / 2
                necessario[cands[1]] = round(100 * x / restante_votos, 1)
                necessario[cands[0]] = round(100 - necessario[cands[1]], 1)
            else:
                x = (vb - va + restante_votos) / 2
                necessario[cands[0]] = round(100 * x / restante_votos, 1)
                necessario[cands[1]] = round(100 - necessario[cands[0]], 1)
            if abs(va - vb) > restante_votos and (va or vb):
                definido_mat = cands[0] if va > vb else cands[1]
        elif tot_secoes_total and (va or vb):
            definido_mat = cands[0] if va > vb else cands[1]
    if tot_secoes == tot_secoes_total:  # nada começou (ou nada de base)
        necessario = {c: 50.0 for c in cands}
        definido_mat = None

    return {
        "schema": 1,
        "atualizado_em": atualizado_em,
        "base": {
            "eleicao": base.eleicao,
            "descricao": "comparecimento e votos válidos do 1º turno",
        },
        "cands": cands,
        "restante": {
            "votos_est": restante_votos,
            "secoes": tot_secoes,
            "pct_secoes": round(100 * tot_secoes / tot_secoes_total, 1)
            if tot_secoes_total
            else 100.0,
            "municipios_abertos": abertos,
        },
        "necessario": necessario,
        "definido_matematicamente": definido_mat,
        "por_regiao": {r: fechar(d) for r, d in por_regiao.items() if d["secoes_total"]},
        "por_uf": {u: fechar(d) for u, d in sorted(por_uf.items())},
        "maiores_abertos": maiores,
    }


def _titulo(nome: str) -> str:
    minus = {"de", "da", "do", "dos", "das", "e", "d"}
    out = []
    for p in nome.lower().split():
        if "'" in p:
            a, b = p.split("'", 1)
            out.append(a + "'" + b.capitalize())
        else:
            out.append(p if p in minus else p.capitalize())
    return " ".join(out)
