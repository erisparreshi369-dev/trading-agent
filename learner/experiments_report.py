"""Markdown sections for the weekly report: shadow variants, filter hindsight, out-of-sample wallets,
costs per trade and by size, Helius spend vs the Free plan, disk growth, and the real period covered.

    sections(c, since, until)  -> list of markdown lines (the weekly report appends these)
    python learner/experiments_report.py [--db path] [--days 7]   prints them on their own
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "learner"))
import experiments as ex  # noqa: E402

HELIUS_FREE_CREDITS = 1_000_000  # per month
CREDITS_PER_MB = 20              # websocket data: 2 credits per 0.1 MB, uncompressed (helius.dev/docs/billing/credits)


def pct(x: float | None) -> str:
    return "-" if x is None else f"{x * 100:+.1f}%"


def sol(x: float | None) -> str:
    return "-" if x is None else f"{x:+.4f}"


def ts(ms: int | None, fmt: str = "%Y-%m-%d %H:%M") -> str:
    return "-" if not ms else time.strftime(fmt, time.gmtime(ms / 1000))


def table(headers: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return "_none yet_\n"
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(out) + "\n"


def config_number(key: str, default: float) -> float:
    m = re.search(rf"^\s+{key}:\s*([\d.]+)", (ROOT / "config/config.yaml").read_text(), re.M)
    return float(m.group(1)) if m else default


def period_line(c: sqlite3.Connection, since: int, until: int, days: int) -> tuple[str, str]:
    """(title range, one-line note) for the period the system actually ran, not the nominal window."""
    per = ex.period(c, since, until)
    covered = f"{per['hours']:.1f} hours" if per["hours"] < 48 else f"{per['hours'] / 24:.1f} days"
    note = (f"Covers {ts(per['start'])} to {ts(until)} UTC: {covered} of data"
            + (f" (the system started {ts(per['data_start'])} UTC, inside the {days}-day window)" if per["partial"] else "")
            + (f"; paper trading since {ts(per['paper_start'])} UTC." if per["paper_start"] else "."))
    return f"{ts(per['start'])} to {ts(until)} UTC", note


def sections(c: sqlite3.Connection, since: int, until: int) -> list[str]:
    return variants_md(c, since, until) + filters_md(c, since, until) + oos_md(c) + costs_md(c, since, until) \
        + ["## Data budget and disk", ""] + credits_md(c, since, until) + disk_md(c, until) + [""]


def variants_md(c: sqlite3.Connection, since: int, until: int) -> list[str]:
    md = ["## Shadow variants", "",
          "_Every signal paper-traded under each variant in parallel (fixed size, no balance or portfolio limits). "
          "`live` = the live settings. Settled ~30 min after the signal; `gap` = collector outage, left out._", ""]
    md.append(table(["variant", "taken", "closed", "missed", "win", "PnL SOL", "avg ROI", "median ROI", "costs % size", "exits"], [
        [f"`{v['variant']}`", f"{v['taken']}/{v['signals']}", str(v["closed"]), str(v["missed"]),
         f"{v['wins'] / v['closed'] * 100:.0f}%" if v["closed"] else "-", sol(v["pnl_sol"]), pct(v["avg_roi"]), pct(v["median_roi"]),
         pct(v["cost_share"]).lstrip("+"), ", ".join(f"{k} {n}" for k, n in sorted(v["exits"].items(), key=lambda x: -x[1]))]
        for v in ex.variants(c, since, until)]))
    chk = ex.live_check(c, since, until)
    if chk:
        md += [f"Check: on the {chk['n']} signals both traded, real paper trades averaged {pct(chk['paper_roi'])} and the `live` shadow "
               f"{pct(chk['shadow_roi'])} (largest difference {chk['max_abs_diff'] * 100:.2f} pts; differences come from sizing, "
               f"which shadows fix at `shadow.size_sol`).", ""]
    return md


def filters_md(c: sqlite3.Connection, since: int, until: int) -> list[str]:
    md = ["## Did each filter help?", "",
          "_What happened after every signal. Returns: spot price vs where we'd have bought (leader + delay), median. "
          "`follow ROI`: following it with the live exits, after all costs (`all_signals` variant), with the number of trades. "
          "`this reason only`: signals rejected for nothing else; the verdict uses those when there are 10+, since a signal with several reasons says little about any one. A filter helps if what it blocked would have lost money._", ""]
    md.append(table(["", "signals", "1 min", "5 min", "30 min", "peak 30m", "follow ROI (n)", "follow win", "this reason only: ROI (n)", "verdict"], [
        [r["group"], str(r["n"]), pct(r["ret_1m"]), pct(r["ret_5m"]), pct(r["ret_30m"]), pct(r["peak_30m"]), f"{pct(r['follow_roi'])} ({r['follow_n']})",
         f"{r['follow_win'] * 100:.0f}%" if r["follow_win"] is not None else "-",
         f"{pct(r['sole_roi'])} ({r['sole_n']})" if r["group"] != "(accepted)" else "",
         r["verdict"] + (" [on this-reason-only]" if r["verdict"] and r["verdict_on"] == "sole" and "few" not in r["verdict"] else "")]
        for r in ex.filter_hindsight(c, since, until)]))
    return md


def oos_md(c: sqlite3.Connection) -> list[str]:
    md = ["## Out-of-sample wallet check", ""]
    oos = ex.out_of_sample(c)
    if not oos or not oos["wallets"]:
        return md + ["_Nothing to compare yet: needs data older than `scoring.oos_days` (runs with `make score`, daily 00:15 UTC)._", ""]
    md += [f"_Scoring run {ts(oos['run_at'])} UTC: wallets scored on data before {ts(oos['split_at'])}, measured after it._", "",
           f"- top-ranked wallets: in-sample {pct(oos['top_is_roi'])}/trade → out-of-sample **{pct(oos['top_oos_roi'])}** "
           f"over {oos['top_oos_trades']} trades; all other wallets {pct(oos['rest_oos_roi'])} over {oos['rest_oos_trades']}",
           "- rank correlation in-sample vs out-of-sample ROI: "
           + (f"{oos['rank_corr']:+.2f} ({oos['rank_corr_n']} wallets with 5+ trades on both sides)" if oos["rank_corr"] is not None
              else f"too few wallets with 5+ trades on both sides ({oos['rank_corr_n']})"), ""]
    md.append(table(["rank", "wallet", "IS trades", "IS ROI", "OOS trades", "OOS ROI", "OOS PnL SOL"], [
        [str(r["is_rank"]), f"`{r['wallet'][:8]}…`", str(r["is_trades"]), pct(r["is_roi"]), str(r["oos_trades"]), pct(r["oos_roi"]), sol(r["oos_pnl_sol"])]
        for r in oos["top"]]))
    return md


def costs_md(c: sqlite3.Connection, since: int, until: int) -> list[str]:
    md = ["## Costs per trade", ""]
    rows = []
    for label, cs in (("paper trades", ex.paper_costs(c, since, until)), ("`live` shadow", ex.shadow_costs(c, since, until))):
        if cs:
            rows.append([label, str(cs["n"]), f"{cs['size_sol']:.3f}"] + [f"{cs[k]:.5f} ({cs[k] / cs['size_sol'] * 100:.1f}%)"
                        for k in ("platform", "executor", "slippage", "priority", "rent", "total")] + [f"{(cs['delay'] or 0) / cs['size_sol'] * 100:+.1f}%"])
    md.append(table(["", "trades", "size", "platform fee", "executor fee", "slippage", "priority fee", "rent (net)", "total", "delay drift"], rows))
    md += ["_SOL per round trip (% of size). Platform = pump.fun/PumpSwap protocol + creator fees; executor = PumpPortal 0.5%; "
           "slippage = price impact + extra slippage vs spot; priority = fixed per transaction; rent is refunded on exit. "
           "Delay drift = price move during the execution delay (not a fee; negative = we bought cheaper than the leader)._", "",
           "### Does a bigger position cut the cost share?", ""]
    md.append(table(["variant", "size SOL", "closed", "costs % size", "fixed % size", "slippage % size", "avg ROI", "PnL SOL"], [
        [f"`{r['variant']}`", f"{r['size_sol']:g}" if r["size_sol"] else "-", str(r["closed"]),
         *([f"{r['costs']['total'] / r['costs']['size_sol'] * 100:.1f}%", f"{r['costs']['fixed'] / r['costs']['size_sol'] * 100:.1f}%",
            f"{r['costs']['slippage'] / r['costs']['size_sol'] * 100:.1f}%"] if r["costs"] else ["-", "-", "-"]),
         pct(r["avg_roi"]), sol(r["pnl_sol"])] for r in ex.size_test(c, since, until)]))
    md += ["_`make costs` replays every copyable position of the scoring window at several sizes: a much bigger sample._", ""]
    return md


def credits_md(c: sqlite3.Connection, since: int, until: int) -> list[str]:
    """Helius spend per day vs the cap and the Free plan: websocket MB plus RPC calls (1 credit each)."""
    cap = config_number("daily_mb_cap", 1500)
    day0 = ts(since, "%Y-%m-%d")
    usage = c.execute("""SELECT day, SUM(CASE WHEN source != 'pumpportal' THEN bytes END), SUM(CASE WHEN source = 'targeted' THEN bytes END)
        FROM stream_usage WHERE day >= ? GROUP BY day ORDER BY day""", (day0,)).fetchall()
    holder = dict(c.execute("SELECT date(ts / 1000, 'unixepoch'), count(*) FROM holder_snapshots WHERE ts >= ? GROUP BY 1", (since,)).fetchall())
    onchain = dict(c.execute("""SELECT date(ts / 1000, 'unixepoch'), 2 * count(*) FROM signals WHERE ts >= ?
        AND (json_extract(features, '$.onchain_checked') = 1 OR json_extract(features, '$.top10_pct') IS NOT NULL) GROUP BY 1""", (since,)).fetchall())
    capped = {d for (d,) in c.execute("SELECT DISTINCT date(started_at / 1000, 'unixepoch') FROM collector_gaps WHERE reason = 'daily cap reached' AND started_at >= ?", (since,))}
    month = ts(until, "%Y-%m")
    out, month_credits = [], 0.0
    for d, b, tb in usage:
        mb, tmb = (b or 0) / 1e6, (tb or 0) / 1e6
        rpc = holder.get(d, 0) + onchain.get(d, 0)
        credits = mb * CREDITS_PER_MB + rpc
        month_credits += credits if d.startswith(month) else 0
        out.append(f"- Helius {d}: {mb:.0f} MB websocket ({mb / cap * 100:.0f}% of the {cap:.0f} MB daily cap; targeted streams {tmb:.0f} MB) "
                   f"+ ~{rpc} RPC calls ≈ {credits / 1000:.1f}k credits" + (" — **cap reached: following paused until 00:00 UTC**" if d in capped else ""))
    if month_credits:
        out.append(f"- {month} so far ≈ {month_credits / 1000:.0f}k of the Free plan's {HELIUS_FREE_CREDITS // 1000}k credits/month "
                   f"(the daily cap alone allows ≈ {cap * CREDITS_PER_MB * 30 / 1000:.0f}k/month)")
    return out


def disk_md(c: sqlite3.Connection, until: int) -> list[str]:
    db = Path(os.environ.get("DB_PATH", str(ROOT / "data/trading.db")))
    db = db if db.is_absolute() else ROOT / db
    size = sum(f.stat().st_size for f in db.parent.glob(db.name + "*")) if db.parent.exists() else 0
    free = shutil.disk_usage(db.parent if db.parent.exists() else ROOT).free
    out = [f"- database {size / 1e6:.0f} MB, disk free {free / 1e9:.0f} GB"]
    log = c.execute("SELECT day, bytes FROM db_size_log ORDER BY day").fetchall() if ex.has_table(c, "db_size_log") else []
    growth = [b2 - b1 for (_, b1), (_, b2) in zip(log, log[1:])][-7:]
    if growth:
        per_day = sum(growth) / len(growth)
        out.append(f"- growth {per_day / 1e6:.0f} MB/day (last {len(growth)} days)" + (f": ~{free / per_day:.0f} days of disk left" if per_day > 0 else ""))
    else:
        out.append("- growth per day: needs two days of size samples (db_size_log, written by the trader)")
    trades = c.execute("SELECT date(received_at / 1000, 'unixepoch'), count(*) FROM trades WHERE received_at > ? GROUP BY 1 ORDER BY 1",
                       (until - 8 * 86_400_000,)).fetchall()
    if trades:
        out.append("- trades stored per day: " + ", ".join(f"{d} {n:,}" for d, n in trades[-7:]) + " (kept forever unless config collector.retention says otherwise)")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("DB_PATH", str(ROOT / "data/trading.db")))
    ap.add_argument("--days", type=int, default=7)
    a = ap.parse_args()
    os.environ["DB_PATH"] = a.db
    c = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True, timeout=30)
    now = int(time.time() * 1000)
    since = now - a.days * 86_400_000
    title, note = period_line(c, since, now, a.days)
    print("\n".join([f"# Experiments {title}", "", f"_{note}_", ""] + sections(c, since, now)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
