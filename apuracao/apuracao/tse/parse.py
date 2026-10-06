"""Normalização dos JSONs ``-u.json`` do TSE para um modelo compacto e tipado.

O TSE entrega tudo como string (``"vap": "56104503"``, ``"pvap": "47,03"``). Aqui convertemos
para inteiros/floats, achatamos a hierarquia ``carg → agr → par → cand`` e extraímos apenas
o que a apuração precisa. Campos observados (2026):

``s``  seções: ``ts`` total, ``st`` totalizadas, ``snt`` não totalizadas, ``si`` instaladas...
``e``  eleitorado: ``te`` aptos, ``c`` comparecimento, ``a`` abstenção (+ percentuais ``pc``/``pa``).
``v``  votos: ``tv`` total, ``vv`` válidos, ``vb`` brancos, ``tvn`` nulos (``vn`` nulos + ``vnt``
       nulos técnicos), ``vnom`` nominais, ``van`` anulados sub judice, ``vansj``...
``carg[].agr[].par[].cand[]`` candidatos: ``sqcand`` id, ``n`` número, ``nm`` nome completo,
       ``nmu`` nome de urna, ``vap`` votos, ``pvap`` % válidos, ``e`` ("s" eleito), ``st`` situação,
       ``vs[]`` vice/suplentes.
Cabeçalho: ``ele`` eleição, ``t`` turno, ``tpabr`` nível (br/uf/mu), ``cdabr`` código,
       ``dg``/``hg`` data/hora de geração, ``idg`` id de geração (muda a cada totalização).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

BRT = timezone(timedelta(hours=-3), name="America/Sao_Paulo")


def _int(v: object, default: int = 0) -> int:
    if v is None or v == "":
        return default
    try:
        return int(str(v).replace(".", ""))
    except ValueError:
        return default


def _pct(v: object) -> float:
    """``"47,03"`` → ``47.03``; aceita também a variante numérica ``pvapn``."""
    if v is None or v == "":
        return 0.0
    try:
        return round(float(str(v).replace(",", ".")), 2)
    except ValueError:
        return 0.0


def to_iso_brt(dg: str | None, hg: str | None) -> str | None:
    """``("05/10/2026", "12:51:47")`` → ``"2026-10-05T12:51:47-03:00"``."""
    if not dg or not hg:
        return None
    try:
        dt = datetime.strptime(f"{dg} {hg}", "%d/%m/%Y %H:%M:%S").replace(tzinfo=BRT)
    except ValueError:
        return None
    return dt.isoformat()


@dataclass(slots=True)
class Candidato:
    id: str  # sqcand
    numero: str
    nome: str  # nome de urna
    nome_completo: str
    partido: str
    coligacao: str
    vice: str | None
    votos: int
    pct: float
    eleito: bool
    situacao: str
    seq: int


@dataclass(slots=True)
class Resultado:
    eleicao: str
    turno: int
    cargo: str
    cargo_nome: str
    nivel: str  # br | uf | mu
    codigo: str  # br | sigla | código TSE do município
    uf: str | None
    gerado_em: str | None
    idg: str
    secoes_total: int
    secoes_totalizadas: int
    secoes_pct: float
    aptos: int
    comparecimento: int
    abstencao: int
    pct_comparecimento: float
    pct_abstencao: float
    votos_total: int
    validos: int
    brancos: int
    nulos: int
    pct_validos: float
    pct_brancos: float
    pct_nulos: float
    candidatos: list[Candidato] = field(default_factory=list)
    municipios_nao_apurados: list[str] = field(default_factory=list)

    @property
    def lider(self) -> Candidato | None:
        if not self.candidatos:
            return None
        return max(self.candidatos, key=lambda c: c.votos)

    @property
    def margem_votos(self) -> int:
        if len(self.candidatos) < 2:
            return self.lider.votos if self.lider else 0
        v = sorted((c.votos for c in self.candidatos), reverse=True)
        return v[0] - v[1]

    @property
    def margem_pct(self) -> float:
        if len(self.candidatos) < 2:
            return self.lider.pct if self.lider else 0.0
        p = sorted((c.pct for c in self.candidatos), reverse=True)
        return round(p[0] - p[1], 2)

    @property
    def definido(self) -> bool:
        return any(c.eleito for c in self.candidatos)


def parse_resultado(doc: dict, uf_hint: str | None = None) -> Resultado:
    """Converte um documento ``-u.json`` do TSE em :class:`Resultado`."""
    s = doc.get("s") or {}
    e = doc.get("e") or {}
    v = doc.get("v") or {}
    cargs = doc.get("carg") or []
    carg = cargs[0] if cargs else {}

    cands: list[Candidato] = []
    for agr in carg.get("agr") or []:
        coligacao = agr.get("com") or agr.get("nm") or ""
        for par in agr.get("par") or []:
            for c in par.get("cand") or []:
                vices = [
                    x.get("nmu") or x.get("nm") for x in (c.get("vs") or []) if x.get("tp") == "v"
                ]
                cands.append(
                    Candidato(
                        id=str(c.get("sqcand") or c.get("n")),
                        numero=str(c.get("n") or ""),
                        nome=c.get("nmu") or c.get("nm") or "",
                        nome_completo=c.get("nm") or c.get("nmu") or "",
                        partido=par.get("sg") or "",
                        coligacao=coligacao,
                        vice=vices[0] if vices else None,
                        votos=_int(c.get("vap")),
                        pct=_pct(c.get("pvap")),
                        eleito=(
                            c.get("e") == "s" and str(c.get("st", "")).lower().startswith("eleit")
                        ),
                        situacao=c.get("st") or "",
                        seq=_int(c.get("seq"), 999),
                    )
                )
    cands.sort(key=lambda c: (-c.votos, c.seq))

    nivel = doc.get("tpabr") or "br"
    codigo = str(doc.get("cdabr") or "br")
    if nivel == "uf":
        uf = codigo.upper()
    elif nivel == "br":
        uf = None
    else:
        uf = (uf_hint or "").upper() or None

    return Resultado(
        eleicao=str(doc.get("ele") or ""),
        turno=_int(doc.get("t"), 1),
        cargo=str(carg.get("cd") or ""),
        cargo_nome=carg.get("nmn") or carg.get("nmm") or "",
        nivel=nivel,
        codigo=codigo,
        uf=uf,
        gerado_em=to_iso_brt(doc.get("dg"), doc.get("hg")),
        idg=str(doc.get("idg") or ""),
        secoes_total=_int(s.get("ts")),
        secoes_totalizadas=_int(s.get("st")),
        secoes_pct=_pct(s.get("pst")),
        aptos=_int(e.get("te")),
        comparecimento=_int(e.get("c")),
        abstencao=_int(e.get("a")),
        pct_comparecimento=_pct(e.get("pc")),
        pct_abstencao=_pct(e.get("pa")),
        votos_total=_int(v.get("tv")),
        validos=_int(v.get("vv")),
        brancos=_int(v.get("vb")),
        nulos=_int(v.get("tvn")) or _int(v.get("vn")),
        pct_validos=_pct(v.get("pvvc")) or _pct(v.get("pvv")),
        pct_brancos=_pct(v.get("pvb")),
        pct_nulos=_pct(v.get("ptvn")) or _pct(v.get("pvn")),
        candidatos=cands,
        municipios_nao_apurados=[str(m) for m in (doc.get("mnae") or [])],
    )
