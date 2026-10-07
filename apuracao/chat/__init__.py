"""Chat ao vivo com acesso pago (R$ 5). Contrato em docs/CHAT.md.

Serviço independente do coletor: FastAPI + WebSocket, SQLite para pagamentos/auditoria,
Redis opcional para escalar horizontalmente (pub/sub + histórico + presença).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _raiz() -> Path:
    """Raiz do projeto ``apuracao/`` (onde ficam ``data/ref`` e ``data/latest``).

    Em desenvolvimento é o pai deste pacote. Instalado via pip (imagem Docker), o pacote mora em
    site-packages e a raiz é ``APURACAO_RAIZ`` (``/app`` na imagem) ou o diretório atual.
    """
    env = os.environ.get("APURACAO_RAIZ")
    if env:
        return Path(env)
    local = Path(__file__).resolve().parent.parent
    return local if (local / "data" / "ref").is_dir() else Path.cwd()


RAIZ = _raiz()
JWT_SECRET_PADRAO = "troque-este-segredo-em-producao"


@dataclass(slots=True)
class Config:
    pagamento: str = "dev"  # dev | stripe
    preco_centavos: int = 500
    jwt_secret: str = JWT_SECRET_PADRAO
    jwt_dias: int = 365  # quem paga fica logado (a conta vale para a plataforma depois)
    db_path: Path = RAIZ / "data" / "chat.sqlite"
    redis_url: str | None = None
    dados_base: str = "http://127.0.0.1:8000/dados"
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None
    bloqueio_path: Path = RAIZ / "data" / "ref" / "chat-bloqueio.txt"
    historico: int = 50
    msg_max: int = 280
    intervalo_msg_s: float = 2.0
    origens_cors: list[str] = field(default_factory=lambda: ["*"])
    resend_api_key: str | None = None  # e-mail de login (Resend); sem ela, só loga o link
    email_de: str = "Apuração ao Vivo <contato@apuracaoaovivo.com>"

    @classmethod
    def from_env(cls) -> Config:
        env = os.environ.get
        return cls(
            pagamento=env("CHAT_PAGAMENTO", "dev"),
            preco_centavos=int(env("CHAT_PRECO_CENTAVOS", "500")),
            jwt_secret=env("CHAT_JWT_SECRET", JWT_SECRET_PADRAO),
            jwt_dias=int(env("CHAT_JWT_DIAS", "365")),
            db_path=Path(env("CHAT_DB", str(RAIZ / "data" / "chat.sqlite"))),
            redis_url=env("CHAT_REDIS_URL") or None,
            dados_base=env("CHAT_DADOS_BASE", "http://127.0.0.1:8000/dados"),
            stripe_secret_key=env("STRIPE_SECRET_KEY") or None,
            stripe_webhook_secret=env("STRIPE_WEBHOOK_SECRET") or None,
            bloqueio_path=Path(
                env("CHAT_BLOQUEIO", str(RAIZ / "data" / "ref" / "chat-bloqueio.txt"))
            ),
            origens_cors=[o for o in env("CHAT_CORS", "*").split(",") if o],
            resend_api_key=env("RESEND_API_KEY") or None,
            email_de=env("EMAIL_DE", "Apuração ao Vivo <contato@apuracaoaovivo.com>"),
        )
