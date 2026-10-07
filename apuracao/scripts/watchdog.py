#!/usr/bin/env python3
"""Vigia do dia da apuração: lê o ``status.json`` público (pelo CDN, como o público vê) e
alerta se a coleta envelhecer. Roda em qualquer lugar fora da infra principal (um cron em
outro provedor, o notebook de alguém da equipe).

    python scripts/watchdog.py https://dados.exemplo.com.br --max-idade 90 \
        --webhook https://hooks.slack.com/... (ou URL de bot do Telegram)

Sai com código 2 quando há alerta (útil para cron/healthchecks.io).
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import UTC, datetime


def get_json(url: str) -> dict:
    req = urllib.request.Request(
        url, headers={"Cache-Control": "no-cache", "User-Agent": "apuracao-watchdog"}
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def notificar(webhook: str | None, texto: str) -> None:
    print(texto)
    if not webhook:
        return
    corpo = json.dumps({"text": texto}).encode()
    req = urllib.request.Request(webhook, data=corpo, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15):
        pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", help="URL base dos snapshots (onde está ativo.json)")
    ap.add_argument("--max-idade", type=int, default=90, help="segundos desde a última coleta")
    ap.add_argument("--webhook", default=None)
    a = ap.parse_args()

    try:
        ativo = get_json(f"{a.base.rstrip('/')}/ativo.json")
        st = get_json(f"{a.base.rstrip('/')}/{ativo['prefixo']}/status.json")
    except Exception as exc:  # noqa: BLE001
        notificar(a.webhook, f"🚨 apuração: não consegui ler status.json ({exc})")
        return 2

    ultima = datetime.fromisoformat(st["ultima_coleta"])
    idade = (datetime.now(UTC) - ultima).total_seconds()
    problemas = []
    if idade > a.max_idade:
        problemas.append(f"última coleta há {int(idade)} s (limite {a.max_idade})")
    if st.get("erros_ciclo", 0) > 5:
        problemas.append(f"{st['erros_ciclo']} erros no último ciclo")
    if problemas:
        notificar(
            a.webhook, "🚨 apuração: " + "; ".join(problemas) + f" — eleição {st.get('eleicao')}"
        )
        return 2
    print(
        f"ok: coleta há {int(idade)} s, idg={st.get('fonte_idg')}, "
        f"municípios={st.get('municipios_coletados')}, aguardando={st.get('aguardando_totalizacao')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
