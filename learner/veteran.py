"""Veteran habits: does trading like someone with 10 years behind them beat our current rules?

Each habit is a practice (shadow) variant in config shadow.variants, the live settings plus one
habit; `veteran` has them all. They never change real paper trades. Here each one is compared with
`live` on the same signals: a signal one of them didn't trade counts as 0 return for it, so a
filter that skips losers shows up as a gain, and one that skips winners as a loss.

    python3 learner/veteran.py [--days 7]     (make veteran)
"""
from __future__ import annotations

import argparse
import math
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "live"
MIN_N = 30  # signals where at least one of the two traded, before a verdict
HABITS = {
    "vet_no_chase": "don't chase coins that went vertical",
    "vet_cool_off": "sit out 30 min after 3 losses in a row",
    "vet_stop_15": "cut losers at -15% instead of -25%",
    "vet_breakeven": "once up 25%, never let it turn into a loss",
    "vet_cut_flat": "not above entry after 2 min: get out",
    "veteran": "all of the above together",
}
SETTLED = ("closed", "filtered", "missed")


def compare(c: sqlite3.Connection, variant: str, since: int, until: int) -> dict:
    """Paired per signal: the habit's return minus live's, with a rough 95% range (mean +- 2 standard errors)."""
    rows = c.execute(
        f"""SELECT x.status, x.roi, x.pnl_sol, y.status, y.roi, y.pnl_sol FROM shadow_trades x
            JOIN shadow_trades y ON y.signal_id = x.signal_id AND y.variant = ?
            WHERE x.variant = ? AND x.signal_at >= ? AND x.signal_at < ?
              AND x.status IN ({",".join("?" * len(SETTLED))}) AND y.status IN ({",".join("?" * len(SETTLED))})""",
        (BASE, variant, since, until, *SETTLED, *SETTLED)).fetchall()
    traded = [r for r in rows if r[0] == "closed" or r[3] == "closed"]
    diffs = [(r[1] if r[0] == "closed" else 0.0) - (r[4] if r[3] == "closed" else 0.0) for r in traded]
    n = len(diffs)
    mean = sum(diffs) / n if n else None
    se = math.sqrt(sum((d - mean) ** 2 for d in diffs) / (n - 1) / n) if n > 1 else None
    lo, hi = (mean - 2 * se, mean + 2 * se) if se is not None else (None, None)
    if n < MIN_N:
        verdict = "too early"
    elif lo > 0:
        verdict = "helps"
    elif hi < 0:
        verdict = "hurts"
    else:
        verdict = "no clear difference"
    return {
        "variant": variant, "n": n, "trades": sum(r[0] == "closed" for r in traded), "base_trades": sum(r[3] == "closed" for r in traded),
        "pnl": sum(r[2] for r in traded if r[0] == "closed"), "base_pnl": sum(r[5] for r in traded if r[3] == "closed"),
        "diff": mean, "lo": lo, "hi": hi, "verdict": verdict,
    }


def results(c: sqlite3.Connection, since: int, until: int) -> list[dict]:
    if c.execute("SELECT 1 FROM sqlite_master WHERE name = 'shadow_trades'").fetchone() is None:
        return []
    have = {r[0] for r in c.execute("SELECT DISTINCT variant FROM shadow_trades WHERE signal_at >= ? AND signal_at < ?", (since, until))}
    return [compare(c, v, since, until) | {"habit": HABITS[v]} for v in HABITS if v in have]


def section(c: sqlite3.Connection, since: int, until: int, table, sol, pct) -> list[str]:
    """Weekly report section (the report passes its own formatting helpers)."""
    rs = results(c, since, until)
    if not rs:
        return []
    md = ["## Veteran habits", "",
          f"_Each habit is practice-traded next to `{BASE}` (our current rules) on the same signals; real paper trades don't use them. "
          f"`gain per signal` = the habit's return minus `{BASE}`'s, a skipped trade counting as 0, with a rough 95% range. "
          f"Verdict after {MIN_N} signals: `helps` / `hurts` only when the whole range is on one side of 0._", ""]
    md.append(table(["habit", "variant", "signals", "trades (live)", "PnL SOL (live)", "gain per signal", "range", "verdict"], [
        [r["habit"], f"`{r['variant']}`", str(r["n"]), f"{r['trades']} ({r['base_trades']})", f"{sol(r['pnl'])} ({sol(r['base_pnl'])})",
         pct(r["diff"]), f"{pct(r['lo'])} to {pct(r['hi'])}" if r["lo"] is not None else "-", r["verdict"]]
        for r in rs]))
    return md + [""]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("DB_PATH", str(ROOT / "data/trading.db")))
    ap.add_argument("--days", type=int, default=7)
    a = ap.parse_args()
    c = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True, timeout=30)
    now = int(time.time() * 1000)
    rs = results(c, now - a.days * 86_400_000, now)
    if not rs:
        print("No veteran practice trades yet (the trader needs a restart to start them).")
        return 0
    p = lambda x: "-" if x is None else f"{x * 100:+.1f}%"  # noqa: E731
    print(f"Veteran habits vs our current rules, last {a.days} days (same signals; skipped = 0):\n")
    for r in rs:
        rng = f" [{p(r['lo'])} .. {p(r['hi'])}]" if r["lo"] is not None else ""
        print(f"  {r['verdict']:>19}  {r['variant']:<14} {p(r['diff'])} per signal{rng}, {r['n']} signals, "
              f"{r['trades']} trades vs {r['base_trades']}  - {r['habit']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
