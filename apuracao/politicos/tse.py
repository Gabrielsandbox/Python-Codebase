"""Candidaturas de 2026 e bens declarados (dados abertos do TSE, CSV latin-1 com ';')."""
from __future__ import annotations

import csv
import io
import zipfile
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field

from politicos import RAW_DIR
from politicos.texto import data_iso, nome_proprio, valor_br

# CD_CARGO do TSE -> nome exibido. Vices e suplentes de senador ficam de fora: votou-se na chapa.
CARGOS = {
    "1": "Presidente",
    "3": "Governador",
    "5": "Senador",
    "6": "Deputado federal",
    "7": "Deputado estadual",
    "8": "Deputado distrital",
}

# DS_SIT_TOT_TURNO -> código curto do contrato (docs/POLITICOS.md).
SITUACAO = {
    "ELEITO": "eleito",
    "ELEITO POR QP": "eleito",
    "ELEITO POR MÉDIA": "eleito",
    "2º TURNO": "2turno",
    "NÃO ELEITO": "nao_eleito",
    "SUPLENTE": "suplente",
}


@dataclass
class Candidatura:
    sq: str
    cargo: str
    uf: str
    numero: str
    nome_urna: str
    nome_civil: str
    cpf: str
    nascimento: str | None
    partido: str
    partido_nome: str
    coligacao: str
    composicao: str
    genero: str
    instrucao: str
    ocupacao: str
    situacao: str  # código de SITUACAO ou "" (sem resultado: indeferida, renúncia…)
    turno2: bool = False
    bens: list[dict] = field(default_factory=list)

    @property
    def bens_total(self) -> float:
        return round(sum(b["valor"] for b in self.bens), 2)


def _linhas(zip_nome: str, sufixo: str = "BRASIL") -> Iterator[dict[str, str]]:
    with zipfile.ZipFile(RAW_DIR / zip_nome) as z:
        nome = next(n for n in z.namelist() if n.endswith(f"_{sufixo}.csv"))
        with z.open(nome) as f:
            yield from csv.DictReader(io.TextIOWrapper(f, "latin-1"), delimiter=";")


def _limpo(v: str) -> str:
    return "" if v in ("#NULO", "#NE", "NÃO DIVULGÁVEL", "-1", "-3") else v.strip()


def carregar_candidaturas() -> dict[str, Candidatura]:
    """SQ_CANDIDATO -> Candidatura (1º e 2º turno fundidos numa só)."""
    cands: dict[str, Candidatura] = {}
    for r in _linhas("consulta_cand_2026.zip"):
        if r["CD_CARGO"] not in CARGOS:
            continue
        sq = r["SQ_CANDIDATO"]
        sit = SITUACAO.get(r["DS_SIT_TOT_TURNO"], "")
        if sq in cands:
            # linha do 2º turno: só substitui a situação quando o TSE já totalizou
            if r["NR_TURNO"] == "2":
                cands[sq].turno2 = True
                if sit:
                    cands[sq].situacao = sit
            elif sit:
                cands[sq].situacao = cands[sq].situacao or sit
            continue
        cands[sq] = Candidatura(
            sq=sq,
            cargo=r["CD_CARGO"],
            uf=r["SG_UF"],
            numero=r["NR_CANDIDATO"],
            nome_urna=nome_proprio(r["NM_URNA_CANDIDATO"]),
            nome_civil=nome_proprio(r["NM_CANDIDATO"]),
            cpf=_limpo(r["NR_CPF_CANDIDATO"]),
            nascimento=data_iso(r["DT_NASCIMENTO"]),
            partido=r["SG_PARTIDO"],
            partido_nome=nome_proprio(r["NM_PARTIDO"]),
            # NM_COLIGACAO vem "FEDERAÇÃO"/"PARTIDO ISOLADO" quando não há nome de coligação
            coligacao="" if r["NM_COLIGACAO"] in ("FEDERAÇÃO", "PARTIDO ISOLADO") else _limpo(r["NM_COLIGACAO"]),
            composicao="" if r["TP_AGREMIACAO"] == "PARTIDO ISOLADO" else _limpo(r["DS_COMPOSICAO_COLIGACAO"]),
            genero=_limpo(r["DS_GENERO"]).capitalize(),
            instrucao=_limpo(r["DS_GRAU_INSTRUCAO"]).capitalize(),
            ocupacao=_limpo(r["DS_OCUPACAO"]).capitalize(),
            situacao=sit,
            turno2=r["NR_TURNO"] == "2",
        )
        if r["NR_TURNO"] == "1" and sit == "2turno":
            cands[sq].turno2 = True

    bens: dict[str, list[dict]] = defaultdict(list)
    for r in _linhas("bem_candidato_2026.zip"):
        if r["SQ_CANDIDATO"] in cands:
            bens[r["SQ_CANDIDATO"]].append({
                "tipo": r["DS_TIPO_BEM_CANDIDATO"].strip(),
                "descricao": r["DS_BEM_CANDIDATO"].strip(),
                "valor": valor_br(r["VR_BEM_CANDIDATO"]),
            })
    for sq, lista in bens.items():
        cands[sq].bens = sorted(lista, key=lambda b: -b["valor"])
    return cands
