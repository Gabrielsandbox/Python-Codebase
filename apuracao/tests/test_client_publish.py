import json

import httpx
import pytest
import respx

from apuracao import publish
from apuracao.storage import LocalStorage
from apuracao.tse import urls
from apuracao.tse.client import TSEClient
from apuracao.tse.eleicoes import encontrar, parse_catalogo, parse_municipios
from apuracao.tse.parse import parse_resultado


def test_urls():
    assert urls.resultado("ele2026", 6258, 1, "br") == (
        "https://resultados.tse.jus.br/oficial/ele2026/6258/dados/br/br-c0001-e006258-u.json"
    )
    assert urls.resultado("ele2026", "6258", "1", "SP", "71072") == (
        "https://resultados.tse.jus.br/oficial/ele2026/6258/dados/sp/sp71072-c0001-e006258-u.json"
    )
    assert urls.config_municipios("ele2026", 6258).endswith("/6258/config/mun-e006258-cm.json")


@respx.mock
async def test_get_condicional_e_304(doc_br):
    url = urls.resultado_br("ele2026", 6257, 1)
    body = json.dumps(doc_br).encode()
    rota = respx.get(url)
    rota.side_effect = [
        httpx.Response(200, content=body, headers={"ETag": '"abc"', "Last-Modified": "x"}),
        httpx.Response(304),
        httpx.Response(200, content=body, headers={"ETag": '"abc"'}),
    ]
    async with TSEClient(rate_per_s=1000) as c:
        r1 = await c.fetch(url)
        assert r1.status == 200 and r1.changed and r1.etag == '"abc"'
        r2 = await c.fetch(url)
        assert r2.status == 304 and not r2.changed and r2.body == body  # corpo vem do cache
        r3 = await c.fetch(url)
        assert r3.status == 200 and not r3.changed  # mesmo corpo → não mudou
    # 2ª e 3ª chamadas enviaram If-None-Match
    assert rota.calls[1].request.headers["If-None-Match"] == '"abc"'


@respx.mock
async def test_404_nao_retenta_e_5xx_retenta():
    url = urls.resultado_br("ele2026", 6258, 1)
    rota = respx.get(url).mock(return_value=httpx.Response(404))
    async with TSEClient(rate_per_s=1000) as c:
        r = await c.fetch(url)
    assert r.status == 404 and not r.ok and rota.call_count == 1

    rota.side_effect = [httpx.Response(503), httpx.Response(200, content=b"{}")]
    async with TSEClient(rate_per_s=1000, max_retries=2) as c:
        r = await c.fetch(url)
    assert r.status == 200 and rota.call_count == 3  # 1 (404 acima) + 503 + 200


def test_publish_snapshots(doc_br, doc_sp, doc_mun_sp, doc_catalogo, doc_municipios, tmp_path):
    br = parse_resultado(doc_br)
    sp = parse_resultado(doc_sp)
    cands = publish.ordem_candidatos(br)
    assert cands[0] == next(c.id for c in br.candidatos if c.numero == "13")  # ordem por número

    ele = encontrar(parse_catalogo(doc_catalogo), ano=2026, turno=1, cargo=1)
    meta = publish.build_meta(ele, "1", br, cands)
    assert (
        meta["schema"] == 1 and meta["eleicao"] == "6257" and len(meta["candidatos"]) == len(cands)
    )
    assert meta["candidatos"][cands[0]]["nome"] == "LULA" and meta["candidatos"][cands[0]][
        "cor"
    ].startswith("#")

    b = publish.build_br(br, cands)
    assert b["lider"] == next(c.id for c in br.candidatos if c.numero == "22")
    assert (
        sum(b["v"]) == b["votos"]["validos"] and b["margem_pct"] == 1.87 and b["definido"] is False
    )

    u = publish.build_uf({"SP": sp}, cands, b["atualizado_em"])
    assert u["ufs"]["SP"]["nome"] == "São Paulo" and u["ufs"]["SP"]["ibge"] == "35"

    muns = parse_municipios(doc_municipios)
    m = next(x for x in muns if x.nome == "RIO BRANCO")
    mun = publish.build_mun(
        {m.tse: (m, parse_resultado(doc_mun_sp, uf_hint="AC"))}, cands, b["atualizado_em"]
    )
    assert (
        mun["campos"][0] == "ibge"
        and mun["linhas"][0][0] == "1200401"
        and mun["linhas"][0][1] == "AC"
    )
    assert len(mun["linhas"][0][-1]) == len(cands)

    tl = publish.Timeline(cands)
    assert tl.adicionar(br) is True and tl.adicionar(br) is False  # mesmo idg não duplica
    d = tl.to_dict()
    assert len(d["pontos"]) == 1 and d["pontos"][0]["secoes_pct"] == 100.0
    assert publish.Timeline.from_dict(d, cands).pontos == d["pontos"]
    assert publish.Timeline.from_dict(d, ["outro"]).pontos == []  # cands diferentes → reinicia

    st = LocalStorage(tmp_path)
    st.write_json("6257/1/br.json", b)
    assert st.read_json("6257/1/br.json")["lider"] == b["lider"]
    with pytest.raises(ValueError):
        st.write_json("../fora.json", {})


def test_cores_por_partido(doc_br, doc_catalogo):
    br = parse_resultado(doc_br)
    cands = publish.ordem_candidatos(br)
    cores = {"PT": "#c8102e", "PL": "#1f4fd8"}
    meta = publish.build_meta(
        encontrar(parse_catalogo(doc_catalogo), ano=2026, turno=1, cargo=1),
        "1",
        br,
        cands,
        cores=cores,
    )
    por_nome = {v["nome"]: v["cor"] for v in meta["candidatos"].values()}
    assert por_nome["LULA"] == "#c8102e" and por_nome["FLAVIO BOLSONARO"] == "#1f4fd8"
    assert len(set(por_nome.values())) == len(por_nome)  # 12 cores distintas


def test_timeline_nao_duplica_apos_reinicio(doc_br):
    br = parse_resultado(doc_br)
    cands = publish.ordem_candidatos(br)
    tl = publish.Timeline(cands)
    tl.adicionar(br)
    tl2 = publish.Timeline.from_dict(tl.to_dict(), cands)  # "reinício" do coletor
    assert tl2.adicionar(br) is False and len(tl2.pontos) == 1
