"""Simulador de noite de apuração a partir de um snapshot completo (ex.: 1º turno 6257).

Gera, município a município, uma totalização progressiva e publica pelos mesmos caminhos do
coletor (meta/br/uf/mun/timeline/caminho/ritmo/og). Serve para ensaiar o frontend, o chat, os
alertas e o próprio contrato sem depender do TSE. Os números são do 1º turno redistribuídos
entre os dois finalistas; **não é previsão**.

    apuracao simular --origem 6257 --destino 6258 --duracao 90 --velocidade 6
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import time
from datetime import date, datetime, timedelta

import orjson

from .collector import Collector, Config, Estado
from .publish.caminho import Base
from .storage import LocalStorage, Storage
from .tse.eleicoes import Eleicao, Municipio, parse_municipios
from .tse.parse import BRT, Candidato, Resultado

log = logging.getLogger("apuracao.simulador")


def _h(s: str) -> float:
    """Pseudo-aleatório determinístico em [0, 1)."""
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


class Simulador:
    def __init__(
        self,
        origem: LocalStorage,
        destino: Storage,
        *,
        prefixo_origem: str,
        codigo_destino: str,
        duracao_min: float = 90,
        velocidade: float = 6.0,
        tick_s: float = 10.0,
        ref_municipios=None,
        base_1turno=None,
    ) -> None:
        self.meta = origem.read_json(f"{prefixo_origem}/meta.json")
        self.mun = origem.read_json(f"{prefixo_origem}/mun.json")
        self.br = origem.read_json(f"{prefixo_origem}/br.json")
        if not (self.meta and self.mun and self.br):
            raise RuntimeError(f"snapshot de origem incompleto em {prefixo_origem}")
        self.destino = destino
        self.codigo_destino = codigo_destino
        self.duracao = duracao_min
        self.velocidade = velocidade
        self.tick = tick_s
        self.finalistas = [
            c for c in self.meta["cands"] if self.br["situacao"].get(c) == "2º turno"
        ]
        if len(self.finalistas) != 2:
            pares = sorted(zip(self.br["cands"], self.br["v"], strict=True), key=lambda x: -x[1])[
                :2
            ]
            self.finalistas = sorted(
                (c for c, _ in pares), key=lambda c: int(self.meta["candidatos"][c]["numero"])
            )
        self.municipios = (
            parse_municipios(orjson.loads(ref_municipios.read_bytes())) if ref_municipios else []
        )
        self.base = Base.carregar(base_1turno) if base_1turno else None
        campos = self.mun["campos"]
        ix = {k: campos.index(k) for k in campos}
        self.linhas = {}
        por_ibge = {(m.ibge or f"99{m.tse}"): m for m in self.municipios}
        idx = [self.mun["cands"].index(c) for c in self.finalistas]
        for linha in self.mun["linhas"]:
            ibge = linha[ix["ibge"]]
            m = por_ibge.get(ibge)
            if m is None:
                continue
            v = [linha[ix["v"]][j] for j in idx]
            soma = sum(v) or 1
            validos = linha[ix["validos"]]
            # 2 candidatos: redistribui os válidos na proporção do 1º turno entre os finalistas
            v2 = [round(validos * v[0] / soma), 0]
            v2[1] = validos - v2[0]
            self.linhas[m.tse] = {
                "m": m,
                "secoes_total": linha[ix["secoes_total"]],
                "aptos": linha[ix["aptos"]],
                "comparecimento": linha[ix["comparecimento"]],
                "validos": validos,
                "brancos": linha[ix["brancos"]],
                "nulos": linha[ix["nulos"]],
                "v": v2,
                # perfil: começa entre 0 e 30 % do tempo, termina entre 45 e 100 %; cidades
                # grandes terminam mais tarde
                "inicio": 0.30 * _h(m.tse + "i"),
                "fim": 0.45
                + 0.55
                * min(
                    1.0, 0.4 * _h(m.tse + "f") + 0.6 * math.log10(max(10, linha[ix["aptos"]])) / 7
                ),
            }

    # ------------------------------------------------------------------ geração
    def _progresso(self, d: dict, frac: float) -> float:
        if frac <= d["inicio"]:
            return 0.0
        if frac >= d["fim"]:
            return 1.0
        x = (frac - d["inicio"]) / (d["fim"] - d["inicio"])
        return x * x * (3 - 2 * x)  # suavização

    def _resultado(
        self, *, nivel: str, codigo: str, uf: str | None, acc: dict, gerado: datetime, idg: str
    ) -> Resultado:
        cands = []
        por_id = self.meta["candidatos"]
        validos = acc["validos"]
        for i, cid in enumerate(self.finalistas):
            c = por_id[cid]
            votos = acc["v"][i]
            cands.append(
                Candidato(
                    id=cid,
                    numero=c["numero"],
                    nome=c["nome"],
                    nome_completo=c["nome_completo"],
                    partido=c["partido"],
                    coligacao=c["coligacao"],
                    vice=c.get("vice"),
                    votos=votos,
                    pct=round(100 * votos / validos, 2) if validos else 0.0,
                    eleito=False,
                    situacao="",
                    seq=i + 1,
                )
            )
        st, ts = acc["secoes_totalizadas"], acc["secoes_total"]
        if nivel == "br" and st == ts and ts and cands:
            lider = max(cands, key=lambda c: c.votos)
            for c in cands:
                c.eleito = c is lider
                c.situacao = "Eleito" if c is lider else "Não eleito"
        comp, aptos = acc["comparecimento"], acc["aptos"]
        total = acc["validos"] + acc["brancos"] + acc["nulos"]
        return Resultado(
            eleicao=self.codigo_destino,
            turno=2,
            cargo="1",
            cargo_nome="Presidente",
            nivel=nivel,
            codigo=codigo,
            uf=uf,
            gerado_em=gerado.isoformat(),
            idg=idg,
            secoes_total=ts,
            secoes_totalizadas=st,
            secoes_pct=round(100 * st / ts, 2) if ts else 0.0,
            aptos=aptos,
            comparecimento=comp,
            abstencao=aptos - comp,
            pct_comparecimento=round(100 * comp / aptos, 2) if aptos else 0.0,
            pct_abstencao=round(100 * (aptos - comp) / aptos, 2) if aptos else 0.0,
            votos_total=total,
            validos=validos,
            brancos=acc["brancos"],
            nulos=acc["nulos"],
            pct_validos=round(100 * validos / total, 2) if total else 0.0,
            pct_brancos=round(100 * acc["brancos"] / total, 2) if total else 0.0,
            pct_nulos=round(100 * acc["nulos"] / total, 2) if total else 0.0,
            candidatos=cands,
        )

    def gerar(
        self, frac: float, gerado: datetime, idg: str
    ) -> tuple[Resultado, dict[str, Resultado], dict]:
        def novo() -> dict:
            return {
                "secoes_total": 0,
                "secoes_totalizadas": 0,
                "aptos": 0,
                "comparecimento": 0,
                "validos": 0,
                "brancos": 0,
                "nulos": 0,
                "v": [0, 0],
            }

        br_acc, uf_acc, muns = novo(), {}, {}
        for tse, d in self.linhas.items():
            p = self._progresso(d, frac)
            m: Municipio = d["m"]
            acc = {
                "secoes_total": d["secoes_total"],
                "secoes_totalizadas": round(p * d["secoes_total"]),
                "aptos": d["aptos"],
                "comparecimento": round(p * d["comparecimento"]),
                "validos": round(p * d["v"][0]) + round(p * d["v"][1]),
                "brancos": round(p * d["brancos"]),
                "nulos": round(p * d["nulos"]),
                "v": [round(p * d["v"][0]), round(p * d["v"][1])],
            }
            u = uf_acc.setdefault(m.uf, novo())
            for k in (
                "secoes_total",
                "secoes_totalizadas",
                "aptos",
                "comparecimento",
                "validos",
                "brancos",
                "nulos",
            ):
                u[k] += acc[k]
                br_acc[k] += acc[k]
            for i in (0, 1):
                u["v"][i] += acc["v"][i]
                br_acc["v"][i] += acc["v"][i]
            if p > 0:
                muns[tse] = (
                    m,
                    self._resultado(
                        nivel="mu", codigo=tse, uf=m.uf, acc=acc, gerado=gerado, idg=idg
                    ),
                )
        br = self._resultado(nivel="br", codigo="br", uf=None, acc=br_acc, gerado=gerado, idg=idg)
        ufs = {
            s: self._resultado(nivel="uf", codigo=s.lower(), uf=s, acc=a, gerado=gerado, idg=idg)
            for s, a in uf_acc.items()
        }
        return br, ufs, muns

    # ------------------------------------------------------------------ execução
    def coletor(self) -> Collector:
        cfg = Config(eleicao_codigo=self.codigo_destino, gerar_og=True, simulacao=True)
        col = Collector(cfg, self.destino)
        ele = Eleicao(
            codigo=self.codigo_destino,
            pleito=self.meta.get("pleito", ""),
            ciclo=self.meta.get("ciclo", "ele2026"),
            nome="Simulação — 2º turno",
            turno=2,
            tipo="8",
            data=date.fromisoformat(self.meta["data_eleicao"]) + timedelta(days=21),
            codigo_2turno=None,
            cargos=[],
            abrangencias=["br"],
        )
        col.estado = Estado(
            eleicao=ele,
            municipios=self.municipios,
            cands=list(self.finalistas),
            cargo="1",
            base=self.base,
        )
        return col

    async def rodar(self, *, inicio_real: float | None = None) -> None:
        col = self.coletor()
        est = col.estado
        assert est
        t0 = inicio_real or time.monotonic()
        hora0 = datetime.now(BRT).replace(microsecond=0)
        n = 0
        while True:
            minutos_sim = (time.monotonic() - t0) * self.velocidade
            frac = min(1.0, minutos_sim / self.duracao)
            gerado = (hora0 + timedelta(minutes=minutos_sim)).replace(microsecond=0)
            n += 1
            br, ufs, muns = self.gerar(frac, gerado, idg=f"sim{n:06d}")
            est.br, est.ufs, est.muns = br, ufs, muns
            est.ultima_mudanca = br.gerado_em
            col._publicar_rapido()
            if n % 3 == 1:  # municípios a cada ~30 s, como no real
                col._publicar_mun()
                col._publicar_caminho()
                col._publicar_og_ufs()
            col._publicar_status(time.monotonic(), 0)
            log.info(
                "sim %.1f%% das seções (%.0f min simulados) — %s",
                br.secoes_pct,
                minutos_sim,
                " × ".join(f"{c.nome} {c.pct}%" for c in br.candidatos),
            )
            if frac >= 1.0:
                log.info("simulação concluída")
                return
            await asyncio.sleep(self.tick)
