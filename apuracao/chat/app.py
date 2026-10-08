"""FastAPI do chat: checkout, acesso, estado, webhook e WebSocket. Contrato em docs/CHAT.md."""

from __future__ import annotations

import contextlib
import logging
import secrets
import time
from datetime import UTC, datetime
from typing import Any

import orjson
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from . import JWT_SECRET_PADRAO, Config
from .auth import ApelidoInvalido, emitir_token, normalizar_apelido, novo_ref, verificar_token
from .contas import (
    EmailInvalido,
    GoogleInvalido,
    apelido_de_nome,
    corpo_email_login,
    enviar_email,
    hash_token,
    normalizar_email,
    novo_id_usuario,
    novo_token_login,
    verificar_google,
)
from .db import DB
from .espera import WhatsAppInvalido, formatar_whatsapp, normalizar_whatsapp
from .hub import Hub, codigo_autor, reacao_valida, sala_valida
from .moderacao import LimiteTaxa, TextoInvalido, bloqueado, carregar_bloqueio, higienizar
from .pagamentos import ProvedorStripe, anexar_query, criar_provedor

log = logging.getLogger("apuracao.chat")

WS_NAO_AUTORIZADO = 4401
WS_LIMITE = 4429
WS_SALA_INVALIDA = 4400
WS_PAGAMENTO = 4402  # conta válida, mas sem pagamento


class CheckoutIn(BaseModel):
    apelido: str = Field(min_length=1, max_length=64)
    # e-mail só quando não há conta logada (Authorization: Bearer); com conta, vem dela
    email: str | None = Field(default=None, max_length=254)
    retorno: str = Field(min_length=1, max_length=2048)


class GoogleIn(BaseModel):
    credential: str = Field(min_length=8, max_length=4096)


class EsperaIn(BaseModel):
    whatsapp: str = Field(min_length=8, max_length=32)
    origem: str | None = Field(default=None, max_length=64)


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
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
    if cfg.pagamento != "dev" and cfg.jwt_secret == JWT_SECRET_PADRAO:
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

    def _claims_de(request: Request) -> dict | None:
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            return None
        claims = verificar_token(cfg.jwt_secret, auth.removeprefix("Bearer ").strip())
        if claims is None or db.bloqueado(claims["sub"]):
            return None
        return claims

    # ------------------------------------------------------------------ HTTP
    @app.get("/chat/estado")
    async def estado() -> JSONResponse:
        return JSONResponse(
            {
                "online": await hub.online(),
                "salas": await hub.salas(),
                "aberto": True,
                "preco_centavos": cfg.preco_centavos,
                "mensagens_total": db.total_mensagens(),
                "provedor": provedor.nome,
                "contas": db.total_usuarios(),
            },
            headers={"Cache-Control": "public, max-age=5"},
        )

    @app.get("/chat/previa")
    async def previa(sala: str = Query(default="geral")) -> JSONResponse:
        """Prévia pública (somente leitura) da sala: últimas mensagens para o paywall desfocado."""
        sala_ok = sala_valida(sala)
        if sala_ok is None:
            raise HTTPException(422, "sala inválida")
        itens = await hub.ultimas(sala_ok)
        return JSONResponse(
            {
                "sala": sala_ok,
                "online": await hub.online(sala_ok),
                "mensagens": [
                    {
                        "apelido": m.get("apelido"),
                        "texto": m.get("texto"),
                        "t": m.get("t"),
                        "tipo": m.get("tipo", "msg"),
                    }
                    for m in itens[-20:]
                ],
            },
            headers={"Cache-Control": "public, max-age=5"},
        )

    @app.post("/chat/checkout")
    def checkout(body: CheckoutIn, request: Request) -> dict[str, Any]:
        """Com conta logada (Entrar com Google), o pagamento já nasce vinculado a ela e o e-mail
        é o da conta. Sem conta, o e-mail vem no corpo e a conta é criada na confirmação."""
        claims = _claims_de(request)
        usuario = db.usuario(claims["sub"]) if claims else None
        try:
            apelido = normalizar_apelido(body.apelido)
            if usuario is not None:
                email = usuario["email"]
            elif body.email:
                email = normalizar_email(body.email)
            else:
                raise HTTPException(422, "entre com o Google ou informe um e-mail")
        except (ApelidoInvalido, EmailInvalido) as exc:
            raise HTTPException(422, str(exc)) from exc
        if not body.retorno.startswith(("http://", "https://")):
            raise HTTPException(422, "retorno deve ser uma URL absoluta")
        ref = novo_ref()
        ck = provedor.criar_checkout(
            ref=ref,
            apelido=apelido,
            retorno=body.retorno,
            valor_centavos=cfg.preco_centavos,
            email=email,
        )
        db.criar_pagamento(
            ref,
            provedor.nome,
            apelido,
            cfg.preco_centavos,
            ck.provedor_id,
            email=email,
            usuario_id=usuario["id"] if usuario is not None else None,
        )
        if usuario is not None and usuario["apelido"] != apelido:
            db.obter_ou_criar_usuario(usuario["id"], email, apelido)  # atualiza o apelido
        return {"url": ck.url, "ref": ref}

    def _sessao(usuario_id: str, apelido: str, email: str | None) -> JSONResponse:
        """Token de longa duração: quem pagou fica logado (a conta vale para a plataforma)."""
        token, exp = emitir_token(cfg.jwt_secret, usuario_id, apelido, cfg.jwt_dias, email=email)
        return JSONResponse(
            {
                "token": token,
                "apelido": apelido,
                "email": email,
                "expira_em": exp.isoformat(),
                "autor": codigo_autor(usuario_id),
                "pago": db.conta_pagou(usuario_id),
            }
        )

    def _conta_do_pagamento(pg: Any, email_confirmado: str | None = None) -> tuple[str, str | None]:
        """Garante a conta do pagamento pago e devolve (sub, email). Pagamentos antigos sem
        e-mail continuam com o ``ref`` como identidade."""
        if pg["usuario_id"]:
            u = db.usuario(pg["usuario_id"])
            if u is not None:
                return u["id"], u["email"]
        email = email_confirmado or pg["email"]
        if not email:
            return pg["ref"], None
        u = db.obter_ou_criar_usuario(novo_id_usuario(), email, pg["apelido"])
        db.vincular_pagamento(pg["ref"], u["id"], email)
        return u["id"], u["email"]

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
        pg = db.pagamento(ref)
        sub, email = _conta_do_pagamento(pg)
        if email:
            db.tocar_acesso(sub)
        return _sessao(sub, pg["apelido"], email)

    @app.get("/chat/eu")
    def eu(request: Request) -> dict[str, Any]:
        """Valida o token (``Authorization: Bearer``) sem abrir WebSocket."""
        claims = _claims_de(request)
        if claims is None:
            raise HTTPException(401, "token inválido ou expirado")
        return {
            "apelido": claims["apelido"],
            "email": claims.get("email"),
            "expira_em": datetime.fromtimestamp(claims["exp"], tz=UTC).isoformat(),
            "autor": codigo_autor(claims["sub"]),
            "pago": db.conta_pagou(claims["sub"]),
        }

    # ------------------------------------------------------------------ lista de espera
    espera_ips: dict[str, list[float]] = {}

    @app.post("/espera")
    def espera_entrar(body: EsperaIn, request: Request) -> dict[str, Any]:
        """Guarda o WhatsApp de quem quer ser avisado do lançamento. 10 por minuto por IP."""
        ip = request.headers.get("cf-connecting-ip") or (
            request.client.host if request.client else "?"
        )
        agora_ = time.monotonic()
        janela = [t for t in espera_ips.get(ip, []) if agora_ - t < 60]
        if len(janela) >= 10:
            raise HTTPException(429, "muitas tentativas; aguarde um minuto")
        try:
            numero = normalizar_whatsapp(body.whatsapp)
        except WhatsAppInvalido as exc:
            raise HTTPException(422, str(exc)) from exc
        janela.append(agora_)
        espera_ips[ip] = janela
        if len(espera_ips) > 10_000:  # não cresce para sempre
            espera_ips.clear()
        novo = db.entrar_espera(numero, (body.origem or "")[:64] or None)
        return {"ok": True, "novo": novo, "whatsapp": formatar_whatsapp(numero)}

    @app.get("/espera/total")
    def espera_total() -> JSONResponse:
        return JSONResponse(
            {"total": db.total_espera()}, headers={"Cache-Control": "public, max-age=30"}
        )

    @app.get("/espera.csv")
    def espera_csv(chave: str = Query(default="")) -> PlainTextResponse:
        """Exporta a lista (só com ``ESPERA_CHAVE``)."""
        if not cfg.espera_chave or not secrets.compare_digest(chave, cfg.espera_chave):
            raise HTTPException(404)
        linhas = ["whatsapp,criado_em,origem"]
        for r in db.listar_espera():
            origem = (r["origem"] or "").replace(",", " ")
            linhas.append(f"{r['whatsapp']},{r['criado_em']},{origem}")
        return PlainTextResponse(
            "\n".join(linhas) + "\n",
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=lista-de-espera.csv"},
        )

    @app.post("/conta/google")
    def conta_google(body: GoogleIn) -> JSONResponse:
        """Entrar com Google: o ID token do botão vira (ou reencontra) a conta e uma sessão.
        ``pago`` diz se essa conta já tem o chat liberado."""
        if cfg.google_client_id:
            try:
                g = verificar_google(body.credential, cfg.google_client_id)
            except GoogleInvalido as exc:
                raise HTTPException(401, str(exc)) from exc
        elif cfg.pagamento == "dev" and body.credential.startswith("dev:"):
            # só em desenvolvimento (que já não cobra): "dev:<email>:<nome>"
            partes = body.credential.split(":", 2)
            g = {
                "sub": "dev-" + partes[1],
                "email": normalizar_email(partes[1]),
                "nome": partes[2] if len(partes) > 2 else "",
                "foto": None,
            }
        else:
            raise HTTPException(501, "Entrar com Google não está configurado (GOOGLE_CLIENT_ID)")
        u = db.usuario_por_google(g["sub"])
        if u is None:
            u = db.obter_ou_criar_usuario(
                novo_id_usuario(), g["email"], apelido_de_nome(g["nome"], g["email"])
            )
        db.vincular_google(u["id"], g["sub"], g["nome"], g["foto"])
        u = db.usuario(u["id"])
        return _sessao(u["id"], u["apelido"], u["email"])

    # ------------------------------------------------------------------ conta (login por e-mail)
    @app.post("/conta/login")
    def conta_login(body: LoginIn) -> dict[str, Any]:
        """Envia um link de acesso de uso único (30 min) para quem já tem conta. A resposta é
        sempre a mesma, exista ou não a conta, para não revelar e-mails cadastrados."""
        try:
            email = normalizar_email(body.email)
        except EmailInvalido as exc:
            raise HTTPException(422, str(exc)) from exc
        if not body.retorno.startswith(("http://", "https://")):
            raise HTTPException(422, "retorno deve ser uma URL absoluta")
        resposta: dict[str, Any] = {"ok": True}
        u = db.usuario_por_email(email)
        if u is not None:
            tok, tok_hash, exp = novo_token_login()
            db.criar_login(tok_hash, u["id"], exp.isoformat())
            link = anexar_query(body.retorno, login=tok)
            assunto, texto = corpo_email_login(link, u["apelido"])
            enviado = enviar_email(
                api_key=cfg.resend_api_key,
                de=cfg.email_de,
                para=email,
                assunto=assunto,
                texto=texto,
            )
            if cfg.pagamento == "dev" and not enviado:
                resposta["link"] = link  # dev sem e-mail: devolve o link para testar o fluxo
        return resposta

    @app.get("/conta/entrar")
    def conta_entrar(token: str = Query(min_length=16, max_length=128)) -> JSONResponse:
        uid = db.consumir_login(hash_token(token))
        u = db.usuario(uid) if uid else None
        if u is None:
            raise HTTPException(410, "link inválido, já usado ou vencido; peça um novo")
        db.tocar_acesso(u["id"])
        return _sessao(u["id"], u["apelido"], u["email"])

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
        obj = ev["data"]["object"]  # StripeObject: acesso por item, não por .get
        confirmados = ("checkout.session.completed", "checkout.session.async_payment_succeeded")
        if tipo in confirmados and _campo(obj, "payment_status") == "paid":
            meta_ = _campo(obj, "metadata") or {}
            ref = _campo(obj, "client_reference_id") or _campo(meta_, "ref")
            if ref and db.marcar_pago(ref):
                log.info("pagamento confirmado %s", ref)
            if ref and (pg := db.pagamento(ref)) is not None and pg["status"] == "pago":
                detalhes = _campo(obj, "customer_details") or {}
                email_conf = _campo(detalhes, "email")
                try:
                    email_conf = normalizar_email(email_conf) if email_conf else None
                except EmailInvalido:
                    email_conf = None
                _conta_do_pagamento(pg, email_conf)
        return {"ok": True}

    # ------------------------------------------------------------------ WebSocket
    @app.websocket("/chat/ws")
    async def ws_chat(
        ws: WebSocket, token: str = Query(default=""), sala: str = Query(default="geral")
    ) -> None:
        await ws.accept()  # antes do close, senão o navegador vê 1006 em vez de 4401
        claims = verificar_token(cfg.jwt_secret, token)
        if claims is None or db.bloqueado(claims["sub"]):
            await ws.close(code=WS_NAO_AUTORIZADO)
            return
        if not db.conta_pagou(claims["sub"]):
            await ws.close(code=WS_PAGAMENTO)  # logado com Google, mas ainda sem os R$ 5
            return
        sala_ok = sala_valida(sala)
        if sala_ok is None:
            await ws.close(code=WS_SALA_INVALIDA)
            return
        exp = datetime.fromtimestamp(claims["exp"], tz=UTC)
        await hub.entrar(ws, claims, sala_ok)
        sub, apelido = claims["sub"], claims["apelido"]
        erros_seguidos = 0
        reacoes_janela: list[float] = []  # instantes das últimas reações (limite 5/s)
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
                    await ws.send_text('{"tipo":"pong"}')
                    continue
                if tipo == "reacao":
                    valor = str(dado.get("valor", ""))
                    agora = time.monotonic()
                    reacoes_janela[:] = [t for t in reacoes_janela if agora - t < 1.0]
                    if len(reacoes_janela) >= 5 or not reacao_valida(valor, hub.cands):
                        continue  # excesso ou valor inválido: ignorado em silêncio
                    reacoes_janela.append(agora)
                    await hub.reagir(sala_ok, valor)
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
                if hub.sala_lotada(sala_ok):
                    await _erro(
                        ws,
                        "lotado",
                        "a sala está muito movimentada; tente de novo em alguns segundos",
                    )
                    continue
                await hub.publicar_msg(sub, apelido, texto, sala_ok)
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


def _campo(obj: Any, chave: str) -> Any:
    """Lê ``chave`` de um dict ou StripeObject sem depender de ``.get``."""
    try:
        return obj[chave]
    except (KeyError, TypeError, AttributeError):
        return None


async def _erro(ws: WebSocket, codigo: str, texto: str) -> None:
    await ws.send_text(orjson.dumps({"tipo": "erro", "codigo": codigo, "texto": texto}).decode())


app = criar_app()
