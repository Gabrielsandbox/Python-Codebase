"""``python -m chat`` — sobe o serviço do chat (porta 8001 por padrão)."""

from __future__ import annotations

import logging
import os

import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
uvicorn.run(
    "chat.app:app",
    host=os.environ.get("CHAT_HOST", "0.0.0.0"),
    port=int(os.environ.get("CHAT_PORT", "8001")),
    proxy_headers=True,
)
