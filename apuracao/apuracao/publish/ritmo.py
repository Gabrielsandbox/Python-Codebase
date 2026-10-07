"""Ritmo da apuração: seções/min e ETA a partir da linha do tempo nacional (docs/RECURSOS.md §2).

É extrapolação da **velocidade de contagem**, nunca do resultado.
"""

from __future__ import annotations

from datetime import datetime, timedelta

JANELA_MIN = 10


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s)


def calcular_ritmo(
    timeline: dict | None,
    secoes_total: int,
    secoes_totalizadas: int,
    atualizado_em: str,
    *,
    votos_total: int = 0,
) -> dict:
    pontos = list((timeline or {}).get("pontos") or [])
    out = {
        "schema": 1,
        "atualizado_em": atualizado_em,
        "secoes_por_min": 0.0,
        "votos_por_min": 0,
        "janela_min": JANELA_MIN,
        "amostras": 0,
        "eta_90": None,
        "eta_100": None,
        "inicio": None,
        "fase": "aguardando",
    }
    if secoes_total <= 0 or not pontos:
        return out
    pct_atual = 100.0 * secoes_totalizadas / secoes_total
    primeiros = [p for p in pontos if p.get("secoes_pct", 0) > 0]
    if primeiros:
        out["inicio"] = primeiros[0]["t"]
    if pct_atual >= 100.0:
        out["fase"] = "concluida"
        return out
    if pct_atual <= 0:
        return out

    agora = _dt(atualizado_em)
    janela = [p for p in pontos if agora - _dt(p["t"]) <= timedelta(minutes=JANELA_MIN)]
    if len(janela) < 2:
        janela = pontos[-2:]
    out["amostras"] = len(janela)
    if len(janela) < 2:
        out["fase"] = "acelerando"
        return out
    p0, p1 = janela[0], janela[-1]
    minutos = (_dt(p1["t"]) - _dt(p0["t"])).total_seconds() / 60
    if minutos <= 0:
        out["fase"] = "acelerando"
        return out
    d_secoes = (p1["secoes_pct"] - p0["secoes_pct"]) / 100 * secoes_total
    spm = max(0.0, d_secoes / minutos)
    out["secoes_por_min"] = round(spm, 1)
    v0, v1 = sum(p0.get("v", [])), sum(p1.get("v", []))
    out["votos_por_min"] = int(max(0, (v1 - v0) / minutos)) if v1 >= v0 else 0

    if pct_atual >= 95:
        out["fase"] = "cauda"
    elif len(janela) < 3:
        out["fase"] = "acelerando"
    else:
        out["fase"] = "ritmo"

    if spm >= 1 and len(janela) >= 3:
        faltam_100 = secoes_total - secoes_totalizadas
        faltam_90 = max(0, int(0.9 * secoes_total) - secoes_totalizadas)
        out["eta_100"] = (
            (agora + timedelta(minutes=faltam_100 / spm)).replace(microsecond=0).isoformat()
        )
        out["eta_90"] = (
            (agora + timedelta(minutes=faltam_90 / spm)).replace(microsecond=0).isoformat()
            if faltam_90 > 0
            else None
        )
    return out
