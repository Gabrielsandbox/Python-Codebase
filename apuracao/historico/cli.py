"""CLI: `python -m historico <comando>` (rodar a partir de `apuracao/`)."""
from __future__ import annotations

import json

import typer
from rich.console import Console
from rich.table import Table

from historico import TABELAS
from historico.catalogo import listar_recursos, tamanho_remoto

app = typer.Typer(help="Acervo histórico de resultados eleitorais (TSE dados abertos).", no_args_is_help=True)
consulta_app = typer.Typer(help="Consultas ao lake Parquet.", no_args_is_help=True)
app.add_typer(consulta_app, name="consulta")
console = Console()
err = Console(stderr=True)


def _mb(n: int | None) -> str:
    return "-" if n is None else f"{n / 1e6:,.1f} MB"


def _imprimir(linhas: list[dict], como_json: bool, titulo: str = "") -> None:
    if como_json:
        console.print_json(json.dumps(linhas, ensure_ascii=False, default=str))
        return
    if not linhas:
        console.print("[yellow]sem resultados[/]")
        return
    t = Table(title=titulo or None, show_lines=False)
    for c in linhas[0]:
        t.add_column(str(c))
    for l in linhas:
        t.add_row(*["" if v is None else str(v) for v in l.values()])
    console.print(t)


@app.command()
def catalogo(
    ano: int,
    sufixo: str | None = typer.Option(None, help="ex.: boletim-de-urna -> resultados-ANO-boletim-de-urna"),
    tamanhos: bool = typer.Option(False, "--tamanhos", help="faz HEAD em cada ZIP para obter o tamanho real"),
    so_conhecidas: bool = typer.Option(False, "--so-conhecidas", help="só recursos mapeados em TABELAS"),
    forcar: bool = typer.Option(False, "--forcar", help="ignora o cache do catálogo"),
    como_json: bool = typer.Option(False, "--json"),
):
    """Lista os recursos do dataset resultados-ANO no CKAN do TSE."""
    try:
        recs = listar_recursos(ano, sufixo=sufixo, forcar=forcar)
    except LookupError as e:
        err.print(f"[red]{e}[/]")
        raise typer.Exit(1)
    linhas = []
    for r in recs:
        if so_conhecidas and not r.tabela:
            continue
        d = r.para_dict()
        if tamanhos:
            tam, existe = tamanho_remoto(r.url)
            d["tamanho"] = tam if existe else "404"
        linhas.append(d)
    if como_json:
        _imprimir(linhas, True)
        return
    t = Table(title=f"resultados-{ano}{'-' + sufixo if sufixo else ''}: {len(linhas)} recursos")
    t.add_column("tabela"); t.add_column("nome"); t.add_column("formato"); t.add_column("tamanho", justify="right"); t.add_column("url")
    for d in linhas:
        tam = d["tamanho"]
        t.add_row(d["tabela"] or "", d["nome"], str(d["formato"]), tam if isinstance(tam, str) else _mb(tam), d["url"])
    console.print(t)
    console.print("[dim]Obs.: o CKAN do TSE não informa tamanho; use --tamanhos para consultar o CDN.[/]")


@app.command()
def baixar(
    ano: int,
    tabela: str = typer.Option("votacao_candidato_munzona", help=f"uma de {sorted(TABELAS)}"),
    uf: str | None = typer.Option(None, help="UF para tabelas por UF (votacao_secao)"),
    max_mb: float | None = typer.Option(None, "--max-mb", help="aborta se o arquivo passar deste tamanho"),
):
    """Baixa o ZIP da tabela para data/historico/raw/ANO/ (idempotente, retomável)."""
    from rich.progress import (
        BarColumn,
        DownloadColumn,
        Progress,
        TimeRemainingColumn,
        TransferSpeedColumn,
    )

    from historico.download import LimiteExcedido, baixar_tabela

    if tabela not in TABELAS:
        err.print(f"[red]tabela desconhecida: {tabela}. Opções: {sorted(TABELAS)}[/]")
        raise typer.Exit(2)
    if TABELAS[tabela]["por_uf"] and not uf:
        err.print("[red]esta tabela exige --uf[/]")
        raise typer.Exit(2)
    with Progress("[progress.description]{task.description}", BarColumn(), DownloadColumn(), TransferSpeedColumn(), TimeRemainingColumn(), console=err) as prog:
        tarefa = prog.add_task(f"{tabela} {ano}", total=None)

        def cb(feito: int, total: int | None) -> None:
            prog.update(tarefa, completed=feito, total=total)

        try:
            rec, res = baixar_tabela(ano, tabela, uf=uf, max_mb=max_mb, progresso=cb)
        except LimiteExcedido as e:
            err.print(f"[red]{e}[/]")
            raise typer.Exit(3)
        except FileNotFoundError as e:
            err.print(f"[red]{e}[/]")
            raise typer.Exit(4)
    estado = "já existia (pulado)" if res.pulado else f"baixado em {res.segundos:.1f}s"
    console.print(f"[green]{rec.url}[/] -> {res.caminho} ({_mb(res.bytes_total)}; {estado})")


@app.command()
def etl(
    ano: int,
    tabela: str = typer.Option("votacao_candidato_munzona", help=f"uma de {sorted(TABELAS)}"),
    uf: str | None = typer.Option(None),
    threads: int | None = typer.Option(None),
    memoria: str | None = typer.Option(None, help="ex.: 4GB (memory_limit do DuckDB)"),
    ignorar_erros: bool = typer.Option(False, "--ignorar-erros", help="read_csv(ignore_errors=true)"),
    como_json: bool = typer.Option(False, "--json"),
):
    """Converte o ZIP baixado em Parquet particionado (ano=/turno=)."""
    from historico.etl import executar_etl

    try:
        r = executar_etl(ano, tabela, uf=uf, threads=threads, memoria=memoria, ignorar_erros=ignorar_erros)
    except FileNotFoundError as e:
        err.print(f"[red]{e}[/]")
        raise typer.Exit(4)
    if como_json:
        console.print_json(json.dumps(r.para_dict(), ensure_ascii=False))
        return
    console.print(f"[green]{tabela} {ano}[/]: {r.linhas:,} linhas, {r.colunas} colunas, {len(r.particoes)} partições em {r.segundos:.1f}s")
    for p in r.particoes:
        console.print(f"  ano={p['ano']} turno={p['turno']}: {p['linhas']:,} linhas -> {p['caminho']}")
    if r.colunas_ausentes:
        console.print(f"  [yellow]colunas ausentes neste ano (criadas como NULL):[/] {', '.join(r.colunas_ausentes)}")
    if r.sem_ibge:
        console.print(f"  [yellow]{r.sem_ibge:,} linhas sem código IBGE (municípios extintos/exterior)[/]")


@app.command()
def pipeline(
    ano: int,
    tabela: str = typer.Option("votacao_candidato_munzona"),
    max_mb: float | None = typer.Option(None, "--max-mb"),
    threads: int | None = typer.Option(None),
    memoria: str | None = typer.Option(None),
):
    """baixar + etl em um passo (um comando por ano no backfill)."""
    baixar(ano, tabela=tabela, uf=None, max_mb=max_mb)
    etl(ano, tabela=tabela, uf=None, threads=threads, memoria=memoria, ignorar_erros=False, como_json=False)


@app.command()
def particoes(como_json: bool = typer.Option(False, "--json")):
    """Mostra as partições (ano/turno) presentes no lake."""
    from historico.consulta import particoes_disponiveis

    linhas = [{"tabela": t, "ano": a, "turno": tr} for t in TABELAS for a, tr in particoes_disponiveis(t)]
    _imprimir(linhas, como_json, "partições")


@consulta_app.command("municipio")
def consulta_municipio(
    ano: int,
    turno: int,
    cargo: str = typer.Argument(..., help="código (1=Presidente, 3=Governador, 11=Prefeito...) ou nome"),
    uf: str | None = typer.Option(None),
    ibge: str | None = typer.Option(None, help="código IBGE de 7 dígitos"),
    tse: str | None = typer.Option(None, help="código TSE de 5 dígitos"),
    limite: int | None = typer.Option(50),
    como_json: bool = typer.Option(False, "--json"),
):
    """Votos por candidato em cada município para ano/turno/cargo."""
    from historico.consulta import resultado_por_municipio

    linhas = resultado_por_municipio(ano, turno, cargo, uf=uf, cd_ibge=ibge, cd_municipio=tse, limite=limite)
    _imprimir(linhas, como_json, f"resultado por município — {ano} t{turno} cargo={cargo}")


@consulta_app.command("serie")
def consulta_serie(
    ibge: str,
    cargo: str,
    turno: int | None = typer.Option(None),
    top: int = typer.Option(3),
    como_json: bool = typer.Option(False, "--json"),
):
    """Série histórica (todos os anos do lake) de um município para um cargo."""
    from historico.consulta import serie_historica_municipio

    _imprimir(serie_historica_municipio(ibge, cargo, turno=turno, top=top), como_json, f"série {ibge} cargo={cargo}")


@consulta_app.command("detalhe")
def consulta_detalhe(
    ano: int,
    turno: int,
    cargo: str,
    uf: str | None = typer.Option(None),
    ibge: str | None = typer.Option(None),
    como_json: bool = typer.Option(False, "--json"),
):
    """Aptos/comparecimento/abstenção/brancos/nulos por município."""
    from historico.consulta import detalhe_municipio

    _imprimir(detalhe_municipio(ano, turno, cargo, cd_ibge=ibge, uf=uf), como_json, "detalhe")


@consulta_app.command("sql")
def consulta_sql(query: str, como_json: bool = typer.Option(False, "--json")):
    """SQL livre; views disponíveis: votacao_candidato_munzona, detalhe_votacao_munzona, ..."""
    from historico.consulta import sql

    _imprimir(sql(query), como_json)


if __name__ == "__main__":
    app()
