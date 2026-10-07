"""Chat ao vivo com acesso pago (R$ 5). Contrato em docs/CHAT.md.

Serviço independente do coletor: FastAPI + WebSocket, SQLite para pagamentos/auditoria,
Redis opcional para escalar horizontalmente (pub/sub + histórico + presença).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


@dataclass(slots=True)
class Config:
    pagamento: str = "dev"  # dev | stripe
    preco_centavos: int = 500
    jwt_secret: str = "troque-este-segredo-em-producao"
    jwt_dias: int = 7
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

    @classmethod
    def from_env(cls) -> Config:
        env = os.environ.get
        return cls(
            pagamento=env("CHAT_PAGAMENTO", "dev"),
            preco_centavos=int(env("CHAT_PRECO_CENTAVOS", "500")),
            jwt_secret=env("CHAT_JWT_SECRET", cls.jwt_secret),
            jwt_dias=int(env("CHAT_JWT_DIAS", "7")),
            db_path=Path(env("CHAT_DB", str(RAIZ / "data" / "chat.sqlite"))),
            redis_url=env("CHAT_REDIS_URL") or None,
            dados_base=env("CHAT_DADOS_BASE", "http://127.0.0.1:8000/dados"),
            stripe_secret_key=env("STRIPE_SECRET_KEY") or None,
            stripe_webhook_secret=env("STRIPE_WEBHOOK_SECRET") or None,
            bloqueio_path=Path(
                env("CHAT_BLOQUEIO", str(RAIZ / "data" / "ref" / "chat-bloqueio.txt"))
            ),
            origens_cors=[o for o in env("CHAT_CORS", "*").split(",") if o],
        )
