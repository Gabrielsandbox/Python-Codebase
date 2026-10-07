import json

import pytest
from fastapi.testclient import TestClient

from chat import Config
from chat.app import WS_NAO_AUTORIZADO, criar_app
from chat.auth import ApelidoInvalido, emitir_token, normalizar_apelido, verificar_token
from chat.hub import frase_placar
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


def comprar(cliente, apelido="Maria"):
    r = cliente.post("/chat/checkout", json={"apelido": apelido, "retorno": "https://site.test/ap"})
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
        ma = json.loads(a.receive_text())
        mb = json.loads(b.receive_text())
        assert ma["tipo"] == "msg" and ma["eu"] is True and mb["eu"] is False
        assert (
            ma["texto"] == "Vai virar! veja agora" and ma["apelido"] == "Maria" and "sub" not in ma
        )
        assert ma["id"] == mb["id"]

        a.send_text(json.dumps({"tipo": "msg", "texto": "ganhe no pix premiado"}))
        err = json.loads(a.receive_text())
        assert err["tipo"] == "erro" and err["codigo"] == "bloqueado"

        a.send_text(json.dumps({"tipo": "msg", "texto": "Vai virar! veja agora"}))  # repetida
        assert json.loads(a.receive_text())["codigo"] == "repetida"

        a.send_text(json.dumps({"tipo": "msg", "texto": "x" * 300}))
        assert json.loads(a.receive_text())["codigo"] == "texto_invalido"

        a.send_text(json.dumps({"tipo": "ping"}))
        assert json.loads(a.receive_text())["tipo"] == "pong"

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
