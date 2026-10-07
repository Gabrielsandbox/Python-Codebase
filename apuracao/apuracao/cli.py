"""CLI: ``apuracao eleicoes | snapshot | coletar | servir``."""

from __future__ import annotations

import asyncio
import logging
import os
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
        base_1turno=RAIZ / "data" / "ref" / "base-1turno.json",
        site_url=os.environ.get("APURACAO_SITE_URL", ""),
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


@app.command(name="base-1turno")
def base_1turno(
    eleicao: str = typer.Option("6257", help="Código da eleição do 1º turno já totalizada"),
    cargo: str = "1",
) -> None:
    """Gera data/ref/base-1turno.json (seções, válidos e votos dos finalistas por município),
    a referência do "caminho para a vitória". Rode depois de `apuracao snapshot --eleicao 6257`."""
    import orjson

    from .publish.caminho import construir_base

    st = storage_mod.LocalStorage(RAIZ / "data" / "latest")
    pref = f"{eleicao}/{cargo}"
    meta, mun, br = (st.read_json(f"{pref}/{n}.json") for n in ("meta", "mun", "br"))
    if not (meta and mun and br):
        raise typer.BadParameter(
            f"snapshot incompleto em data/latest/{pref}; rode `apuracao snapshot` antes"
        )
    doc = construir_base(meta, mun, br)  # type: ignore[arg-type]
    out = RAIZ / "data" / "ref" / "base-1turno.json"
    out.write_bytes(orjson.dumps(doc))
    console.print(
        f"[green]ok[/] {out} — {len(doc['por_mun'])} municípios, finalistas: "
        + " × ".join(doc["candidatos"].values())
    )


@app.command()
def simular(
    origem: str = typer.Option("6257", help="Eleição de origem (snapshot completo em data/latest)"),
    destino: str = typer.Option("6258", help="Código que o site vai enxergar como ativo"),
    duracao: float = typer.Option(90.0, help="minutos simulados de apuração"),
    velocidade: float = typer.Option(6.0, help="minutos simulados por segundo real"),
    tick: float = typer.Option(10.0, help="segundos reais entre publicações"),
    cargo: str = "1",
    verbose: bool = False,
) -> None:
    """Ensaio geral: reproduz uma noite de apuração com os dados do 1º turno (não é previsão)."""
    from .simulador import Simulador

    _log(verbose)
    origem_st = storage_mod.LocalStorage(RAIZ / "data" / "latest")
    sim = Simulador(
        origem_st,
        storage_mod.from_env(str(RAIZ / "data" / "latest")),
        prefixo_origem=f"{origem}/{cargo}",
        codigo_destino=destino,
        duracao_min=duracao,
        velocidade=velocidade,
        tick_s=tick,
        ref_municipios=RAIZ / "data" / "ref" / "tse-municipios-2026.json",
        base_1turno=RAIZ / "data" / "ref" / "base-1turno.json",
    )
    try:
        asyncio.run(sim.rodar())
    except KeyboardInterrupt:
        pass


@app.command()
def servir(host: str = "0.0.0.0", port: int = 8000, reload: bool = False) -> None:
    """Sobe a API/arquivos estáticos locais (desenvolvimento)."""
    import uvicorn

    uvicorn.run("apuracao.api.app:app", host=host, port=port, reload=reload)


if __name__ == "__main__":
    app()
