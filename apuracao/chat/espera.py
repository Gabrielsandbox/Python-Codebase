"""Lista de espera: antes do lançamento o site só pede o WhatsApp de quem quer ser avisado."""

from __future__ import annotations

import re


class WhatsAppInvalido(ValueError):
    pass


def normalizar_whatsapp(valor: str) -> str:
    """Devolve o número no formato E.164 brasileiro (``+55DDDNÚMERO``) ou lança erro.

    Aceita com ou sem +55, com máscara ou só dígitos. Celular tem 9 dígitos após o DDD e começa
    com 9; fixo (8 dígitos) é recusado porque WhatsApp é celular.
    """
    d = re.sub(r"\D", "", valor or "")
    if d.startswith("55") and len(d) in (12, 13):
        d = d[2:]
    if len(d) == 10 and d[2] in "6789":  # celular antigo sem o 9: adiciona
        d = d[:2] + "9" + d[2:]
    if len(d) != 11 or d[2] != "9" or d[:2] < "11" or d[:2] > "99" or d[1] == "0":
        raise WhatsAppInvalido("informe um celular com DDD, ex.: (11) 99999-9999")
    if len(set(d[2:])) == 1:  # 99999-9999 etc.
        raise WhatsAppInvalido("informe um celular válido")
    return "+55" + d


def formatar_whatsapp(e164: str) -> str:
    d = e164.removeprefix("+55")
    return f"({d[:2]}) {d[2:7]}-{d[7:]}"
