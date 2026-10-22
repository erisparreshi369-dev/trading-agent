"""`make status`: is everything running, how fresh is the data, how is paper trading doing."""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = Path(os.environ.get("DB_PATH", ROOT / "data/trading.db"))
if not DB.is_absolute():
    DB = ROOT / DB
SERVICES = ["collector", "trader", "notifier", "brain"]
TIMERS = ["score", "weekly", "logrotate", "intel"]  # the checker runs every 10 min: its line is under paper trading
STALE_S = 300

G, R, Y, D, B = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[1m"
X = "\033[0m"


def ago(ms: int | None) -> str:
    if not ms:
        return "never"
    s = time.time() - ms / 1000
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if s >= n:
            return f"{s / n:.1f}{unit} ago"
    return f"{s:.0f}s ago"


def pid_running(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def systemd_state(name: str) -> str:
    try:
        out = subprocess.run(["systemctl", "--user", "is-active", f"trading-{name}"], capture_output=True, text=True, timeout=5)
        return out.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


MODES = {"normal": "normal", "light": "LIGHT (no new-wallet discovery)", "essential": "ESSENTIAL (copied wallets + open trades only)",
         "positions_only": "OPEN TRADES ONLY (no new trades today)", "off": "OFF (cap reached)"}
FREE_MONTH_CREDITS = 1_000_000
CREDITS_PER_MB = 20


def data_budget(c: sqlite3.Connection, i: dict, now: float) -> tuple[str, str]:
    """Helius data today: used / cap, speed, when the cap is hit at that speed, mode, and this month's credits."""
    mb, cap = i.get("heliusMbToday", 0), i.get("heliusCapMb") or 0
    pct = mb / cap * 100 if cap else 0
    col = R if pct >= 95 else Y if pct >= 70 else G
    out = f"helius today {col}{mb:.0f} / {cap:.0f} MB ({pct:.0f}%){X}"
    if i.get("heliusCapOverridden"):
        out += f" {Y}(raised on the dashboard to {i.get('heliusCapChosenMb', 0):.0f}){X}"
    if i.get("heliusMonthlyGuardMb") is not None and i.get("heliusCapChosenMb", cap) > i["heliusMonthlyGuardMb"]:
        out += f" {D}[monthly guard: {i['heliusMonthlyGuardMb']:.0f} MB today]{X}"
    if i.get("heliusMbPerHour") is not None:
        out += f"  {i['heliusMbPerHour']:.0f} MB/h"
        eta = i.get("heliusCapAt")
        out += f", cap at {time.strftime('%H:%M', time.gmtime(eta / 1000))} UTC at this speed" if eta and mb < cap else ("" if mb >= cap else ", lasts the day at this speed")
    mode = i.get("dataMode")
    if mode:
        out += f"  mode {G if mode == 'normal' else Y if mode in ('light', 'essential') else R}{MODES.get(mode, mode)}{X}"
    month = time.strftime("%Y-%m", time.gmtime(now / 1000))
    month_mb = (c.execute("SELECT COALESCE(SUM(bytes), 0) FROM stream_usage WHERE day LIKE ? AND source != 'pumpportal'", (month + "%",)).fetchone()[0]) / 1e6
    return out, f"this month ~{month_mb * CREDITS_PER_MB / 1e3:.0f}k of {FREE_MONTH_CREDITS // 1000}k free Helius credits (our count; dashboard.helius.dev has Helius's own)"


def check() -> int:
    """--check: one line, exit 0 healthy / 2 unhealthy. For cron, scripts and the VPS."""
    if not DB.exists():
        print("UNHEALTHY no database")
        return 2
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    now = time.time() * 1000
    bad = []
    for svc in SERVICES:
        row = c.execute("SELECT ts, pid FROM service_heartbeats WHERE service=?", (svc,)).fetchone()
        if not row or now - row[0] > STALE_S * 1000 or not pid_running(row[1]):
            bad.append(svc)
    last = c.execute("SELECT max(received_at) FROM trades").fetchone()[0]
    if not last or now - last > 15 * 60_000:
        bad.append("no trades for 15 min")
    print("OK" if not bad else "UNHEALTHY " + ", ".join(bad))
    return 0 if not bad else 2


def main() -> int:
    if not DB.exists():
        print(f"{R}no database at {DB}{X} (has the collector ever run?)")
        return 1
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    now = time.time() * 1000
    ok = True

    print(f"{B}services{X}")
    for svc in SERVICES:
        row = c.execute("SELECT ts, pid, info FROM service_heartbeats WHERE service=?", (svc,)).fetchone()
        unit = systemd_state(svc)
        if not row:
            print(f"  {svc:<10} {R}no heartbeat{X}  systemd={unit}")
            ok = False
            continue
        ts, pid, info = row
        fresh = now - ts < STALE_S * 1000 and pid_running(pid)
        ok &= fresh
        state = f"{G}alive{X}" if fresh else (f"{R}STALE{X}" if pid_running(pid) else f"{R}STOPPED{X}")
        print(f"  {svc:<10} {state}  heartbeat {ago(ts)}  pid={pid}  systemd={unit}")
        i = json.loads(info or "{}")
        if svc == "collector":
            st = i.get("streams", {})
            def show(name):
                v = st.get(name)
                return f"{name}={'up' if v else ('off' if v is None else R + 'DOWN' + X + D)}"
            fh = show("firehose") + (f" ({st['firehoseOff']})" if st.get("firehoseOff") else "")
            print(f"  {D}{'':<10} {fh}  {show('targeted')} [{st.get('targetedSubs', 0)} subs, {i.get('trackedWallets', 0)} wallets]  {show('pumpportal')}{X}")
            today, month = data_budget(c, i, now)
            print(f"  {'':<10} {today}  {D}rss={i.get('rss_mb')}MB{X}")
            print(f"  {D}{'':<10} {month}{X}")
        elif svc == "trader":
            flags = (f" {R}KILL SWITCH ON{X}" if i.get("killed") else "") + (f" {Y}halted today (daily loss cap){X}" if i.get("haltedToday") else "")
            print(f"  {D}{'':<10} mode={i.get('mode')} tracked={i.get('tracked')} signals={i.get('signals', 0)} entered={i.get('entered', 0)} errors={i.get('errors', 0)}{X}{flags}")
        elif svc == "brain":
            last = i.get("last") or {}
            print(f"  {D}{'':<10} studies since start={i.get('studies', 0)}  last study {ago(last.get('at'))}: {last.get('studied', 0)} signals, "
                  f"{'ACTIVE (may skip predicted losers)' if last.get('active') else 'studying only'}{X}")

    print(f"  {'dashboard':<10} {D}desktop app only: open \"Trading Dashboard\" (or make app); it stops when you close the window{X}")

    timers = []
    for t in TIMERS:
        try:
            out = subprocess.run(["systemctl", "--user", "show", f"trading-{t}.timer", "-p", "NextElapseUSecRealtime", "-p", "LastTriggerUSec", "--value"],
                                 capture_output=True, text=True, timeout=5).stdout.split("\n")
            if out and out[0].strip():
                timers.append(f"{t} next {out[0].strip()[4:20]}")
        except Exception:
            pass
    if timers:
        print(f"  {D}timers: {' · '.join(timers)}{X}")

    print(f"\n{B}data{X}")
    day = time.strftime("%Y-%m-%d", time.gmtime())
    q = lambda sql, *a: c.execute(sql, a).fetchone()
    tok_total, tok_last = q("SELECT count(*), max(first_seen_at) FROM tokens")
    tok_24h = q("SELECT count(*) FROM tokens WHERE first_seen_at > ?", now - 86_400_000)[0]
    tr_last = q("SELECT max(received_at) FROM trades")[0]
    tr_1h = q("SELECT count(*) FROM trades WHERE received_at > ?", now - 3_600_000)[0]
    bars_1h = q("SELECT count(*) FROM token_bars WHERE ts > ?", now - 3_600_000)[0]
    migr_24h = q("SELECT count(*) FROM tokens WHERE migrated_at > ?", now - 86_400_000)[0]
    print(f"  tokens     {tok_total:>10,} total  {tok_24h:>7,} in 24h  last {ago(tok_last)}  migrations 24h: {migr_24h}")
    print(f"  trades     {tr_1h:>10,} in 1h               last {ago(tr_last)}")
    print(f"  bars       {bars_1h:>10,} in 1h")
    for src, msgs, byts in c.execute("SELECT source, messages, bytes FROM stream_usage WHERE day=?", (day,)):
        print(f"  {D}usage today {src}: {msgs:,} msgs, {byts / 1e6:.1f} MB{X}")
    gaps = c.execute("SELECT source, started_at, ended_at, reason FROM collector_gaps ORDER BY id DESC LIMIT 3").fetchall()
    if gaps:
        print(f"  {D}recent gaps:{X}")
        for src, st, en, why in gaps:
            dur = f"{((en or now) - st) / 1000:.0f}s" + ("" if en else " (open)")
            print(f"  {D}  {src:<10} {ago(st):>10}  {dur:>8}  {why}{X}")
    if has_table(c, "intel_requests"):
        n, remote, last_ok = q("SELECT count(*), MAX(remote_used), MAX(CASE WHEN ok = 1 THEN ts END) FROM intel_requests WHERE provider = 'madeonsol' AND ts >= ?",
                               int(time.time() // 86400 * 86400 * 1000))
        print(f"  madeonsol  {max(n, remote or 0):>10} / 200 requests today (daily job only, never while trading)  last ok {ago(last_ok)}")
    size = sum(p.stat().st_size for p in DB.parent.glob(DB.name + "*"))
    print(f"  db size    {size / 1e9:.2f} GB")

    print(f"\n{B}paper trading{X}")
    lim = (ROOT / "trader/src/risk/limits.ts").read_text()
    sw = q("SELECT value FROM kv WHERE key = 'override.risk.PAPER_NO_LIMITS'") if has_table(c, "kv") else None
    if (sw[0] == "1") if sw and sw[0] in ("0", "1") else "export const PAPER_NO_LIMITS = true" in lim:
        print(f"  {Y}practice limits OFF{X} {D}(no cap on open trades, trades/day, size, losses; switch it on the dashboard's Limits tab){X}")
    changed = c.execute("SELECT count(*) FROM kv WHERE key LIKE 'override.%'").fetchone()[0] if has_table(c, "kv") else 0
    if changed:
        print(f"  {Y}{changed} limit(s) changed on the dashboard{X} {D}(Limits tab shows which){X}")
    acct = q("SELECT balance_sol, start_balance FROM paper_account WHERE id = 1") if has_table(c, "paper_account") else None
    if not acct:
        print(f"  {D}not started{X}")
    else:
        bal, start = acct
        live = c.execute("SELECT mint, status, cost_sol, size_sol, tokens, last_price, entry_price, opened_at FROM paper_positions WHERE status IN ('pending','open')").fetchall()
        tr = q("SELECT info FROM service_heartbeats WHERE service = 'trader'")
        equity = json.loads(tr[0]).get("equity", bal) if tr else bal
        pnl = equity - start
        col = G if pnl >= 0 else R
        print(f"  equity     {equity:.4f} SOL  ({col}{pnl:+.4f} SOL, {pnl / start * 100:+.1f}%{X} since start {start:g})  free {bal:.4f}")
        day0 = int(time.mktime(time.strptime(day, "%Y-%m-%d")) - time.timezone) * 1000
        for label, since in (("today", day0), ("7 days", now - 7 * 86_400_000), ("all time", 0)):
            n, wins, s, fails = q("""SELECT count(*), SUM(pnl_sol > 0), COALESCE(SUM(pnl_sol), 0), SUM(status = 'failed')
                FROM paper_positions WHERE status IN ('closed','failed') AND closed_at >= ?""", since)
            closed = n - (fails or 0)
            wr = f"{(wins or 0) / closed * 100:.0f}% win" if closed else "-"
            print(f"  {label:<10} {closed:>4} closed  {wr:>8}  {s:+.4f} SOL  {fails or 0} failed fills")
        for m, st, cost, size, tok, last, entry, opened in live:
            chg = f"{(last / entry - 1) * 100:+.1f}%" if st == "open" and entry else "pending fill"
            print(f"  {D}  {st:<7} {m[:8]}  {(cost or size):.4f} SOL  {chg}  {ago(opened) if opened else ''}{X}")
        sig = q("SELECT count(*), SUM(decision = 'enter'), SUM(decision = 'risk_block') FROM signals WHERE ts > ?", now - 86_400_000)
        if sig and sig[0]:
            print(f"  {D}signals 24h: {sig[0]} evaluated, {sig[1] or 0} entered, {sig[2] or 0} blocked by risk{X}")
        top = c.execute("""SELECT reasons, count(*) n FROM signals WHERE decision = 'reject' AND ts > ? GROUP BY reasons ORDER BY n DESC LIMIT 3""", (now - 86_400_000,)).fetchall()
        for r, n in top:
            print(f"  {D}  {n:>4}x {', '.join(json.loads(r))[:90]}{X}")
    if has_table(c, "mistakes"):
        n_all, n_24h = q("SELECT count(*), SUM(alerted = 1 AND found_at > ?) FROM mistakes", now - 86_400_000)  # alerted = 0: history from the first run
        hb = q("SELECT ts FROM service_heartbeats WHERE service = 'checker'")
        last = f"checked {ago(hb[0])}" if hb else "checker never ran"
        col = R if n_24h else G
        print(f"  mistakes   {col}{n_24h or 0} in 24h{X}, {n_all} all time  {D}{last} (make check){X}")
        for (text,) in c.execute("SELECT text FROM mistakes ORDER BY id DESC LIMIT 3"):
            print(f"  {D}  {text[:110]}{X}")
    return 0 if ok else 2


def has_table(c, name: str) -> bool:
    return c.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (name,)).fetchone() is not None


if __name__ == "__main__":
    sys.exit(check() if "--check" in sys.argv else main())
