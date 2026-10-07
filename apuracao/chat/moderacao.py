"""Higienização e moderação de mensagens.

- remove URLs e caracteres de controle, colapsa espaços, limita tamanho;
- bloqueia termos de ``data/ref/chat-bloqueio.txt`` (uma expressão por linha; ``#`` comenta);
- limite de taxa por usuário (``intervalo_s`` entre mensagens) e anti-flood (repetição).
"""

from __future__ import annotations

import re
import time
import unicodedata
from pathlib import Path

URL_RE = re.compile(
    r"(https?://\S+|www\.\S+|\S+\.(com|br|net|org|io|app|me|ly)(/\S*)?)", re.IGNORECASE
)


class TextoInvalido(ValueError):
    pass


def carregar_bloqueio(path: Path | None) -> list[re.Pattern[str]]:
    if not path or not path.exists():
        return []
    pats: list[re.Pattern[str]] = []
    for linha in path.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#"):
            continue
        pats.append(re.compile(r"\b" + re.escape(linha) + r"\b", re.IGNORECASE))
    return pats


def _sem_acentos(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def higienizar(texto: str, *, max_len: int) -> str:
    t = unicodedata.normalize("NFC", texto or "")
    t = "".join(ch for ch in t if unicodedata.category(ch)[0] != "C" or ch == "\n")
    t = URL_RE.sub("", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    if not t:
        raise TextoInvalido("mensagem vazia")
    if len(t) > max_len:
        raise TextoInvalido(f"máximo de {max_len} caracteres")
    # grito: mais de 20 letras e >80% maiúsculas → normaliza
    letras = [c for c in t if c.isalpha()]
    if len(letras) > 20 and sum(c.isupper() for c in letras) / len(letras) > 0.8:
        t = t.capitalize()
    return t


def bloqueado(texto: str, padroes: list[re.Pattern[str]]) -> bool:
    if not padroes:
        return False
    plano = _sem_acentos(texto)
    return any(p.search(texto) or p.search(plano) for p in padroes)


class LimiteTaxa:
    """Uma mensagem a cada ``intervalo_s`` por usuário + rejeição de repetição imediata."""

    def __init__(self, intervalo_s: float) -> None:
        self.intervalo = intervalo_s
        self._ultimo: dict[str, float] = {}
        self._ultimo_texto: dict[str, str] = {}

    def permitir(self, sub: str, texto: str) -> tuple[bool, str | None]:
        agora = time.monotonic()
        if agora - self._ultimo.get(sub, -1e9) < self.intervalo:
            return False, "rate_limit"
        if self._ultimo_texto.get(sub) == texto:
            return False, "repetida"
        self._ultimo[sub] = agora
        self._ultimo_texto[sub] = texto
        return True, None

    def esquecer(self, sub: str) -> None:
        self._ultimo.pop(sub, None)
        self._ultimo_texto.pop(sub, None)
