"""Alertas da apuração: Web Push (PWA) e Telegram. Contrato em docs/ALERTAS.md."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent

EVENTOS = ["inicio", "marcos", "virada", "definido", "matematica"]


@dataclass(slots=True)
class Config:
    dados_base: str = "http://127.0.0.1:8000/dados"
    db_path: Path = RAIZ / "data" / "alertas.sqlite"
    site_url: str = "http://localhost:5173/"
    vapid_private_key: str | None = None
    vapid_public_key: str | None = None
    vapid_email: str = "mailto:contato@example.com"
    telegram_token: str | None = None
    telegram_bot: str | None = None
    telegram_polling: bool = True  # dev: long polling; produção: webhook
    intervalo_s: float = 10.0
    dev: bool = True
    origens_cors: list[str] = field(default_factory=lambda: ["*"])

    @classmethod
    def from_env(cls) -> Config:
        env = os.environ.get
        return cls(
            dados_base=env(
                "ALERTAS_DADOS_BASE", env("CHAT_DADOS_BASE", "http://127.0.0.1:8000/dados")
            ),
            db_path=Path(env("ALERTAS_DB", str(RAIZ / "data" / "alertas.sqlite"))),
            site_url=env("APURACAO_SITE_URL", "http://localhost:5173/"),
            vapid_private_key=env("VAPID_PRIVATE_KEY") or None,
            vapid_public_key=env("VAPID_PUBLIC_KEY") or None,
            vapid_email=env("VAPID_CLAIMS_EMAIL", "mailto:contato@example.com"),
            telegram_token=env("TELEGRAM_BOT_TOKEN") or None,
            telegram_bot=env("TELEGRAM_BOT_NOME") or None,
            telegram_polling=env("TELEGRAM_POLLING", "1") == "1",
            intervalo_s=float(env("ALERTAS_INTERVALO_S", "10")),
            dev=env("ALERTAS_DEV", "1") == "1",
            origens_cors=[o for o in env("ALERTAS_CORS", "*").split(",") if o],
        )
