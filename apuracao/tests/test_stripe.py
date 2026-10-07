"""Integração com o Stripe sem rede: parâmetros do Checkout, verificação ativa e webhook assinado."""

import json
import time
from types import SimpleNamespace

import pytest
import stripe
from fastapi.testclient import TestClient

from chat import Config
from chat.app import criar_app

SEGREDO_WEBHOOK = "whsec_teste_123"


@pytest.fixture
def cfg(tmp_path):
    return Config(
        pagamento="stripe",
        stripe_secret_key="sk_test_falso",
        stripe_webhook_secret=SEGREDO_WEBHOOK,
        jwt_secret="segredo-de-teste-com-mais-de-32-caracteres!",
        db_path=tmp_path / "chat.sqlite",
        dados_base=None,
        bloqueio_path=tmp_path / "nada.txt",
    )


def assinar(payload: bytes) -> str:
    t = int(time.time())
    sig = stripe.WebhookSignature._compute_signature(f"{t}.{payload.decode()}", SEGREDO_WEBHOOK)
    return f"t={t},v1={sig}"


def evento(tipo: str, ref: str, pago: bool, sessao="cs_test_abc") -> bytes:
    return json.dumps(
        {
            "id": "evt_1",
            "object": "event",
            "api_version": stripe.api_version,
            "type": tipo,
            "data": {
                "object": {
                    "id": sessao,
                    "object": "checkout.session",
                    "client_reference_id": ref,
                    "payment_status": "paid" if pago else "unpaid",
                    "metadata": {"ref": ref},
                }
            },
        }
    ).encode()


def test_checkout_pix_cartao_e_webhook(cfg, monkeypatch):
    enviados = {}

    def fake_create(**params):
        enviados.update(params)
        return SimpleNamespace(
            url="https://checkout.stripe.com/c/pay/cs_test_abc", id="cs_test_abc"
        )

    # sessão ainda não paga quando o cliente consulta (PIX pendente)
    monkeypatch.setattr(stripe.checkout.Session, "create", staticmethod(fake_create))
    monkeypatch.setattr(
        stripe.checkout.Session,
        "retrieve",
        staticmethod(lambda sid: SimpleNamespace(payment_status="unpaid", status="open")),
    )

    with TestClient(criar_app(cfg)) as c:
        r = c.post("/chat/checkout", json={"apelido": "Maria", "retorno": "https://site.test/ap"})
        assert r.status_code == 200 and r.json()["url"].startswith("https://checkout.stripe.com/")
        ref = r.json()["ref"]
        # parâmetros enviados ao Stripe
        assert enviados["mode"] == "payment"
        assert enviados["allowed_payment_method_types"] == ["card", "pix"]
        assert "payment_method_types" not in enviados  # removido na API 2025+
        li = enviados["line_items"][0]["price_data"]
        assert li["currency"] == "brl" and li["unit_amount"] == 500
        assert enviados["client_reference_id"] == ref and enviados["metadata"]["ref"] == ref
        assert enviados["success_url"] == f"https://site.test/ap?chat_ref={ref}"
        assert enviados["cancel_url"] == "https://site.test/ap?chat_cancelado=1"
        assert enviados["payment_method_options"]["pix"]["expires_after_seconds"] == 1800

        # ainda pendente: 402
        assert c.get("/chat/acesso", params={"ref": ref}).status_code == 402

        # webhook com assinatura inválida → 400
        corpo = evento("checkout.session.async_payment_succeeded", ref, pago=True)
        assert (
            c.post(
                "/chat/webhook/stripe", content=corpo, headers={"stripe-signature": "t=1,v1=x"}
            ).status_code
            == 400
        )

        # checkout.session.completed com PIX ainda não pago não libera
        pend = evento("checkout.session.completed", ref, pago=False)
        assert c.post(
            "/chat/webhook/stripe", content=pend, headers={"stripe-signature": assinar(pend)}
        ).json() == {"ok": True}
        assert c.get("/chat/acesso", params={"ref": ref}).status_code == 402

        # async_payment_succeeded (PIX compensou) libera o token
        r = c.post(
            "/chat/webhook/stripe", content=corpo, headers={"stripe-signature": assinar(corpo)}
        )
        assert r.status_code == 200
        r = c.get("/chat/acesso", params={"ref": ref})
        assert r.status_code == 200 and r.json()["apelido"] == "Maria"

        # verificação ativa também funciona (cliente volta antes do webhook)
        r2 = c.post("/chat/checkout", json={"apelido": "Joao", "retorno": "https://site.test/ap"})
        monkeypatch.setattr(
            stripe.checkout.Session,
            "retrieve",
            staticmethod(lambda sid: SimpleNamespace(payment_status="paid", status="complete")),
        )
        assert c.get("/chat/acesso", params={"ref": r2.json()["ref"]}).status_code == 200


def test_stripe_exige_segredo_jwt(tmp_path):
    with pytest.raises(RuntimeError):
        criar_app(
            Config(pagamento="stripe", stripe_secret_key="sk_test_x", db_path=tmp_path / "c.sqlite")
        )
