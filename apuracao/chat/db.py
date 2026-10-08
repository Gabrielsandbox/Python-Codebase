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
CREATE TABLE IF NOT EXISTS usuarios (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    apelido       TEXT NOT NULL,
    criado_em     TEXT NOT NULL,
    ultimo_acesso TEXT,
    origem        TEXT NOT NULL DEFAULT 'apuracao-2026'
);
CREATE TABLE IF NOT EXISTS espera (
    whatsapp  TEXT PRIMARY KEY,
    criado_em TEXT NOT NULL,
    origem    TEXT
);
CREATE TABLE IF NOT EXISTS logins (
    token_hash TEXT PRIMARY KEY,
    usuario_id TEXT NOT NULL,
    criado_em  TEXT NOT NULL,
    expira_em  TEXT NOT NULL,
    usado_em   TEXT
);
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
            cols = {r[1] for r in self._con.execute("PRAGMA table_info(mensagens)")}
            if "sala" not in cols:  # migração: salas por estado
                self._con.execute(
                    "ALTER TABLE mensagens ADD COLUMN sala TEXT NOT NULL DEFAULT 'geral'"
                )
                self._con.commit()
            cols = {r[1] for r in self._con.execute("PRAGMA table_info(pagamentos)")}
            for col in ("email", "usuario_id"):  # migração: contas
                if col not in cols:
                    self._con.execute(f"ALTER TABLE pagamentos ADD COLUMN {col} TEXT")
            cols = {r[1] for r in self._con.execute("PRAGMA table_info(usuarios)")}
            for col in ("google_sub", "nome", "foto"):  # migração: Entrar com Google
                if col not in cols:
                    self._con.execute(f"ALTER TABLE usuarios ADD COLUMN {col} TEXT")
            self._con.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_usuarios_google ON usuarios(google_sub)"
            )
            self._con.commit()

    # ---------------------------------------------------------------- pagamentos
    def criar_pagamento(
        self,
        ref: str,
        provedor: str,
        apelido: str,
        valor: int,
        provedor_id: str | None = None,
        email: str | None = None,
        usuario_id: str | None = None,
    ) -> None:
        with self._lock:
            self._con.execute(
                "INSERT INTO pagamentos(ref, provedor, provedor_id, apelido, valor_centavos, status,"
                " criado_em, email, usuario_id) VALUES (?,?,?,?,?,'pendente',?,?,?)",
                (ref, provedor, provedor_id, apelido, valor, agora(), email, usuario_id),
            )
            self._con.commit()

    def vincular_pagamento(self, ref: str, usuario_id: str, email: str | None = None) -> None:
        with self._lock:
            self._con.execute(
                "UPDATE pagamentos SET usuario_id=?, email=COALESCE(?, email) WHERE ref=?",
                (usuario_id, email, ref),
            )
            self._con.commit()

    # ---------------------------------------------------------------- contas
    def obter_ou_criar_usuario(self, id_novo: str, email: str, apelido: str) -> sqlite3.Row:
        """Uma conta por e-mail. Se já existe, o apelido passa a ser o escolhido agora."""
        with self._lock:
            row = self._con.execute("SELECT * FROM usuarios WHERE email=?", (email,)).fetchone()
            if row is not None and row["apelido"] != apelido:
                self._con.execute("UPDATE usuarios SET apelido=? WHERE id=?", (apelido, row["id"]))
                self._con.commit()
                row = self._con.execute("SELECT * FROM usuarios WHERE email=?", (email,)).fetchone()
            if row is None:
                self._con.execute(
                    "INSERT INTO usuarios(id, email, apelido, criado_em, ultimo_acesso) VALUES (?,?,?,?,?)",
                    (id_novo, email, apelido, agora(), agora()),
                )
                self._con.commit()
                row = self._con.execute("SELECT * FROM usuarios WHERE email=?", (email,)).fetchone()
            return row

    def usuario(self, id_: str) -> sqlite3.Row | None:
        with self._lock:
            return self._con.execute("SELECT * FROM usuarios WHERE id=?", (id_,)).fetchone()

    def usuario_por_google(self, google_sub: str) -> sqlite3.Row | None:
        with self._lock:
            return self._con.execute(
                "SELECT * FROM usuarios WHERE google_sub=?", (google_sub,)
            ).fetchone()

    def vincular_google(
        self, id_: str, google_sub: str, nome: str | None, foto: str | None
    ) -> None:
        with self._lock:
            self._con.execute(
                "UPDATE usuarios SET google_sub=?, nome=COALESCE(?, nome), foto=COALESCE(?, foto),"
                " ultimo_acesso=? WHERE id=?",
                (google_sub, nome or None, foto or None, agora(), id_),
            )
            self._con.commit()

    def conta_pagou(self, sub: str) -> bool:
        """A identidade do token (id da conta, ou ref de pagamento antigo) tem pagamento pago?"""
        with self._lock:
            return (
                self._con.execute(
                    "SELECT 1 FROM pagamentos WHERE status='pago' AND (usuario_id=? OR ref=?) LIMIT 1",
                    (sub, sub),
                ).fetchone()
                is not None
            )

    # ---------------------------------------------------------------- lista de espera
    def entrar_espera(self, whatsapp: str, origem: str | None) -> bool:
        """True se entrou agora; False se já estava."""
        with self._lock:
            cur = self._con.execute(
                "INSERT OR IGNORE INTO espera(whatsapp, criado_em, origem) VALUES (?,?,?)",
                (whatsapp, agora(), origem),
            )
            self._con.commit()
            return cur.rowcount > 0

    def total_espera(self) -> int:
        with self._lock:
            return self._con.execute("SELECT COUNT(*) FROM espera").fetchone()[0]

    def listar_espera(self) -> list[sqlite3.Row]:
        with self._lock:
            return self._con.execute(
                "SELECT whatsapp, criado_em, origem FROM espera ORDER BY criado_em"
            ).fetchall()

    def usuario_por_email(self, email: str) -> sqlite3.Row | None:
        with self._lock:
            return self._con.execute("SELECT * FROM usuarios WHERE email=?", (email,)).fetchone()

    def tocar_acesso(self, id_: str) -> None:
        with self._lock:
            self._con.execute("UPDATE usuarios SET ultimo_acesso=? WHERE id=?", (agora(), id_))
            self._con.commit()

    def total_usuarios(self) -> int:
        with self._lock:
            return self._con.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0]

    def criar_login(self, token_hash: str, usuario_id: str, expira_em: str) -> None:
        with self._lock:
            self._con.execute(
                "INSERT INTO logins(token_hash, usuario_id, criado_em, expira_em) VALUES (?,?,?,?)",
                (token_hash, usuario_id, agora(), expira_em),
            )
            self._con.commit()

    def consumir_login(self, token_hash: str) -> str | None:
        """Marca o link como usado e devolve o usuário; None se inválido, usado ou vencido."""
        with self._lock:
            row = self._con.execute(
                "SELECT usuario_id, expira_em, usado_em FROM logins WHERE token_hash=?",
                (token_hash,),
            ).fetchone()
            if row is None or row["usado_em"] or row["expira_em"] < agora():
                return None
            self._con.execute(
                "UPDATE logins SET usado_em=? WHERE token_hash=?", (agora(), token_hash)
            )
            self._con.commit()
            return row["usuario_id"]

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
    def gravar_mensagem(
        self, id_: str, sub: str, apelido: str, texto: str, t: str, sala: str = "geral"
    ) -> None:
        with self._lock:
            self._con.execute(
                "INSERT OR IGNORE INTO mensagens(id, sub, apelido, texto, t, sala) VALUES (?,?,?,?,?,?)",
                (id_, sub, apelido, texto, t, sala),
            )
            self._con.commit()

    def total_mensagens(self) -> int:
        with self._lock:
            return self._con.execute("SELECT COUNT(*) FROM mensagens").fetchone()[0]

    def ultimas(self, n: int, sala: str = "geral") -> list[dict]:
        with self._lock:
            rows = self._con.execute(
                "SELECT id, apelido, texto, t, sala FROM mensagens WHERE sala=? ORDER BY t DESC, id DESC LIMIT ?",
                (sala, n),
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
