"""FastAPI do chat: checkout, acesso, estado, webhook e WebSocket. Contrato em docs/CHAT.md."""

from __future__ import annotations

import contextlib
import logging
from datetime import UTC, datetime
from typing import Any

import orjson
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import Config
from .auth import ApelidoInvalido, emitir_token, normalizar_apelido, novo_ref, verificar_token
from .db import DB
from .hub import Hub
from .moderacao import LimiteTaxa, TextoInvalido, bloqueado, carregar_bloqueio, higienizar
from .pagamentos import ProvedorStripe, criar_provedor

log = logging.getLogger("apuracao.chat")

WS_NAO_AUTORIZADO = 4401
WS_LIMITE = 4429


class CheckoutIn(BaseModel):
    apelido: str = Field(min_length=1, max_length=64)
    retorno: str = Field(min_length=1, max_length=2048)


def criar_app(cfg: Config | None = None) -> FastAPI:
    cfg = cfg or Config.from_env()
    app = FastAPI(title="Apuração BR — chat", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.origens_cors,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    if cfg.pagamento != "dev" and cfg.jwt_secret == Config.jwt_secret:
        raise RuntimeError("Defina CHAT_JWT_SECRET (32+ caracteres) fora do modo dev")
    db = DB(cfg.db_path)
    provedor = criar_provedor(cfg.pagamento, stripe_secret_key=cfg.stripe_secret_key)
    hub = Hub(historico=cfg.historico, redis_url=cfg.redis_url, dados_base=cfg.dados_base, db=db)
    limite = LimiteTaxa(cfg.intervalo_msg_s)
    padroes = carregar_bloqueio(cfg.bloqueio_path)
    app.state.cfg, app.state.db, app.state.hub, app.state.provedor = cfg, db, hub, provedor

    @app.on_event("startup")
    async def _startup() -> None:
        await hub.iniciar()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        await hub.parar()
        db.close()

    # ------------------------------------------------------------------ HTTP
    @app.get("/chat/estado")
    async def estado() -> JSONResponse:
        return JSONResponse(
            {
                "online": await hub.online(),
                "aberto": True,
                "preco_centavos": cfg.preco_centavos,
                "mensagens_total": db.total_mensagens(),
                "provedor": provedor.nome,
            },
            headers={"Cache-Control": "public, max-age=5"},
        )

    @app.post("/chat/checkout")
    def checkout(body: CheckoutIn) -> dict[str, Any]:
        try:
            apelido = normalizar_apelido(body.apelido)
        except ApelidoInvalido as exc:
            raise HTTPException(422, str(exc)) from exc
        if not body.retorno.startswith(("http://", "https://")):
            raise HTTPException(422, "retorno deve ser uma URL absoluta")
        ref = novo_ref()
        ck = provedor.criar_checkout(
            ref=ref, apelido=apelido, retorno=body.retorno, valor_centavos=cfg.preco_centavos
        )
        db.criar_pagamento(ref, provedor.nome, apelido, cfg.preco_centavos, ck.provedor_id)
        return {"url": ck.url, "ref": ref}

    @app.get("/chat/acesso")
    def acesso(ref: str = Query(min_length=4, max_length=64)) -> JSONResponse:
        pg = db.pagamento(ref)
        if pg is None:
            raise HTTPException(404, "ref desconhecida")
        if pg["status"] != "pago":
            st = provedor.verificar(ref=ref, provedor_id=pg["provedor_id"])
            if st == "pago":
                db.marcar_pago(ref)
            elif st == "falhou":
                raise HTTPException(410, "pagamento expirado; inicie de novo")
            else:
                return JSONResponse({"detail": "pagamento pendente"}, status_code=402)
        token, exp = emitir_token(cfg.jwt_secret, ref, pg["apelido"], cfg.jwt_dias)
        return JSONResponse(
            {"token": token, "apelido": pg["apelido"], "expira_em": exp.isoformat()}
        )

    @app.post("/chat/webhook/stripe")
    async def webhook_stripe(request: Request) -> dict[str, Any]:
        if not isinstance(provedor, ProvedorStripe) or not cfg.stripe_webhook_secret:
            raise HTTPException(404)
        payload = await request.body()
        try:
            ev = provedor.evento_webhook(
                payload, request.headers.get("stripe-signature", ""), cfg.stripe_webhook_secret
            )
        except ValueError as exc:
            raise HTTPException(400, f"assinatura inválida: {exc}") from exc
        tipo = ev["type"]
        obj = ev["data"]["object"]
        confirmados = ("checkout.session.completed", "checkout.session.async_payment_succeeded")
        if tipo in confirmados and obj.get("payment_status") == "paid":
            ref = obj.get("client_reference_id") or (obj.get("metadata") or {}).get("ref")
            if ref and db.marcar_pago(ref):
                log.info("pagamento confirmado %s", ref)
        return {"ok": True}

    # ------------------------------------------------------------------ WebSocket
    @app.websocket("/chat/ws")
    async def ws_chat(ws: WebSocket, token: str = Query(default="")) -> None:
        claims = verificar_token(cfg.jwt_secret, token)
        if claims is None or db.bloqueado(claims["sub"]):
            await ws.close(code=WS_NAO_AUTORIZADO)
            return
        exp = datetime.fromtimestamp(claims["exp"], tz=UTC)
        await ws.accept()
        await hub.entrar(ws, claims)
        sub, apelido = claims["sub"], claims["apelido"]
        erros_seguidos = 0
        try:
            while True:
                raw = await ws.receive_text()
                if datetime.now(UTC) >= exp:
                    await ws.close(code=WS_NAO_AUTORIZADO)
                    break
                try:
                    dado = orjson.loads(raw)
                except orjson.JSONDecodeError:
                    continue
                tipo = dado.get("tipo")
                if tipo == "ping":
                    await ws.send_bytes(orjson.dumps({"tipo": "pong"}))
                    continue
                if tipo != "msg":
                    continue
                try:
                    texto = higienizar(str(dado.get("texto", "")), max_len=cfg.msg_max)
                except TextoInvalido as exc:
                    await _erro(ws, "texto_invalido", str(exc))
                    continue
                if bloqueado(texto, padroes):
                    await _erro(ws, "bloqueado", "mensagem contém termos não permitidos")
                    continue
                ok, motivo = limite.permitir(sub, texto)
                if not ok:
                    erros_seguidos += 1
                    if erros_seguidos >= 20:
                        await ws.close(code=WS_LIMITE)
                        break
                    await _erro(
                        ws, motivo or "rate_limit", "aguarde um instante antes de enviar de novo"
                    )
                    continue
                erros_seguidos = 0
                await hub.publicar_msg(sub, apelido, texto)
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("ws %s", sub)
            with contextlib.suppress(Exception):
                await ws.close()
        finally:
            hub.sair(ws)
            limite.esquecer(sub)

    return app


async def _erro(ws: WebSocket, codigo: str, texto: str) -> None:
    await ws.send_bytes(orjson.dumps({"tipo": "erro", "codigo": codigo, "texto": texto}))


app = criar_app()
