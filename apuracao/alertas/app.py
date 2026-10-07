"""FastAPI dos alertas: inscrições Web Push, bot do Telegram e o vigia que dispara os marcos."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import EVENTOS, Config
from .eventos import EstadoAlertas, Evento, detectar, placar_texto

log = logging.getLogger("apuracao.alertas")

SCHEMA = """
CREATE TABLE IF NOT EXISTS push_subs (
    id TEXT PRIMARY KEY, endpoint TEXT UNIQUE NOT NULL, sub_json TEXT NOT NULL,
    eventos TEXT NOT NULL, criado_em TEXT NOT NULL, falhas INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS telegram (
    chat_id INTEGER PRIMARY KEY, eventos TEXT NOT NULL, criado_em TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS enviados (chave TEXT PRIMARY KEY, em TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS estado (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


def agora() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


class DB:
    def __init__(self, path: Path | str) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._con = sqlite3.connect(path, check_same_thread=False)
        self._con.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._con.executescript("PRAGMA journal_mode=WAL;" + SCHEMA)

    def _q(self, sql: str, *args: Any) -> list[sqlite3.Row]:
        with self._lock:
            cur = self._con.execute(sql, args)
            self._con.commit()
            return cur.fetchall()

    # push
    def inscrever_push(self, sub: dict, eventos: list[str]) -> str:
        id_ = secrets.token_urlsafe(12)
        self._q(
            "INSERT INTO push_subs(id, endpoint, sub_json, eventos, criado_em) VALUES (?,?,?,?,?) "
            "ON CONFLICT(endpoint) DO UPDATE SET sub_json=excluded.sub_json, eventos=excluded.eventos, falhas=0",
            id_,
            sub["endpoint"],
            json.dumps(sub),
            ",".join(eventos),
            agora(),
        )
        return self._q("SELECT id FROM push_subs WHERE endpoint=?", sub["endpoint"])[0]["id"]

    def remover_push(self, endpoint: str) -> None:
        self._q("DELETE FROM push_subs WHERE endpoint=?", endpoint)

    def push_para(self, tipo: str) -> list[sqlite3.Row]:
        return [
            r
            for r in self._q("SELECT * FROM push_subs WHERE falhas < 3")
            if tipo in r["eventos"].split(",")
        ]

    def push_falhou(self, endpoint: str, remover: bool = False) -> None:
        if remover:
            self.remover_push(endpoint)
        else:
            self._q("UPDATE push_subs SET falhas = falhas + 1 WHERE endpoint=?", endpoint)

    # telegram
    def inscrever_tg(self, chat_id: int, eventos: list[str]) -> None:
        self._q(
            "INSERT INTO telegram(chat_id, eventos, criado_em, ativo) VALUES (?,?,?,1) "
            "ON CONFLICT(chat_id) DO UPDATE SET eventos=excluded.eventos, ativo=1",
            chat_id,
            ",".join(eventos),
            agora(),
        )

    def parar_tg(self, chat_id: int) -> None:
        self._q("UPDATE telegram SET ativo=0 WHERE chat_id=?", chat_id)

    def tg_para(self, tipo: str) -> list[int]:
        return [
            r["chat_id"]
            for r in self._q("SELECT * FROM telegram WHERE ativo=1")
            if tipo in r["eventos"].split(",")
        ]

    # dedupe / estado
    def marcar_enviado(self, chave: str) -> bool:
        try:
            self._q("INSERT INTO enviados(chave, em) VALUES (?,?)", chave, agora())
            return True
        except sqlite3.IntegrityError:
            return False

    def estado_get(self, k: str) -> str | None:
        r = self._q("SELECT v FROM estado WHERE k=?", k)
        return r[0]["v"] if r else None

    def estado_set(self, k: str, v: str) -> None:
        self._q(
            "INSERT INTO estado(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v
        )

    def contagens(self) -> dict:
        return {
            "push": self._q("SELECT COUNT(*) c FROM push_subs")[0]["c"],
            "telegram": self._q("SELECT COUNT(*) c FROM telegram WHERE ativo=1")[0]["c"],
            "enviados": self._q("SELECT COUNT(*) c FROM enviados")[0]["c"],
        }


# --------------------------------------------------------------------------- envio
class Push:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    @property
    def ativo(self) -> bool:
        return bool(self.cfg.vapid_private_key and self.cfg.vapid_public_key)

    def enviar(self, sub: dict, payload: dict) -> tuple[bool, bool]:
        """→ (ok, remover_inscricao)."""
        if not self.ativo:
            return False, False
        from pywebpush import WebPushException, webpush

        try:
            webpush(
                subscription_info=sub,
                data=json.dumps(payload, ensure_ascii=False),
                vapid_private_key=self.cfg.vapid_private_key,
                vapid_claims={"sub": self.cfg.vapid_email},
                ttl=3600,
            )
            return True, False
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None)
            return False, status in (404, 410)


class Telegram:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.base = (
            f"https://api.telegram.org/bot{cfg.telegram_token}" if cfg.telegram_token else None
        )
        self._offset = 0

    @property
    def ativo(self) -> bool:
        return self.base is not None

    async def enviar(self, cli: httpx.AsyncClient, chat_id: int, texto: str) -> bool:
        if not self.base:
            return False
        r = await cli.post(
            f"{self.base}/sendMessage",
            json={"chat_id": chat_id, "text": texto, "disable_web_page_preview": True},
        )
        return r.status_code == 200

    async def atualizacoes(self, cli: httpx.AsyncClient) -> list[dict]:
        if not self.base:
            return []
        r = await cli.get(
            f"{self.base}/getUpdates", params={"offset": self._offset, "timeout": 20}, timeout=30
        )
        itens = r.json().get("result", []) if r.status_code == 200 else []
        for it in itens:
            self._offset = max(self._offset, it["update_id"] + 1)
        return itens


# --------------------------------------------------------------------------- app
class InscreverIn(BaseModel):
    subscription: dict = Field(...)
    eventos: list[str] = Field(default_factory=lambda: list(EVENTOS))


class RemoverIn(BaseModel):
    endpoint: str


def criar_app(cfg: Config | None = None) -> FastAPI:
    cfg = cfg or Config.from_env()
    app = FastAPI(title="Apuração BR — alertas", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.origens_cors,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["*"],
    )
    db = DB(cfg.db_path)
    push = Push(cfg)
    tg = Telegram(cfg)
    estado = _carregar_estado(db)
    app.state.cfg, app.state.db, app.state.estado = cfg, db, estado
    ultimo: dict[str, Any] = {"meta": None, "br": None}
    tasks: list[asyncio.Task] = []

    async def disparar(ev: Evento, cli: httpx.AsyncClient) -> int:
        if not db.marcar_enviado(ev.chave):
            return 0
        n = 0
        payload = {
            "title": f"Apuração · {ev.titulo}",
            "body": ev.corpo,
            "url": cfg.site_url,
            "tag": ev.chave,
        }
        for row in db.push_para(ev.tipo):
            ok, remover = await asyncio.to_thread(push.enviar, json.loads(row["sub_json"]), payload)
            if ok:
                n += 1
            else:
                db.push_falhou(row["endpoint"], remover)
        for chat_id in db.tg_para(ev.tipo):
            if await tg.enviar(cli, chat_id, f"{ev.titulo}\n{ev.corpo}\n{cfg.site_url}"):
                n += 1
        log.info("evento %s → %d envios", ev.chave, n)
        return n

    async def vigia() -> None:
        base = cfg.dados_base.rstrip("/")
        async with httpx.AsyncClient(timeout=10) as cli:
            while True:
                try:
                    ativo = (
                        await cli.get(f"{base}/ativo.json", headers={"Cache-Control": "no-cache"})
                    ).json()
                    pref = ativo["prefixo"]
                    meta = (await cli.get(f"{base}/{pref}/meta.json")).json()
                    br = (
                        await cli.get(
                            f"{base}/{pref}/br.json", headers={"Cache-Control": "no-cache"}
                        )
                    ).json()
                    rc = await cli.get(
                        f"{base}/{pref}/caminho.json", headers={"Cache-Control": "no-cache"}
                    )
                    caminho = rc.json() if rc.status_code == 200 else None
                    ultimo["meta"], ultimo["br"] = meta, br
                    chave_noite = f"{pref}"
                    if db.estado_get("noite") != chave_noite:
                        estado.__dict__.update(EstadoAlertas().__dict__)
                        db.estado_set("noite", chave_noite)
                    for ev in detectar(estado, meta, br, caminho):
                        await disparar(ev, cli)
                    _salvar_estado(db, estado)
                except Exception as exc:  # noqa: BLE001
                    log.debug("vigia: %s", exc)
                await asyncio.sleep(cfg.intervalo_s)

    async def bot() -> None:
        async with httpx.AsyncClient(timeout=35) as cli:
            while True:
                try:
                    for up in await tg.atualizacoes(cli):
                        await tratar_mensagem(up.get("message") or {}, cli)
                except Exception as exc:  # noqa: BLE001
                    log.debug("telegram: %s", exc)
                    await asyncio.sleep(5)

    async def tratar_mensagem(msg: dict, cli: httpx.AsyncClient) -> None:
        chat_id = (msg.get("chat") or {}).get("id")
        texto = (msg.get("text") or "").strip().lower()
        if not chat_id:
            return
        if texto.startswith(("/start", "/tudo")):
            db.inscrever_tg(chat_id, EVENTOS)
            await tg.enviar(
                cli,
                chat_id,
                "Inscrito! Você recebe: início, marcos (25/50/75/90/100%), virada e definição. "
                "Comandos: /placar, /so virada, /parar.",
            )
        elif texto.startswith("/so"):
            db.inscrever_tg(chat_id, ["virada", "definido", "matematica"])
            await tg.enviar(cli, chat_id, "Ok: só virada e definição.")
        elif texto.startswith("/parar"):
            db.parar_tg(chat_id)
            await tg.enviar(cli, chat_id, "Alertas desligados. /start para voltar.")
        elif texto.startswith("/placar"):
            if ultimo["br"]:
                sec = ultimo["br"].get("secoes", {}).get("pct", 0)
                await tg.enviar(
                    cli,
                    chat_id,
                    f"{placar_texto(ultimo['meta'], ultimo['br'])} — {sec}% das seções. {cfg.site_url}",
                )
            else:
                await tg.enviar(cli, chat_id, "A totalização ainda não começou.")

    @app.on_event("startup")
    async def _start() -> None:
        tasks.append(asyncio.create_task(vigia()))
        if tg.ativo and cfg.telegram_polling:
            tasks.append(asyncio.create_task(bot()))

    @app.on_event("shutdown")
    async def _stop() -> None:
        for t in tasks:
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t

    @app.get("/alertas/config")
    def config() -> dict:
        return {
            "vapid_publica": cfg.vapid_public_key,
            "telegram_bot": cfg.telegram_bot,
            "eventos": EVENTOS,
            **db.contagens(),
        }

    @app.post("/alertas/inscrever", status_code=201)
    def inscrever(body: InscreverIn) -> dict:
        sub = body.subscription
        if not isinstance(sub.get("endpoint"), str) or not sub["endpoint"].startswith("https://"):
            raise HTTPException(422, "subscription.endpoint inválido")
        if not (sub.get("keys") or {}).get("p256dh"):
            raise HTTPException(422, "subscription.keys ausente")
        eventos = [e for e in body.eventos if e in EVENTOS] or list(EVENTOS)
        return {"id": db.inscrever_push(sub, eventos), "eventos": eventos}

    @app.delete("/alertas/inscrever", status_code=204)
    def remover(body: RemoverIn) -> Response:
        db.remover_push(body.endpoint)
        return Response(status_code=204)

    @app.post("/alertas/teste")
    async def teste() -> JSONResponse:
        if not cfg.dev:
            raise HTTPException(404)
        ev = Evento(
            f"teste-{secrets.token_hex(3)}", "marcos", "Teste", "Os alertas estão funcionando."
        )
        async with httpx.AsyncClient(timeout=10) as cli:
            n = await disparar(ev, cli)
        return JSONResponse({"enviados": n})

    @app.post("/alertas/telegram/webhook")
    async def webhook(request: Request) -> dict:
        up = await request.json()
        async with httpx.AsyncClient(timeout=10) as cli:
            await tratar_mensagem(up.get("message") or {}, cli)
        return {"ok": True}

    return app


def _carregar_estado(db: DB) -> EstadoAlertas:
    raw = db.estado_get("alertas")
    if not raw:
        return EstadoAlertas()
    d = json.loads(raw)
    return EstadoAlertas(
        iniciado=d.get("iniciado", False),
        marcos=set(d.get("marcos", [])),
        lider=d.get("lider"),
        definido=d.get("definido", False),
        matematica=d.get("matematica"),
    )


def _salvar_estado(db: DB, e: EstadoAlertas) -> None:
    db.estado_set(
        "alertas",
        json.dumps(
            {
                "iniciado": e.iniciado,
                "marcos": sorted(e.marcos),
                "lider": e.lider,
                "definido": e.definido,
                "matematica": e.matematica,
            }
        ),
    )


app = criar_app()
