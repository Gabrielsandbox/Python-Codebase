"""Persistência mínima em SQLite (stdlib): pagamentos e auditoria de mensagens."""

from __future__ import annotations

import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS pagamentos (
    ref            TEXT PRIMARY KEY,
    provedor       TEXT NOT NULL,
    provedor_id    TEXT,
    apelido        TEXT NOT NULL,
    valor_centavos INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pendente',
    criado_em      TEXT NOT NULL,
    pago_em        TEXT
);
CREATE TABLE IF NOT EXISTS mensagens (
    id       TEXT PRIMARY KEY,
    sub      TEXT NOT NULL,
    apelido  TEXT NOT NULL,
    texto    TEXT NOT NULL,
    t        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bloqueados (
    sub      TEXT PRIMARY KEY,
    motivo   TEXT,
    em       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mensagens_t ON mensagens(t);
"""


def agora() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


class DB:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._con = sqlite3.connect(self.path, check_same_thread=False)
        self._con.row_factory = sqlite3.Row
        with self._lock:
            self._con.executescript("PRAGMA journal_mode=WAL;" + SCHEMA)

    # ---------------------------------------------------------------- pagamentos
    def criar_pagamento(
        self, ref: str, provedor: str, apelido: str, valor: int, provedor_id: str | None = None
    ) -> None:
        with self._lock:
            self._con.execute(
                "INSERT INTO pagamentos(ref, provedor, provedor_id, apelido, valor_centavos, status, criado_em)"
                " VALUES (?,?,?,?,?,'pendente',?)",
                (ref, provedor, provedor_id, apelido, valor, agora()),
            )
            self._con.commit()

    def pagamento(self, ref: str) -> sqlite3.Row | None:
        with self._lock:
            return self._con.execute("SELECT * FROM pagamentos WHERE ref=?", (ref,)).fetchone()

    def pagamento_por_provedor_id(self, provedor_id: str) -> sqlite3.Row | None:
        with self._lock:
            return self._con.execute(
                "SELECT * FROM pagamentos WHERE provedor_id=?", (provedor_id,)
            ).fetchone()

    def marcar_pago(self, ref: str) -> bool:
        with self._lock:
            cur = self._con.execute(
                "UPDATE pagamentos SET status='pago', pago_em=? WHERE ref=? AND status!='pago'",
                (agora(), ref),
            )
            self._con.commit()
            return cur.rowcount > 0

    def total_pagos(self) -> int:
        with self._lock:
            return self._con.execute(
                "SELECT COUNT(*) FROM pagamentos WHERE status='pago'"
            ).fetchone()[0]

    # ---------------------------------------------------------------- mensagens
    def gravar_mensagem(self, id_: str, sub: str, apelido: str, texto: str, t: str) -> None:
        with self._lock:
            self._con.execute(
                "INSERT OR IGNORE INTO mensagens(id, sub, apelido, texto, t) VALUES (?,?,?,?,?)",
                (id_, sub, apelido, texto, t),
            )
            self._con.commit()

    def total_mensagens(self) -> int:
        with self._lock:
            return self._con.execute("SELECT COUNT(*) FROM mensagens").fetchone()[0]

    def ultimas(self, n: int) -> list[dict]:
        with self._lock:
            rows = self._con.execute(
                "SELECT id, apelido, texto, t FROM mensagens ORDER BY t DESC, id DESC LIMIT ?", (n,)
            ).fetchall()
        return [dict(r) for r in reversed(rows)]

    # ---------------------------------------------------------------- moderação
    def bloquear(self, sub: str, motivo: str = "") -> None:
        with self._lock:
            self._con.execute(
                "INSERT OR REPLACE INTO bloqueados(sub, motivo, em) VALUES (?,?,?)",
                (sub, motivo, agora()),
            )
            self._con.commit()

    def bloqueado(self, sub: str) -> bool:
        with self._lock:
            return (
                self._con.execute("SELECT 1 FROM bloqueados WHERE sub=?", (sub,)).fetchone()
                is not None
            )

    def close(self) -> None:
        with self._lock:
            self._con.close()
