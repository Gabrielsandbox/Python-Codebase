"""Gera os snapshots do contrato (docs/SCHEMA.md) a partir de :class:`Resultado` normalizados."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from ..tse.eleicoes import Eleicao, Municipio
from ..tse.parse import BRT, Resultado

SCHEMA = 1

# Paleta neutra (sem conotação partidária), atribuída pela ordem de ``cands``.
PALETA = ["#1d4ed8", "#ea580c", "#059669", "#7c3aed", "#db2777", "#ca8a04", "#0891b2", "#4b5563"]

UF_NOMES = {
    "AC": "Acre",
    "AL": "Alagoas",
    "AP": "Amapá",
    "AM": "Amazonas",
    "BA": "Bahia",
    "CE": "Ceará",
    "DF": "Distrito Federal",
    "ES": "Espírito Santo",
    "GO": "Goiás",
    "MA": "Maranhão",
    "MT": "Mato Grosso",
    "MS": "Mato Grosso do Sul",
    "MG": "Minas Gerais",
    "PA": "Pará",
    "PB": "Paraíba",
    "PR": "Paraná",
    "PE": "Pernambuco",
    "PI": "Piauí",
    "RJ": "Rio de Janeiro",
    "RN": "Rio Grande do Norte",
    "RS": "Rio Grande do Sul",
    "RO": "Rondônia",
    "RR": "Roraima",
    "SC": "Santa Catarina",
    "SP": "São Paulo",
    "SE": "Sergipe",
    "TO": "Tocantins",
    "ZZ": "Exterior",
}
UF_IBGE = {
    "RO": "11",
    "AC": "12",
    "AM": "13",
    "RR": "14",
    "PA": "15",
    "AP": "16",
    "TO": "17",
    "MA": "21",
    "PI": "22",
    "CE": "23",
    "RN": "24",
    "PB": "25",
    "PE": "26",
    "AL": "27",
    "SE": "28",
    "BA": "29",
    "MG": "31",
    "ES": "32",
    "RJ": "33",
    "SP": "35",
    "PR": "41",
    "SC": "42",
    "RS": "43",
    "MS": "50",
    "MT": "51",
    "GO": "52",
    "DF": "53",
}


def agora_iso() -> str:
    return datetime.now(BRT).replace(microsecond=0).isoformat()


def ordem_candidatos(res: Resultado) -> list[str]:
    """Ordem canônica: número de urna crescente (estável durante toda a apuração)."""
    return [c.id for c in sorted(res.candidatos, key=lambda c: (int(c.numero or 0), c.seq))]


def build_meta(eleicao: Eleicao, cargo: str, br: Resultado, cands: list[str]) -> dict:
    por_id = {c.id: c for c in br.candidatos}
    return {
        "schema": SCHEMA,
        "eleicao": eleicao.codigo,
        "pleito": eleicao.pleito,
        "ciclo": eleicao.ciclo,
        "turno": eleicao.turno,
        "cargo": cargo,
        "cargo_nome": br.cargo_nome
        or next((c.nome for c in eleicao.cargos if c.codigo == cargo), ""),
        "data_eleicao": eleicao.data.isoformat(),
        "atualizado_em": br.gerado_em or agora_iso(),
        "cands": cands,
        "candidatos": {
            cid: {
                "numero": por_id[cid].numero,
                "nome": por_id[cid].nome,
                "nome_completo": por_id[cid].nome_completo,
                "partido": por_id[cid].partido,
                "coligacao": por_id[cid].coligacao,
                "vice": por_id[cid].vice,
                "cor": PALETA[i % len(PALETA)],
                "foto": None,
            }
            for i, cid in enumerate(cands)
            if cid in por_id
        },
    }


def _bloco(res: Resultado, cands: list[str]) -> dict:
    por_id = {c.id: c for c in res.candidatos}
    v = [por_id[c].votos if c in por_id else 0 for c in cands]
    pct = [por_id[c].pct if c in por_id else 0.0 for c in cands]
    lider = res.lider
    return {
        "secoes": {
            "total": res.secoes_total,
            "totalizadas": res.secoes_totalizadas,
            "pct": res.secoes_pct,
        },
        "eleitorado": {
            "aptos": res.aptos,
            "comparecimento": res.comparecimento,
            "abstencao": res.abstencao,
            "pct_comparecimento": res.pct_comparecimento,
            "pct_abstencao": res.pct_abstencao,
        },
        "votos": {
            "total": res.votos_total,
            "validos": res.validos,
            "brancos": res.brancos,
            "nulos": res.nulos,
            "pct_validos": res.pct_validos,
            "pct_brancos": res.pct_brancos,
            "pct_nulos": res.pct_nulos,
        },
        "v": v,
        "pct": pct,
        "lider": lider.id if lider and lider.votos > 0 else None,
        "margem_votos": res.margem_votos,
        "margem_pct": res.margem_pct,
        "situacao": {c.id: c.situacao for c in res.candidatos},
        "definido": res.definido,
    }


def build_nivel(res: Resultado, cands: list[str], *, nivel: str, codigo: str, nome: str) -> dict:
    return {
        "schema": SCHEMA,
        "nivel": nivel,
        "codigo": codigo,
        "nome": nome,
        "atualizado_em": res.gerado_em or agora_iso(),
        "cands": cands,
        **_bloco(res, cands),
    }


def build_br(br: Resultado, cands: list[str]) -> dict:
    return build_nivel(br, cands, nivel="br", codigo="br", nome="Brasil")


def build_uf(ufs: dict[str, Resultado], cands: list[str], atualizado_em: str) -> dict:
    out: dict[str, dict] = {}
    for sigla, res in sorted(ufs.items()):
        out[sigla] = {
            "nome": UF_NOMES.get(sigla, sigla),
            "ibge": UF_IBGE.get(sigla),
            **_bloco(res, cands),
        }
    return {"schema": SCHEMA, "atualizado_em": atualizado_em, "cands": cands, "ufs": out}


CAMPOS_MUN = [
    "ibge",
    "uf",
    "secoes_total",
    "secoes_totalizadas",
    "aptos",
    "comparecimento",
    "validos",
    "brancos",
    "nulos",
    "v",
]


def build_mun(
    muns: dict[str, tuple[Municipio, Resultado]], cands: list[str], atualizado_em: str
) -> dict:
    linhas = []
    for _tse, (m, res) in sorted(muns.items(), key=lambda kv: (kv[1][0].uf, kv[1][0].ibge)):
        por_id = {c.id: c for c in res.candidatos}
        linhas.append(
            [
                m.ibge or None,
                m.uf,
                res.secoes_total,
                res.secoes_totalizadas,
                res.aptos,
                res.comparecimento,
                res.validos,
                res.brancos,
                res.nulos,
                [por_id[c].votos if c in por_id else 0 for c in cands],
            ]
        )
    return {
        "schema": SCHEMA,
        "atualizado_em": atualizado_em,
        "cands": cands,
        "campos": CAMPOS_MUN,
        "linhas": linhas,
    }


@dataclass
class Timeline:
    cands: list[str]
    pontos: list[dict] = field(default_factory=list)
    ultimo_idg: str | None = None

    def adicionar(self, res: Resultado) -> bool:
        if res.idg == self.ultimo_idg:
            return False
        self.ultimo_idg = res.idg
        por_id = {c.id: c for c in res.candidatos}
        self.pontos.append(
            {
                "t": res.gerado_em or agora_iso(),
                "secoes_pct": res.secoes_pct,
                "v": [por_id[c].votos if c in por_id else 0 for c in self.cands],
                "pct": [por_id[c].pct if c in por_id else 0.0 for c in self.cands],
            }
        )
        return True

    def to_dict(self) -> dict:
        return {"schema": SCHEMA, "cands": self.cands, "pontos": self.pontos}

    @classmethod
    def from_dict(cls, d: dict | None, cands: list[str]) -> Timeline:
        if not d or d.get("cands") != cands:
            return cls(cands)
        t = cls(cands, list(d.get("pontos") or []))
        return t


def build_status(
    *,
    ultima_coleta: str,
    ultima_mudanca: str | None,
    idg: str | None,
    ciclo_ms: int,
    erros: int,
    municipios: int,
) -> dict:
    return {
        "schema": SCHEMA,
        "ultima_coleta": ultima_coleta,
        "ultima_mudanca": ultima_mudanca,
        "fonte_idg": idg,
        "ciclo_ms": ciclo_ms,
        "erros_ciclo": erros,
        "municipios_coletados": municipios,
    }
