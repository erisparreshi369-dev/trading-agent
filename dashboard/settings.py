"""The dashboard's only write: the limits the owner may change, until changed back.

Everything else in the dashboard is read-only. The list of limits, with their ranges, is
shared/editable-settings.json (the bot reads the same file). A change goes into the database
(kv override.*), where the bot picks it up within seconds, and a Telegram notice goes into the
alerts outbox. Nothing outside that list can be written, and nothing outside its range.

A setting is named by its kv key without "override.": e.g. helius_daily_mb_cap (the daily
Helius data cap, still under the collector's monthly guard), risk.STOP_LOSS_PCT, signals.min_score.
risk.* values also stay inside the walls in trader/src/risk/limits.ts (the same ranges).
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = json.loads((ROOT / "shared/editable-settings.json").read_text())
PREFIX = "override."
SETTINGS = {s["key"][len(PREFIX):]: s for s in REGISTRY["settings"]}
BY_PATH = {s["path"]: name for name, s in SETTINGS.items()}
# Stick to one plan: a change to how the bot trades needs this many closed trades before anyone can
# tell whether it helped (the notifier's TRADES_TO_JUDGE). Changing it again sooner is allowed, with a warning.
JUDGE_AFTER = 30
TRADING_GROUPS = ("safety", "filters")


# ---------------------------------------------------------------- normal values (what applies without a change)

def _yaml_value(text: str, path: str) -> str:
    """The raw scalar at a dotted path in config.yaml (no YAML dependency: block mappings, inline lists, comments)."""
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    block, raw = lines, None
    for key in path.split("."):
        if raw is not None:  # an index into the inline list found at the previous key
            if not key.isdigit():
                raise ValueError(f"{path}: not found in config.yaml")
            return [x.strip() for x in raw.strip("[]").split(",")][int(key)]
        depth = len(block[0]) - len(block[0].lstrip()) if block else 0
        for i, ln in enumerate(block):
            m = re.match(r"^(\s*)([\w.-]+):(.*)$", ln)
            if m and len(m.group(1)) == depth and m.group(2) == key:
                rest = m.group(3).split("#", 1)[0].strip()
                if rest:
                    raw = rest
                    block = []
                else:
                    end = next((j for j in range(i + 1, len(block)) if len(block[j]) - len(block[j].lstrip()) <= depth), len(block))
                    block = block[i + 1:end]
                break
        else:
            raise ValueError(f"{path}: not found in config.yaml")
    if raw is None or raw.startswith("["):
        raise ValueError(f"{path}: not a value")
    return raw


def _risk_value(text: str, name: str) -> str:
    """A RISK constant from limits.ts (numeric literal or product), or PAPER_NO_LIMITS."""
    if name == "PAPER_NO_LIMITS":
        m = re.search(r"export const PAPER_NO_LIMITS = (true|false)", text)
    else:
        block = re.search(r"export const RISK = Object\.freeze\(\{(.*?)\n\}\);", text, re.S)
        m = re.search(rf"^\s*{name}:\s*([\d_.\s*]+),", block.group(1) if block else "", re.M)
    if not m:
        raise ValueError(f"risk.{name}: not found in limits.ts")
    return m.group(1)


def _parse(s: dict, raw: str) -> float | bool:
    if s["type"] == "bool":
        return raw.strip() in ("true", "1")
    v = 1.0
    for part in raw.split("*"):
        v *= float(part.strip().replace("_", ""))
    return v


_cache: dict = {}


def default(name: str, config: Path = ROOT / "config/config.yaml", limits: Path = ROOT / "trader/src/risk/limits.ts") -> float | bool:
    """The normal value: config.yaml, or limits.ts for risk.* (files re-read only when they change)."""
    s = SETTINGS[name]
    src = limits if s["path"].startswith("risk.") else config
    st = src.stat()
    ck = (str(src), st.st_mtime_ns, st.st_size)
    if _cache.get("_" + str(src)) != ck:
        _cache["_" + str(src)] = ck
        _cache[str(src)] = src.read_text()
        _cache.pop(("v", str(src)), None)
    vals = _cache.setdefault(("v", str(src)), {})
    if name not in vals:
        text = _cache[str(src)]
        vals[name] = _parse(s, _risk_value(text, s["path"][5:]) if src is limits else _yaml_value(text, s["path"]))
    return vals[name]


def _stored(s: dict, raw: str | None) -> float | bool | None:
    """A kv value if it's valid for this setting (same test as the bot), else None."""
    if raw is None:
        return None
    if s["type"] == "bool":
        return True if raw in ("1", "true") else False if raw in ("0", "false") else None
    try:
        v = float(raw)
    except ValueError:
        return None
    if not s["min"] <= v <= s["max"] or (s["type"] == "int" and v != int(v)):
        return None
    return v


def fmt(name: str, v: float | bool) -> str:
    """A value in words, as the page shows it: 25%, 1.5 min, 0.05 SOL, on."""
    s = SETTINGS[name]
    if s["type"] == "bool":
        return "on" if v else "off"
    num = lambda x: f"{x:,.0f}" if x == int(x) and abs(x) >= 1000 else f"{x:.6g}"  # noqa: E731
    show = s.get("show")
    if show == "percent":
        return f"{num(round(v * 100, 4))}%"
    if show == "bps":
        return f"{num(round(v / 100, 4))}%"
    if show == "minutes":
        return f"{num(round(v / 60000, 4))} min"
    unit = s.get("unit", "")
    return f"{num(v)}%" if unit == "%" else f"{num(v)} {unit}".strip()


# ---------------------------------------------------------------- reading and writing

def _all_stored(c: sqlite3.Connection) -> dict[str, str]:
    return {k: v for k, v in c.execute("SELECT key, value FROM kv WHERE key LIKE 'override.%'")}


def current(c: sqlite3.Connection, name: str, stored: dict[str, str] | None = None, defaults: dict | None = None) -> dict:
    """{value, default, overridden, min, max} for the page."""
    s = SETTINGS[name]
    stored = _all_stored(c) if stored is None else stored
    d = defaults[name] if defaults and name in defaults else default(name)
    v = _stored(s, stored.get(s["key"]))
    out = {"value": d if v is None else v, "default": d, "overridden": v is not None}
    if s["type"] != "bool":
        out |= {"min": s["min"], "max": s["max"]}
    return out


def last_changes(c: sqlite3.Connection) -> dict[str, int]:
    """When each setting was last changed on the dashboard (ms), from the setting_changed alerts it writes."""
    out: dict[str, int] = {}
    try:
        rows = c.execute("SELECT ts, data FROM alerts WHERE kind = 'setting_changed' AND source = 'dashboard' ORDER BY ts, id").fetchall()
    except sqlite3.OperationalError:
        return out
    for ts, raw in rows:
        try:
            name = json.loads(raw or "{}").get("setting")
        except ValueError:
            continue
        if name in SETTINGS:
            out[name] = ts
    return out


def trades_since(c: sqlite3.Connection, ts: int) -> int:
    """Closed practice trades since `ts`: what a change made then has been tested on."""
    try:
        return c.execute("SELECT count(*) FROM paper_positions WHERE status = 'closed' AND closed_at > ?", (ts,)).fetchone()[0]
    except sqlite3.OperationalError:
        return 0


def all_current(c: sqlite3.Connection) -> dict[str, dict]:
    """Every setting, for the page (one database read), with when a trading setting was last changed and the trades since."""
    stored = _all_stored(c)
    changes = last_changes(c)
    out = {}
    for name in SETTINGS:
        try:
            out[name] = current(c, name, stored)
        except ValueError:  # its normal value can't be found: don't offer it
            continue
        if name in changes and SETTINGS[name]["group"] in TRADING_GROUPS:
            out[name] |= {"changed_at": changes[name], "trades_since": trades_since(c, changes[name]), "judge_after": JUDGE_AFTER}
    return out


def meta() -> dict:
    """What the page needs to draw the Limits tab: groups, and per setting its label, unit and help."""
    keep = ("path", "group", "type", "label", "gz", "help", "unit", "show", "min", "max")
    return {"groups": REGISTRY["groups"],
            "settings": [{"name": n, **{k: s[k] for k in keep if k in s}} for n, s in SETTINGS.items()]}


def _check_rules(c: sqlite3.Connection, name: str, value: float | bool | None) -> None:
    """Pair rules (min below max...), with `name` at its new value (None = back to normal)."""
    path = SETTINGS[name]["path"]
    stored = _all_stored(c)

    def effective(n: str) -> float:
        if n == name:
            return default(n) if value is None else value
        v = _stored(SETTINGS[n], stored.get(SETTINGS[n]["key"]))
        return default(n) if v is None else v

    for a, b in REGISTRY["rules"]:
        if path not in (a, b):
            continue
        na, nb = BY_PATH[a], BY_PATH[b]
        va, vb = effective(na), effective(nb)
        if not va < vb:
            sa, sb = SETTINGS[na], SETTINGS[nb]
            raise ValueError(f'"{sa["label"]}" ({fmt(na, va)}) must stay below "{sb["label"]}" ({fmt(nb, vb)})')


def apply(db: Path, name: str, value, guard_mb: float | None = None, limit: int | None = None) -> dict:
    """Set `name` to `value`, or back to normal (value None). Raises ValueError on bad input."""
    if name not in SETTINGS:
        raise ValueError("unknown setting")
    s = SETTINGS[name]
    if value is not None:
        if s["type"] == "bool":
            if not isinstance(value, bool):
                raise ValueError("value must be on or off")
        else:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("value must be a number")
            value = float(value)
            if s["type"] == "int":
                value = float(round(value))
            elif name == "madeonsol_stop_pct":
                value = round(value, 1)
            if not s["min"] <= value <= s["max"]:
                raise ValueError(f"must be between {fmt(name, s['min'])} and {fmt(name, s['max'])}")
    c = sqlite3.connect(str(db), timeout=10, isolation_level=None)
    try:
        c.execute("BEGIN IMMEDIATE")
        _check_rules(c, name, value)
        before = current(c, name)
        last = last_changes(c).get(name) if s["group"] in TRADING_GROUPS else None
        since = trades_since(c, last) if last is not None else None
        if value is None:
            c.execute("DELETE FROM kv WHERE key = ?", (s["key"],))
            to = before["default"]
        else:
            raw = ("1" if value else "0") if s["type"] == "bool" else str(int(value)) if value == int(value) else repr(value)
            c.execute("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (s["key"], raw))
            to = value
        changed = to != before["value"] or (value is None) == before["overridden"]
        if changed:
            frm_t, to_t = fmt(name, before["value"]), fmt(name, to)
            data = {"setting": name, "from": float(before["value"]), "to": float(to), "reset": value is None, "guardMb": guard_mb, "limit": limit,
                    "label": s["label"], "fromText": frm_t, "toText": to_t, "group": s["group"]}
            c.execute("INSERT INTO alerts (ts, level, kind, source, text, data) VALUES (?, 'info', 'setting_changed', 'dashboard', ?, ?)",
                      (int(time.time() * 1000), f"{name}: {frm_t} -> {to_t}" + (" (back to normal)" if value is None else ""), json.dumps(data)))
        c.execute("COMMIT")
        out = {"setting": name, **current(c, name), "text": fmt(name, current(c, name)["value"]), "changed": changed}
        if changed and since is not None and since < JUDGE_AFTER:
            out["too_soon"] = {"trades_since": since, "judge_after": JUDGE_AFTER}  # saved anyway: the owner decides
        return out
    except Exception:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    finally:
        c.close()
