"""``python -m alertas`` sobe o serviço (porta 8002); ``python -m alertas gerar-vapid`` cria as chaves."""

from __future__ import annotations

import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

if len(sys.argv) > 1 and sys.argv[1] == "gerar-vapid":
    import base64

    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid

    v = Vapid()
    v.generate_keys()
    priv = v.private_key.private_bytes(
        serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    pub = v.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    print("VAPID_PRIVATE_KEY=" + base64.urlsafe_b64encode(priv).decode().rstrip("="))
    print("VAPID_PUBLIC_KEY=" + base64.urlsafe_b64encode(pub).decode().rstrip("="))
    sys.exit(0)

import uvicorn

uvicorn.run(
    "alertas.app:app",
    host=os.environ.get("ALERTAS_HOST", "0.0.0.0"),
    port=int(os.environ.get("ALERTAS_PORT", "8002")),
    proxy_headers=True,
)
