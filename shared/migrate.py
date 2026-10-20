"""Apply shared/migrations/*.sql to the SQLite database.

Mirrors trader/src/lib/db.ts: both runners record applied files in
schema_migrations, so whichever service starts first brings the schema up to date.
Usage: python shared/migrate.py [db_path]
"""
from __future__ import annotations

import os
import sqlite3
import sys
import time
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def connect(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def migrate(conn: sqlite3.Connection) -> list[str]:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
    )
    applied = {r[0] for r in conn.execute("SELECT name FROM schema_migrations")}
    done = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if path.name in applied:
            continue
        conn.execute("BEGIN IMMEDIATE")
        try:
            # re-check under the write lock in case the other runner just applied it
            if conn.execute("SELECT 1 FROM schema_migrations WHERE name=?", (path.name,)).fetchone():
                conn.execute("ROLLBACK")
                continue
            for stmt in _split(path.read_text()):
                conn.execute(stmt)
            conn.execute(
                "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)",
                (path.name, int(time.time() * 1000)),
            )
            conn.execute("COMMIT")
            done.append(path.name)
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return done


def _split(sql: str) -> list[str]:
    # executescript() would auto-commit; split on complete statements instead.
    out, buf = [], ""
    for line in sql.splitlines(keepends=True):
        buf += line
        if sqlite3.complete_statement(buf):
            if buf.strip():
                out.append(buf)
            buf = ""
    if buf.strip() and not all(l.strip().startswith("--") or not l.strip() for l in buf.splitlines()):
        raise ValueError("trailing incomplete SQL statement")
    return out


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DB_PATH", "./data/trading.db")
    applied = migrate(connect(db))
    print(f"applied: {applied}" if applied else "schema up to date")
