"""Coletor: consulta o TSE em duas camadas e publica snapshots compactos.

Camada rápida (padrão a cada 10 s): Brasil + 27 UFs + exterior (29 arquivos).
Camada municipal (padrão a cada 60 s, igual ao ``max-age`` do CDN do TSE): ~5.757 arquivos.

Cada ciclo usa GET condicional; só o que mudou é reprocessado e republicado. Os corpos brutos
que mudaram são guardados em ``raw/`` (um por ``idg``) — é a matéria-prima do acervo histórico:
a evolução da totalização município a município, que o TSE não publica depois.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import orjson

from . import publish
from .storage import Storage
from .tse import urls
from .tse.client import FetchResult, TSEClient
from .tse.eleicoes import (
    Eleicao,
    Municipio,
    carregar_catalogo,
    carregar_municipios,
    encontrar,
    parse_municipios,
)
from .tse.parse import Resultado, parse_resultado

log = logging.getLogger("apuracao.collector")

UFS = [
    "AC",
    "AL",
    "AM",
    "AP",
    "BA",
    "CE",
    "DF",
    "ES",
    "GO",
    "MA",
    "MG",
    "MS",
    "MT",
    "PA",
    "PB",
    "PE",
    "PI",
    "PR",
    "RJ",
    "RN",
    "RO",
    "RR",
    "RS",
    "SC",
    "SE",
    "SP",
    "TO",
    "ZZ",
]


@dataclass
class Config:
    ano: int = 2026
    turno: int = 2
    cargo: str = "1"  # Presidente
    intervalo_rapido: float = 10.0
    intervalo_mun: float = 60.0
    rate_per_s: float = 150.0
    concurrency: int = 40
    raw_dir: Path | None = None
    ref_municipios: Path | None = None  # fallback local p/ mun-e*-cm.json
    eleicao_codigo: str | None = None  # força um código (ex.: 6257 p/ desenvolver com o 1º turno)


@dataclass
class Estado:
    eleicao: Eleicao
    municipios: list[Municipio]
    cands: list[str] = field(default_factory=list)
    br: Resultado | None = None
    ufs: dict[str, Resultado] = field(default_factory=dict)
    muns: dict[str, tuple[Municipio, Resultado]] = field(default_factory=dict)
    timeline_br: publish.Timeline | None = None
    timeline_uf: dict[str, publish.Timeline] = field(default_factory=dict)
    ultima_mudanca: str | None = None
    meta_publicado_idg: str | None = None
    cargo: str = "1"


class Collector:
    def __init__(self, cfg: Config, storage: Storage) -> None:
        self.cfg = cfg
        self.storage = storage
        self.client = TSEClient(rate_per_s=cfg.rate_per_s, concurrency=cfg.concurrency)
        self.estado: Estado | None = None
        self._stop = asyncio.Event()

    # ------------------------------------------------------------------ setup
    async def preparar(self) -> Estado:
        catalogo = await carregar_catalogo(self.client)
        if self.cfg.eleicao_codigo:
            ele = next((e for e in catalogo if e.codigo == self.cfg.eleicao_codigo), None)
            if ele is None:
                # 2º turno ainda fora do catálogo: deriva do 1º turno
                base = next(
                    (e for e in catalogo if e.codigo_2turno == self.cfg.eleicao_codigo), None
                )
                ele = (
                    encontrar(catalogo, ano=base.data.year, turno=2, cargo=self.cfg.cargo)
                    if base
                    else None
                )
        else:
            ele = encontrar(catalogo, ano=self.cfg.ano, turno=self.cfg.turno, cargo=self.cfg.cargo)
        if ele is None:
            raise RuntimeError(
                f"Eleição não encontrada no catálogo do TSE (ano={self.cfg.ano}, turno={self.cfg.turno}, "
                f"cargo={self.cfg.cargo}). Verifique `apuracao eleicoes`."
            )

        muns = await carregar_municipios(self.client, ele.ciclo, ele.codigo)
        if not muns:
            # Antes da publicação do 2º turno, o TSE ainda não tem o mun-e*-cm.json dele.
            primeiro = next((e for e in catalogo if e.codigo_2turno == ele.codigo), None)
            if primeiro:
                muns = await carregar_municipios(self.client, primeiro.ciclo, primeiro.codigo)
                log.warning("Usando lista de municípios do 1º turno (%s)", primeiro.codigo)
        if not muns and self.cfg.ref_municipios and self.cfg.ref_municipios.exists():
            muns = parse_municipios(orjson.loads(self.cfg.ref_municipios.read_bytes()))
            log.warning("Usando lista de municípios local: %s", self.cfg.ref_municipios)
        if not muns:
            raise RuntimeError("Sem lista de municípios do TSE")

        est = Estado(eleicao=ele, municipios=muns, cargo=self.cfg.cargo)
        # retoma linhas do tempo já publicadas (reinício do processo no meio da apuração)
        self.estado = est
        log.info(
            "Eleição %s (%s) turno %s — %d municípios", ele.codigo, ele.nome, ele.turno, len(muns)
        )
        return est

    # ------------------------------------------------------------------ helpers
    @property
    def prefixo(self) -> str:
        assert self.estado
        return f"{self.estado.eleicao.codigo}/{self.cfg.cargo}"

    def _url(self, uf: str, mun: str | None = None) -> str:
        e = self.estado.eleicao  # type: ignore[union-attr]
        return urls.resultado(e.ciclo, e.codigo, self.cfg.cargo, uf, mun)

    def _salvar_raw(self, nome: str, r: FetchResult, idg: str) -> None:
        if not self.cfg.raw_dir or r.body is None:
            return
        p = self.cfg.raw_dir / self.estado.eleicao.codigo / nome / f"{idg}.json"  # type: ignore[union-attr]
        p.parent.mkdir(parents=True, exist_ok=True)
        if not p.exists():
            p.write_bytes(r.body)

    def _parse(self, r: FetchResult, uf_hint: str | None = None) -> Resultado | None:
        try:
            doc = r.json()
        except orjson.JSONDecodeError:
            log.warning("JSON inválido em %s", r.url)
            return None
        if not doc:
            return None
        return parse_resultado(doc, uf_hint=uf_hint)

    # ------------------------------------------------------------------ ciclos
    async def ciclo_rapido(self) -> dict:
        est = self.estado
        assert est
        t0 = time.monotonic()
        alvos = [("br", None)] + [(uf.lower(), uf) for uf in UFS]
        resultados = await self.client.fetch_many([self._url(a) for a, _ in alvos])
        erros = 0
        mudou_br = False
        for (abr, uf), r in zip(alvos, resultados, strict=True):
            if r.status == 404:
                continue
            if not r.ok:
                erros += 1
                log.warning("falha %s: %s %s", r.url, r.status, r.error)
                continue
            if not r.changed and (est.br if abr == "br" else est.ufs.get(uf or "")) is not None:
                continue
            res = self._parse(r, uf_hint=uf)
            if res is None:
                continue
            self._salvar_raw(abr, r, res.idg)
            if abr == "br":
                mudou_br = est.br is None or est.br.idg != res.idg
                est.br = res
                if not est.cands:
                    est.cands = publish.ordem_candidatos(res)
            else:
                est.ufs[uf] = res  # type: ignore[index]

        if est.br is None:
            # Totalização ainda não começou (todos 404). Publica status "aguardando".
            self._publicar_status(t0, erros, aguardando=True)
            return {"ms": int((time.monotonic() - t0) * 1000), "erros": erros, "mudou": False}

        if mudou_br or est.meta_publicado_idg is None:
            self._publicar_rapido()
            est.ultima_mudanca = est.br.gerado_em
        self._publicar_status(t0, erros)
        return {"ms": int((time.monotonic() - t0) * 1000), "erros": erros, "mudou": mudou_br}

    async def ciclo_municipal(self) -> dict:
        est = self.estado
        assert est
        t0 = time.monotonic()
        if est.br is None:
            # Sem o arquivo nacional não há arquivos municipais: evita ~5.800 404 por ciclo.
            log.info("municípios: totalização ainda não começou, pulando ciclo")
            return {"ms": 0, "erros": 0, "mudaram": 0}
        alvos = [m for m in est.municipios if m.uf and m.tse]
        resultados = await self.client.fetch_many([self._url(m.uf, m.tse) for m in alvos])
        erros = 0
        mudaram = 0
        for m, r in zip(alvos, resultados, strict=True):
            if r.status == 404:
                continue
            if not r.ok:
                erros += 1
                continue
            if not r.changed and m.tse in est.muns:
                continue
            res = self._parse(r, uf_hint=m.uf)
            if res is None:
                continue
            est.muns[m.tse] = (m, res)
            self._salvar_raw(f"{m.uf.lower()}{m.tse}", r, res.idg)
            mudaram += 1
        if mudaram and est.cands:
            atual = est.br.gerado_em if est.br and est.br.gerado_em else publish.agora_iso()
            self.storage.write_json(
                f"{self.prefixo}/mun.json",
                publish.build_mun(est.muns, est.cands, atual),
                max_age=30,
            )
        ms = int((time.monotonic() - t0) * 1000)
        log.info(
            "municípios: %d/%d coletados, %d mudaram, %d erros, %d ms",
            len(est.muns),
            len(alvos),
            mudaram,
            erros,
            ms,
        )
        return {"ms": ms, "erros": erros, "mudaram": mudaram}

    # ------------------------------------------------------------------ publicação
    def _publicar_rapido(self) -> None:
        est = self.estado
        assert est and est.br
        p = self.prefixo
        cands = est.cands
        if est.meta_publicado_idg != est.br.idg:
            self.storage.write_json(
                f"{p}/meta.json",
                publish.build_meta(est.eleicao, self.cfg.cargo, est.br, cands),
                max_age=60,
            )
            est.meta_publicado_idg = est.br.idg
        self.storage.write_json(f"{p}/br.json", publish.build_br(est.br, cands))
        atual = est.br.gerado_em or publish.agora_iso()
        self.storage.write_json(f"{p}/uf.json", publish.build_uf(est.ufs, cands, atual))
        for sigla, res in est.ufs.items():
            self.storage.write_json(
                f"{p}/uf/{sigla}.json",
                publish.build_nivel(
                    res, cands, nivel="uf", codigo=sigla, nome=publish.UF_NOMES.get(sigla, sigla)
                ),
            )
        # linhas do tempo
        if est.timeline_br is None:
            est.timeline_br = publish.Timeline.from_dict(
                self.storage.read_json(f"{p}/timeline/br.json"), cands
            )  # type: ignore[arg-type]
        if est.timeline_br.adicionar(est.br):
            self.storage.write_json(f"{p}/timeline/br.json", est.timeline_br.to_dict(), max_age=30)
        for sigla, res in est.ufs.items():
            tl = est.timeline_uf.get(sigla)
            if tl is None:
                tl = publish.Timeline.from_dict(
                    self.storage.read_json(f"{p}/timeline/uf/{sigla}.json"), cands
                )  # type: ignore[arg-type]
                est.timeline_uf[sigla] = tl
            if tl.adicionar(res):
                self.storage.write_json(f"{p}/timeline/uf/{sigla}.json", tl.to_dict(), max_age=30)

    def _publicar_status(self, t0: float, erros: int, *, aguardando: bool | None = None) -> None:
        est = self.estado
        assert est
        if aguardando is None:
            aguardando = est.br is None
        st = publish.build_status(
            ultima_coleta=publish.agora_iso(),
            ultima_mudanca=est.ultima_mudanca,
            idg=est.br.idg if est.br else None,
            ciclo_ms=int((time.monotonic() - t0) * 1000),
            erros=erros,
            municipios=len(est.muns),
        )
        st["aguardando_totalizacao"] = aguardando
        st["eleicao"] = est.eleicao.codigo
        st["turno"] = est.eleicao.turno
        self.storage.write_json(f"{self.prefixo}/status.json", st, max_age=5)
        # ponteiro global "qual eleição está ativa" para o frontend
        self.storage.write_json(
            "ativo.json",
            {
                "schema": 1,
                "prefixo": self.prefixo,
                "eleicao": est.eleicao.codigo,
                "cargo": self.cfg.cargo,
                "turno": est.eleicao.turno,
                "data_eleicao": est.eleicao.data.isoformat(),
            },
            max_age=30,
        )

    # ------------------------------------------------------------------ loop
    async def uma_vez(self) -> None:
        async with self.client:
            await self.preparar()
            r1 = await self.ciclo_rapido()
            log.info("camada rápida: %s", r1)
            r2 = await self.ciclo_municipal()
            log.info("camada municipal: %s", r2)
            self._publicar_status(time.monotonic(), r2["erros"])

    async def rodar(self) -> None:
        async with self.client:
            await self.preparar()

            async def loop_rapido() -> None:
                while not self._stop.is_set():
                    try:
                        r = await self.ciclo_rapido()
                        log.info("camada rápida: %s", r)
                    except Exception:
                        log.exception("erro na camada rápida")
                    await asyncio.sleep(self.cfg.intervalo_rapido)

            async def loop_mun() -> None:
                while not self._stop.is_set():
                    try:
                        await self.ciclo_municipal()
                    except Exception:
                        log.exception("erro na camada municipal")
                    await asyncio.sleep(self.cfg.intervalo_mun)

            await asyncio.gather(loop_rapido(), loop_mun())

    def parar(self) -> None:
        self._stop.set()
