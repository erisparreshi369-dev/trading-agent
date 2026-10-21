"""Trade journal: every closed practice trade written down with why we went in, what happened,
and what went wrong; then a tally of which mistakes cost the most.

A pro trader journals every trade and keeps a recap: "the last six times I skipped this check, I
lost". This does that for the bot, from what it already stored (the signal's features, the fills,
the exit). Mistakes come in two kinds: `entry` ones are decisions a rule could avoid (late,
chasing); `exit` ones describe how a trade went wrong after we were in. It only reads; it never changes
what the bot does (the brain and the practice tests decide that from data).

    python3 learner/journal.py [--days 7] [--last 20]     (make journal)
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIN_N = 15  # trades with a mistake before the tally calls it costly or fine

# key: (kind, words). Order = how a trade's line lists them.
MISTAKES = {
    "late": ("entry", "bought late: paid 2%+ more than the trader we copied"),
    "chasing": ("entry", "chased a coin that went vertical (curve filled > 30 SOL/min)"),
    "gave_back": ("exit", "was up 30%+ and still ended in a loss"),
    "dumped": ("exit", "the trader we copied sold within 30 s"),
    "stopped": ("exit", "hit the stop loss"),
    "timed_out": ("exit", "went nowhere until the time limit"),
    "fees": ("exit", "the price held, but fees turned it into a loss"),
}
LATE_BPS = 200
CHASE_SOL_PER_MIN = 30
GAVE_BACK_PEAK = 0.30
DUMP_S = 30
EXIT_WORDS = {"leader_exit": "the trader sold", "stop_loss": "stop loss", "time_exit": "time limit", "kill_switch": "emergency stop"}


def trades(c: sqlite3.Connection, since: int, until: int) -> list[dict]:
    """Closed practice trades in [since, until), newest first, each with its mistakes."""
    if c.execute("SELECT 1 FROM sqlite_master WHERE name = 'paper_positions'").fetchone() is None:
        return []
    rows = c.execute(
        """SELECT p.id, p.mint, p.leader_wallet, p.opened_at, p.closed_at, p.exit_reason, p.cost_sol, p.pnl_sol, p.entry_price, p.peak_price,
                  s.features,
                  (SELECT slippage_bps FROM paper_fills f WHERE f.position_id = p.id AND f.side = 'buy' AND f.ok = 1 ORDER BY f.id LIMIT 1),
                  (SELECT price FROM paper_fills f WHERE f.position_id = p.id AND f.side = 'sell' AND f.ok = 1 ORDER BY f.id DESC LIMIT 1),
                  t.symbol
           FROM paper_positions p LEFT JOIN signals s ON s.id = p.signal_id LEFT JOIN tokens t ON t.mint = p.mint
           WHERE p.status = 'closed' AND p.closed_at >= ? AND p.closed_at < ? ORDER BY p.closed_at DESC, p.id DESC""",
        (since, until)).fetchall()
    out = []
    for (pid, mint, leader, opened, closed, exit_reason, cost, pnl, entry, peak, feats, slip, sell_price, symbol) in rows:
        try:
            f = json.loads(feats or "{}")
        except ValueError:
            f = {}
        age, liq = f.get("token_age_s"), f.get("liquidity_sol")
        speed = liq / (age / 60) if f.get("venue") == "curve" and isinstance(age, (int, float)) and age > 0 and isinstance(liq, (int, float)) else None
        tags = []
        if slip is not None and slip > LATE_BPS:
            tags.append("late")
        if speed is not None and speed > CHASE_SOL_PER_MIN:
            tags.append("chasing")
        if pnl < 0 and entry and peak and peak >= entry * (1 + GAVE_BACK_PEAK):
            tags.append("gave_back")
        if exit_reason == "leader_exit" and opened and closed - opened < DUMP_S * 1000:
            tags.append("dumped")
        if exit_reason == "stop_loss":
            tags.append("stopped")
        if exit_reason == "time_exit" and pnl < 0:
            tags.append("timed_out")
        if pnl < 0 and entry and sell_price and sell_price >= entry:
            tags.append("fees")
        out.append({
            "id": pid, "mint": mint, "symbol": symbol, "leader": leader, "opened_at": opened, "closed_at": closed,
            "hold_s": (closed - opened) / 1000 if opened else None, "exit": exit_reason, "pnl": pnl, "roi": pnl / cost if cost else 0.0,
            "leader_buy": f.get("leader_buy_sol"), "confirmations": f.get("confirmations"), "age_s": age, "speed": speed,
            "slip_bps": slip, "peak_roi": (peak / entry - 1) if entry and peak else None, "mistakes": tags,
        })
    return out


def tally(ts: list[dict]) -> list[dict]:
    """Per mistake: how often, its trades' results, and how they compare with the trades without it."""
    out = []
    for key, (kind, words) in MISTAKES.items():
        hit = [t for t in ts if key in t["mistakes"]]
        if not hit:
            continue
        rest = [t for t in ts if key not in t["mistakes"]]
        avg = sum(t["roi"] for t in hit) / len(hit)
        rest_avg = sum(t["roi"] for t in rest) / len(rest) if rest else None
        n = len(hit)
        if n < MIN_N or rest_avg is None:
            verdict = "too early"
        elif avg < rest_avg - 0.02:
            verdict = "costly"
        else:
            verdict = "not costly"
        out.append({"key": key, "kind": kind, "words": words, "n": n, "wins": sum(t["pnl"] > 0 for t in hit), "pnl": sum(t["pnl"] for t in hit),
                    "avg_roi": avg, "rest_avg_roi": rest_avg, "verdict": verdict})
    return sorted(out, key=lambda m: m["pnl"])


def recap(t: dict) -> str:
    """One trade in words: why in, what happened, what went wrong."""
    name = t["symbol"] or t["mint"][:6]
    why = []
    if isinstance(t["leader_buy"], (int, float)):
        why.append(f"trader bought {t['leader_buy']:.2f} SOL")
    if isinstance(t["confirmations"], (int, float)):
        why.append(f"{int(t['confirmations'])} of ours in")
    if isinstance(t["age_s"], (int, float)):
        why.append(f"coin {int(t['age_s'])}s old")
    hold = f" after {int(t['hold_s'])}s" if t["hold_s"] is not None else ""
    out = f"{EXIT_WORDS.get(t['exit'] or '', t['exit'] or '?')}{hold}"
    peak = f", best {t['peak_roi'] * 100:+.0f}%" if t["peak_roi"] is not None else ""
    wrong = "; ".join(MISTAKES[m][1] for m in t["mistakes"]) or "nothing"
    return f"{name} {t['pnl']:+.4f} SOL ({t['roi'] * 100:+.1f}%) · in: {', '.join(why) or '?'} · out: {out}{peak} · went wrong: {wrong}"


def section(c: sqlite3.Connection, since: int, until: int, table, sol, pct) -> list[str]:
    """Weekly report section (the report passes its own formatting helpers)."""
    ts = trades(c, since, until)
    if not ts:
        return []
    ms = tally(ts)
    clean = sum(not t["mistakes"] for t in ts)
    md = ["## Trade journal", "",
          f"_Every closed practice trade, written down with what went wrong. `entry` mistakes are decisions a rule could avoid; "
          f"`exit` ones are how a trade went wrong once we were in. `vs others` = average return of the trades without that mistake. "
          f"Verdict after {MIN_N} trades: `costly` when those trades did 2+ points worse._", "",
          f"{len(ts)} trades, {clean} without a mistake."]
    leak = next((m for m in ms if m["verdict"] == "costly"), None)
    if leak:
        md.append(f"Biggest leak: **{leak['words']}** ({leak['n']} trades, {sol(leak['pnl'])} SOL).")
    md.append("")
    if ms:
        md.append(table(["mistake", "kind", "trades", "won", "PnL SOL", "avg return", "vs others", "verdict"], [
            [m["words"], m["kind"], str(m["n"]), str(m["wins"]), sol(m["pnl"]), pct(m["avg_roi"]), pct(m["rest_avg_roi"]), m["verdict"]] for m in ms]))
        md.append("")
    md += ["Last trades:", ""] + [f"- {recap(t)}" for t in ts[:10]]
    return md + [""]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("DB_PATH", str(ROOT / "data/trading.db")))
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--last", type=int, default=20, help="trades to write out")
    a = ap.parse_args()
    c = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True, timeout=30)
    now = int(time.time() * 1000)
    ts = trades(c, now - a.days * 86_400_000, now)
    if not ts:
        print(f"No closed practice trades in the last {a.days} days.")
        return 0
    p = lambda x: "-" if x is None else f"{x * 100:+.1f}%"  # noqa: E731
    print(f"Trade journal, last {a.days} days: {len(ts)} trades, {sum(not t['mistakes'] for t in ts)} without a mistake.\n")
    for m in tally(ts):
        print(f"  {m['verdict']:>10}  {m['n']:>4} trades {m['pnl']:+.4f} SOL, avg {p(m['avg_roi'])} vs {p(m['rest_avg_roi'])} others  - {m['words']} ({m['kind']})")
    print(f"\nLast {min(a.last, len(ts))} trades:")
    for t in ts[:a.last]:
        print(f"  {time.strftime('%m-%d %H:%M', time.gmtime(t['closed_at'] / 1000))}  {recap(t)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
