"""Tokens de acesso (JWT HS256) e validação de apelido."""

from __future__ import annotations

import re
import secrets
import unicodedata
from datetime import UTC, datetime, timedelta

import jwt

APELIDO_RE = re.compile(r"^[A-Za-zÀ-ÿ0-9_ ]{2,24}$")


class ApelidoInvalido(ValueError):
    pass


def normalizar_apelido(apelido: str) -> str:
    """Remove controles, colapsa espaços e valida 2–24 chars de letras/números/_/espaço."""
    a = unicodedata.normalize("NFC", (apelido or "")).strip()
    a = re.sub(r"\s+", " ", a)
    a = "".join(ch for ch in a if unicodedata.category(ch)[0] != "C")
    if not APELIDO_RE.match(a):
        raise ApelidoInvalido("apelido deve ter 2–24 letras, números, espaço ou _")
    return a


def novo_ref() -> str:
    return "ch_" + secrets.token_urlsafe(16)


def emitir_token(secret: str, sub: str, apelido: str, dias: int) -> tuple[str, datetime]:
    exp = datetime.now(UTC) + timedelta(days=dias)
    tok = jwt.encode(
        {
            "sub": sub,
            "apelido": apelido,
            "exp": exp,
            "iat": datetime.now(UTC),
            "scope": "chat",
        },
        secret,
        algorithm="HS256",
    )
    return tok, exp


def verificar_token(secret: str, token: str) -> dict | None:
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if claims.get("scope") != "chat" or not claims.get("sub") or not claims.get("apelido"):
        return None
    return claims
