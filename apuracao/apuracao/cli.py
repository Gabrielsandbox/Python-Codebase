"""CLI: ``apuracao eleicoes | snapshot | coletar | servir``."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from . import storage as storage_mod
from .collector import Collector, Config
from .tse.client import TSEClient
from .tse.eleicoes import carregar_catalogo

app = typer.Typer(help="Apuração em tempo real (TSE) — coletor e publicador de snapshots.")
console = Console()

RAIZ = Path(__file__).resolve().parent.parent


def _log(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)


@app.command()
def eleicoes(ano: int = typer.Option(2026, help="Filtra pelo ano")) -> None:
    """Lista as eleições do catálogo oficial do TSE (ele-c.json)."""

    async def _run() -> None:
        async with TSEClient() as c:
            cat = await carregar_catalogo(c)
        t = Table(title=f"Eleições {ano} no catálogo do TSE")
        for col in ("código", "2º turno", "ciclo", "turno", "data", "nome", "cargos"):
            t.add_column(col)
        for e in cat:
            if e.data.year != ano:
                continue
            t.add_row(
                e.codigo,
                e.codigo_2turno or "-",
                e.ciclo,
                str(e.turno),
                e.data.isoformat(),
                e.nome,
                ", ".join(f"{c.codigo}={c.nome}" for c in e.cargos),
            )
        console.print(t)

    asyncio.run(_run())


def _config(
    ano: int,
    turno: int,
    cargo: str,
    eleicao: str | None,
    raw: bool,
    intervalo_rapido: float,
    intervalo_mun: float,
    rate: float,
    concurrency: int,
) -> Config:
    return Config(
        ano=ano,
        turno=turno,
        cargo=cargo,
        eleicao_codigo=eleicao,
        intervalo_rapido=intervalo_rapido,
        intervalo_mun=intervalo_mun,
        rate_per_s=rate,
        concurrency=concurrency,
        raw_dir=(RAIZ / "data" / "raw") if raw else None,
        ref_municipios=RAIZ / "data" / "ref" / "tse-municipios-2026.json",
    )


@app.command()
def snapshot(
    ano: int = 2026,
    turno: int = 2,
    cargo: str = "1",
    eleicao: str | None = typer.Option(None, help="Força o código da eleição (ex.: 6257)"),
    raw: bool = typer.Option(True, help="Guarda os JSONs brutos que mudaram em data/raw"),
    rate: float = 150.0,
    concurrency: int = 40,
    verbose: bool = False,
) -> None:
    """Executa um ciclo completo (BR + UFs + municípios) e publica os snapshots uma vez."""
    _log(verbose)
    cfg = _config(ano, turno, cargo, eleicao, raw, 10, 60, rate, concurrency)
    col = Collector(cfg, storage_mod.from_env(str(RAIZ / "data" / "latest")))
    asyncio.run(col.uma_vez())


@app.command()
def coletar(
    ano: int = 2026,
    turno: int = 2,
    cargo: str = "1",
    eleicao: str | None = typer.Option(None, help="Força o código da eleição (ex.: 6257)"),
    raw: bool = True,
    intervalo_rapido: float = typer.Option(10.0, help="segundos entre ciclos BR/UF"),
    intervalo_mun: float = typer.Option(60.0, help="segundos entre ciclos municipais"),
    rate: float = 150.0,
    concurrency: int = 40,
    verbose: bool = False,
) -> None:
    """Loop contínuo de coleta e publicação (use no dia da apuração)."""
    _log(verbose)
    cfg = _config(
        ano, turno, cargo, eleicao, raw, intervalo_rapido, intervalo_mun, rate, concurrency
    )
    col = Collector(cfg, storage_mod.from_env(str(RAIZ / "data" / "latest")))
    try:
        asyncio.run(col.rodar())
    except KeyboardInterrupt:
        col.parar()


@app.command()
def servir(host: str = "0.0.0.0", port: int = 8000, reload: bool = False) -> None:
    """Sobe a API/arquivos estáticos locais (desenvolvimento)."""
    import uvicorn

    uvicorn.run("apuracao.api.app:app", host=host, port=port, reload=reload)


if __name__ == "__main__":
    app()
