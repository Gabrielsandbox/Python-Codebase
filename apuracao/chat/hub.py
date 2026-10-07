"""Hub de conexões: salas, broadcast, histórico, presença, reações, termômetro e placar.

Em memória por padrão (1 processo). Com ``redis_url``:
- ``PUBLISH chat:sala`` leva cada mensagem a todos os processos (campo ``sala`` filtra);
- ``LPUSH/LTRIM chat:hist:<sala>`` guarda o histórico por sala;
- ``SET chat:presenca:<proc> {sala: n} EX 15`` por processo; o total é a soma das chaves;
- ``HINCRBY chat:reacoes:<sala>:<janela2s>`` e ``INCRBY chat:torcida:<sala>:<cand>:<minuto>``
  agregam reações entre processos (TTL curto).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import httpx
import orjson
from starlette.websockets import WebSocket

log = logging.getLogger("apuracao.chat.hub")
BRT = timezone(timedelta(hours=-3))

CANAL = "chat:sala"
HIST = "chat:hist:"
PRESENCA = "chat:presenca:"
REACOES = "chat:reacoes:"
TORCIDA = "chat:torcida:"

UFS = {
    "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE",
    "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO", "ZZ",
}  # fmt: skip
SALAS = {"geral", *UFS}
EMOJIS = {"🔥", "👏", "😱", "😂", "🇧🇷"}
JANELA_REACOES_S = 2
JANELA_TORCIDA_MIN = 5


def sala_valida(s: str | None) -> str | None:
    s = (s or "geral").strip()
    s = s.upper() if s.lower() != "geral" else "geral"
    return s if s in SALAS else None


def reacao_valida(valor: str, cands: set[str]) -> bool:
    if valor in EMOJIS:
        return True
    return valor.startswith("torcida:") and valor[8:] in cands


def agora_iso() -> str:
    return datetime.now(BRT).replace(microsecond=0).isoformat()


def novo_id() -> str:
    # ordenável no tempo + aleatório: ms em hex (12) + 6 bytes
    return f"{int(time.time() * 1000):012x}{secrets.token_hex(6)}"


class Hub:
    def __init__(
        self,
        *,
        historico: int = 50,
        redis_url: str | None = None,
        dados_base: str | None = None,
        db=None,
    ) -> None:
        self.historico_n = historico
        self.redis_url = redis_url
        self.dados_base = dados_base
        self.db = db
        self._conexoes: dict[WebSocket, dict] = {}
        self._hist: dict[str, deque[dict]] = defaultdict(lambda: deque(maxlen=historico))
        self._redis = None
        self._proc = secrets.token_hex(4)
        self._tasks: list[asyncio.Task] = []
        self._presenca_cache: tuple[float, dict[str, int]] = (0.0, {})
        self._ultimo_idg: str | None = None
        self.cands: set[str] = set()  # ids válidos para "torcida:<id>" (de meta.json)
        # reações locais (sem redis): sala → valor → n ; torcida: (sala, cand, minuto) → n
        self._reacoes: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self._torcida: dict[tuple[str, str, int], int] = defaultdict(int)

    # ------------------------------------------------------------------ ciclo de vida
    async def iniciar(self) -> None:
        if self.redis_url:
            import redis.asyncio as aioredis

            self._redis = aioredis.from_url(self.redis_url, decode_responses=False)
            await self._redis.ping()
            self._tasks.append(asyncio.create_task(self._assinar_redis()))
            log.info("hub com redis (%s), proc=%s", self.redis_url, self._proc)
        elif self.db:
            for sala in SALAS:
                for m in self.db.ultimas(self.historico_n, sala=sala):
                    self._hist[sala].append({"tipo": "msg", **m})
        self._tasks.append(asyncio.create_task(self._loop_presenca()))
        self._tasks.append(asyncio.create_task(self._loop_reacoes()))
        self._tasks.append(asyncio.create_task(self._loop_termometro()))
        if self.dados_base:
            self._tasks.append(asyncio.create_task(self._loop_placar()))

    async def parar(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        if self._redis is not None:
            with contextlib.suppress(Exception):
                await self._redis.delete(PRESENCA + self._proc)
                await self._redis.aclose()

    # ------------------------------------------------------------------ conexões
    async def entrar(self, ws: WebSocket, claims: dict, sala: str = "geral") -> None:
        # Envia histórico antes de registrar a conexão, para o loop de presença não
        # entregar um frame antes do "historico".
        historico = await self.ultimas(sala, claims.get("sub"))
        self._conexoes[ws] = {**claims, "sala": sala}
        await self._atualizar_presenca()
        await ws.send_text(
            orjson.dumps({"tipo": "historico", "sala": sala, "mensagens": historico}).decode()
        )
        await ws.send_text(
            orjson.dumps(
                {"tipo": "presenca", "sala": sala, "online": await self.online(sala)}
            ).decode()
        )

    def sair(self, ws: WebSocket) -> None:
        if self._conexoes.pop(ws, None) is not None and self._redis is not None:
            with contextlib.suppress(RuntimeError):
                asyncio.get_running_loop().create_task(self._atualizar_presenca())

    def _locais(self) -> dict[str, int]:
        out: dict[str, int] = defaultdict(int)
        for c in self._conexoes.values():
            out[c.get("sala", "geral")] += 1
        return dict(out)

    async def _atualizar_presenca(self) -> None:
        if self._redis is not None:
            with contextlib.suppress(Exception):
                await self._redis.set(PRESENCA + self._proc, orjson.dumps(self._locais()), ex=15)
        self._presenca_cache = (0.0, {})  # invalida o cache

    @property
    def locais(self) -> int:
        return len(self._conexoes)

    # ------------------------------------------------------------------ mensagens
    async def publicar_msg(self, sub: str, apelido: str, texto: str, sala: str = "geral") -> dict:
        msg = {
            "tipo": "msg",
            "id": novo_id(),
            "sub": sub,
            "apelido": apelido,
            "texto": texto,
            "sala": sala,
            "t": agora_iso(),
        }
        if self.db:
            self.db.gravar_mensagem(msg["id"], sub, apelido, texto, msg["t"], sala=sala)
        await self._publicar(msg)
        return msg

    async def publicar_sistema(self, texto: str, sala: str | None = None) -> None:
        msg = {"tipo": "sistema", "id": novo_id(), "texto": texto, "t": agora_iso()}
        if sala:
            msg["sala"] = sala
        await self._publicar(msg)

    async def _publicar(self, msg: dict) -> None:
        if self._redis is not None:
            raw = orjson.dumps(msg)
            pipe = self._redis.pipeline()
            pipe.publish(CANAL, raw)
            if msg["tipo"] == "msg":
                pipe.lpush(HIST + msg["sala"], raw)
                pipe.ltrim(HIST + msg["sala"], 0, self.historico_n - 1)
            await pipe.execute()
        else:
            await self._entregar(msg)

    async def _entregar(self, msg: dict) -> None:
        sala = msg.get("sala")  # None = todas as salas
        if msg["tipo"] == "msg" and sala:
            self._hist[sala].append(msg)
        sub = msg.get("sub")
        publico = {k: v for k, v in msg.items() if k != "sub"}
        if msg["tipo"] == "msg":
            raw_outros = orjson.dumps({**publico, "eu": False}).decode()
            raw_eu = orjson.dumps({**publico, "eu": True}).decode()
        else:
            raw_outros = raw_eu = orjson.dumps(publico).decode()
        mortas: list[WebSocket] = []
        for ws, claims in list(self._conexoes.items()):
            if sala and claims.get("sala") != sala:
                continue
            try:
                await ws.send_text(raw_eu if sub and claims.get("sub") == sub else raw_outros)
            except Exception:  # noqa: BLE001 — conexão fechada
                mortas.append(ws)
        for ws in mortas:
            self.sair(ws)

    async def ultimas(self, sala: str = "geral", sub: str | None = None) -> list[dict]:
        if self._redis is not None:
            raws = await self._redis.lrange(HIST + sala, 0, self.historico_n - 1)
            itens = [orjson.loads(r) for r in reversed(raws)]
        else:
            itens = list(self._hist[sala])
        return [
            {**{k: v for k, v in m.items() if k != "sub"}, "eu": bool(sub) and m.get("sub") == sub}
            for m in itens
        ]

    # ------------------------------------------------------------------ presença
    async def salas(self) -> dict[str, int]:
        """Online por sala (só salas com gente)."""
        if self._redis is None:
            return self._locais()
        t, cache = self._presenca_cache
        if time.monotonic() - t < 2:
            return cache
        total: dict[str, int] = defaultdict(int)
        async for chave in self._redis.scan_iter(match=PRESENCA + "*"):
            v = await self._redis.get(chave)
            if v:
                with contextlib.suppress(Exception):
                    for s, n in orjson.loads(v).items():
                        total[s] += int(n)
        self._presenca_cache = (time.monotonic(), dict(total))
        return dict(total)

    async def online(self, sala: str | None = None) -> int:
        s = await self.salas()
        return s.get(sala, 0) if sala else sum(s.values())

    async def _loop_presenca(self) -> None:
        while True:
            try:
                await self._atualizar_presenca()
                s = await self.salas()
                por_sala = {
                    sala: orjson.dumps({"tipo": "presenca", "sala": sala, "online": n}).decode()
                    for sala, n in s.items()
                }
                for ws, claims in list(self._conexoes.items()):
                    raw = por_sala.get(claims.get("sala", "geral"))
                    if raw:
                        with contextlib.suppress(Exception):
                            await ws.send_text(raw)
            except Exception:
                log.exception("presença")
            await asyncio.sleep(5)

    # ------------------------------------------------------------------ reações
    async def reagir(self, sala: str, valor: str) -> None:
        janela = int(time.time() // JANELA_REACOES_S)
        minuto = int(time.time() // 60)
        if self._redis is not None:
            pipe = self._redis.pipeline()
            pipe.hincrby(f"{REACOES}{sala}:{janela}", valor, 1)
            pipe.expire(f"{REACOES}{sala}:{janela}", 10)
            if valor.startswith("torcida:"):
                k = f"{TORCIDA}{sala}:{valor[8:]}:{minuto}"
                pipe.incrby(k, 1)
                pipe.expire(k, (JANELA_TORCIDA_MIN + 1) * 60)
            await pipe.execute()
        else:
            self._reacoes[sala][valor] += 1
            if valor.startswith("torcida:"):
                self._torcida[(sala, valor[8:], minuto)] += 1

    async def _enviar_sala(self, sala: str, doc: dict) -> None:
        raw = orjson.dumps(doc).decode()
        for ws, claims in list(self._conexoes.items()):
            if claims.get("sala") == sala:
                with contextlib.suppress(Exception):
                    await ws.send_text(raw)

    async def _loop_reacoes(self) -> None:
        """A cada 2 s entrega a contagem da janela anterior a cada sala com gente."""
        while True:
            await asyncio.sleep(JANELA_REACOES_S)
            try:
                salas = set(self._locais())
                if self._redis is not None:
                    janela = int(time.time() // JANELA_REACOES_S) - 1
                    for sala in salas:
                        h = await self._redis.hgetall(f"{REACOES}{sala}:{janela}")
                        if h:
                            contagem = {k.decode(): int(v) for k, v in h.items()}
                            await self._enviar_sala(
                                sala,
                                {
                                    "tipo": "reacoes",
                                    "janela_s": JANELA_REACOES_S,
                                    "contagem": contagem,
                                },
                            )
                else:
                    for sala in salas:
                        contagem = dict(self._reacoes.pop(sala, {}))
                        if contagem:
                            await self._enviar_sala(
                                sala,
                                {
                                    "tipo": "reacoes",
                                    "janela_s": JANELA_REACOES_S,
                                    "contagem": contagem,
                                },
                            )
            except Exception:
                log.exception("reações")

    async def torcida(self, sala: str) -> dict[str, int]:
        minuto = int(time.time() // 60)
        minutos = range(minuto - JANELA_TORCIDA_MIN + 1, minuto + 1)
        out: dict[str, int] = {}
        if self._redis is not None:
            for cand in self.cands:
                vals = await self._redis.mget([f"{TORCIDA}{sala}:{cand}:{m}" for m in minutos])
                n = sum(int(v) for v in vals if v)
                if n:
                    out[cand] = n
        else:
            for (s, cand, m), n in list(self._torcida.items()):
                if s != sala:
                    continue
                if m < minuto - JANELA_TORCIDA_MIN:
                    del self._torcida[(s, cand, m)]
                elif m in minutos:
                    out[cand] = out.get(cand, 0) + n
        return out

    async def _loop_termometro(self) -> None:
        while True:
            await asyncio.sleep(5)
            try:
                for sala in set(self._locais()):
                    t = await self.torcida(sala)
                    await self._enviar_sala(
                        sala,
                        {
                            "tipo": "termometro",
                            "janela_min": JANELA_TORCIDA_MIN,
                            "torcida": t,
                            "total": sum(t.values()),
                        },
                    )
            except Exception:
                log.exception("termômetro")

    # ------------------------------------------------------------------ redis
    async def _assinar_redis(self) -> None:
        assert self._redis is not None
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(CANAL)
        async for item in pubsub.listen():
            if item.get("type") != "message":
                continue
            try:
                msg = orjson.loads(item["data"])
            except orjson.JSONDecodeError:
                continue
            await self._entregar(msg)

    # ------------------------------------------------------------------ placar
    async def _loop_placar(self) -> None:
        """Lê ``br.json`` publicado pelo coletor e emite mensagem de sistema quando muda."""
        base = (self.dados_base or "").rstrip("/")
        async with httpx.AsyncClient(timeout=10) as cli:
            while True:
                try:
                    ativo = (
                        await cli.get(f"{base}/ativo.json", headers={"Cache-Control": "no-cache"})
                    ).json()
                    pref = ativo["prefixo"]
                    meta = (await cli.get(f"{base}/{pref}/meta.json")).json()
                    self.cands = set(meta.get("cands") or [])
                    st = (
                        await cli.get(
                            f"{base}/{pref}/status.json", headers={"Cache-Control": "no-cache"}
                        )
                    ).json()
                    idg = st.get("fonte_idg")
                    if idg and idg != self._ultimo_idg:
                        br = (
                            await cli.get(
                                f"{base}/{pref}/br.json", headers={"Cache-Control": "no-cache"}
                            )
                        ).json()
                        # só o primeiro processo a ver o idg publica (lock curto no redis)
                        primeiro = self._redis is None or await self._redis.set(
                            f"chat:placar:{idg}", 1, ex=600, nx=True
                        )
                        if primeiro and self._ultimo_idg is not None:  # não anuncia na partida
                            await self.publicar_sistema(frase_placar(meta, br))
                    self._ultimo_idg = idg
                except Exception as exc:  # noqa: BLE001
                    log.debug("placar indisponível: %s", exc)
                await asyncio.sleep(10)


def frase_placar(meta: dict, br: dict) -> str:
    """``Flavio Bolsonaro 50,4% × Lula 49,6% — 71,2% das seções totalizadas``."""
    cands = br.get("cands") or []
    pcts = br.get("pct") or []
    nomes = meta.get("candidatos") or {}
    pares = sorted(zip(cands, pcts, strict=False), key=lambda x: -x[1])[:2]
    partes = [
        f"{titulo(nomes.get(c, {}).get('nome', c))} {p:.1f}%".replace(".", ",") for c, p in pares
    ]
    sec = f"{br.get('secoes', {}).get('pct', 0):.1f}".replace(".", ",")
    frase = " × ".join(partes) + f" — {sec}% das seções totalizadas"
    if br.get("definido") and br.get("vencedor"):
        frase = f"🏁 {titulo(nomes.get(br['vencedor'], {}).get('nome', ''))} eleito. " + frase
    return frase


def titulo(nome: str) -> str:
    minus = {"de", "da", "do", "dos", "das", "e"}
    return " ".join(p if p in minus else p.capitalize() for p in nome.lower().split())
