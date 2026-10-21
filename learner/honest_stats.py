"""Honest numbers for closed practice trades: the ones a backtest usually flatters.

Idea from HKUDS/Vibe-Trading: a number that can't be worked out yet says so (None plus the reason)
instead of turning into a believable one. A profit factor with no losing trade is not "infinite",
it is unknown; a range from 3 trades is not a range. It only reads; it never changes what the bot does.

    profit factor   money won / money lost (above 1 = the wins pay for the losses)
    max drawdown    the biggest drop from a high point of the balance, starting money included
    losing streak   most losses in a row
    without best    the result if the single best trade had not happened (one moonshot carrying it?)
    likely range    average return per trade ± 2 standard errors; a verdict only after MIN_N trades
"""
from __future__ import annotations

import math
import sqlite3

MIN_N = 30  # trades before the likely range gives a verdict (same as the veteran habits)


def trades(c: sqlite3.Connection, since: int, until: int) -> list[tuple[float, float]]:
    """(pnl_sol, cost_sol) of closed practice trades in [since, until), oldest first."""
    if c.execute("SELECT 1 FROM sqlite_master WHERE name = 'paper_positions'").fetchone() is None:
        return []
    return c.execute(
        """SELECT pnl_sol, cost_sol FROM paper_positions WHERE status = 'closed' AND closed_at >= ? AND closed_at < ?
           ORDER BY closed_at, id""", (since, until)).fetchall()


def balance_at(c: sqlite3.Connection, ms: int) -> float:
    """Practice balance just before `ms`: the starting money plus every trade closed before it."""
    acct = c.execute("SELECT start_balance FROM paper_account WHERE id = 1").fetchone() \
        if c.execute("SELECT 1 FROM sqlite_master WHERE name = 'paper_account'").fetchone() else None
    start = acct[0] if acct else 1.0
    if c.execute("SELECT 1 FROM sqlite_master WHERE name = 'paper_positions'").fetchone() is None:
        return start
    done = c.execute("SELECT COALESCE(SUM(pnl_sol), 0) FROM paper_positions WHERE status = 'closed' AND closed_at < ?", (ms,)).fetchone()[0]
    return start + done


def stats(ts: list[tuple[float, float]], start: float) -> dict:
    """Every number with `why` = {name: reason} for the ones that can't be worked out yet (they are None)."""
    why: dict[str, str] = {}
    n = len(ts)
    pnls = [p for p, _ in ts]
    rois = [p / cost for p, cost in ts if cost]
    won = sum(p for p in pnls if p > 0)
    lost = -sum(p for p in pnls if p < 0)

    if not n:
        pf = None
        why["profit_factor"] = "no trades"
    elif lost == 0:
        pf = None
        why["profit_factor"] = "no losing trade yet"
    else:
        pf = won / lost

    balance, peak, dd, dd_pct = start, start, 0.0, 0.0
    for p in pnls:
        balance += p
        peak = max(peak, balance)
        if peak - balance > dd:
            dd = peak - balance
            dd_pct = dd / peak if peak > 0 else None
    if dd_pct is None:
        why["max_drawdown_pct"] = "the balance was at or below 0"

    streak = run = 0
    for p in pnls:
        run = run + 1 if p < 0 else 0
        streak = max(streak, run)

    total = sum(pnls)
    best = max(pnls) if pnls else None
    without_best = total - best if n >= 2 else None
    if n < 2:
        why["without_best"] = "fewer than 2 trades"
    carried = without_best is not None and total > 0 and without_best <= 0

    avg = sum(rois) / len(rois) if rois else None
    lo = hi = None
    if len(rois) < 2:
        why["range"] = "fewer than 2 trades"
    else:
        sd = math.sqrt(sum((r - avg) ** 2 for r in rois) / (len(rois) - 1))
        lo, hi = avg - 2 * sd / math.sqrt(len(rois)), avg + 2 * sd / math.sqrt(len(rois))
    if len(rois) < MIN_N:
        verdict = "too early"
    elif hi < 0:
        verdict = "losing"
    elif lo > 0:
        verdict = "winning"
    else:
        verdict = "can't tell yet"

    return {"n": n, "wins": sum(p > 0 for p in pnls), "pnl": total, "won": won, "lost": lost,
            "avg_win": won / sum(p > 0 for p in pnls) if won else None, "avg_loss": -lost / sum(p < 0 for p in pnls) if lost else None,
            "profit_factor": pf, "max_drawdown": dd, "max_drawdown_pct": dd_pct, "losing_streak": streak,
            "best": best, "without_best": without_best, "carried_by_best": carried,
            "avg_roi": avg, "lo": lo, "hi": hi, "verdict": verdict, "min_n": MIN_N, "why": why}


def lines(s: dict, sol, pct) -> list[str]:
    """The numbers as plain bullet lines; an unknown one says why."""
    def unknown(key: str) -> str:
        return f"unknown ({s['why'][key]})"

    pf = f"{s['profit_factor']:.2f}" + (" (the wins pay for the losses)" if s["profit_factor"] >= 1 else " (the losses are bigger than the wins)") \
        if s["profit_factor"] is not None else unknown("profit_factor")
    dd = f"{sol(-s['max_drawdown'])} SOL" + (f" ({pct(-s['max_drawdown_pct'])} from the high point)" if s["max_drawdown_pct"] is not None else f", {unknown('max_drawdown_pct')}")
    wb = f"{sol(s['without_best'])} SOL" + (" (one lucky trade carries the whole result)" if s["carried_by_best"] else "") \
        if s["without_best"] is not None else unknown("without_best")
    if s["lo"] is None:
        rng = unknown("range")
    else:
        rng = f"{pct(s['lo'])} to {pct(s['hi'])} per trade"
    say = {"too early": f"too early: {s['n']} of {s['min_n']} trades", "losing": "losing for sure (the whole range is below 0)",
           "winning": "winning for sure (the whole range is above 0)", "can't tell yet": "can't tell yet (the range crosses 0)"}[s["verdict"]]
    out = [f"- **Profit factor:** {pf}",
           f"- **Average win / loss:** {sol(s['avg_win'])} / {sol(s['avg_loss'])} SOL",
           f"- **Biggest drop (max drawdown):** {dd}",
           f"- **Longest losing streak:** {s['losing_streak']} trades",
           f"- **Without the best trade:** {wb}",
           f"- **Real average per trade is likely:** {rng}. Verdict: {say}"]
    return out


def section(c: sqlite3.Connection, since: int, until: int, table, sol, pct) -> list[str]:
    """Weekly report section (the report passes its own formatting helpers)."""
    ts = trades(c, since, until)
    if not ts:
        return []
    md = ["## Honest numbers", "",
          "_The numbers a good-looking result can hide. A number we can't work out yet says why instead of guessing. "
          f"The likely range is the average return ± 2 standard errors; a verdict needs {MIN_N} trades._", ""]
    week = stats(ts, balance_at(c, since))
    md += [f"This week ({week['n']} trades):", ""] + lines(week, sol, pct) + [""]
    every = trades(c, 0, until)
    if len(every) > len(ts):
        md += [f"Since the start ({len(every)} trades):", ""] + lines(stats(every, balance_at(c, 0)), sol, pct) + [""]
    return md
