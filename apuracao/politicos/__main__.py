"""CLI: ``python -m politicos baixar | gerar | tudo`` (rodar a partir de ``apuracao/``)."""
from __future__ import annotations

import asyncio
import logging

import typer

app = typer.Typer(help="Ficha pública dos políticos (Câmara, Senado, TSE).", no_args_is_help=True)


def _log() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)


@app.command()
def baixar(forcar: bool = typer.Option(False, "--forcar", help="baixa de novo o que já existe")) -> None:
    """Baixa as fontes para data/politicos/raw (idempotente)."""
    from politicos.baixar import baixar as _baixar

    _log()
    asyncio.run(_baixar(forcar=forcar))


@app.command()
def gerar() -> None:
    """Cruza as fontes e publica indice.json + p/{id}.json."""
    from politicos.gerar import gerar as _gerar

    _log()
    _gerar()


@app.command()
def tudo(forcar: bool = typer.Option(False, "--forcar")) -> None:
    """baixar + gerar (é o que roda uma vez por dia)."""
    baixar(forcar)
    gerar()


app()
