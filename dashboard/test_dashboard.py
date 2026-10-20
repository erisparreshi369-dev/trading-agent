"""Dashboard tests: python -m unittest discover -s dashboard"""
from __future__ import annotations

import http.client
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "shared"))
import data  # noqa: E402
import server  # noqa: E402
from migrate import connect, migrate  # noqa: E402

NOW = 1_800_000_000_000
W1, W2 = "Leader1111111111111111111111111111111111111", "Leader2222222222222222222222222222222222222"
MINT = "Mint11111111111111111111111111111111111pump"


def seed(path: Path) -> None:
    c = connect(str(path))
    migrate(c)
    ex = c.execute
    ex("INSERT INTO paper_account VALUES (1, 0.95, 1.0, ?)", (NOW - 86_400_000,))
    ex("UPDATE risk_state SET day = ?, day_start_equity = 1.0", (data.utc_day(NOW),))
    ex("INSERT INTO tokens (mint, symbol, creator, created_at, first_seen_at, source) VALUES (?, 'TEST', 'Dev', ?, ?, 'pumpportal')", (MINT, NOW - 60_000, NOW - 60_000))
    ex("INSERT INTO tracked_wallets (wallet, added_at, active, source, score) VALUES (?, ?, 1, 'scoring', 0.1)", (W1, NOW - 86_400_000))
    ex("INSERT INTO tracked_wallets (wallet, added_at, active, source, score, deactivated_at, deactivated_reason) VALUES (?, ?, 0, 'scoring', -0.2, ?, 'follower ROI negative')",
       (W2, NOW - 86_400_000, NOW - 3_600_000))
    ex("""INSERT INTO wallet_scores (run_at, wallet, tokens_traded, closed_positions, realized_pnl_sol, copy_trades, copy_missed, copy_roi, score, eligible)
          VALUES (?, ?, 20, 15, 1.0, 10, 1, 0.2, 0.1, 1)""", (NOW - 3_600_000, W1))
    # leader buy (curve state: 30 SOL / 1e15 raw tokens), the signal it produced, and our open position
    ex("""INSERT INTO trades (id, signature, ev_index, block_time, received_at, mint, wallet, is_buy, sol_lamports, token_amount,
          v_sol_reserves, v_token_reserves, real_token_reserves, fee_lamports, creator_fee_lamports, price_sol, source)
          VALUES (1, 'sig1', 0, ?, ?, ?, ?, 1, 500000000, 1, 30000000000, 1000000000000000, 700000000000000, 5000000, 1250000, 3e-8, 'helius')""",
       (NOW - 20_000, NOW - 19_000, MINT, W1))
    ex("""INSERT INTO signals (id, ts, wallet, mint, leader_trade_id, venue, score, decision, reasons, features)
          VALUES (1, ?, ?, ?, 1, 'curve', 0.1, 'enter', '[]', '{"confirmations": 1}')""", (NOW - 18_700, W1, MINT))
    ex("""INSERT INTO signals (id, ts, wallet, mint, leader_trade_id, venue, score, decision, reasons, features)
          VALUES (2, ?, ?, ?, 1, 'curve', 0.1, 'reject', '["token age 2400s outside [3, 1800]"]', '{}')""", (NOW - 18_000, W1, MINT))
    ex("""INSERT INTO paper_positions (id, signal_id, mint, leader_wallet, status, size_sol, leader_price, entry_due_at, opened_at, cost_sol, tokens, entry_price, last_price)
          VALUES (1, 1, ?, ?, 'open', 0.02, 3e-8, ?, ?, 0.02, 600000000000, 3.1e-8, 3e-8)""", (MINT, W1, NOW - 17_500, NOW - 17_500))
    # one closed winner and one closed loser
    for pid, pnl in ((2, 0.004), (3, -0.002)):
        ex("""INSERT INTO paper_positions (id, signal_id, mint, leader_wallet, status, size_sol, leader_price, entry_due_at, opened_at, cost_sol,
              closed_at, exit_reason, proceeds_sol, pnl_sol) VALUES (?, 1, ?, ?, 'closed', 0.02, 3e-8, ?, ?, 0.02, ?, 'leader_exit', ?, ?)""",
           (pid, MINT, W1, NOW - 7_200_000, NOW - 7_200_000, NOW - 7_000_000 + pid, 0.02 + pnl, pnl))
    ex("""INSERT INTO paper_fills (position_id, ts, side, venue, ok, sol, tokens, price, ref_price, slippage_bps, delay_ms, fees_sol)
          VALUES (1, ?, 'buy', 'curve', 1, 0.02, 600000000000, 3.1e-8, 3e-8, 100, 1500, 0.0025)""", (NOW - 17_500,))
    ex("INSERT INTO alerts (ts, level, source, text) VALUES (?, 'error', 'trader', 'trader restarted after dying without a clean shutdown')", (NOW - 5_000,))
    ex("INSERT INTO service_heartbeats VALUES ('trader', ?, 1, '{\"mode\": \"paper\"}')", (NOW - 1_000,))
    c.close()


class DashboardData(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "t.db"
        seed(self.path)
        self.c = data.connect_ro(self.path)

    def tearDown(self):
        self.c.close()
        self.tmp.cleanup()

    def test_connection_cannot_write(self):
        with self.assertRaises(sqlite3.OperationalError):
            self.c.execute("UPDATE risk_state SET kill_switch = 1")
        with self.assertRaises(sqlite3.OperationalError):
            self.c.execute("INSERT INTO kv VALUES ('x', 'y')")

    def test_limits_come_from_limits_ts(self):
        L = data.risk_limits()
        for k in ("MAX_OPEN_POSITIONS", "DAILY_LOSS_CAP_PCT", "MAX_DRAWDOWN_PCT", "MAX_ENTRIES_PER_DAY", "STOP_LOSS_PCT", "TIME_EXIT_MS"):
            self.assertIn(k, L)
        self.assertEqual(L["TIME_EXIT_MS"], 30 * 60_000)
        # the real-money block, not the practice one further down in limits.ts
        self.assertEqual((L["MIN_POSITION_SOL"], L["MAX_OPEN_POSITIONS"], L["MIN_FREE_BALANCE_SOL"]), (0.01, 5, 0.05))
        self.assertTrue(data.paper_no_limits())

    def test_snapshot(self):
        s = data.Snapshot(self.c, self.path).build({}, NOW)
        self.assertEqual(s["mode"], "PAPER")
        m = s["money"]
        # mark-to-market mirrors simulateSell: constant product, 0.5% extra slippage, venue + executor fee, priority fee, rent back
        gross = 30e9 * 6e11 / (1e15 + 6e11) / 1e9 * (1 - 0.005)
        mark = gross - gross * (0.0125 + 0.005) - 0.0003 + 0.00203928
        self.assertAlmostEqual(s["positions"][0]["mark_sol"], mark, places=9)
        self.assertAlmostEqual(m["equity"], 0.95 + mark, places=9)
        self.assertAlmostEqual(m["pnl_today"], 0.95 + mark - 1.0, places=9)
        self.assertAlmostEqual(m["realized_all"], 0.002)
        self.assertEqual(m["win_rate"], 0.5)
        self.assertAlmostEqual(m["avg_win"], 0.004)
        self.assertAlmostEqual(m["avg_loss"], -0.002)
        self.assertAlmostEqual(m["fees_paid"], 0.0025 - 0.00203928)  # rent comes back, it isn't a cost
        self.assertEqual(s["risk"]["open"], 1)
        self.assertFalse(s["risk"]["killed"])
        self.assertEqual([w["wallet"] for w in s["wallets"]["active"]], [W1])
        self.assertAlmostEqual(s["wallets"]["active"][0]["confidence"], 0.5)
        self.assertEqual(s["wallets"]["dropped"][0]["deactivated_reason"], "follower ROI negative")
        lat = {x["name"]: x for x in s["latency"]["stages"]}
        self.assertEqual(lat["detect"]["p50"], 1000)
        self.assertEqual(lat["decide"]["n"], 2)
        self.assertEqual(lat["fill"]["p50"], 1200)
        self.assertEqual(len(s["closed"]), 2)

    def test_madeonsol_panel(self):
        w = connect(str(self.path))
        w.execute("INSERT INTO intel_requests (ts, provider, endpoint, ok, remote_used) VALUES (?, 'madeonsol', 'token/batch', 1, 12)", (NOW - 60_000,))
        w.execute("INSERT INTO intel_requests (ts, provider, endpoint, ok, error) VALUES (?, 'madeonsol', 'me', 0, 'http 500 msk_abcdefSECRET123')", (NOW - 30_000,))
        w.execute("INSERT INTO intel_requests (ts, provider, endpoint, ok) VALUES (?, 'madeonsol', 'me', 1)", (NOW - 2 * 86_400_000,))  # another day
        w.close()
        m = data.Snapshot(self.c, self.path).build({}, NOW)["madeonsol"]
        self.assertEqual((m["used_today"], m["limit"], m["stop_at"]), (12, 200, 180))  # MadeOnSol's own count (12) beats our 2
        self.assertEqual(m["last_ok_at"], NOW - 60_000)
        self.assertEqual(m["last_error_at"], NOW - 30_000)
        self.assertEqual(m["last_error"], "me: http 500 msk_***")

    def test_feed_seed_and_poll(self):
        f = data.Feed(self.c)
        f.seed()
        cats = {i["cat"] for i in f.all()}
        self.assertTrue({"launch", "wallet", "followed", "rejected", "trade", "error"} <= cats)
        rej = next(i for i in f.all() if i["cat"] == "rejected")
        self.assertEqual(rej["reasons"], ["token age 2400s outside [3, 1800]"])
        self.assertEqual(f.poll(NOW), [])
        # new rows written by the bot show up on the next poll
        w = connect(str(self.path))
        w.execute("""INSERT INTO signals (id, ts, wallet, mint, leader_trade_id, venue, score, decision, reasons, features)
                     VALUES (3, ?, ?, ?, 1, 'curve', 0.1, 'risk_block', '["risk: max open positions (5)"]', '{}')""", (NOW - 500, W1, MINT))
        w.execute("INSERT INTO alerts (ts, level, source, text) VALUES (?, 'error', 'collector', 'boom')", (NOW,))
        w.close()
        self.assertEqual([i["cat"] for i in f.poll(NOW)], ["error"])  # the signal is still settling
        new = f.poll(NOW + 1000)
        self.assertEqual([(i["cat"], i["kind"]) for i in new], [("rejected", "risk_block")])

    def test_systemd_restart_events(self):
        f = data.Feed(self.c)
        f.seed()
        up = {"trader": {"active": "active", "pid": 10, "restarts": 0}}
        self.assertEqual(f.systemd_events(up), [])
        ev = f.systemd_events({"trader": {"active": "active", "pid": 11, "restarts": 1}})
        self.assertEqual(ev[0]["kind"], "restart")
        ev = f.systemd_events({"trader": {"active": "inactive", "sub": "dead", "pid": None, "restarts": 1}})
        self.assertEqual(ev[0]["kind"], "stop")


class DashboardServer(unittest.TestCase):
    def test_only_get(self):
        hub = server.Hub()
        srv = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(hub))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            port = srv.server_address[1]
            for method in ("POST", "PUT", "DELETE", "PATCH"):
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                c.request(method, "/events", body=b"{}")
                self.assertEqual(c.getresponse().status, 405, method)
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.request("GET", "/")
            body = c.getresponse().read().decode()
            self.assertIn('<script id="state" type="application/json">', body)
            state = body.split('type="application/json">', 1)[1].split("</script>", 1)[0]
            self.assertEqual(json.loads(state)["feed"], [])
        finally:
            srv.shutdown()
            srv.server_close()

    def test_refuses_public_bind(self):
        argv = sys.argv
        sys.argv = ["server.py", "--host", "0.0.0.0"]
        try:
            self.assertEqual(server.main(), 2)
        finally:
            sys.argv = argv


if __name__ == "__main__":
    unittest.main()
