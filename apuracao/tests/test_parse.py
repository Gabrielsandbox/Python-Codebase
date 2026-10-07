from apuracao.tse.eleicoes import encontrar, parse_catalogo, parse_municipios
from apuracao.tse.parse import parse_resultado, to_iso_brt


def test_parse_br(doc_br):
    r = parse_resultado(doc_br)
    assert r.nivel == "br" and r.codigo == "br" and r.uf is None
    assert r.eleicao == "6257" and r.turno == 1 and r.cargo == "1" and r.cargo_nome == "Presidente"
    assert r.gerado_em == "2026-10-05T12:51:47-03:00"
    assert r.secoes_total == 499248 and r.secoes_totalizadas == 499248 and r.secoes_pct == 100.0
    assert r.aptos == 158745502 and r.comparecimento == 125275835 and r.abstencao == 33469244
    assert r.validos == 119300788 and r.brancos == 2300798 and r.nulos == 3674249
    assert r.pct_validos == 95.23 and r.pct_brancos == 1.84 and r.pct_nulos == 2.93
    # soma dos votos nominais = válidos (eleição majoritária)
    assert sum(c.votos for c in r.candidatos) == r.validos
    lider = r.lider
    assert lider.nome == "FLAVIO BOLSONARO" and lider.numero == "22" and lider.partido == "PL"
    assert lider.votos == 56104503 and lider.pct == 47.03 and lider.vice == "ALFREDO GASPAR"
    assert lider.situacao == "2º turno" and not lider.eleito
    assert r.margem_votos == 56104503 - 53879538 and r.margem_pct == 1.87
    assert r.definido is False


def test_parse_uf_e_municipio(doc_sp, doc_mun_sp):
    uf = parse_resultado(doc_sp)
    assert uf.nivel == "uf" and uf.codigo == "sp" and uf.uf == "SP"
    mun = parse_resultado(doc_mun_sp, uf_hint="sp")
    assert mun.nivel == "mu" and mun.codigo == "71072" and mun.uf == "SP"
    assert mun.lider.nome == "LULA"
    assert mun.aptos > 9_000_000


def test_eleito_detectado():
    doc = {
        "ele": "6258",
        "t": "2",
        "tpabr": "br",
        "cdabr": "br",
        "dg": "25/10/2026",
        "hg": "20:00:00",
        "idg": "1",
        "s": {"ts": "10", "st": "10", "pst": "100,00"},
        "e": {"te": "100", "c": "90", "a": "10", "pc": "90,00", "pa": "10,00"},
        "v": {
            "tv": "90",
            "vv": "80",
            "vb": "5",
            "tvn": "5",
            "pvvc": "88,89",
            "pvb": "5,56",
            "ptvn": "5,56",
        },
        "carg": [
            {
                "cd": "1",
                "nmn": "Presidente",
                "agr": [
                    {
                        "com": "A",
                        "par": [
                            {
                                "sg": "A",
                                "cand": [
                                    {
                                        "sqcand": "1",
                                        "n": "10",
                                        "nm": "A",
                                        "nmu": "A",
                                        "vap": "50",
                                        "pvap": "62,50",
                                        "e": "s",
                                        "st": "Eleito",
                                        "seq": "1",
                                    }
                                ],
                            }
                        ],
                    },
                    {
                        "com": "B",
                        "par": [
                            {
                                "sg": "B",
                                "cand": [
                                    {
                                        "sqcand": "2",
                                        "n": "20",
                                        "nm": "B",
                                        "nmu": "B",
                                        "vap": "30",
                                        "pvap": "37,50",
                                        "e": "n",
                                        "st": "Não eleito",
                                        "seq": "2",
                                    }
                                ],
                            }
                        ],
                    },
                ],
            }
        ],
    }
    r = parse_resultado(doc)
    assert r.definido and r.lider.id == "1" and r.margem_pct == 25.0


def test_to_iso_brt():
    assert to_iso_brt("05/10/2026", "12:51:47") == "2026-10-05T12:51:47-03:00"
    assert to_iso_brt(None, "1") is None
    assert to_iso_brt("xx", "yy") is None


def test_catalogo_2026(doc_catalogo):
    cat = parse_catalogo(doc_catalogo)
    e1 = encontrar(cat, ano=2026, turno=1, cargo=1)
    assert e1 and e1.codigo == "6257" and e1.ciclo == "ele2026" and e1.codigo_2turno == "6258"
    assert e1.pleito == "3220" and e1.data.isoformat() == "2026-10-04"
    # 2º turno ainda não listado no catálogo → derivado via cdt2
    e2 = encontrar(cat, ano=2026, turno=2, cargo=1)
    assert e2 and e2.codigo == "6258" and e2.turno == 2 and e2.ciclo == "ele2026"
    assert e2.data.isoformat() == "2026-10-25"
    gov = encontrar(cat, ano=2026, turno=1, cargo=3)
    assert gov and gov.codigo == "6259"


def test_municipios(doc_municipios):
    ms = parse_municipios(doc_municipios)
    assert len(ms) == 208
    rb = next(m for m in ms if m.nome == "RIO BRANCO")
    assert rb.uf == "AC" and rb.capital and rb.ibge == "1200401" and len(rb.tse) == 5
    assert any(m.uf == "ZZ" for m in ms)
