"""Catálogo de eleições (``ele-c.json``) e de municípios (``mun-e*-cm.json``) do TSE."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from . import urls
from .client import TSEClient


@dataclass(slots=True)
class Cargo:
    codigo: str
    nome: str


@dataclass(slots=True)
class Eleicao:
    codigo: str
    pleito: str
    ciclo: str  # ex.: ele2026
    nome: str
    turno: int
    tipo: str  # tp do TSE: 8=federal, 1=estadual, 3=municipal, 4=suplementar, 7=consulta
    data: date
    codigo_2turno: str | None
    cargos: list[Cargo] = field(default_factory=list)
    abrangencias: list[str] = field(default_factory=list)  # ufs (ou "br")

    def tem_cargo(self, cargo: str | int) -> bool:
        return any(c.codigo == str(cargo) for c in self.cargos)


def parse_catalogo(doc: dict) -> list[Eleicao]:
    out: list[Eleicao] = []
    for pl in doc.get("pl") or []:
        try:
            dt = datetime.strptime(pl.get("dt", ""), "%d/%m/%Y").date()
        except ValueError:
            continue
        for e in pl.get("e") or []:
            cargos: dict[str, Cargo] = {}
            abrs: list[str] = []
            for a in e.get("abr") or []:
                abrs.append(str(a.get("cd")))
                for cp in a.get("cp") or []:
                    cargos.setdefault(
                        str(cp.get("cd")), Cargo(str(cp.get("cd")), cp.get("ds") or "")
                    )
            out.append(
                Eleicao(
                    codigo=str(e.get("cd")),
                    pleito=str(pl.get("cd")),
                    ciclo=pl.get("c") or f"ele{dt.year}",
                    nome=e.get("nm") or "",
                    turno=int(e.get("t") or 1),
                    tipo=str(e.get("tp") or ""),
                    data=dt,
                    codigo_2turno=(e.get("cdt2") or None),
                    cargos=list(cargos.values()),
                    abrangencias=abrs,
                )
            )
    return out


ORDINARIAS = {"8", "1", "3"}  # federal, estadual, municipal


def encontrar(eleicoes: list[Eleicao], *, ano: int, turno: int, cargo: str | int) -> Eleicao | None:
    """Acha a eleição de ``ano``/``turno`` que contém ``cargo`` (ex.: 1 = Presidente)."""
    cands = [e for e in eleicoes if e.data.year == ano and e.turno == turno and e.tem_cargo(cargo)]
    if cands:
        # Prefere eleições ordinárias de abrangência nacional; suplementares (tp 2/4) por último.
        cands.sort(
            key=lambda e: (0 if "br" in e.abrangencias else 1, 0 if e.tipo in ORDINARIAS else 1)
        )
        return cands[0]
    # Em anos cujo 2º turno ainda não está no catálogo, derivamos a partir do 1º turno (cdt2).
    if turno == 2:
        base = encontrar(eleicoes, ano=ano, turno=1, cargo=cargo)
        if base and base.codigo_2turno:
            return Eleicao(
                codigo=base.codigo_2turno,
                pleito=base.pleito,
                ciclo=base.ciclo,
                nome=base.nome.replace("1º Turno", "2º Turno"),
                turno=2,
                tipo=base.tipo,
                data=base.data + timedelta(days=21),  # 2º turno: último domingo de outubro
                codigo_2turno=None,
                cargos=base.cargos,
                abrangencias=base.abrangencias,
            )
    return None


@dataclass(slots=True)
class Municipio:
    tse: str  # 5 dígitos
    ibge: str  # 7 dígitos (cdi)
    uf: str  # sigla maiúscula
    nome: str
    capital: bool
    zonas: list[str] = field(default_factory=list)


def parse_municipios(doc: dict) -> list[Municipio]:
    out: list[Municipio] = []
    for abr in doc.get("abr") or []:
        uf = str(abr.get("cd") or "").upper()
        for mu in abr.get("mu") or []:
            out.append(
                Municipio(
                    tse=str(mu.get("cd")),
                    ibge=str(mu.get("cdi") or ""),
                    uf=uf,
                    nome=mu.get("nm") or "",
                    capital=(mu.get("c") == "s"),
                    zonas=[str(z) for z in (mu.get("z") or [])],
                )
            )
    return out


async def carregar_catalogo(client: TSEClient) -> list[Eleicao]:
    r = await client.fetch(urls.config_eleicoes(), conditional=False)
    if not r.ok or r.body is None:
        raise RuntimeError(f"Falha ao carregar catálogo do TSE: {r.status} {r.error}")
    return parse_catalogo(r.json() or {})


async def carregar_municipios(client: TSEClient, ciclo: str, eleicao: str) -> list[Municipio]:
    r = await client.fetch(urls.config_municipios(ciclo, eleicao), conditional=False)
    if r.status == 404:
        return []
    if not r.ok or r.body is None:
        raise RuntimeError(f"Falha ao carregar municípios: {r.status} {r.error}")
    return parse_municipios(r.json() or {})
