"""Construção das URLs do serviço de resultados do TSE.

Layout observado (2022–2026), base ``https://resultados.tse.jus.br/oficial``:

- ``comum/config/ele-c.json`` — catálogo de pleitos/eleições (códigos, datas, cargos).
- ``{ciclo}/{eleicao}/config/mun-e{eleicao:06}-cm.json`` — municípios por UF (código TSE,
  código IBGE, nome, capital, zonas).
- ``{ciclo}/{eleicao}/dados/{uf}/{uf}{mun}-c{cargo:04}-e{eleicao:06}-u.json`` — resultado
  totalizado de um município (``mun`` = código TSE de 5 dígitos).
- ``{ciclo}/{eleicao}/dados/{uf}/{uf}-c{cargo:04}-e{eleicao:06}-u.json`` — resultado de uma UF.
- ``{ciclo}/{eleicao}/dados/br/br-c{cargo:04}-e{eleicao:06}-u.json`` — resultado nacional.

``ciclo`` é ``ele2026``; ``eleicao`` é o código numérico (ex.: 6257 = 1º turno presidencial
2026, 6258 = 2º turno). ``uf`` é a sigla em minúsculas; ``zz`` é o exterior.
"""

from __future__ import annotations

BASE = "https://resultados.tse.jus.br/oficial"


def config_eleicoes() -> str:
    return f"{BASE}/comum/config/ele-c.json"


def config_municipios(ciclo: str, eleicao: str | int) -> str:
    return f"{BASE}/{ciclo}/{eleicao}/config/mun-e{int(eleicao):06d}-cm.json"


def resultado(
    ciclo: str,
    eleicao: str | int,
    cargo: str | int,
    uf: str,
    municipio: str | None = None,
) -> str:
    """URL do JSON de resultado (``-u.json``) para BR, UF ou município."""
    uf = uf.lower()
    abr = f"{uf}{municipio}" if municipio else uf
    return f"{BASE}/{ciclo}/{eleicao}/dados/{uf}/{abr}-c{int(cargo):04d}-e{int(eleicao):06d}-u.json"


def resultado_br(ciclo: str, eleicao: str | int, cargo: str | int) -> str:
    return resultado(ciclo, eleicao, cargo, "br")
