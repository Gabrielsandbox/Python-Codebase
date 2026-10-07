import json

import pytest
from fastapi.testclient import TestClient

from chat import Config
from chat.app import WS_NAO_AUTORIZADO, criar_app
from chat.auth import ApelidoInvalido, emitir_token, normalizar_apelido, verificar_token
from chat.auth import verificar_token as _vt
from chat.hub import codigo_autor, frase_placar


def codigo_autor_de(token):
    return codigo_autor(_vt("segredo-de-teste-com-mais-de-32-caracteres!", token)["sub"])


from chat.moderacao import LimiteTaxa, TextoInvalido, bloqueado, carregar_bloqueio, higienizar


@pytest.fixture
def cfg(tmp_path):
    bloq = tmp_path / "bloqueio.txt"
    bloq.write_text("# teste\npix premiado\n", encoding="utf-8")
    return Config(
        pagamento="dev",
        jwt_secret="segredo-de-teste-com-mais-de-32-caracteres!",
        db_path=tmp_path / "chat.sqlite",
        dados_base=None,
        bloqueio_path=bloq,
        intervalo_msg_s=0.0,
    )


@pytest.fixture
def cliente(cfg):
    with TestClient(criar_app(cfg)) as c:
        yield c


def proximo(ws, tipo):
    """Lê frames até achar ``tipo``; itens de ``lote`` contam como frames individuais."""
    fila = []
    while True:
        if fila:
            d = fila.pop(0)
        else:
            d = json.loads(ws.receive_text())
            if d["tipo"] == "lote":
                fila.extend(d["itens"])
                continue
        if d["tipo"] == tipo:
            return d


def comprar(cliente, apelido="Maria", email=None):
    email = email or f"{apelido.lower().replace(' ', '')}@exemplo.test"
    r = cliente.post(
        "/chat/checkout",
        json={"apelido": apelido, "email": email, "retorno": "https://site.test/ap"},
    )
    assert r.status_code == 200, r.text
    ref = r.json()["ref"]
    assert r.json()["url"] == f"https://site.test/ap?chat_ref={ref}"
    r = cliente.get("/chat/acesso", params={"ref": ref})
    assert r.status_code == 200, r.text
    return r.json()["token"], r.json()["apelido"]


def test_estado_e_checkout(cliente):
    r = cliente.get("/chat/estado")
    assert r.status_code == 200 and r.json()["preco_centavos"] == 500 and r.json()["online"] == 0
    assert (
        cliente.post("/chat/checkout", json={"apelido": "x", "retorno": "https://a/b"}).status_code
        == 422
    )
    assert (
        cliente.post(
            "/chat/checkout", json={"apelido": "Maria", "retorno": "javascript:1"}
        ).status_code
        == 422
    )
    assert cliente.get("/chat/acesso", params={"ref": "ch_inexistente"}).status_code == 404
    token, apelido = comprar(cliente, "  maria   silva ")
    assert apelido == "maria silva"
    assert (
        verificar_token("segredo-de-teste-com-mais-de-32-caracteres!", token)["apelido"]
        == "maria silva"
    )
    assert verificar_token("outro", token) is None


def test_ws_recusa_token_invalido(cliente):
    from starlette.websockets import WebSocketDisconnect

    # o servidor aceita e fecha com 4401 (assim o navegador enxerga o código)
    with cliente.websocket_connect("/chat/ws?token=lixo") as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
        assert exc.value.code == WS_NAO_AUTORIZADO


def test_ws_fluxo_completo(cliente):
    t1, _ = comprar(cliente, "Maria")
    t2, _ = comprar(cliente, "João")
    with (
        cliente.websocket_connect(f"/chat/ws?token={t1}") as a,
        cliente.websocket_connect(f"/chat/ws?token={t2}") as b,
    ):
        hist_a = json.loads(a.receive_text())
        assert hist_a["tipo"] == "historico" and hist_a["mensagens"] == []
        assert json.loads(a.receive_text())["tipo"] == "presenca"
        json.loads(b.receive_text())
        json.loads(b.receive_text())

        a.send_text(json.dumps({"tipo": "msg", "texto": "  Vai virar!  veja www.spam.com agora "}))
        ma = proximo(a, "msg")
        mb = proximo(b, "msg")
        assert ma["autor"] == mb["autor"] == codigo_autor_de(t1) and "sub" not in ma
        assert ma["texto"] == "Vai virar! veja agora" and ma["apelido"] == "Maria"
        assert ma["id"] == mb["id"]

        a.send_text(json.dumps({"tipo": "msg", "texto": "ganhe no pix premiado"}))
        assert proximo(a, "erro")["codigo"] == "bloqueado"

        a.send_text(json.dumps({"tipo": "msg", "texto": "Vai virar! veja agora"}))  # repetida
        assert proximo(a, "erro")["codigo"] == "repetida"

        a.send_text(json.dumps({"tipo": "msg", "texto": "x" * 300}))
        assert proximo(a, "erro")["codigo"] == "texto_invalido"

        a.send_text(json.dumps({"tipo": "ping"}))
        assert proximo(a, "pong")["tipo"] == "pong"

    # histórico persiste (sqlite) e reaparece para quem entra depois
    t3, _ = comprar(cliente, "Ana")
    with cliente.websocket_connect(f"/chat/ws?token={t3}") as c:
        hist = json.loads(c.receive_text())
        assert [m["texto"] for m in hist["mensagens"]] == ["Vai virar! veja agora"]
        assert hist["mensagens"][0]["eu"] is False
    with cliente.websocket_connect(f"/chat/ws?token={t1}") as c:
        assert (
            json.loads(c.receive_text())["mensagens"][0]["eu"] is True
        )  # histórico marca as minhas
    assert (
        cliente.get("/chat/eu", headers={"Authorization": f"Bearer {t1}"}).json()["apelido"]
        == "Maria"
    )
    assert cliente.get("/chat/eu", headers={"Authorization": "Bearer x"}).status_code == 401
    assert cliente.get("/chat/estado").json()["mensagens_total"] == 1


def test_moderacao_unidades(tmp_path):
    assert higienizar("  oi   https://x.com/a  tudo\x00bem ", max_len=280) == "oi tudobem"
    with pytest.raises(TextoInvalido):
        higienizar("https://so.link", max_len=280)
    assert higienizar("ISSO É UM GRITO MUITO ALTO MESMO VIU", max_len=280).startswith("Isso é")
    p = tmp_path / "b.txt"
    p.write_text("golpe\n# c\npix premiado\n", encoding="utf-8")
    pats = carregar_bloqueio(p)
    assert (
        bloqueado("foi GOLPE!", pats)
        and bloqueado("Pix Prêmiado aqui", pats)
        and not bloqueado("golpear", pats)
    )
    lim = LimiteTaxa(60)
    assert lim.permitir("u", "a") == (True, None)
    assert lim.permitir("u", "b") == (False, "rate_limit")
    with pytest.raises(ApelidoInvalido):
        normalizar_apelido("a")
    with pytest.raises(ApelidoInvalido):
        normalizar_apelido("<script>")
    tok, _ = emitir_token("s" * 32, "sub1", "Zé", 1)
    assert verificar_token("s" * 32, tok)["sub"] == "sub1"


def test_frase_placar():
    meta = {"candidatos": {"1": {"nome": "FLAVIO BOLSONARO"}, "2": {"nome": "LULA"}}}
    br = {"cands": ["2", "1"], "pct": [49.6, 50.4], "secoes": {"pct": 71.23}, "definido": False}
    assert (
        frase_placar(meta, br)
        == "Flavio Bolsonaro 50,4% × Lula 49,6% — 71,2% das seções totalizadas"
    )
    br["definido"], br["vencedor"] = True, "1"
    assert frase_placar(meta, br).startswith("🏁 Flavio Bolsonaro eleito. ")


def test_config_from_env_segredo_padrao(monkeypatch):
    from chat import JWT_SECRET_PADRAO

    monkeypatch.delenv("CHAT_JWT_SECRET", raising=False)
    assert Config.from_env().jwt_secret == JWT_SECRET_PADRAO
    monkeypatch.setenv("CHAT_PAGAMENTO", "stripe")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    with pytest.raises(RuntimeError):
        criar_app(Config.from_env())


def test_salas_reacoes_termometro(cliente):
    """Salas isolam mensagens; reações agregam em 2 s; termômetro soma a torcida."""
    import time as _time

    from starlette.websockets import WebSocketDisconnect

    cliente.app.state.hub.cands = {"c1", "c2"}

    ate = proximo

    t1, _ = comprar(cliente, "Maria")
    t2, _ = comprar(cliente, "João")
    # sala inválida → 4400
    with cliente.websocket_connect(f"/chat/ws?token={t1}&sala=XX") as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
        assert exc.value.code == 4400
    with (
        cliente.websocket_connect(f"/chat/ws?token={t1}&sala=SP") as sp,
        cliente.websocket_connect(f"/chat/ws?token={t2}") as geral,
    ):
        h = json.loads(sp.receive_text())
        assert h["tipo"] == "historico" and h["sala"] == "SP"
        assert json.loads(sp.receive_text())["sala"] == "SP"
        json.loads(geral.receive_text())
        json.loads(geral.receive_text())
        est = cliente.get("/chat/estado").json()
        assert est["salas"] == {"SP": 1, "geral": 1} and est["online"] == 2

        sp.send_text(json.dumps({"tipo": "msg", "texto": "só em SP"}))
        m = ate(sp, "msg")
        assert m["sala"] == "SP" and m["autor"] == codigo_autor_de(t1)
        # reações: 3 fogos + 2 torcidas; a 6ª reação no mesmo segundo é ignorada
        for v in ["🔥", "🔥", "🔥", "torcida:c1", "torcida:c1", "torcida:c2", "lixo"]:
            sp.send_text(json.dumps({"tipo": "reacao", "valor": v}))
        vistos: dict[str, dict] = {}
        fim = _time.monotonic() + 8
        while _time.monotonic() < fim and not ({"reacoes", "termometro"} <= set(vistos)):
            d = json.loads(sp.receive_text())
            if d["tipo"] == "lote":
                continue
            if d["tipo"] in ("reacoes", "termometro") and d["tipo"] not in vistos:
                if d["tipo"] == "termometro" and d["total"] == 0:
                    continue
                vistos[d["tipo"]] = d
        assert vistos["reacoes"]["contagem"] == {"🔥": 3, "torcida:c1": 2}  # 5/s: a 6ª caiu
        assert vistos["termometro"]["torcida"] == {"c1": 2} and vistos["termometro"]["total"] == 2
        # a sala geral não recebeu a mensagem de SP
        geral.send_text(json.dumps({"tipo": "msg", "texto": "oi geral"}))
        g = ate(geral, "msg")
        assert g["texto"] == "oi geral" and g["sala"] == "geral"
    # histórico por sala persiste
    with cliente.websocket_connect(f"/chat/ws?token={t2}&sala=SP") as ws:
        assert [m["texto"] for m in json.loads(ws.receive_text())["mensagens"]] == ["só em SP"]


def test_previa_publica(cliente):
    t1, _ = comprar(cliente, "Maria")
    with cliente.websocket_connect(f"/chat/ws?token={t1}&sala=RJ") as ws:
        json.loads(ws.receive_text())
        ws.send_text(json.dumps({"tipo": "msg", "texto": "prévia do Rio"}))
        proximo(ws, "msg")
    r = cliente.get("/chat/previa", params={"sala": "RJ"})
    assert r.status_code == 200 and r.headers["cache-control"] == "public, max-age=5"
    assert [m["texto"] for m in r.json()["mensagens"]] == ["prévia do Rio"]
    assert r.json()["mensagens"][0]["apelido"] == "Maria" and "sub" not in r.json()["mensagens"][0]
    assert cliente.get("/chat/previa", params={"sala": "XX"}).status_code == 422


def test_conta_e_login_por_email(cliente):
    """Pagar cria a conta (uma por e-mail), o token dura muito e o link de login reentra."""

    def comprar_json(apelido, email):
        r = cliente.post(
            "/chat/checkout",
            json={"apelido": apelido, "email": email, "retorno": "https://site.test/ap"},
        )
        assert r.status_code == 200, r.text
        r = cliente.get("/chat/acesso", params={"ref": r.json()["ref"]})
        assert r.status_code == 200, r.text
        return r.json()

    a1 = comprar_json("Maria", "maria@exemplo.test")
    a2 = comprar_json("Maria 2", "MARIA@exemplo.test")  # mesmo e-mail, outra compra
    c1 = _vt("segredo-de-teste-com-mais-de-32-caracteres!", a1["token"])
    c2 = _vt("segredo-de-teste-com-mais-de-32-caracteres!", a2["token"])
    assert c1["sub"] == c2["sub"] and c1["sub"].startswith("u_")
    assert c1["email"] == "maria@exemplo.test"
    assert a2["apelido"] == "Maria 2"  # a conta passa a usar o apelido escolhido agora
    assert cliente.get("/chat/estado").json()["contas"] == 1
    eu = cliente.get("/chat/eu", headers={"Authorization": f"Bearer {a1['token']}"}).json()
    assert eu["email"] == "maria@exemplo.test" and eu["autor"] == a1["autor"]

    # e-mail inválido no checkout
    r = cliente.post(
        "/chat/checkout", json={"apelido": "Zé", "email": "nada", "retorno": "https://x.test/"}
    )
    assert r.status_code == 422

    # login por link: dev sem e-mail devolve o link; resposta igual para e-mail desconhecido
    r = cliente.post(
        "/conta/login", json={"email": "maria@exemplo.test", "retorno": "https://site.test/ap"}
    )
    assert r.status_code == 200 and r.json()["ok"] and "link" in r.json()
    link = r.json()["link"]
    assert link.startswith("https://site.test/ap?login=")
    r2 = cliente.post(
        "/conta/login", json={"email": "ninguem@exemplo.test", "retorno": "https://site.test/ap"}
    )
    assert r2.json() == {"ok": True}

    tok = link.split("login=")[1]
    r = cliente.get("/conta/entrar", params={"token": tok})
    assert r.status_code == 200
    c3 = _vt("segredo-de-teste-com-mais-de-32-caracteres!", r.json()["token"])
    assert c3["sub"] == c1["sub"] and r.json()["apelido"] == "Maria 2"
    # link é de uso único
    assert cliente.get("/conta/entrar", params={"token": tok}).status_code == 410
