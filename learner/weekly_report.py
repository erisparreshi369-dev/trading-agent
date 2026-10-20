"""Weekly markdown report: what is and isn't working in paper trading.

Writes reports/weekly-<date>.md; the notifier sends new reports to Telegram.
Phase 4 adds model results (feature importances, backtest) to this report.
Usage: python learner/weekly_report.py [--db path] [--days 7]
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "shared"))
from migrate import connect, migrate  # noqa: E402


def pct(x: float | None) -> str:
    return "-" if x is None else f"{x * 100:+.1f}%"


def sol(x: float | None) -> str:
    return "-" if x is None else f"{x:+.4f}"


def table(headers: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return "_none_\n"
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(out) + "\n"


def group(c: sqlite3.Connection, key_sql: str, since: int, until: int, order: str = "pnl") -> list[tuple]:
    return c.execute(
        f"""SELECT {key_sql} AS k, count(*), SUM(pnl_sol > 0), SUM(pnl_sol), AVG(pnl_sol / cost_sol)
            FROM paper_positions p LEFT JOIN signals s ON s.id = p.signal_id
            WHERE p.status = 'closed' AND p.closed_at >= ? AND p.closed_at < ?
            GROUP BY k ORDER BY SUM(pnl_sol) {'DESC' if order == 'pnl' else 'ASC'}""",
        (since, until),
    ).fetchall()


def build(c: sqlite3.Connection, now_ms: int, days: int) -> str:
    since = now_ms - days * 86_400_000
    end = time.strftime("%Y-%m-%d", time.gmtime(now_ms / 1000))
    start = time.strftime("%Y-%m-%d", time.gmtime(since / 1000))
    md = [f"# Weekly report {start} → {end}", "", "_Paper trading. All PnL after simulated fees, slippage and delay._", ""]

    acct = c.execute("SELECT balance_sol, start_balance FROM paper_account WHERE id = 1").fetchone()
    hb = c.execute("SELECT info FROM service_heartbeats WHERE service = 'trader'").fetchone()
    equity = json.loads(hb[0]).get("equity") if hb else (acct[0] if acct else None)
    n, wins, pnl, avg_roi, missed = c.execute(
        """SELECT SUM(status='closed'), SUM(status='closed' AND pnl_sol > 0), COALESCE(SUM(pnl_sol),0),
           AVG(CASE WHEN status='closed' THEN pnl_sol / cost_sol END), SUM(status='failed')
           FROM paper_positions WHERE status IN ('closed','failed') AND closed_at >= ? AND closed_at < ?""",
        (since, now_ms),
    ).fetchone()
    n, wins, missed = n or 0, wins or 0, missed or 0
    md += ["## Summary", ""]
    if acct:
        md.append(f"- Equity **{equity:.4f} SOL** ({pct((equity - acct[1]) / acct[1])} since start, start {acct[1]:g} SOL)")
    md += [
        f"- This week: **{n} trades**, {wins} wins ({f'{wins / n * 100:.0f}%' if n else '-'} win rate), "
        f"**{sol(pnl)} SOL**, average {pct(avg_roi)} per trade",
        f"- Missed fills (price ran past the slippage limit or similar): {missed}",
        "",
    ]

    # ---- what's working / not ----
    by_leader = group(c, "p.leader_wallet", since, now_ms)
    by_exit = group(c, "p.exit_reason", since, now_ms)
    by_age = group(
        c,
        """CASE WHEN json_extract(s.features,'$.token_age_s') < 30 THEN 'a <30s'
                WHEN json_extract(s.features,'$.token_age_s') < 120 THEN 'b 30s-2m'
                WHEN json_extract(s.features,'$.token_age_s') < 600 THEN 'c 2-10m' ELSE 'd >10m' END""",
        since, now_ms,
    )
    by_conf = group(c, "COALESCE(json_extract(s.features,'$.confirmations'),1)", since, now_ms)
    working, not_working = [], []
    for k, cnt, w, p, roi in by_leader:
        if cnt >= 3:
            (working if p > 0 else not_working).append(f"leader `{k[:8]}…`: {cnt} trades, {sol(p)} SOL, {pct(roi)} avg")
    for label, rows in (("exit", by_exit), ("token age", by_age), ("confirmations", by_conf)):
        for k, cnt, w, p, roi in rows:
            if cnt >= 3:
                (working if p > 0 else not_working).append(f"{label} {k}: {cnt} trades, {sol(p)} SOL, {pct(roi)} avg")
    md += ["## What is working", ""] + ([f"- {x}" for x in working] or ["- nothing with at least 3 trades yet"]) + [""]
    md += ["## What isn't", ""] + ([f"- {x}" for x in not_working] or ["- nothing with at least 3 trades yet"]) + [""]

    def rows(data):
        return [[str(k), str(cnt), f"{(w or 0) / cnt * 100:.0f}%", sol(p), pct(roi)] for k, cnt, w, p, roi in data]

    hdr = ["", "trades", "win", "PnL SOL", "avg ROI"]
    md += ["## Breakdown", "", "### By exit reason", "", table(hdr, rows(by_exit)), "### By token age at entry", "", table(hdr, rows(by_age)),
           "### By leader", "", table(hdr, [[f"`{r[0][:8]}…`", *r[1:]] for r in rows(by_leader)])]

    # ---- signals ----
    total, entered, blocked = c.execute(
        "SELECT count(*), SUM(decision='enter'), SUM(decision='risk_block') FROM signals WHERE ts >= ? AND ts < ?", (since, now_ms)
    ).fetchone()
    reasons: Counter[str] = Counter()
    for (r,) in c.execute("SELECT reasons FROM signals WHERE decision = 'reject' AND ts >= ? AND ts < ?", (since, now_ms)):
        for reason in json.loads(r):
            reasons[_bucket(reason)] += 1
    md += ["## Signals", "", f"{total or 0} evaluated, {entered or 0} entered, {blocked or 0} blocked by risk.", "",
           table(["rejection reason", "count"], [[k, str(v)] for k, v in reasons.most_common(10)])]

    # ---- wallets ----
    tracked = c.execute("SELECT count(*) FROM tracked_wallets WHERE active = 1").fetchone()[0]
    dropped = c.execute(
        "SELECT deactivated_reason, count(*) FROM tracked_wallets WHERE deactivated_at >= ? GROUP BY 1 ORDER BY 2 DESC", (since,)
    ).fetchall()
    added = c.execute("SELECT count(*) FROM tracked_wallets WHERE added_at >= ? AND active = 1", (since,)).fetchone()[0]
    md += ["## Tracked wallets", "", f"{tracked} tracked now; {added} added this week.", ""]
    md += [f"- dropped: {r} ({n})" for r, n in dropped] + [""]

    # ---- data health ----
    usage = c.execute(
        "SELECT day, SUM(CASE WHEN source != 'pumpportal' THEN bytes END) FROM stream_usage WHERE day >= ? GROUP BY day ORDER BY day", (start,)
    ).fetchall()
    restarts = c.execute("SELECT count(*) FROM collector_gaps WHERE source = 'all' AND started_at >= ?", (since,)).fetchone()[0]
    outages = c.execute(
        """SELECT source, count(*), SUM(COALESCE(ended_at, ?) - started_at) FROM collector_gaps
           WHERE started_at >= ? AND reason NOT IN ('off-hours', 'daily budget used', 'stopped') GROUP BY source""",
        (now_ms, since),
    ).fetchall()
    md += ["## Data health", "", f"- collector restarts: {restarts}"]
    md += [f"- {src} outages: {cnt}, total {(ms or 0) / 60000:.0f} min" for src, cnt, ms in outages]
    md += [f"- Helius {d}: {(b or 0) / 1e6:.0f} MB" for d, b in usage] + [""]
    return "\n".join(md)


def _bucket(reason: str) -> str:
    """Collapse numbers so reasons group: 'token age 2400s outside [3, 1800]' -> 'token age Ns outside [N, N]'."""
    import re

    return re.sub(r"(?<![A-Za-z0-9.])-?\d+(\.\d+)?", "N", reason)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("DB_PATH", str(ROOT / "data/trading.db")))
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--out", default=str(ROOT / "reports"))
    a = ap.parse_args()
    db = Path(a.db) if Path(a.db).is_absolute() else ROOT / a.db
    c = connect(str(db))
    migrate(c)
    now = int(time.time() * 1000)
    md = build(c, now, a.days)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"weekly-{time.strftime('%Y-%m-%d', time.gmtime(now / 1000))}.md"
    tmp = path.with_suffix(".tmp")  # the notifier only picks up *.md: write then rename
    tmp.write_text(md)
    tmp.rename(path)
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
