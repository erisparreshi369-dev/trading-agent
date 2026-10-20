"""Weekly report section: buys skipped because the price moved too much, and whether the limit is right.

"What would have happened" comes from the shadow variant `no_slip_limit` (config shadow.variants):
every signal is also simulated with no slippage limit, with the same filters, delay, costs and
exits as the live paper trader. Its trades above the limit are exactly the ones we skip.
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VARIANT = "no_slip_limit"
SKIP_PREFIX = "skipped: price moved too much"
# slippage bands, in bps: is the money above the limit better or worse than below it?
BANDS = [(-10**9, 100), (100, 200), (200, 300), (300, 500), (500, 1000), (1000, 10**9)]


def limit_bps(c: sqlite3.Connection, config: Path = ROOT / "config/config.yaml") -> float:
    """paper.max_slippage_bps from config.yaml, tightened by the learner like the trader does (lib/safe-settings.ts)."""
    m = re.search(r"^paper:\n(?:[ \t]+.*\n|\n)*?[ \t]+max_slippage_bps:\s*([\d.]+)", config.read_text(), re.M)
    base = float(m.group(1)) if m else 300.0
    row = c.execute("SELECT value FROM kv WHERE key = 'learner.max_slippage_bps'").fetchone()
    try:
        proposed = float(row[0]) if row else None
    except ValueError:
        proposed = None
    return min(base, proposed) if proposed and proposed > 0 else base


def _pct(bps: float) -> str:
    return f"{bps / 100:g}%"


def _band(lo: int, hi: int) -> str:
    if lo < 0:
        return f"under {_pct(hi)}"
    if hi >= 10**9:
        return f"over {_pct(lo)}"
    return f"{_pct(lo)} to {_pct(hi)}"


def _has(c: sqlite3.Connection, table: str) -> bool:
    return c.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (table,)).fetchone() is not None


def section(c: sqlite3.Connection, since: int, until: int, table, sol, pct) -> list[str]:
    lim = limit_bps(c)
    md = [f"## Buys skipped because the price moved too much (limit {_pct(lim)})", "",
          f"_Slippage: how much more we would pay than the wallet we copy, because the price rose in the "
          f"moments before our order lands. Above {_pct(lim)} we skip the buy. Sells are never skipped._", ""]

    skipped = c.execute(
        """SELECT p.signal_id, f.slippage_bps, -p.pnl_sol FROM paper_positions p
           JOIN paper_fills f ON f.position_id = p.id AND f.side = 'buy' AND f.ok = 0
           WHERE p.status = 'failed' AND p.exit_reason LIKE ? AND p.closed_at >= ? AND p.closed_at < ?""",
        (SKIP_PREFIX + "%", since, until)).fetchall()
    fees = sum(r[2] or 0 for r in skipped)
    md += [f"- Skipped this week: **{len(skipped)}** buys. They cost {fees:.4f} SOL in network fees (a refused order still pays its fee)."]

    have_shadow = _has(c, "shadow_trades") and c.execute(
        "SELECT 1 FROM shadow_trades WHERE variant = ? AND signal_at >= ? LIMIT 1", (VARIANT, since)).fetchone()
    if not have_shadow:
        md += ["- What they would have done: not measured yet (the no-limit simulation starts once this version runs).", ""]
    else:
        ids = [r[0] for r in skipped]
        rows = c.execute(
            f"""SELECT status, pnl_sol, roi FROM shadow_trades WHERE variant = ? AND signal_id IN ({",".join("?" * len(ids)) or "NULL"})""",
            (VARIANT, *ids)).fetchall()
        closed = [r for r in rows if r[0] == "closed"]
        if closed:
            pnl = sum(r[1] for r in closed)
            wins = sum(r[1] > 0 for r in closed)
            md += [f"- If we had bought them anyway: {len(closed)} trades, {wins} winners, **{sol(pnl)} SOL** in total, "
                   f"{pct(sum(r[2] for r in closed) / len(closed))} per trade on average. "
                   + ("Skipping them **saved** money." if pnl < 0 else "Skipping them **cost** us money.")]
        else:
            md += ["- If we had bought them anyway: no result yet for these (their trades are still being measured)."]

        # every simulated buy this week by slippage band: does a higher slippage mean worse results?
        bands = []
        for lo, hi in BANDS:
            n, wins, pnl, roi = c.execute(
                """SELECT count(*), SUM(pnl_sol > 0), COALESCE(SUM(pnl_sol), 0), AVG(roi) FROM shadow_trades
                   WHERE variant = ? AND status = 'closed' AND signal_at >= ? AND signal_at < ? AND slippage_bps > ? AND slippage_bps <= ?""",
                (VARIANT, since, until, lo, hi)).fetchone()
            if n:
                bands.append([_band(lo, hi) + (" (we skip these)" if lo >= lim else ""), str(n), f"{(wins or 0) / n * 100:.0f}%", sol(pnl), pct(roi)])
        md += ["", "Every buy we could have copied this week, simulated without a limit, grouped by slippage:", "",
               table(["slippage", "trades", "winners", "PnL SOL", "avg per trade"], bands)]
        below = c.execute("""SELECT count(*), AVG(roi) FROM shadow_trades WHERE variant = ? AND status = 'closed' AND signal_at >= ? AND signal_at < ?
                             AND slippage_bps <= ?""", (VARIANT, since, until, lim)).fetchone()
        above = c.execute("""SELECT count(*), AVG(roi) FROM shadow_trades WHERE variant = ? AND status = 'closed' AND signal_at >= ? AND signal_at < ?
                             AND slippage_bps > ?""", (VARIANT, since, until, lim)).fetchone()
        md += [_verdict(lim, below, above, pct), ""]

    # trades we actually took above today's limit (before the rule, or before a stricter learner value)
    took = c.execute(
        """SELECT count(*), COALESCE(SUM(p.pnl_sol), 0) FROM paper_positions p JOIN paper_fills f ON f.position_id = p.id AND f.side = 'buy' AND f.ok = 1
           WHERE p.status = 'closed' AND p.closed_at >= ? AND p.closed_at < ? AND f.slippage_bps > ?""", (since, until, lim)).fetchone()
    if took[0]:
        md += [f"- Trades we did take with more than {_pct(lim)} slippage (before this rule): {took[0]}, {sol(took[1])} SOL in total."]
    sells = c.execute(
        """SELECT count(*), AVG(slippage_bps) FROM paper_fills WHERE side = 'sell' AND ok = 1 AND ts >= ? AND ts < ? AND slippage_bps > ?""",
        (since, until, lim)).fetchone()
    md += [f"- Sells where the price moved more than {_pct(lim)} before our sell landed: {sells[0]}"
           + (f" (on average {_pct(round(sells[1]))}). We sold anyway: an exit is never blocked." if sells[0] else "."), ""]
    return md


def _verdict(lim: float, below: tuple, above: tuple, pct) -> str:
    (nb, rb), (na, ra) = below, above
    if na < 5 or nb < 5:
        return f"**Is {_pct(lim)} right?** Not enough trades yet to tell ({nb} below, {na} above the limit; we want at least 5 of each)."
    if ra < rb:
        return (f"**Is {_pct(lim)} right?** It looks right: buys above the limit made {pct(ra)} per trade on average, "
                f"buys below it {pct(rb)}. Skipping the expensive ones helps.")
    return (f"**Is {_pct(lim)} right?** Maybe too strict: buys above the limit made {pct(ra)} per trade on average, "
            f"as good as or better than buys below it ({pct(rb)}). Worth checking again next week before changing it.")
