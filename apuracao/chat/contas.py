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
import jwt

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


# ---------------------------------------------------------------- Entrar com Google
# O botão do Google (Identity Services) devolve um ID token (JWT RS256) assinado pelo Google.
# Verificamos assinatura (JWKS do Google), emissor, audiência (nosso client id) e e-mail verificado.
GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISS = ("accounts.google.com", "https://accounts.google.com")
_jwks: jwt.PyJWKClient | None = None


class GoogleInvalido(ValueError):
    pass


def verificar_google(credential: str, client_id: str) -> dict:
    """Devolve ``{"sub", "email", "nome", "foto"}`` ou lança :class:`GoogleInvalido`."""
    global _jwks
    try:
        if _jwks is None:
            _jwks = jwt.PyJWKClient(GOOGLE_JWKS, cache_keys=True, lifespan=3600)
        chave = _jwks.get_signing_key_from_jwt(credential)
        claims = jwt.decode(
            credential,
            chave.key,
            algorithms=["RS256"],
            audience=client_id,
            issuer=GOOGLE_ISS,
            options={"require": ["exp", "iat", "sub", "email"]},
        )
    except (jwt.PyJWTError, ValueError) as exc:
        raise GoogleInvalido("credencial do Google inválida") from exc
    if not claims.get("email_verified"):
        raise GoogleInvalido("e-mail do Google não verificado")
    return {
        "sub": str(claims["sub"]),
        "email": normalizar_email(claims["email"]),
        "nome": str(claims.get("given_name") or claims.get("name") or "").strip(),
        "foto": claims.get("picture"),
    }


def apelido_de_nome(nome: str, email: str) -> str:
    """Apelido inicial a partir do nome do Google (a pessoa pode trocar no checkout)."""
    import re as _re

    base = (nome or email.split("@")[0]).strip()
    base = _re.sub(r"[^A-Za-zÀ-ÿ0-9_ ]", "", base)[:24].strip()
    return base if len(base) >= 2 else "Visitante"
