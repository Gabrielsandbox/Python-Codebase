"""Normalização de nomes, datas e valores das três fontes."""
from __future__ import annotations

import re
import unicodedata

_MINUSCULAS = {"da", "de", "do", "das", "dos", "e", "di", "du", "del", "della", "von", "van"}
_ROMANOS = {"II", "III", "IV", "VI"}


def chave(s: str) -> str:
    """Comparação de nomes entre fontes: sem acento, minúsculo, só letras e espaços simples."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z ]+", " ", s).split())


def nome_proprio(s: str) -> str:
    """"JOSÉ DA SILVA JÚNIOR" -> "José da Silva Júnior". Mantém numerais romanos."""
    partes = []
    for i, p in enumerate(s.strip().split()):
        if p in _ROMANOS:
            partes.append(p)
        elif i and p.lower() in _MINUSCULAS:
            partes.append(p.lower())
        else:
            partes.append("-".join(x[:1].upper() + x[1:].lower() for x in p.split("-")))
    return " ".join(partes)


def data_iso(s: str) -> str | None:
    """"06/08/1989" -> "1989-08-06"; aceita também ISO com hora."""
    s = (s or "").strip()
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})", s)
    if m:
        return f"{m[3]}-{m[2]}-{m[1]}"
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    return m[1] if m else None


def valor_br(s: str) -> float:
    """"29000,00" / "1.467,50" / "1467.5" -> float."""
    s = (s or "").strip()
    if not s:
        return 0.0
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return 0.0
