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
SERVICES = ["collector", "trader"]  # learner joins in Phase 4
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
            print(f"  {D}{'':<10} helius today {i.get('heliusMbToday', 0)} / {i.get('heliusCapMb', '?')} MB  rss={i.get('rss_mb')}MB{X}")
        elif svc == "trader":
            flags = (f" {R}KILL SWITCH ON{X}" if i.get("killed") else "") + (f" {Y}halted today (daily loss cap){X}" if i.get("haltedToday") else "")
            print(f"  {D}{'':<10} mode={i.get('mode')} tracked={i.get('tracked')} signals={i.get('signals', 0)} entered={i.get('entered', 0)} errors={i.get('errors', 0)}{X}{flags}")

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
    size = sum(p.stat().st_size for p in DB.parent.glob(DB.name + "*"))
    print(f"  db size    {size / 1e9:.2f} GB")

    print(f"\n{B}paper trading{X}")
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
    return 0 if ok else 2


def has_table(c, name: str) -> bool:
    return c.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (name,)).fetchone() is not None


if __name__ == "__main__":
    sys.exit(main())
