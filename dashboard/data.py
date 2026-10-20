"""Everything the dashboard shows, computed from the shared SQLite database and systemd.

Read-only by construction: the database is opened with mode=ro plus PRAGMA query_only, and
nothing here imports trader code, reads .env, or calls anything that can change state.
Risk limits and paper costs are parsed from their source files (trader/src/risk/limits.ts,
config/config.yaml) so the dashboard shows the numbers the trader actually enforces.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import time
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVICES = ["collector", "trader", "notifier"]
LEARNER_UNITS = {"weekly": "weekly report / retrain", "score": "wallet re-scoring"}
STALE_HEARTBEAT_MS = 5 * 60_000
QUIET_MS = 5 * 60_000
SHRINK_K = 10  # trader/src/scoring/score.ts: pseudo-trades of zero ROI in the wallet score
FEED_KEEP = 200  # per category


def db_path() -> Path:
    p = Path(os.environ.get("DB_PATH", ROOT / "data/trading.db"))
    return p if p.is_absolute() else ROOT / p


def connect_ro(path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10, isolation_level=None, check_same_thread=False)
    c.execute("PRAGMA query_only = ON")
    c.row_factory = sqlite3.Row
    return c


def now_ms() -> int:
    return int(time.time() * 1000)


def utc_day(ms: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))


def utc_day_start(ms: int) -> int:
    return ms - ms % 86_400_000


# ---------------------------------------------------------------- source-file parameters

def risk_limits(path: Path = ROOT / "trader/src/risk/limits.ts") -> dict[str, float]:
    """NAME: 30 * 60_000, -> {"NAME": 1800000}. Only numeric literals and products."""
    out = {}
    for name, expr in re.findall(r"^\s*([A-Z_]+):\s*([\d_.\s*]+),", path.read_text(), re.M):
        v = 1.0
        for part in expr.split("*"):
            v *= float(part.strip().replace("_", ""))
        out[name] = v
    return out


PAPER_DEFAULTS = {"start_balance_sol": 1.0, "priority_fee_sol": 0.0003, "executor_fee_bps": 50, "extra_slippage_bps": 50,
                  "token_account_rent_sol": 0.00203928, "execution_delay_ms": 1500}


def paper_costs(path: Path = ROOT / "config/config.yaml") -> dict[str, float]:
    """The paper: section's numbers (no YAML dependency: these keys are flat scalars)."""
    out = dict(PAPER_DEFAULTS)
    text = path.read_text() if path.exists() else ""
    m = re.search(r"^paper:\n((?:[ \t]+.*\n|\n)*)", text, re.M)
    for key, val in re.findall(r"^\s+(\w+):\s*([-\d.]+)", m.group(1) if m else "", re.M):
        if key in out:
            out[key] = float(val)
    return out


# ---------------------------------------------------------------- market math (mirrors trader/src/sim/market.ts)

def fee_rate(t: sqlite3.Row) -> float:
    if not t["sol_lamports"] or t["fee_lamports"] is None:
        return 0.0125
    r = (t["fee_lamports"] + (t["creator_fee_lamports"] or 0)) / t["sol_lamports"]
    return r if 0 < r < 0.1 else 0.0125


def sell_value(t: sqlite3.Row, tokens: int, cost: dict[str, float]) -> float | None:
    """Net SOL from selling `tokens` at the state left by trade `t`, rent refund included (= PaperEngine.markValue)."""
    if not t["v_sol_reserves"] or not t["v_token_reserves"]:
        return None
    gross = t["v_sol_reserves"] * tokens / (t["v_token_reserves"] + tokens) / 1e9
    gross *= 1 - cost["extra_slippage_bps"] / 10_000
    fees = gross * (fee_rate(t) + cost["executor_fee_bps"] / 10_000) + cost["priority_fee_sol"]
    return max(0.0, gross - fees) + cost["token_account_rent_sol"]


# ---------------------------------------------------------------- systemd

def _show(units: list[str], props: str) -> list[dict[str, str]]:
    try:
        out = subprocess.run(["systemctl", "--user", "show", *units, "-p", props, "--timestamp=unix"],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return []
    blocks = []
    for chunk in out.strip().split("\n\n"):
        blocks.append(dict(line.split("=", 1) for line in chunk.splitlines() if "=" in line))
    return blocks


def systemd_status() -> dict[str, dict]:
    units = [f"trading-{s}.service" for s in SERVICES + list(LEARNER_UNITS) + ["dashboard"]]
    mono = time.monotonic()
    res = {}
    for b in _show(units, "Id,ActiveState,SubState,MainPID,NRestarts,ActiveEnterTimestampMonotonic,Result,ExecMainExitTimestamp,ExecMainStatus"):
        name = b.get("Id", "").removeprefix("trading-").removesuffix(".service")
        entered = int(b.get("ActiveEnterTimestampMonotonic") or 0)
        exit_ts = b.get("ExecMainExitTimestamp", "")
        res[name] = {
            "active": b.get("ActiveState"), "sub": b.get("SubState"), "pid": int(b.get("MainPID") or 0) or None,
            "restarts": int(b.get("NRestarts") or 0),
            "uptime_s": round(mono - entered / 1e6) if entered and b.get("ActiveState") == "active" else None,
            "result": b.get("Result"), "exit_status": b.get("ExecMainStatus"),
            "last_exit_at": int(exit_ts[1:]) * 1000 if exit_ts.startswith("@") else None,
        }
    try:
        timers = json.loads(subprocess.run(["systemctl", "--user", "list-timers", "trading-*", "--all", "-o", "json"],
                                           capture_output=True, text=True, timeout=5).stdout or "[]")
    except Exception:
        timers = []
    for t in timers:
        name = t["unit"].removeprefix("trading-").removesuffix(".timer")
        res.setdefault(name, {})["timer"] = {"next_at": t["next"] // 1000 if t.get("next") else None,
                                             "last_at": t["last"] // 1000 if t.get("last") else None}
    return res


# ---------------------------------------------------------------- snapshot (all panels except the feed)

class Snapshot:
    """Builds the panel data. Expensive aggregates are cached for a while; the rest is cheap."""

    def __init__(self, c: sqlite3.Connection, path: Path):
        self.c, self.path = c, path
        self.limits = risk_limits()
        self.costs = paper_costs()
        self._cache: dict[str, tuple[float, object]] = {}

    def cached(self, key: str, ttl_s: float, fn):
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < ttl_s:
            return hit[1]
        v = fn()
        self._cache[key] = (time.monotonic(), v)
        return v

    def q(self, sql: str, *a) -> list[sqlite3.Row]:
        return self.c.execute(sql, a).fetchall()

    def one(self, sql: str, *a):
        r = self.c.execute(sql, a).fetchone()
        return r[0] if r is not None else None

    def has(self, table: str) -> bool:
        return self.one("SELECT 1 FROM sqlite_master WHERE name = ?", table) is not None

    def has_col(self, table: str, col: str) -> bool:
        return any(r["name"] == col for r in self.q(f"PRAGMA table_info({table})"))

    def build(self, svc: dict[str, dict], now: int | None = None) -> dict:
        now = now or now_ms()
        heartbeats = {r["service"]: r for r in self.q("SELECT service, ts, pid, info FROM service_heartbeats")}
        info = {k: json.loads(r["info"] or "{}") for k, r in heartbeats.items()}
        positions = self.positions(now)
        money = self.money(now, positions)
        return {
            "now": now,
            "mode": (info.get("trader", {}).get("mode") or "unknown").upper(),
            "services": self.services(svc, heartbeats, info, now),
            "money": money,
            "positions": positions,
            "closed": self.closed(),
            "wallets": self.cached("wallets", 10, lambda: self.wallets(now)),
            "risk": self.risk(now, money, positions),
            "data": self.data(now, info.get("collector", {})),
            "latency": self.cached("latency", 15, lambda: self.latency(now)),
            "learner": self.cached("learner", 30, lambda: self.learner(svc, info.get("scoring"), heartbeats.get("scoring"))),
        }

    # ---- 1. services
    def services(self, svc, heartbeats, info, now) -> list[dict]:
        out = []
        # restarts after a crash/kill are alerts: kind='restart' (migration 004) or, before it, recognisable by their text
        restart_sql = ("kind = 'restart'" if self.has_col("alerts", "kind") else "text LIKE '%restarted after%'")
        runs = {r["service"]: r for r in self.q("SELECT * FROM service_runs")} if self.has("service_runs") else {}
        for name in SERVICES:
            hb = heartbeats.get(name)
            s = svc.get(name, {})
            crashes = self.one(f"SELECT count(*) FROM alerts WHERE source = ? AND ts >= ? AND {restart_sql}", name, utc_day_start(now)) \
                if self.has("alerts") else 0
            run = runs.get(name)
            running = s.get("active") == "active"
            fresh = bool(hb) and now - hb["ts"] < STALE_HEARTBEAT_MS
            out.append({
                "name": name, "state": ("running" if fresh else "stale") if running else (s.get("sub") or s.get("active") or "unknown"),
                "ok": running and fresh, "pid": s.get("pid"), "uptime_s": s.get("uptime_s"), "restarts": s.get("restarts"),
                "crashes_today": int(crashes or 0), "heartbeat_at": hb["ts"] if hb else None, "info": info.get(name, {}),
                "run_state": run["state"] if run else None, "crash_detail": run["detail"] if run else None,
            })
        # the learner is timer-driven: "ok" means its timers are scheduled and the last runs succeeded
        runs = []
        for unit, label in LEARNER_UNITS.items():
            s = svc.get(unit, {})
            runs.append({"unit": unit, "label": label, "active": s.get("active"), "result": s.get("result"),
                         "last_run_at": s.get("last_exit_at"), "next_at": (s.get("timer") or {}).get("next_at")})
        hb = heartbeats.get("scoring")
        out.append({
            "name": "learner", "state": "running" if any(r["active"] == "active" for r in runs) else
            ("scheduled" if all(r["next_at"] for r in runs) else "not scheduled"),
            "ok": all(r["next_at"] for r in runs) and all(r["result"] in (None, "success") for r in runs),
            "runs": runs, "heartbeat_at": hb["ts"] if hb else None,
            "restarts": sum(svc.get(u, {}).get("restarts", 0) for u in LEARNER_UNITS), "uptime_s": None,
        })
        return out

    # ---- 3. money
    def money(self, now: int, positions: list[dict]) -> dict:
        if not self.has("paper_account"):
            return {"started": False}
        acct = self.c.execute("SELECT balance_sol, start_balance FROM paper_account WHERE id = 1").fetchone()
        if not acct:
            return {"started": False}
        balance, start = acct
        equity = balance + sum(p["mark_sol"] for p in positions)
        unrealized = sum(p["unrealized_sol"] or 0 for p in positions)
        rs = self.c.execute("SELECT day, day_start_equity FROM risk_state WHERE id = 1").fetchone()
        day_start_eq = rs["day_start_equity"] if rs and rs["day"] == utc_day(now) else None

        def realized(since: int) -> float:
            return self.one("SELECT COALESCE(SUM(pnl_sol), 0) FROM paper_positions WHERE status IN ('closed','failed') AND closed_at >= ?", since)

        closed = self.q("SELECT pnl_sol, cost_sol, closed_at FROM paper_positions WHERE status = 'closed' ORDER BY closed_at")
        wins = [r["pnl_sol"] for r in closed if r["pnl_sol"] > 0]
        losses = [r["pnl_sol"] for r in closed if r["pnl_sol"] <= 0]
        # equity curve: start + realized PnL (closed and failed fills) in time order, then today's marked equity
        curve = [[self.one("SELECT created_at FROM paper_account WHERE id = 1"), start]]
        run = start
        for r in self.q("SELECT closed_at, pnl_sol FROM paper_positions WHERE status IN ('closed','failed') AND pnl_sol IS NOT NULL ORDER BY closed_at"):
            run += r["pnl_sol"]
            curve.append([r["closed_at"], round(run, 6)])
        curve.append([now, round(equity, 6)])
        peak, max_dd = curve[0][1], 0.0
        for _, v in curve:
            peak = max(peak, v)
            max_dd = max(max_dd, (peak - v) / peak if peak else 0)
        fills = self.c.execute("""SELECT COALESCE(SUM(fees_sol), 0), SUM(side = 'buy' AND ok = 1),
            COALESCE(SUM(CASE WHEN ok = 1 AND slippage_bps > 0 THEN
              CASE side WHEN 'buy' THEN sol * (1 - 1 / (1 + slippage_bps / 10000.0)) ELSE sol * slippage_bps / 10000.0 END END), 0)
            FROM paper_fills""").fetchone()
        # buy fees include token-account rent: refunded on exit (and still held while open), so it isn't a cost
        fees = fills[0] - self.costs["token_account_rent_sol"] * (fills[1] or 0)
        return {
            "started": True, "start": start, "balance": balance, "equity": equity, "unrealized": unrealized,
            "pnl_all": equity - start, "pnl_today": (equity - day_start_eq) if day_start_eq is not None else realized(utc_day_start(now)),
            "realized_today": realized(utc_day_start(now)), "realized_7d": realized(now - 7 * 86_400_000), "realized_all": realized(0),
            "closed": len(closed), "win_rate": len(wins) / len(closed) if closed else None,
            "avg_win": sum(wins) / len(wins) if wins else None, "avg_loss": sum(losses) / len(losses) if losses else None,
            "max_drawdown": max_dd, "fees_paid": fees, "slippage_cost": fills[2],
            "failed_fills": self.one("SELECT count(*) FROM paper_positions WHERE status = 'failed'"),
            "curve": curve,
        }

    # ---- 4. positions
    def positions(self, now: int) -> list[dict]:
        if not self.has("paper_positions"):
            return []
        out = []
        for p in self.q("""SELECT p.*, t.symbol, t.name FROM paper_positions p LEFT JOIN tokens t ON t.mint = p.mint
                           WHERE p.status IN ('pending', 'open') ORDER BY p.id"""):
            mark, last_trade_at = p["size_sol"], None
            if p["status"] == "open":
                mark = p["cost_sol"] or 0
                if p["tokens"] and p["last_price"]:
                    t = self.c.execute("SELECT * FROM trades WHERE mint = ? AND received_at <= ? ORDER BY received_at DESC, id DESC LIMIT 1",
                                       (p["mint"], now)).fetchone()
                    if t:
                        v = sell_value(t, p["tokens"], self.costs)
                        mark = v if v is not None else mark
                        last_trade_at = t["received_at"]
            unreal = mark - p["cost_sol"] if p["status"] == "open" and p["cost_sol"] else None
            out.append({
                "id": p["id"], "mint": p["mint"], "symbol": p["symbol"], "leader": p["leader_wallet"], "status": p["status"],
                "size_sol": p["size_sol"], "cost_sol": p["cost_sol"], "entry_price": p["entry_price"], "last_price": p["last_price"],
                "peak_price": p["peak_price"], "opened_at": p["opened_at"], "entry_due_at": p["entry_due_at"],
                "exit_trigger": p["exit_trigger"], "mark_sol": mark, "unrealized_sol": unreal,
                "unrealized_pct": unreal / p["cost_sol"] if unreal is not None else None, "last_trade_at": last_trade_at,
            })
        return out

    def closed(self, limit: int = 100) -> list[dict]:
        if not self.has("paper_positions"):
            return []
        rows = self.q("""SELECT p.id, p.mint, t.symbol, p.status, p.opened_at, p.closed_at, p.entry_price, p.cost_sol, p.size_sol,
              p.pnl_sol, p.exit_reason, p.leader_wallet,
              (SELECT price FROM paper_fills f WHERE f.position_id = p.id AND f.side = 'sell' AND f.ok = 1 ORDER BY f.id DESC LIMIT 1) exit_price
            FROM paper_positions p LEFT JOIN tokens t ON t.mint = p.mint
            WHERE p.status IN ('closed', 'failed') ORDER BY p.closed_at DESC LIMIT ?""", limit)
        return [{**dict(r), "size_sol": r["cost_sol"] or r["size_sol"],
                 "pnl_pct": r["pnl_sol"] / r["cost_sol"] if r["cost_sol"] and r["pnl_sol"] is not None else None,
                 "hold_ms": r["closed_at"] - r["opened_at"] if r["opened_at"] and r["closed_at"] else None} for r in rows]

    # ---- 5. wallets
    def wallets(self, now: int) -> dict:
        if not self.has("wallet_scores"):
            return {"active": [], "dropped": []}
        rows = self.q("""SELECT w.*, s.copy_trades, s.copy_missed, s.copy_roi, s.copy_win_rate, s.closed_positions, s.realized_pnl_sol,
              s.median_hold_s, s.run_at
            FROM tracked_wallets w LEFT JOIN wallet_scores s ON s.wallet = w.wallet
              AND s.run_at = (SELECT max(run_at) FROM wallet_scores WHERE wallet = w.wallet)
            ORDER BY w.active DESC, w.score DESC""")
        active, dropped = [], []
        day = now - 86_400_000
        for r in rows:
            d = dict(r)
            n = r["copy_trades"] or 0
            d["confidence"] = n / (n + SHRINK_K)
            if r["active"]:
                d["trades_24h"] = self.one("SELECT count(*) FROM trades WHERE wallet = ? AND block_time > ?", r["wallet"], day)
                d["last_trade_at"] = self.one("SELECT max(received_at) FROM trades WHERE wallet = ?", r["wallet"])
                sig = self.c.execute("SELECT count(*), SUM(decision = 'enter') FROM signals WHERE wallet = ? AND ts > ?", (r["wallet"], day)).fetchone()
                d["signals_24h"], d["followed_24h"] = sig[0], sig[1] or 0
                d["paper_pnl"] = self.one("SELECT COALESCE(SUM(pnl_sol), 0) FROM paper_positions WHERE leader_wallet = ? AND status = 'closed'", r["wallet"])
                active.append(d)
            else:
                dropped.append(d)
        dropped.sort(key=lambda d: d.get("deactivated_at") or 0, reverse=True)
        return {"active": active, "dropped": dropped[:50],
                "last_run_at": self.one("SELECT max(run_at) FROM wallet_scores")}

    # ---- 6. risk
    def risk(self, now: int, money: dict, positions: list[dict]) -> dict:
        L = self.limits
        rs = self.c.execute("SELECT * FROM risk_state WHERE id = 1").fetchone() if self.has("risk_state") else None
        kill_file = (ROOT / "data/KILL").exists()
        out = {
            "limits": L, "open": len(positions), "max_open": L.get("MAX_OPEN_POSITIONS"),
            "entries_today": self.one("SELECT count(*) FROM paper_positions WHERE entry_due_at >= ?", utc_day_start(now)) if self.has("paper_positions") else 0,
            "max_entries": L.get("MAX_ENTRIES_PER_DAY"),
            "killed": bool(rs and rs["kill_switch"]) or kill_file, "kill_reason": (rs["kill_reason"] if rs else None) or ("data/KILL file present" if kill_file else None),
            "kill_at": rs["kill_at"] if rs else None, "halted": bool(rs and rs["halted_day"] == utc_day(now)),
        }
        if money.get("started"):
            eq, start = money["equity"], money["start"]
            day_start = rs["day_start_equity"] if rs and rs["day"] == utc_day(now) and rs["day_start_equity"] else eq
            out["daily_loss"] = max(0.0, (day_start - eq) / day_start) if day_start else 0.0
            out["daily_cap"] = L.get("DAILY_LOSS_CAP_PCT")
            out["drawdown"] = max(0.0, (start - eq) / start)
            out["drawdown_cap"] = L.get("MAX_DRAWDOWN_PCT")
        return out

    # ---- 7. data collection
    def data(self, now: int, collector: dict) -> dict:
        def hourly():
            since = now - 24 * 3_600_000
            tr = dict(self.q("SELECT received_at / 3600000 h, count(*) FROM trades WHERE received_at > ? GROUP BY h", since))
            tk = dict(self.q("SELECT first_seen_at / 3600000 h, count(*) FROM tokens WHERE first_seen_at > ? GROUP BY h", since))
            mb = dict(self.q("""SELECT hour / 3600000 h, SUM(bytes) / 1e6 FROM stream_usage_hourly WHERE hour > ? AND source != 'pumpportal'
                                GROUP BY h""", since)) if self.has("stream_usage_hourly") else {}
            h0 = now // 3_600_000
            return [{"h": (h0 - i) * 3_600_000, "trades": tr.get(h0 - i, 0), "tokens": tk.get(h0 - i, 0), "mb": mb.get(h0 - i, 0)}
                    for i in range(23, -1, -1)]

        totals = self.cached("totals", 30, lambda: {"tokens": self.one("SELECT count(*) FROM tokens"),
                                                     "trades": self.one("SELECT count(*) FROM trades")})
        last_trade = self.one("SELECT max(received_at) FROM trades")
        last_token = self.one("SELECT max(first_seen_at) FROM tokens")
        last_event = max(last_trade or 0, last_token or 0) or None
        streams = collector.get("streams", {})
        size = sum(p.stat().st_size for p in self.path.parent.glob(self.path.name + "*"))
        warnings = []
        if not last_event or now - last_event > QUIET_MS:
            warnings.append(f"no new trades or tokens for {fmt_age(now - last_event) if last_event else 'ever'}")
        elif streams.get("firehose") and last_trade and now - last_trade > QUIET_MS:
            warnings.append(f"firehose is up but no trades for {fmt_age(now - last_trade)}")
        if streams.get("pumpportal") is False:
            warnings.append("PumpPortal stream down (no new launches)")
        if collector.get("dataMode") not in (None, "normal"):
            warnings.append(f"data budget: {collector['dataMode'].replace('_', ' ')} mode until 00:00 UTC")
        if streams.get("targeted") is False:
            warnings.append("targeted Helius stream down (tracked wallets not followed)")
        open_gaps = self.q("SELECT source, started_at, reason FROM collector_gaps WHERE ended_at IS NULL ORDER BY started_at DESC")
        return {
            **totals, "last_trade_at": last_trade, "last_token_at": last_token, "last_event_at": last_event,
            "trades_1h": self.one("SELECT count(*) FROM trades WHERE received_at > ?", now - 3_600_000),
            "tokens_1h": self.one("SELECT count(*) FROM tokens WHERE first_seen_at > ?", now - 3_600_000),
            "hourly": self.cached("hourly", 60, hourly), "db_bytes": size, "warnings": warnings,
            "streams": streams, "helius_mb": collector.get("heliusMbToday"), "helius_cap_mb": collector.get("heliusCapMb"),
            "helius_mb_per_hour": collector.get("heliusMbPerHour"), "helius_cap_at": collector.get("heliusCapAt"),
            "data_mode": collector.get("dataMode"), "budget_steps_pct": collector.get("budgetStepsPct"),
            "open_gaps": [dict(g) for g in open_gaps],
        }

    # ---- 8. latency
    def latency(self, now: int) -> dict:
        since = now - 7 * 86_400_000
        rows = self.q("""SELECT t.block_time, t.received_at, s.ts,
              (SELECT opened_at FROM paper_positions p WHERE p.signal_id = s.id ORDER BY p.id LIMIT 1) opened_at
            FROM signals s JOIN trades t ON t.id = s.leader_trade_id WHERE s.ts > ?""", since) if self.has("signals") else []
        detect = [r["received_at"] - r["block_time"] for r in rows if r["block_time"]]
        decide = [r["ts"] - r["received_at"] for r in rows]
        fill = [r["opened_at"] - r["ts"] for r in rows if r["opened_at"]]
        total = [r["opened_at"] - r["block_time"] for r in rows if r["opened_at"] and r["block_time"]]
        return {"window_days": 7, "stages": [
            {"name": "detect", "desc": "leader tx block time → collector received it", **pct(detect)},
            {"name": "decide", "desc": "received → signal decision recorded", **pct(decide)},
            {"name": "fill", "desc": "decision → entry filled (paper: simulated landing)", **pct(fill)},
            {"name": "total", "desc": "leader tx → our fill", **pct(total)},
        ], "note": "block_time has 1 s resolution, so detect is coarse"}

    # ---- 9. learner
    def learner(self, svc: dict, scoring: dict | None, scoring_hb) -> dict:
        model = None
        current = ROOT / "models/current.json"
        if current.exists():
            try:
                model = json.loads(current.read_text())
            except ValueError:
                model = {"error": "models/current.json is not valid JSON"}
        reports = sorted((ROOT / "reports").glob("weekly-*.md"))
        report = None
        if reports:
            r = reports[-1]
            report = {"name": r.name, "at": int(r.stat().st_mtime * 1000), "markdown": r.read_text()[:60_000]}
        return {"model": model, "report": report, "scoring": scoring, "scoring_at": scoring_hb["ts"] if scoring_hb else None}


def pct(xs: list[float]) -> dict:
    if not xs:
        return {"n": 0, "p50": None, "p95": None}
    xs = sorted(xs)
    at = lambda q: xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]
    return {"n": len(xs), "p50": at(0.5), "p95": at(0.95)}


def fmt_age(ms: float) -> str:
    s = ms / 1000
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if s >= n:
            return f"{s / n:.1f}{unit}"
    return f"{s:.0f}s"


# ---------------------------------------------------------------- live activity feed

CATS = ["launch", "wallet", "followed", "rejected", "trade", "error", "system"]


class Feed:
    """Turns new rows in each source table into feed items. Keeps the newest FEED_KEEP per category."""

    def __init__(self, c: sqlite3.Connection):
        self.c = c
        self.items = {k: deque(maxlen=FEED_KEEP) for k in CATS}
        self.cur: dict[str, int] = {}
        self.svc_seen: dict[str, tuple] = {}

    def seed(self) -> None:
        """Load recent history (newest FEED_KEEP of each category) and set cursors at the head."""
        c, n = self.c, FEED_KEEP
        self.cur = {
            "tokens": c.execute("SELECT COALESCE(max(rowid), 0) FROM tokens").fetchone()[0],
            "trades": c.execute("SELECT COALESCE(max(id), 0) FROM trades").fetchone()[0],
            "signals": c.execute("SELECT COALESCE(max(id), 0) FROM signals").fetchone()[0],
            "fills": c.execute("SELECT COALESCE(max(id), 0) FROM paper_fills").fetchone()[0],
            "alerts": c.execute("SELECT COALESCE(max(id), 0) FROM alerts").fetchone()[0] if _has(c, "alerts") else 0,
            "gaps": c.execute("SELECT COALESCE(max(id), 0) FROM collector_gaps").fetchone()[0],
        }
        rows = []
        rows += [self._token(r) for r in c.execute(f"{TOKEN_SQL} ORDER BY k.rowid DESC LIMIT {n}")]
        wallets = [r[0] for r in c.execute("SELECT wallet FROM tracked_wallets WHERE active = 1")]
        wt = []
        for w in wallets:  # per wallet via its index; a full scan for "trades by any tracked wallet" is slow on a big table
            wt += c.execute(f"{TRADE_SQL} WHERE t.wallet = ? ORDER BY t.block_time DESC LIMIT {n}", (w,)).fetchall()
        wt.sort(key=lambda r: r["id"], reverse=True)
        rows += [self._trade(r) for r in wt[:n]]
        for decision in ("enter", "reject", "risk_block"):
            rows += [self._signal(r) for r in c.execute(f"{SIGNAL_SQL} WHERE s.decision = ? ORDER BY s.id DESC LIMIT {n}", (decision,))]
        rows += [self._fill(r) for r in c.execute(f"{FILL_SQL} ORDER BY f.id DESC LIMIT {n}")]
        if _has(c, "alerts"):
            rows += [self._alert(r) for r in c.execute(f"SELECT * FROM alerts ORDER BY id DESC LIMIT {n * 2}")]
        rows += [self._gap(r) for r in c.execute(f"SELECT * FROM collector_gaps ORDER BY id DESC LIMIT {n}")]
        for it in sorted(rows, key=lambda i: i["ts"]):
            self.items[it["cat"]].append(it)

    def poll(self, now: int | None = None) -> list[dict]:
        """New items since the last call, oldest first."""
        c, cur, now = self.c, self.cur, now or now_ms()
        new = []
        rows = c.execute(f"{TOKEN_SQL} WHERE k.rowid > ? ORDER BY k.rowid LIMIT 2000", (cur["tokens"],)).fetchall()
        if rows:
            cur["tokens"] = rows[-1]["rid"]
            new += [self._token(r) for r in rows]
        head = c.execute("SELECT COALESCE(max(id), 0) FROM trades").fetchone()[0]
        if head > cur["trades"]:
            rows = c.execute(f"""{TRADE_SQL} WHERE t.id > ? AND t.id <= ? AND t.wallet IN (SELECT wallet FROM tracked_wallets WHERE active = 1)
                ORDER BY t.id""", (cur["trades"], head)).fetchall()
            cur["trades"] = head
            new += [self._trade(r) for r in rows]
        # a signal's decision can flip enter -> risk_block right after insert; give it a second to settle
        rows = c.execute(f"{SIGNAL_SQL} WHERE s.id > ? AND s.ts <= ? ORDER BY s.id", (cur["signals"], now - 1000)).fetchall()
        if rows:
            cur["signals"] = rows[-1]["id"]
            new += [self._signal(r) for r in rows]
        rows = c.execute(f"{FILL_SQL} WHERE f.id > ? ORDER BY f.id", (cur["fills"],)).fetchall()
        if rows:
            cur["fills"] = rows[-1]["fid"]
            new += [self._fill(r) for r in rows]
        if _has(c, "alerts"):
            rows = c.execute("SELECT * FROM alerts WHERE id > ? ORDER BY id", (cur["alerts"],)).fetchall()
            if rows:
                cur["alerts"] = rows[-1]["id"]
                new += [self._alert(r) for r in rows]
        rows = c.execute("SELECT * FROM collector_gaps WHERE id > ? ORDER BY id", (cur["gaps"],)).fetchall()
        if rows:
            cur["gaps"] = rows[-1]["id"]
            new += [self._gap(r) for r in rows]
        new.sort(key=lambda i: i["ts"])
        for it in new:
            self.items[it["cat"]].append(it)
        return new

    def systemd_events(self, svc: dict[str, dict], now: int | None = None) -> list[dict]:
        """Service starts/stops seen by polling systemd (clean restarts leave no trace in the database)."""
        now = now or now_ms()
        new = []
        for name in SERVICES:
            s = svc.get(name)
            if not s:
                continue
            key = (s.get("active"), s.get("pid"), s.get("restarts"))
            prev = self.svc_seen.get(name)
            self.svc_seen[name] = key
            if prev is None or prev == key:
                continue
            if s.get("active") == "active" and s.get("pid") and s.get("pid") != prev[1]:
                auto = (s.get("restarts") or 0) > (prev[2] or 0)
                text = f"{name} {'restarted by systemd after a crash' if auto else 'started'} (pid {s['pid']}, restart #{s.get('restarts')})"
                new.append(_item(f"sd:{name}:{now}", "error" if auto else "system", "restart" if auto else "start", now, text, level="warn" if auto else "info"))
            elif s.get("active") != "active" and prev[0] == "active":
                new.append(_item(f"sd:{name}:{now}", "error", "stop", now, f"{name} is {s.get('active')} ({s.get('sub')})", level="error"))
        for it in new:
            self.items[it["cat"]].append(it)
        return new

    def all(self) -> list[dict]:
        return sorted((i for d in self.items.values() for i in d), key=lambda i: i["ts"])

    # ---- row -> item
    def _token(self, r) -> dict:
        dev = r["initial_buy_lamports"]
        return _item(f"tok:{r['rid']}", "launch", "launch", r["first_seen_at"],
                     f"{_sym(r)} launched" + (f" · dev bought {dev / 1e9:.2f} SOL" if dev else ""),
                     mint=r["mint"], wallet=r["creator"], mayhem=bool(r["is_mayhem_mode"]))

    def _trade(self, r) -> dict:
        side = "buy" if r["is_buy"] else "sell"
        return _item(f"tr:{r['id']}", "wallet", f"wallet_{side}", r["received_at"],
                     f"{r['label'] or _short(r['wallet'])} {'bought' if r['is_buy'] else 'sold'} {r['sol_lamports'] / 1e9:.3f} SOL of {_sym(r)}",
                     mint=r["mint"], wallet=r["wallet"], venue=r["venue"], sol=r["sol_lamports"] / 1e9, price=r["price_sol"])

    def _signal(self, r) -> dict:
        d = r["decision"]
        reasons = json.loads(r["reasons"] or "[]")
        cat = "followed" if d == "enter" else "rejected"
        verb = {"enter": "FOLLOWED", "reject": "rejected", "risk_block": "blocked by risk"}.get(d, d)
        return _item(f"sig:{r['id']}", cat, d, r["ts"], f"signal {verb}: {_short(r['wallet'])} → {_sym(r)}",
                     mint=r["mint"], wallet=r["wallet"], score=r["score"], reasons=reasons,
                     features=json.loads(r["features"] or "{}"))

    def _fill(self, r) -> dict:
        side, ok = r["side"], bool(r["ok"])
        if not ok:
            text = f"paper {side} FAILED {_sym(r)}: {r['reason'] or ''}"
        elif side == "buy":
            text = f"paper BUY {_sym(r)} {r['sol']:.4f} SOL" + (f" · slippage {r['slippage_bps']:+.0f} bps" if r["slippage_bps"] is not None else "")
        else:
            text = f"paper SELL {_sym(r)} → {r['sol']:.4f} SOL ({r['reason'] or 'exit'})"
        pnl = r["pnl_sol"] if side == "sell" and ok else None
        return _item(f"fill:{r['fid']}", "trade", f"paper_{side}" if ok else "fill_failed", r["ts"], text,
                     mint=r["mint"], wallet=r["leader_wallet"], pnl=pnl,
                     pnl_pct=pnl / r["cost_sol"] if pnl is not None and r["cost_sol"] else None, fees=r["fees_sol"])

    def _alert(self, r) -> dict:
        lvl, keys = r["level"], r.keys()
        kind = r["kind"] if "kind" in keys else None  # migration 004 adds alert kinds
        restart = kind == "restart" if kind else ("restarted after" in r["text"] or "back up" in r["text"])
        cat = "error" if lvl in ("warn", "error", "fatal") or restart else "system"
        label = f"[{r['source']}{'' if not kind or kind in ('error', 'restart') else ' · ' + kind}]"
        return _item(f"al:{r['id']}", cat, "restart" if restart else lvl, r["ts"], f"{label} {r['text']}", level=lvl)

    def _gap(self, r) -> dict:
        expected = r["reason"] in ("off-hours", "daily budget used", "stopped")
        return _item(f"gap:{r['id']}", "system" if expected else "error", "gap", r["started_at"],
                     f"{r['source']} stream {'paused' if expected else 'down'}: {r['reason'] or '?'}", level="info" if expected else "warn")


TOKEN_SQL = "SELECT k.rowid rid, k.mint, k.symbol, k.name, k.creator, k.first_seen_at, k.initial_buy_lamports, k.is_mayhem_mode FROM tokens k"
TRADE_SQL = """SELECT t.id, t.received_at, t.wallet, t.mint, t.is_buy, t.sol_lamports, t.price_sol, t.venue, k.symbol, k.name, w.label
  FROM trades t LEFT JOIN tokens k ON k.mint = t.mint LEFT JOIN tracked_wallets w ON w.wallet = t.wallet"""
SIGNAL_SQL = "SELECT s.*, k.symbol, k.name FROM signals s LEFT JOIN tokens k ON k.mint = s.mint"
FILL_SQL = """SELECT f.id fid, f.ts, f.side, f.ok, f.sol, f.slippage_bps, f.fees_sol, f.reason, p.mint, p.leader_wallet, p.cost_sol, p.pnl_sol, k.symbol, k.name
  FROM paper_fills f JOIN paper_positions p ON p.id = f.position_id LEFT JOIN tokens k ON k.mint = p.mint"""


def _item(id_: str, cat: str, kind: str, ts: int, text: str, **extra) -> dict:
    return {"id": id_, "cat": cat, "kind": kind, "ts": ts, "text": text, **{k: v for k, v in extra.items() if v is not None}}


def _short(a: str | None) -> str:
    return f"{a[:4]}…{a[-4:]}" if a else "?"


def _sym(r) -> str:
    return f"${r['symbol']}" if r["symbol"] else _short(r["mint"])


def _has(c: sqlite3.Connection, table: str) -> bool:
    return c.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (table,)).fetchone() is not None
