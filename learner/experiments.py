"""What the experiments say: shadow variants, filter hindsight, out-of-sample wallets, costs, system period.

Pure queries over the database, shared by the weekly report and the dashboard. Every function
takes a connection and a [since, until) window in epoch ms and returns plain dicts/lists.
"""
from __future__ import annotations

import json
import re
import sqlite3
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIN_VERDICT_N = 10  # fewer signals than this: "too few to tell"


def has_table(c: sqlite3.Connection, name: str) -> bool:
    return c.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (name,)).fetchone() is not None


def _mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def _median(xs: list[float]) -> float | None:
    return statistics.median(xs) if xs else None


def bucket(reason: str) -> str:
    """Collapse numbers so reasons group: 'token age 2400s outside [3, 1800]' -> 'token age Ns outside [N, N]'."""
    return re.sub(r"(?<![A-Za-z0-9.])-?\d+(\.\d+)?", "N", reason)


# ---------------------------------------------------------------- period

def period(c: sqlite3.Connection, since: int, until: int) -> dict:
    """The period the system actually ran inside [since, until): first data, paper start, hours covered."""
    first_trade = c.execute("SELECT min(received_at) FROM trades").fetchone()[0]
    paper_start = c.execute("SELECT created_at FROM paper_account WHERE id = 1").fetchone() if has_table(c, "paper_account") else None
    starts = [x for x in (first_trade, paper_start[0] if paper_start else None) if x]
    data_start = min(starts) if starts else until
    start = max(since, data_start)
    return {
        "start": start, "end": until, "hours": (until - start) / 3_600_000, "window_days": (until - since) / 86_400_000,
        "data_start": data_start, "paper_start": paper_start[0] if paper_start else None, "partial": start > since,
    }


# ---------------------------------------------------------------- shadow variants

def variants(c: sqlite3.Connection, since: int, until: int) -> list[dict]:
    """One row per shadow variant: what it took, what it made, what it paid."""
    if not has_table(c, "shadow_trades"):
        return []
    out = []
    names = [r[0] for r in c.execute("SELECT DISTINCT variant FROM shadow_trades WHERE signal_at >= ? AND signal_at < ?", (since, until))]
    for v in names:
        rows = c.execute(
            """SELECT status, pnl_sol, roi, size_sol, exit_reason, platform_fee_sol + executor_fee_sol + priority_fee_sol + slippage_sol + rent_sol
               FROM shadow_trades WHERE variant = ? AND signal_at >= ? AND signal_at < ?""", (v, since, until)).fetchall()
        closed = [r for r in rows if r[0] == "closed"]
        rois = [r[2] for r in closed]
        exits: dict[str, int] = {}
        for r in closed:
            exits[r[4]] = exits.get(r[4], 0) + 1
        out.append({
            "variant": v,
            "signals": len(rows),
            "taken": sum(r[0] != "filtered" for r in rows),
            "closed": len(closed),
            "pending": sum(r[0] == "pending" for r in rows),
            "missed": sum(r[0] == "missed" for r in rows),
            "gap": sum(r[0] == "gap" for r in rows),
            "size_sol": closed[0][3] if closed else (rows[0][3] if rows else None),
            "wins": sum(r[1] > 0 for r in closed),
            "pnl_sol": sum(r[1] for r in closed),
            "avg_roi": _mean(rois),
            "median_roi": _median(rois),
            "cost_share": _mean([r[5] / r[3] for r in closed if r[5] is not None]),
            "exits": exits,
        })
    return sorted(out, key=lambda r: (r["avg_roi"] is None, -(r["avg_roi"] or 0)))


def live_check(c: sqlite3.Connection, since: int, until: int) -> dict | None:
    """The 'live' shadow variant against the real paper trades on the same signals (should agree)."""
    if not has_table(c, "shadow_trades"):
        return None
    rows = c.execute(
        """SELECT p.pnl_sol / p.cost_sol, s.roi FROM paper_positions p JOIN shadow_trades s ON s.signal_id = p.signal_id AND s.variant = 'live'
           WHERE p.status = 'closed' AND s.status = 'closed' AND p.closed_at >= ? AND p.closed_at < ?""", (since, until)).fetchall()
    if not rows:
        return None
    return {"n": len(rows), "paper_roi": _mean([r[0] for r in rows]), "shadow_roi": _mean([r[1] for r in rows]),
            "max_abs_diff": max(abs(a - b) for a, b in rows)}


# ---------------------------------------------------------------- did each filter help?

def filter_hindsight(c: sqlite3.Connection, since: int, until: int) -> list[dict]:
    """
    For accepted signals and for each rejection reason: what the price did 1/5/30 min after our
    would-be entry, and what following it would have made after all costs ('all_signals' variant).
    A filter helps if the signals it rejected would have lost money.
    """
    if not has_table(c, "signal_outcomes"):
        return []
    rows = c.execute(
        """SELECT s.decision, s.reasons, o.entry_spot, o.price_1m, o.price_5m, o.price_30m, o.max_30m, x.status, x.roi
           FROM signals s JOIN signal_outcomes o ON o.signal_id = s.id
           LEFT JOIN shadow_trades x ON x.signal_id = s.id AND x.variant = 'all_signals'
           WHERE o.status = 'ok' AND s.ts >= ? AND s.ts < ?""", (since, until)).fetchall()
    groups: dict[str, dict] = {}

    def add(key: str, r, sole: bool) -> None:
        g = groups.setdefault(key, {"group": key, "n": 0, "sole": 0, "r1": [], "r5": [], "r30": [], "peak": [], "follow": [], "follow_sole": []})
        g["n"] += 1
        g["sole"] += sole
        e = r[2]
        if e:
            for k, p in (("r1", r[3]), ("r5", r[4]), ("r30", r[5]), ("peak", r[6])):
                if p is not None:
                    g[k].append(p / e - 1)
        if r[7] == "closed" and r[8] is not None:
            g["follow"].append(r[8])
            if sole:
                g["follow_sole"].append(r[8])

    for r in rows:
        if r[0] in ("enter", "risk_block"):
            add("(accepted)", r, True)
            continue
        reasons = {bucket(x) for x in json.loads(r[1])}
        for b in reasons:
            add(b, r, len(reasons) == 1)
    out = []
    for g in groups.values():
        follow = g["follow_sole"] if len(g["follow_sole"]) >= MIN_VERDICT_N else g["follow"]
        roi = _mean(follow)
        if g["group"] == "(accepted)":
            verdict = ""
        elif len(follow) < MIN_VERDICT_N:
            verdict = "too few to tell"
        else:
            verdict = "helps (blocked losers)" if roi < 0 else "hurts (blocked winners)"
        out.append({
            "group": g["group"], "n": g["n"], "sole": g["sole"], "ret_1m": _median(g["r1"]), "ret_5m": _median(g["r5"]), "ret_30m": _median(g["r30"]),
            "peak_30m": _median(g["peak"]), "follow_n": len(g["follow"]), "follow_roi": _mean(g["follow"]),
            "sole_n": len(g["follow_sole"]), "sole_roi": _mean(g["follow_sole"]), "verdict_on": "sole" if follow is g["follow_sole"] else "all",
            "follow_win": (sum(x > 0 for x in g["follow"]) / len(g["follow"])) if g["follow"] else None, "verdict": verdict,
        })
    return sorted(out, key=lambda r: (r["group"] != "(accepted)", -r["n"]))


# ---------------------------------------------------------------- out-of-sample wallets

def _ranks(xs: list[float]) -> list[float]:
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2
        i = j + 1
    return r


def spearman(a: list[float], b: list[float]) -> float | None:
    if len(a) < 5:
        return None
    ra, rb = _ranks(a), _ranks(b)
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va, vb = sum((x - ma) ** 2 for x in ra), sum((y - mb) ** 2 for y in rb)
    return cov / (va * vb) ** 0.5 if va and vb else None


def out_of_sample(c: sqlite3.Connection, top_n: int = 25) -> dict | None:
    """Latest scoring run's out-of-sample check."""
    if not has_table(c, "wallet_oos"):
        return None
    run = c.execute("SELECT max(run_at) FROM wallet_oos").fetchone()[0]
    if not run:
        return None
    rows = [dict(zip(("wallet", "split_at", "is_trades", "is_roi", "is_eligible", "is_rank", "oos_trades", "oos_roi", "oos_pnl_sol"), r)) for r in c.execute(
        """SELECT wallet, split_at, is_trades, is_roi, is_eligible, is_rank, oos_trades, oos_roi, oos_pnl_sol FROM wallet_oos
           WHERE run_at = ? ORDER BY is_rank IS NULL, is_rank, is_roi DESC""", (run,))]
    top = [r for r in rows if r["is_rank"] is not None and r["is_rank"] <= top_n]
    rest = [r for r in rows if r not in top]
    both = [r for r in rows if r["is_trades"] >= 5 and r["oos_trades"] >= 5]

    def pooled(rs):  # trade-weighted mean out-of-sample ROI
        n = sum(r["oos_trades"] for r in rs if r["oos_roi"] is not None)
        return (sum(r["oos_roi"] * r["oos_trades"] for r in rs if r["oos_roi"] is not None) / n, n) if n else (None, 0)

    top_roi, top_n_trades = pooled(top)
    rest_roi, rest_n_trades = pooled(rest)
    return {
        "run_at": run, "split_at": rows[0]["split_at"] if rows else None, "wallets": len(rows), "top": top,
        "top_is_roi": _mean([r["is_roi"] for r in top if r["is_roi"] is not None]), "top_oos_roi": top_roi, "top_oos_trades": top_n_trades,
        "rest_oos_roi": rest_roi, "rest_oos_trades": rest_n_trades,
        "rank_corr": spearman([r["is_roi"] for r in both], [r["oos_roi"] for r in both]), "rank_corr_n": len(both),
    }


# ---------------------------------------------------------------- costs

COST_KEYS = ("platform", "executor", "priority", "slippage", "rent")


def paper_costs(c: sqlite3.Connection, since: int, until: int) -> dict | None:
    """Average cost per closed paper trade, by kind (fills recorded since the breakdown existed)."""
    if not c.execute("SELECT 1 FROM pragma_table_info('paper_fills') WHERE name = 'platform_fee_sol'").fetchone():
        return None
    rows = c.execute(
        """SELECT p.cost_sol, SUM(f.platform_fee_sol), SUM(f.executor_fee_sol), SUM(f.priority_fee_sol), SUM(f.slippage_sol), SUM(f.rent_sol),
                  SUM(f.delay_sol), p.pnl_sol
           FROM paper_positions p JOIN paper_fills f ON f.position_id = p.id AND f.ok = 1
           WHERE p.status = 'closed' AND p.closed_at >= ? AND p.closed_at < ?
           GROUP BY p.id HAVING count(*) = 2 AND count(f.platform_fee_sol) = 2""", (since, until)).fetchall()
    if not rows:
        return None
    return _cost_summary([(r[0], r[1:6], r[6], r[7]) for r in rows])


def shadow_costs(c: sqlite3.Connection, since: int, until: int, variant: str = "live") -> dict | None:
    if not has_table(c, "shadow_trades"):
        return None
    rows = c.execute(
        """SELECT size_sol, platform_fee_sol, executor_fee_sol, priority_fee_sol, slippage_sol, rent_sol, delay_sol, pnl_sol FROM shadow_trades
           WHERE variant = ? AND status = 'closed' AND signal_at >= ? AND signal_at < ?""", (variant, since, until)).fetchall()
    return _cost_summary([(r[0], r[1:6], r[6], r[7]) for r in rows]) if rows else None


def _cost_summary(rows: list[tuple]) -> dict:
    n = len(rows)
    out = {"n": n, "size_sol": _mean([r[0] for r in rows])}
    for i, k in enumerate(COST_KEYS):
        out[k] = sum(r[1][i] or 0 for r in rows) / n
    out["total"] = sum(out[k] for k in COST_KEYS)
    out["fixed"] = out["priority"] + out["rent"]
    out["delay"] = _mean([r[2] for r in rows if r[2] is not None])
    out["share"] = _mean([sum(x or 0 for x in r[1]) / r[0] for r in rows])
    out["pnl"] = sum(r[3] for r in rows) / n
    return out


def size_test(c: sqlite3.Connection, since: int, until: int) -> list[dict]:
    """The 'live' variant and the size_* variants: same signals and rules, different size."""
    out = []
    for v in variants(c, since, until):
        if v["variant"] == "live" or v["variant"].startswith("size_"):
            costs = shadow_costs(c, since, until, v["variant"])
            out.append({**v, "costs": costs})
    return sorted(out, key=lambda r: r["size_sol"] or 0)
