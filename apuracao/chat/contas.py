"""Contas: quem paga os R$ 5 vira usuário (e-mail) e fica logado; login por link no e-mail.

O chat é a porta de entrada da plataforma de dados: a conta criada aqui é a mesma que, depois da
apuração, acessa o acervo e a API. Nada de senha: o acesso é por link de uso único enviado ao
e-mail (válido por 30 minutos), ou pelo token já guardado no navegador.
"""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
from datetime import UTC, datetime, timedelta

import httpx

log = logging.getLogger("apuracao.chat.contas")

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
LOGIN_MINUTOS = 30


class EmailInvalido(ValueError):
    pass


def normalizar_email(email: str) -> str:
    e = (email or "").strip().lower()
    if len(e) > 254 or not EMAIL_RE.match(e):
        raise EmailInvalido("informe um e-mail válido")
    return e


def novo_id_usuario() -> str:
    return "u_" + secrets.token_urlsafe(12)


def novo_token_login() -> tuple[str, str, datetime]:
    """Token de uso único (vai no link) e o hash que fica no banco."""
    tok = secrets.token_urlsafe(32)
    return tok, hash_token(tok), datetime.now(UTC) + timedelta(minutes=LOGIN_MINUTOS)


def hash_token(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


def corpo_email_login(link: str, apelido: str) -> tuple[str, str]:
    assunto = "Seu acesso à Apuração ao Vivo"
    texto = (
        f"Olá, {apelido}!\n\n"
        f"Para entrar na sua conta, abra este link (vale por {LOGIN_MINUTOS} minutos):\n{link}\n\n"
        "Se você não pediu este acesso, ignore esta mensagem.\n\n"
        "Apuração ao Vivo · apuracaoaovivo.com"
    )
    return assunto, texto


def enviar_email(*, api_key: str | None, de: str, para: str, assunto: str, texto: str) -> bool:
    """Envia pelo Resend (https://resend.com). Sem ``api_key`` só registra no log (dev)."""
    if not api_key:
        log.info(
            "[e-mail não enviado: sem RESEND_API_KEY] para=%s assunto=%r\n%s", para, assunto, texto
        )
        return False
    try:
        r = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"from": de, "to": [para], "subject": assunto, "text": texto},
            timeout=10,
        )
        r.raise_for_status()
        return True
    except httpx.HTTPError:
        log.exception("falha ao enviar e-mail para %s", para)
        return False
