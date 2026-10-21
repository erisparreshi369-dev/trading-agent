"""Database backups with a restore that is tested every time.

  python scripts/backup_db.py                 make a backup now, then test-restore it (systemd: nightly)
  python scripts/backup_db.py test [FILE]     test-restore the newest backup (or FILE) without touching the live database
  python scripts/backup_db.py list            the backups we have, newest first
  python scripts/backup_db.py restore FILE --yes
                                              put FILE back as the live database (services must be stopped;
                                              the current database is moved aside, never deleted)

A backup is a consistent snapshot taken while the services run (SQLite's online backup), gzipped,
with a manifest next to it: sha256 of the .gz and the row count of every table. "Test-restore"
means: check the sha256, unpack into a scratch folder, run SQLite's integrity check, compare every
table's row count with the manifest, then run the migrations on it, proving today's code can open it.

Backups live in data/backups/ (git-ignored, on this machine's disk): they protect against a broken
database, a bad migration or a mistaken delete, not against losing the disk. Copy them elsewhere
for that. The result of the last run is written to kv `backup.last` for `make status`.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "shared"))
from migrate import MIGRATIONS_DIR, connect, migrate  # noqa: E402

DB = Path(os.environ.get("DB_PATH", ROOT / "data/trading.db"))
if not DB.is_absolute():
    DB = ROOT / DB
KEEP = 7
PREFIX = "trading-"
# services that hold the database open: a restore under them would be overwritten or corrupted
SERVICES = ["collector", "trader", "notifier", "dashboard"]


class BackupError(Exception):
    pass


def backups_dir(db: Path) -> Path:
    return db.parent / "backups"


def table_counts(c: sqlite3.Connection) -> dict[str, int]:
    names = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    return {n: c.execute(f'SELECT count(*) FROM "{n}"').fetchone()[0] for n in names}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def db_bytes(db: Path) -> int:
    return sum(p.stat().st_size for p in (db, Path(f"{db}-wal")) if p.exists())


def list_backups(db: Path) -> list[Path]:
    d = backups_dir(db)
    return sorted(d.glob(f"{PREFIX}*.db.gz"), reverse=True) if d.exists() else []


def manifest_path(gz: Path) -> Path:
    return gz.with_name(gz.name.removesuffix(".db.gz") + ".json")


def backup(db: Path, keep: int = KEEP, now: float | None = None) -> dict:
    """Snapshot `db`, gzip it, write the manifest, test-restore it, prune old ones. Returns the manifest."""
    if not db.exists():
        raise BackupError(f"no database at {db}")
    out = backups_dir(db)
    out.mkdir(parents=True, exist_ok=True)
    os.chmod(out, 0o700)
    need = 2 * db_bytes(db) + 100_000_000  # uncompressed snapshot + the .gz, with room to spare
    free = shutil.disk_usage(out).free
    if free < need:
        raise BackupError(f"not enough disk space for a backup: {free / 1e9:.1f} GB free, need {need / 1e9:.1f} GB")
    now = time.time() if now is None else now
    t = time.gmtime(now)
    name = f"{PREFIX}{time.strftime('%Y-%m-%dT%H%MZ', t)}"
    gz = out / f"{name}.db.gz"
    with tempfile.TemporaryDirectory(dir=out, prefix=".backup-") as tmp:
        snap = Path(tmp) / "snapshot.db"
        src = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=30)
        dst = sqlite3.connect(snap)
        try:
            src.backup(dst)  # one consistent read snapshot; in WAL mode writers carry on meanwhile
            counts = table_counts(dst)
            migrations = [r[0] for r in dst.execute("SELECT name FROM schema_migrations ORDER BY name")]
        finally:
            dst.close()
            src.close()
        part = gz.with_name(gz.name + ".part")
        with open(snap, "rb") as f, gzip.open(part, "wb", compresslevel=6) as z:
            shutil.copyfileobj(f, z, 1 << 20)
        os.chmod(part, 0o600)
        part.rename(gz)
        size = snap.stat().st_size
    manifest = {"file": gz.name, "created_at": int(now * 1000),
                "source": str(db), "db_bytes": size, "gz_bytes": gz.stat().st_size, "sha256": sha256(gz),
                "migrations": migrations, "tables": counts}
    mp = manifest_path(gz)
    mp.write_text(json.dumps(manifest, indent=1))
    os.chmod(mp, 0o600)
    test_restore(gz)
    prune(db, keep)
    return manifest


def test_restore(gz: Path) -> dict:
    """Prove `gz` restores to a working database, without touching the live one. Raises BackupError."""
    mp = manifest_path(gz)
    if not mp.exists():
        raise BackupError(f"{gz.name}: manifest {mp.name} is missing")
    m = json.loads(mp.read_text())
    if sha256(gz) != m["sha256"]:
        raise BackupError(f"{gz.name}: file is damaged (sha256 differs from the manifest)")
    with tempfile.TemporaryDirectory(dir=gz.parent, prefix=".restore-test-") as tmp:
        db = Path(tmp) / "restored.db"
        unpack(gz, db)
        c = sqlite3.connect(db)
        try:
            check = c.execute("PRAGMA integrity_check").fetchall()
            if check != [("ok",)]:
                raise BackupError(f"{gz.name}: integrity check failed: {check[:3]}")
            counts = table_counts(c)
        finally:
            c.close()
        if counts != m["tables"]:
            diff = {k: (m["tables"].get(k), counts.get(k)) for k in set(m["tables"]) | set(counts) if m["tables"].get(k) != counts.get(k)}
            raise BackupError(f"{gz.name}: row counts differ from the manifest: {dict(list(diff.items())[:5])}")
        known = {p.name for p in MIGRATIONS_DIR.glob("*.sql")}
        unknown = [n for n in m["migrations"] if n not in known]
        if unknown:
            raise BackupError(f"{gz.name}: made by newer code (migrations {unknown} aren't in this checkout)")
        conn = connect(str(db))
        try:
            applied = migrate(conn)  # today's code must be able to open and upgrade it
        finally:
            conn.close()
    return {"file": gz.name, "tables": len(counts), "rows": sum(counts.values()), "migrations_applied": applied}


def unpack(gz: Path, to: Path) -> None:
    with gzip.open(gz, "rb") as z, open(to, "wb") as f:
        shutil.copyfileobj(z, f, 1 << 20)


def prune(db: Path, keep: int) -> list[str]:
    removed = []
    for gz in list_backups(db)[keep:]:
        for p in (gz, manifest_path(gz)):
            p.unlink(missing_ok=True)
        removed.append(gz.name)
    return removed


def running_services() -> list[str]:
    out = []
    for s in SERVICES:
        r = subprocess.run(["systemctl", "--user", "is-active", f"trading-{s}"], capture_output=True, text=True)
        if r.stdout.strip() in ("active", "activating", "reloading"):
            out.append(s)
    return out


def restore(gz: Path, db: Path, running: list[str]) -> Path:
    """Replace the live database with `gz`. The current files are moved into data/before-restore-<time>/."""
    if running:
        raise BackupError(f"stop these first, they hold the database open: {', '.join(running)} "
                          f"(systemctl --user stop {' '.join('trading-' + s for s in running)})")
    test_restore(gz)
    aside = db.parent / f"before-restore-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
    aside.mkdir()
    for p in (db, Path(f"{db}-wal"), Path(f"{db}-shm")):
        if p.exists():
            p.rename(aside / p.name)
    tmp = db.with_name(db.name + ".restoring")
    unpack(gz, tmp)
    os.chmod(tmp, 0o600)
    tmp.rename(db)
    return aside


def record(db: Path, result: dict) -> None:
    """Best effort: the last result, for `make status`. A busy database never fails the backup."""
    try:
        c = sqlite3.connect(db, timeout=30)
        with c:
            c.execute("INSERT INTO kv (key, value) VALUES ('backup.last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                      (json.dumps(result),))
        c.close()
    except sqlite3.Error as e:
        print(f"note: could not record the result in the database: {e}", file=sys.stderr)


def resolve_file(db: Path, name: str | None) -> Path:
    if name:
        p = Path(name)
        return p if p.is_absolute() or p.exists() else backups_dir(db) / p
    found = list_backups(db)
    if not found:
        raise BackupError(f"no backups in {backups_dir(db)}")
    return found[0]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", nargs="?", default="backup", choices=["backup", "test", "list", "restore"])
    ap.add_argument("file", nargs="?")
    ap.add_argument("--keep", type=int, default=KEEP)
    ap.add_argument("--yes", action="store_true", help="restore: really replace the live database")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "backup":
            t0 = time.time()
            m = backup(DB, a.keep)
            s = round(time.time() - t0, 1)
            record(DB, {"ok": True, "at": int(time.time() * 1000), "file": m["file"], "gz_bytes": m["gz_bytes"], "seconds": s, "tested": True})
            print(f"backup {m['file']}: {m['db_bytes'] / 1e6:.0f} MB → {m['gz_bytes'] / 1e6:.0f} MB gz, "
                  f"{sum(m['tables'].values())} rows in {len(m['tables'])} tables, restore tested OK ({s}s); keeping {len(list_backups(DB))}")
        elif a.cmd == "test":
            r = test_restore(resolve_file(DB, a.file))
            print(f"restore test OK: {r['file']}: {r['rows']} rows in {r['tables']} tables"
                  + (f", would apply {r['migrations_applied']}" if r["migrations_applied"] else ", schema current"))
        elif a.cmd == "list":
            for gz in list_backups(DB):
                m = json.loads(manifest_path(gz).read_text()) if manifest_path(gz).exists() else {}
                print(f"{gz.name}  {gz.stat().st_size / 1e6:6.1f} MB  {sum(m.get('tables', {}).values()) or '?'} rows")
        elif a.cmd == "restore":
            if not a.file:
                raise BackupError("say which backup: python scripts/backup_db.py list")
            if not a.yes:
                raise BackupError("this replaces the live database: add --yes")
            aside = restore(resolve_file(DB, a.file), DB, running_services())
            print(f"restored {a.file}; the previous database is in {aside}. Start the services again: make restart")
    except (BackupError, sqlite3.Error, OSError) as e:
        if a.cmd == "backup":
            record(DB, {"ok": False, "at": int(time.time() * 1000), "error": str(e)})
        print(f"{a.cmd} FAILED: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
