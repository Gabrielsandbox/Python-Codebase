"""Download das fontes para RAW_DIR (idempotente: o que já existe não é baixado de novo).

Arquivos em massa (Câmara e TSE) são preferidos à API: são gerados de madrugada, não caem e
trazem a legislatura inteira em poucas requisições. A API só entra onde não há arquivo:
detalhe de cada deputado em exercício (CPF, redes, gabinete) e tudo do Senado.

Os arquivos baixados são dados NÃO confiáveis: só são lidos como JSON/CSV.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import httpx
import orjson

from politicos import ANOS, ANOS_VOTOS, INICIO_LEGISLATURA, RAW_DIR

log = logging.getLogger(__name__)

CAMARA_ARQ = "https://dadosabertos.camara.leg.br/arquivos"
CAMARA_API = "https://dadosabertos.camara.leg.br/api/v2"
SENADO_API = "https://legis.senado.leg.br/dadosabertos"
TSE_CDN = "https://cdn.tse.jus.br/estatistica/sead/odsele"
_HEADERS = {"User-Agent": "apuracao-politicos/0.1", "Accept": "application/json"}


def arquivos_em_massa() -> dict[str, str]:
    """nome local -> URL."""
    a: dict[str, str] = {"deputados.json": f"{CAMARA_ARQ}/deputados/json/deputados.json"}
    for ano in ANOS:
        for tabela in ("eventos", "eventosPresencaDeputados", "proposicoes", "proposicoesAutores"):
            a[f"{tabela}-{ano}.json"] = f"{CAMARA_ARQ}/{tabela}/json/{tabela}-{ano}.json"
        a[f"Ano-{ano}.json.zip"] = f"https://www.camara.leg.br/cotas/Ano-{ano}.json.zip"
        a[f"despesa_ceaps_{ano}.csv"] = (
            f"https://www.senado.leg.br/transparencia/LAI/verba/despesa_ceaps_{ano}.csv"
        )
    for ano in ANOS_VOTOS:
        for tabela in ("votacoes", "votacoesVotos", "votacoesProposicoes"):
            a[f"{tabela}-{ano}.json"] = f"{CAMARA_ARQ}/{tabela}/json/{tabela}-{ano}.json"
    a["consulta_cand_2026.zip"] = f"{TSE_CDN}/consulta_cand/consulta_cand_2026.zip"
    a["bem_candidato_2026.zip"] = f"{TSE_CDN}/bem_candidato/bem_candidato_2026.zip"
    a["proposta_governo_2026_BR.zip"] = f"{TSE_CDN}/proposta_governo/proposta_governo_2026_BR.zip"
    return a


async def _get(c: httpx.AsyncClient, url: str, tentativas: int = 4) -> bytes:
    espera = 2.0
    for i in range(tentativas):
        try:
            r = await c.get(url)
            if r.status_code < 500:
                r.raise_for_status()
                return r.content
            log.warning("%s -> %s (tentativa %d)", url, r.status_code, i + 1)
        except httpx.TransportError as e:
            log.warning("%s -> %s (tentativa %d)", url, e, i + 1)
        await asyncio.sleep(espera)
        espera *= 2
    raise RuntimeError(f"falhou depois de {tentativas} tentativas: {url}")


async def _baixar_arquivo(c: httpx.AsyncClient, url: str, destino: Path, forcar: bool) -> None:
    if destino.exists() and not forcar:
        return
    parcial = destino.with_suffix(destino.suffix + ".part")
    async with c.stream("GET", url, headers={"Accept": "*/*"}) as r:
        r.raise_for_status()
        # com Content-Encoding o tamanho do cabeçalho é o comprimido; aí não dá para conferir
        esperado = 0 if r.headers.get("content-encoding") else int(r.headers.get("content-length") or 0)
        with parcial.open("wb") as f:
            async for bloco in r.aiter_bytes(1 << 20):
                f.write(bloco)
    # conexão cortada no meio deixa um JSON truncado que só quebraria no `gerar`
    if esperado and parcial.stat().st_size != esperado:
        parcial.unlink()
        raise RuntimeError(f"download incompleto: {url}")
    parcial.replace(destino)
    log.info("baixado %s (%.1f MB)", destino.name, destino.stat().st_size / 1e6)


async def _json_cache(c: httpx.AsyncClient, url: str, destino: Path, forcar: bool) -> object:
    if destino.exists() and not forcar:
        return orjson.loads(destino.read_bytes())
    corpo = await _get(c, url)
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_bytes(corpo)
    return orjson.loads(corpo)


async def baixar(forcar: bool = False, concorrencia: int = 6) -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(concorrencia)
    timeout = httpx.Timeout(60, read=600)
    async with httpx.AsyncClient(headers=_HEADERS, timeout=timeout, follow_redirects=True) as c:

        async def limitado(coro):
            async with sem:
                return await coro

        await asyncio.gather(
            *(limitado(_baixar_arquivo(c, url, RAW_DIR / nome, forcar))
              for nome, url in arquivos_em_massa().items())
        )

        # Câmara: deputados em exercício + detalhe de cada um (CPF para o cruzamento com o TSE).
        atuais = await _json_cache(
            c, f"{CAMARA_API}/deputados?itens=1000&ordem=ASC&ordenarPor=nome",
            RAW_DIR / "camara" / "deputados-atuais.json", forcar,
        )
        ids = [d["id"] for d in atuais["dados"]]  # type: ignore[index]
        await asyncio.gather(*(
            limitado(_json_cache(c, f"{CAMARA_API}/deputados/{i}", RAW_DIR / "camara" / "dep" / f"{i}.json", forcar))
            for i in ids
        ))

        # Senado: lista, detalhe, votos nominais e autorias de cada senador em exercício.
        lista = await _json_cache(
            c, f"{SENADO_API}/senador/lista/atual.json", RAW_DIR / "senado" / "atuais.json", forcar
        )
        parl = lista["ListaParlamentarEmExercicio"]["Parlamentares"]["Parlamentar"]  # type: ignore[index]
        cods = [p["IdentificacaoParlamentar"]["CodigoParlamentar"] for p in parl]
        tarefas = []
        for cod in cods:
            base = RAW_DIR / "senado" / cod
            tarefas += [
                _json_cache(c, f"{SENADO_API}/senador/{cod}.json", base / "detalhe.json", forcar),
                _json_cache(c, f"{SENADO_API}/votacao?codigoParlamentar={cod}&dataInicio={INICIO_LEGISLATURA}",
                            base / "votos.json", forcar),
                _json_cache(c, f"{SENADO_API}/processo?codigoParlamentarAutor={cod}", base / "autorias.json", forcar),
            ]
        await asyncio.gather(*(limitado(t) for t in tarefas))
    log.info("fontes prontas em %s: %d deputados, %d senadores", RAW_DIR, len(ids), len(cods))
