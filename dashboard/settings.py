"""The dashboard's only write: two daily limits the owner may change, until changed back.

Everything else in the dashboard is read-only. A change goes into the database (kv override.*),
where the bot reads it, and a Telegram notice goes into the alerts outbox. Only these settings
exist here, each with a valid range; nothing else can be written.

  helius_daily_mb_cap  the daily Helius data cap (MB). The collector still applies its monthly
                       guard, so a high cap can never use up the month's free credits.
  madeonsol_stop_pct   where the daily MadeOnSol job stops, in % of its daily requests.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SETTINGS = {
    "helius_daily_mb_cap": {"key": "override.helius_daily_mb_cap", "min": 100, "max": 1_000_000,
                            "section": "collector", "pattern": r"^    daily_mb_cap:\s*([\d.]+)"},
    "madeonsol_stop_pct": {"key": "override.madeonsol_stop_pct", "min": 1, "max": 100,
                           "section": "madeonsol", "pattern": r"^  stop_pct:\s*([\d.]+)"},
}


def default(name: str, config: Path = ROOT / "config/config.yaml") -> float:
    """The config.yaml value (what applies without an override)."""
    s = SETTINGS[name]
    text = config.read_text()
    block = re.search(rf"^{s['section']}:\n((?:[ \t]+.*\n|\n)*)", text + "\n", re.M)
    m = re.search(s["pattern"], block.group(1) if block else "", re.M)
    if not m:
        raise ValueError(f"{name}: not found in config.yaml")
    return float(m.group(1))


def current(c: sqlite3.Connection, name: str) -> dict:
    """{value, default, overridden, min, max} for the page."""
    s = SETTINGS[name]
    row = c.execute("SELECT value FROM kv WHERE key = ?", (s["key"],)).fetchone()
    d = default(name)
    try:
        v = float(row[0]) if row else None
    except ValueError:
        v = None
    ok = v is not None and s["min"] <= v <= s["max"]
    return {"value": v if ok else d, "default": d, "overridden": ok, "min": s["min"], "max": s["max"]}


def apply(db: Path, name: str, value, guard_mb: float | None = None, limit: int | None = None) -> dict:
    """Set `name` to `value` (a number), or back to the config value (value None). Raises ValueError on bad input."""
    if name not in SETTINGS:
        raise ValueError("unknown setting")
    s = SETTINGS[name]
    if value is not None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("value must be a number")
        value = float(value)
        if not s["min"] <= value <= s["max"]:
            raise ValueError(f"value must be between {s['min']:g} and {s['max']:g}")
        value = round(value) if name == "helius_daily_mb_cap" else round(value, 1)
    c = sqlite3.connect(str(db), timeout=10, isolation_level=None)
    try:
        c.execute("BEGIN IMMEDIATE")
        before = current(c, name)
        if value is None:
            c.execute("DELETE FROM kv WHERE key = ?", (s["key"],))
            to = before["default"]
        else:
            c.execute("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (s["key"], str(value)))
            to = value
        changed = to != before["value"] or (value is None) == before["overridden"]
        if changed:
            data = {"setting": name, "from": before["value"], "to": to, "reset": value is None, "guardMb": guard_mb, "limit": limit}
            c.execute("INSERT INTO alerts (ts, level, kind, source, text, data) VALUES (?, 'info', 'setting_changed', 'dashboard', ?, ?)",
                      (int(time.time() * 1000), f"{name}: {before['value']:g} -> {to:g}" + (" (back to normal)" if value is None else ""), json.dumps(data)))
        c.execute("COMMIT")
        return {"setting": name, **current(c, name), "changed": changed}
    except Exception:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    finally:
        c.close()
