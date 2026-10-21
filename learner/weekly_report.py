"""Weekly markdown report, in plain English: is paper trading working, and what is and isn't.

Writes reports/weekly-<date>.md; the notifier sends a 📊 summary message plus this file to Telegram.
Phase 4 adds model results (feature importances, backtest) to this report.
Usage: python learner/weekly_report.py [--db path] [--days 7]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "shared"))
from migrate import connect, migrate  # noqa: E402

sys.path.insert(0, str(ROOT / "learner"))
import experiments as ex  # noqa: E402
import creator_section  # noqa: E402
import slippage_section  # noqa: E402
import journal  # noqa: E402
import honest_stats  # noqa: E402
import veteran  # noqa: E402


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


def ts(ms: int | None, fmt: str = "%Y-%m-%d %H:%M") -> str:
    return "-" if not ms else time.strftime(fmt, time.gmtime(ms / 1000))


TRADES_TO_JUDGE = 50  # same as TRADES_TO_JUDGE in trader/src/notifier/messages.ts

EXITS = {
    "leader_exit": "the wallet we copied sold",
    "stop_loss": "stop loss (price fell 25% below what we paid)",
    "time_exit": "held for the 30-minute maximum",
    "kill_switch": "trading was halted",
}

# Plain words for the signal engine's skip reasons (the Telegram messages use
# trader/src/notifier/messages.ts; this is the short version for the report's table).
SKIPS = [
    ("venue ", "on an exchange we don't use yet"),
    ("leader buy ", "the wallet's buy was too small"),
    ("token launch not seen", "we missed the token's launch"),
    ("token age ", "token too new or too old"),
    ("mayhem mode", "\"mayhem mode\" token"),
    ("dev launched ", "creator launches lots of tokens (scam pattern)"),
    ("leader is the token's dev", "the wallet created the token itself"),
    ("curve SOL ", "too little money in the token, or about to graduate"),
    ("tracked buyers", "not enough of our wallets bought"),
    ("re-entry cooldown", "traded this token less than an hour ago"),
    ("top10 holders", "a few wallets owned too much of it"),
    ("dev holds ", "the creator still owned a big share"),
    ("dev sold ", "the developer sold their tokens (rug warning)"),
    ("on-chain check failed", "safety checks couldn't run"),
    ("score ", "the wallet's track record isn't good enough"),
]


DROPS = [
    (r"median hold", "sells too fast for us to copy"),
    (r"follower ROI", "copying it would have lost money"),
    (r"closed positions", "not enough trades to judge it"),
    (r"copyable entries", "too few trades we could have copied in time"),
    (r"looks like a bot", "trades so many tokens it looks like a bot"),
    (r"from snipes", "its profit came from buying in a launch's first second, which we can't copy"),
    (r"cold|no trades", "stopped trading"),
]

FEEDS = {
    "all": "the data collector was offline",
    "helius": "the feed we find new wallets with was interrupted",
    "firehose": "the feed we find new wallets with was interrupted",
    "targeted": "the feed that watches our wallets was interrupted",
    "pumpportal": "the new-token feed was interrupted",
}


def plain_drop(reason: str | None) -> str:
    import re

    for pattern, text in DROPS:
        if reason and re.search(pattern, reason):
            return text
    return "no longer one of the best"


def plain_skip(reason: str) -> str:
    for prefix, text in SKIPS:
        if reason.startswith(prefix) or prefix in reason:
            return text
    return "other"


def verdict(closed: int, pnl_all: float, start: float, pnl_week: float) -> str:
    if closed < TRADES_TO_JUDGE:
        return f"Too early to tell: {closed} paper trades so far, and we want at least {TRADES_TO_JUDGE} before judging."
    roi = pct(pnl_all / start)
    if pnl_all > 0 and pnl_week >= 0:
        return f"Looking good so far: {roi} over {closed} paper trades. Keep watching a few more weeks before thinking about real money."
    if pnl_all > 0:
        return f"Mixed: {roi} overall, but down this week. Keep watching."
    return f"Not yet: {roi} over {closed} paper trades. It isn't ready for real money."


def build(c: sqlite3.Connection, now_ms: int, days: int) -> str:
    since = now_ms - days * 86_400_000
    end = time.strftime("%Y-%m-%d", time.gmtime(now_ms / 1000))
    start = time.strftime("%Y-%m-%d", time.gmtime(since / 1000))

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
    closed_all, pnl_all = c.execute(
        "SELECT SUM(status='closed'), COALESCE(SUM(pnl_sol),0) FROM paper_positions WHERE status IN ('closed','failed') AND closed_at < ?", (now_ms,)
    ).fetchone()
    start_bal = acct[1] if acct else 1.0

    md = [f"# Weekly report: {start} to {end} (PAPER, practice money)", ""]
    if acct and equity is not None:
        md.append(f"- **Balance:** {equity:.4f} SOL, {pct((equity - start_bal) / start_bal)} since we started with {start_bal:g} SOL")
    md += [
        f"- **This week:** {sol(pnl)} SOL from {n} trades, {wins} won" + (f" ({wins / n * 100:.0f}%)" if n else ""),
        f"- **Is it working yet?** {verdict(closed_all or 0, pnl_all, start_bal, pnl)}",
        "",
        "All results are after the fees, price movement and delay a real trade would have had.",
        "",
        "## What the words mean",
        "",
        "- **Result (SOL):** profit or loss in SOL. **Average per trade:** the average gain or loss as a % of what we put in.",
        "- **Slippage:** the price moving against us between the copied wallet's buy and ours.",
        "- **Stop loss:** a safety rule that sells when the price falls 25% below what we paid.",
        "- **Token age:** how long after the token's launch we bought it.",
        "- **N of our wallets bought it:** how many of the wallets we follow bought the same token within 2 minutes.",
        "",
        f"Average per trade this week: {pct(avg_roi)}. Buys that didn't go through (the price jumped too fast): {missed}.",
        "",
    ]
    md += honest_stats.section(c, since, now_ms, table, sol, pct)

    # ---- what's working / not ----
    by_leader = group(c, "p.leader_wallet", since, now_ms)
    by_exit = group(c, "p.exit_reason", since, now_ms)
    by_age = group(
        c,
        """CASE WHEN json_extract(s.features,'$.token_age_s') < 30 THEN 'a: under 30 seconds'
                WHEN json_extract(s.features,'$.token_age_s') < 120 THEN 'b: 30 seconds to 2 minutes'
                WHEN json_extract(s.features,'$.token_age_s') < 600 THEN 'c: 2 to 10 minutes' ELSE 'd: over 10 minutes' END""",
        since, now_ms,
    )
    by_conf = group(c, "COALESCE(json_extract(s.features,'$.confirmations'),1) || ' of our wallets bought it'", since, now_ms)
    working, not_working = [], []
    for k, cnt, w, p, roi in by_leader:
        if cnt >= 3:
            (working if p > 0 else not_working).append(f"wallet `{k[:4]}…{k[-4:]}`: {cnt} trades, {sol(p)} SOL, {pct(roi)} per trade")
    for label, rows_ in (("sold because", by_exit), ("token age", by_age), ("when", by_conf)):
        for k, cnt, w, p, roi in rows_:
            if cnt >= 3:
                name = EXITS.get(k, k) if label == "sold because" else str(k).split(": ", 1)[-1]
                (working if p > 0 else not_working).append(f"{label} {name}: {cnt} trades, {sol(p)} SOL, {pct(roi)} per trade")
    md += ["## What is making money", ""] + ([f"- {x}" for x in working] or ["- nothing with at least 3 trades yet"]) + [""]
    md += ["## What is losing money", ""] + ([f"- {x}" for x in not_working] or ["- nothing with at least 3 trades yet"]) + [""]

    def rows(data, name=lambda k: str(k)):
        return [[name(k), str(cnt), f"{(w or 0) / cnt * 100:.0f}%", sol(p), pct(roi)] for k, cnt, w, p, roi in data]

    hdr = ["", "trades", "won", "result (SOL)", "average per trade"]
    md += ["## Details", "", "### Why we sold", "", table(hdr, rows(by_exit, lambda k: EXITS.get(k, str(k)))),
           "### Token age when we bought", "", table(hdr, rows(by_age, lambda k: str(k).split(": ", 1)[-1])),
           "### By wallet we copied", "", table(hdr, [[f"`{r[0][:4]}…{r[0][-4:]}`", *r[1:]] for r in rows(by_leader)])]

    # ---- signals ----
    total, entered, blocked = c.execute(
        "SELECT count(*), SUM(decision='enter'), SUM(decision='risk_block') FROM signals WHERE ts >= ? AND ts < ?", (since, now_ms)
    ).fetchone()
    reasons: Counter[str] = Counter()
    for (r,) in c.execute("SELECT reasons FROM signals WHERE decision = 'reject' AND ts >= ? AND ts < ?", (since, now_ms)):
        rs = json.loads(r)
        reasons[plain_skip(rs[0]) if rs else "other"] += 1  # the first check it failed
    md += ["## Buys by our wallets", "",
           f"Our wallets made {total or 0} buys. We copied {entered or 0}; our safety limits stopped {blocked or 0}; the rest we skipped.", "",
           table(["why we skipped", "times"], [[k, str(v)] for k, v in reasons.most_common(10)])]

    md += slippage_section.section(c, since, now_ms, table, sol, pct)
    md += creator_section.section(c, since, now_ms, table, sol, pct)
    md += veteran.section(c, since, now_ms, table, sol, pct)
    md += journal.section(c, since, now_ms, table, sol, pct)

    # ---- wallets ----
    tracked = c.execute("SELECT count(*) FROM tracked_wallets WHERE active = 1").fetchone()[0]
    dropped = c.execute(
        "SELECT deactivated_reason, count(*) FROM tracked_wallets WHERE deactivated_at >= ? GROUP BY 1 ORDER BY 2 DESC", (since,)
    ).fetchall()
    added = c.execute("SELECT count(*) FROM tracked_wallets WHERE added_at >= ? AND active = 1", (since,)).fetchone()[0]
    md += ["## Wallets we follow", "", f"{tracked} now; {added} added this week.", ""]
    drops: Counter[str] = Counter()
    for r, k in dropped:
        drops[plain_drop(r)] += k
    md += [f"- dropped {k}: {r}" for r, k in drops.most_common()] + [""]

    # ---- data health ----
    usage = c.execute(
        "SELECT day, SUM(CASE WHEN source != 'pumpportal' THEN bytes END) FROM stream_usage WHERE day >= ? GROUP BY day ORDER BY day", (start,)
    ).fetchall()
    restarts = c.execute("SELECT count(*) FROM alerts WHERE kind = 'restart' AND ts >= ?", (since,)).fetchone()[0] \
        if _has_col(c, "alerts", "kind") else 0
    outages = c.execute(
        """SELECT source, count(*), SUM(COALESCE(ended_at, ?) - started_at) FROM collector_gaps
           WHERE started_at >= ? AND reason NOT IN ('off-hours', 'daily budget used', 'stopped') GROUP BY source""",
        (now_ms, since),
    ).fetchall()
    md += ["## Is the bot healthy?", "", f"- Unplanned restarts (it fixed itself each time): {restarts}"]
    md += [f"- {FEEDS.get(src, f'the {src} feed was interrupted').capitalize()}: {cnt} times, {(ms or 0) / 60000:.0f} minutes in total" for src, cnt, ms in outages]
    md += [f"- Data used on {d}: {(b or 0) / 1e6:.0f} MB from Helius (our market data provider)" for d, b in usage] + [""]
    return "\n".join(md)


def _has_col(c: sqlite3.Connection, table_name: str, col: str) -> bool:
    return any(r[1] == col for r in c.execute(f"PRAGMA table_info({table_name})"))


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
