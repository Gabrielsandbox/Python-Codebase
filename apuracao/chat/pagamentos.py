"""Provedores de pagamento: ``dev`` (sem cobrança) e ``stripe`` (Checkout com PIX + cartão).

Trocar de provedor é só implementar :class:`Provedor` (ex.: Mercado Pago, Asaas) e registrar em
:func:`criar_provedor`. O resto do serviço só conhece ``criar_checkout`` / ``verificar``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlencode, urlsplit, urlunsplit


def anexar_query(url: str, **params: str) -> str:
    partes = urlsplit(url)
    q = partes.query + ("&" if partes.query else "") + urlencode(params)
    return urlunsplit((partes.scheme, partes.netloc, partes.path, q, partes.fragment))


@dataclass(slots=True)
class Checkout:
    url: str
    provedor_id: str | None = None


class Provedor(Protocol):
    nome: str

    def criar_checkout(
        self, *, ref: str, apelido: str, retorno: str, valor_centavos: int
    ) -> Checkout: ...
    def verificar(self, *, ref: str, provedor_id: str | None) -> str:
        """Devolve ``pago`` | ``pendente`` | ``falhou``."""
        ...


class ProvedorDev:
    """Sem cobrança: a URL de checkout já é o retorno. Só para desenvolvimento/testes."""

    nome = "dev"

    def criar_checkout(
        self, *, ref: str, apelido: str, retorno: str, valor_centavos: int
    ) -> Checkout:
        return Checkout(url=anexar_query(retorno, chat_ref=ref), provedor_id=None)

    def verificar(self, *, ref: str, provedor_id: str | None) -> str:
        return "pago"


class ProvedorStripe:
    """Stripe Checkout em BRL com ``pix`` e ``card``. PIX é assíncrono: o status fica
    ``pendente`` até o webhook ``checkout.session.async_payment_succeeded`` (ou a verificação
    ativa em ``verificar``)."""

    nome = "stripe"

    def __init__(self, secret_key: str) -> None:
        import stripe

        stripe.api_key = secret_key
        self._stripe = stripe

    def criar_checkout(
        self, *, ref: str, apelido: str, retorno: str, valor_centavos: int
    ) -> Checkout:
        s = self._stripe.checkout.Session.create(
            mode="payment",
            # API 2025+: payment_method_types foi substituído por allowed_payment_method_types
            # (os métodos precisam estar ativados no painel: Settings → Payment methods → Pix).
            allowed_payment_method_types=["card", "pix"],
            locale="pt-BR",
            line_items=[
                {
                    "price_data": {
                        "currency": "brl",
                        "unit_amount": valor_centavos,
                        "product_data": {
                            "name": "Chat ao vivo — Apuração 2026",
                            "description": "Acesso ao chat durante toda a apuração do 2º turno",
                        },
                    },
                    "quantity": 1,
                }
            ],
            client_reference_id=ref,
            metadata={"ref": ref, "apelido": apelido},
            success_url=anexar_query(retorno, chat_ref=ref),
            cancel_url=anexar_query(retorno, chat_cancelado="1"),
            payment_method_options={"pix": {"expires_after_seconds": 1800}},
        )
        return Checkout(url=s.url, provedor_id=s.id)

    def verificar(self, *, ref: str, provedor_id: str | None) -> str:
        if not provedor_id:
            return "pendente"
        s = self._stripe.checkout.Session.retrieve(provedor_id)
        if s.payment_status == "paid":
            return "pago"
        if s.status == "expired":
            return "falhou"
        return "pendente"

    def evento_webhook(self, payload: bytes, assinatura: str, webhook_secret: str) -> dict:
        """Valida a assinatura e devolve o evento (lança ``ValueError`` se inválido)."""
        try:
            ev = self._stripe.Webhook.construct_event(payload, assinatura, webhook_secret)
        except Exception as exc:
            raise ValueError(str(exc)) from exc
        return ev


def criar_provedor(nome: str, *, stripe_secret_key: str | None = None) -> Provedor:
    if nome == "dev":
        return ProvedorDev()
    if nome == "stripe":
        if not stripe_secret_key:
            raise RuntimeError("STRIPE_SECRET_KEY é obrigatório com CHAT_PAGAMENTO=stripe")
        return ProvedorStripe(stripe_secret_key)
    raise RuntimeError(f"provedor de pagamento desconhecido: {nome}")
