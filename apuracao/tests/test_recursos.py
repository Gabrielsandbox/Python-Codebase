"""caminho.json, ritmo.json, imagem OG e detecção de eventos de alerta."""

import json

from alertas.eventos import EstadoAlertas, detectar
from apuracao.publish.caminho import Base, calcular_caminho, construir_base
from apuracao.publish.og import desenhar_placar
from apuracao.publish.ritmo import calcular_ritmo
from apuracao.tse.eleicoes import Municipio
from apuracao.tse.parse import Candidato, Resultado

A, B = "cand_a", "cand_b"
META = {
    "cands": [A, B],
    "turno": 2,
    "cargo_nome": "Presidente",
    "data_eleicao": "2026-10-25",
    "candidatos": {
        A: {"nome": "ANA", "cor": "#c8102e", "numero": "13"},
        B: {"nome": "BETO", "cor": "#1f4fd8", "numero": "22"},
    },
}


def _res(nivel, codigo, uf, *, st, ts, va, vb):
    validos = va + vb
    cands = [
        Candidato(
            A,
            "13",
            "ANA",
            "ANA",
            "P1",
            "P1",
            None,
            va,
            round(100 * va / validos, 2) if validos else 0,
            False,
            "",
            1,
        ),
        Candidato(
            B,
            "22",
            "BETO",
            "BETO",
            "P2",
            "P2",
            None,
            vb,
            round(100 * vb / validos, 2) if validos else 0,
            False,
            "",
            2,
        ),
    ]
    return Resultado(
        eleicao="6258", turno=2, cargo="1", cargo_nome="Presidente", nivel=nivel, codigo=codigo, uf=uf,
        gerado_em="2026-10-25T19:00:00-03:00", idg="1", secoes_total=ts, secoes_totalizadas=st,
        secoes_pct=round(100 * st / ts, 2) if ts else 0, aptos=1000, comparecimento=800, abstencao=200,
        pct_comparecimento=80.0, pct_abstencao=20.0, votos_total=validos, validos=validos, brancos=0,
        nulos=0, pct_validos=100.0, pct_brancos=0.0, pct_nulos=0.0, candidatos=cands,
    )  # fmt: skip


def test_caminho_basico():
    # 2 municípios: X (SP, 100 seções, 1º turno 60/40 p/ A) e Y (BA, 100 seções, 30/70)
    base = Base(
        "6257",
        [A, B],
        {"3500001": (100, 10000, [6000, 4000]), "2900001": (100, 10000, [3000, 7000])},
    )
    muns = [
        Municipio("71001", "3500001", "SP", "CIDADE X", False),
        Municipio("30001", "2900001", "BA", "CIDADE Y", False),
    ]
    # X totalmente apurado (A 6000 × B 4000); Y pela metade (A 1500 × B 3500)
    atual = {
        "71001": (muns[0], _res("mu", "71001", "SP", st=100, ts=100, va=6000, vb=4000)),
        "30001": (muns[1], _res("mu", "30001", "BA", st=50, ts=100, va=1500, vb=3500)),
    }
    br = _res("br", "br", None, st=150, ts=200, va=7500, vb=7500)
    c = calcular_caminho(base, [A, B], br, atual, muns, "2026-10-25T19:00:00-03:00")
    assert c["restante"] == {
        "votos_est": 5000,
        "secoes": 50,
        "pct_secoes": 25.0,
        "municipios_abertos": 1,
    }
    assert c["necessario"] == {A: 50.0, B: 50.0}  # empatados: cada um precisa de metade
    assert c["definido_matematicamente"] is None
    assert c["por_regiao"]["Nordeste"]["votos_est"] == 5000 and c["por_regiao"]["Nordeste"][
        "base_pct"
    ] == [30.0, 70.0]
    assert c["por_uf"]["SP"]["votos_est"] == 0 and c["por_uf"]["SP"]["pct_secoes_restantes"] == 0.0
    assert (
        c["maiores_abertos"][0]["nome"] == "Cidade Y"
        and c["maiores_abertos"][0]["pct_secoes"] == 50.0
    )

    # A lidera por 1000 com 5000 restantes → B precisa de (1000+5000)/2 = 3000 = 60%
    br2 = _res("br", "br", None, st=150, ts=200, va=8000, vb=7000)
    c2 = calcular_caminho(base, [A, B], br2, atual, muns, "t")
    assert c2["necessario"] == {A: 40.0, B: 60.0}
    # A lidera por 6000 > 5000 restantes → matematicamente definido
    br3 = _res("br", "br", None, st=150, ts=200, va=11000, vb=5000)
    assert calcular_caminho(base, [A, B], br3, atual, muns, "t")["definido_matematicamente"] == A
    # nada começou: 50/50 e sem definição
    c0 = calcular_caminho(base, [A, B], None, {}, muns, "t")
    assert c0["restante"]["pct_secoes"] == 100.0 and c0["necessario"] == {A: 50.0, B: 50.0}


def test_construir_base_do_snapshot():
    meta = {
        "cands": ["x", A, B],
        "candidatos": {"x": {"numero": "70"}, A: {"numero": "13"}, B: {"numero": "22"}},
        "eleicao": "6257",
        "data_eleicao": "2026-10-04",
    }
    br = {
        "cands": ["x", A, B],
        "v": [5, 60, 40],
        "situacao": {"x": "Não eleito", A: "2º turno", B: "2º turno"},
    }
    mun = {
        "cands": ["x", A, B],
        "campos": [
            "ibge",
            "uf",
            "secoes_total",
            "secoes_totalizadas",
            "aptos",
            "comparecimento",
            "validos",
            "brancos",
            "nulos",
            "v",
        ],
        "linhas": [
            ["3500001", "SP", 100, 100, 1, 1, 105, 0, 0, [5, 60, 40]],
            ["", "ZZ", 1, 1, 1, 1, 1, 0, 0, [0, 1, 0]],
        ],
    }
    d = construir_base(meta, mun, br)
    assert d["cands"] == [A, B] and d["por_mun"] == {"3500001": [100, 105, [60, 40]]}


def test_ritmo():
    pts = [
        {"t": "2026-10-25T17:00:00-03:00", "secoes_pct": 0.0, "v": [0, 0]},
        {"t": "2026-10-25T17:05:00-03:00", "secoes_pct": 5.0, "v": [50, 50]},
        {"t": "2026-10-25T17:10:00-03:00", "secoes_pct": 10.0, "v": [100, 100]},
    ]
    r = calcular_ritmo({"pontos": pts}, 1000, 100, "2026-10-25T17:10:00-03:00")
    assert r["secoes_por_min"] == 10.0 and r["votos_por_min"] == 20 and r["fase"] == "ritmo"
    assert (
        r["eta_100"] == "2026-10-25T18:40:00-03:00" and r["eta_90"] == "2026-10-25T18:30:00-03:00"
    )
    assert r["inicio"] == "2026-10-25T17:05:00-03:00"
    assert calcular_ritmo(None, 1000, 0, "2026-10-25T17:10:00-03:00")["fase"] == "aguardando"
    assert calcular_ritmo({"pontos": pts}, 1000, 1000, "t")["fase"] == "concluida"
    assert (
        calcular_ritmo({"pontos": pts}, 1000, 960, "2026-10-25T17:10:00-03:00")["fase"] == "cauda"
    )


def test_og_png():
    bloco = {
        "cands": [A, B],
        "pct": [48.2, 51.8],
        "v": [4820, 5180],
        "secoes": {"pct": 73.1},
        "atualizado_em": "2026-10-25T19:00:00-03:00",
        "definido": True,
        "vencedor": B,
    }
    png = desenhar_placar(
        {**META, "simulacao": True}, bloco, nome_local="Brasil", site="apuracao.exemplo"
    )
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 5000


def test_eventos_alertas():
    est = EstadoAlertas()
    br = {
        "cands": [A, B],
        "pct": [52.0, 48.0],
        "secoes": {"pct": 30.0, "totalizadas": 300},
        "lider": A,
        "definido": False,
    }
    evs = detectar(est, META, br, None)
    assert [e.chave for e in evs] == ["inicio", "marcos-25"] and "Ana 52,0%" in evs[1].corpo
    assert detectar(est, META, br, None) == []  # nada novo
    br2 = {**br, "pct": [49.0, 51.0], "secoes": {"pct": 55.0, "totalizadas": 550}, "lider": B}
    evs = detectar(est, META, br2, {"definido_matematicamente": None})
    assert sorted(e.tipo for e in evs) == ["marcos", "virada"]
    evs = detectar(
        est,
        META,
        {**br2, "secoes": {"pct": 100.0, "totalizadas": 1000}, "definido": True, "vencedor": B},
        None,
    )
    assert [e.tipo for e in evs] == ["marcos", "marcos", "marcos", "marcos", "definido"]
    assert json.dumps([e.chave for e in evs]).count("marcos-") == 4
