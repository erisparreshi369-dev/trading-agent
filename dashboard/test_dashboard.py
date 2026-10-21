"""Dashboard tests: python -m unittest discover -s dashboard"""
from __future__ import annotations

import http.client
import json
import os
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
import settings  # noqa: E402
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

    def test_youtube_verdicts(self):
        self.assertEqual(data.Snapshot(self.c, self.path).build({}, NOW)["learner"]["youtube"]["rules"], [])  # nothing studied yet
        w = connect(str(self.path))
        w.execute("INSERT INTO yt_videos (id, search, trader, found_at, status, words) VALUES ('v1', 'x', 'Peter Brandt', ?, 'ok', 900)", (NOW - 60_000,))
        w.execute("INSERT INTO yt_videos (id, search, found_at, status) VALUES ('v2', 'y', ?, 'no_subs')", (NOW - 30_000,))
        for key, videos, verdict, d in (("liquidity", 1, "not_enough_data", {"n": 4}), ("cut_losses", 3, "agrees", {"n": 40, "diff": 0.031}),
                                        ("trend", 0, "untested", {})):
            w.execute("""INSERT INTO yt_rules (key, words, videos, mentions, traders, verdict, test, data, checked_at)
                         VALUES (?, ?, ?, ?, '["Peter Brandt"]', ?, 'how', ?, ?)""", (key, key, videos, videos * 2, verdict, json.dumps(d), NOW - 1_000))
        w.close()
        y = data.Snapshot(self.c, self.path).build({}, NOW)["learner"]["youtube"]
        self.assertEqual([r["key"] for r in y["rules"]], ["cut_losses", "liquidity", "trend"])  # most-heard first
        self.assertEqual(y["rules"][0]["data"]["diff"], 0.031)
        self.assertEqual(y["rules"][0]["traders"], ["Peter Brandt"])
        self.assertEqual((y["studied"], y["looked_at"], y["checked_at"]), (1, 2, NOW - 1_000))

    def test_veteran_habits(self):
        w = connect(str(self.path))
        sig = w.execute("SELECT min(id) FROM signals").fetchone()[0]
        for variant, status, roi in (("live", "closed", -0.2), ("vet_no_chase", "filtered", None), ("vet_stop_15", "closed", -0.15)):
            w.execute("""INSERT OR REPLACE INTO shadow_trades (signal_id, variant, mint, leader_wallet, signal_at, status, size_sol, pnl_sol, roi)
                         VALUES (?, ?, 'm', 'w', ?, ?, 0.02, ?, ?)""", (sig, variant, NOW - 60_000, status, None if roi is None else roi * 0.02, roi))
        w.close()
        v = data.Snapshot(self.c, self.path).build({}, NOW)["learner"]["veteran"]
        self.assertEqual([h["variant"] for h in v["habits"]], ["vet_no_chase", "vet_stop_15"])  # only habits with practice trades
        self.assertAlmostEqual(v["habits"][0]["diff"], 0.2)  # skipping a -20% trade
        self.assertEqual((v["habits"][0]["verdict"], v["started_at"], v["min_n"]), ("too early", NOW - 60_000, 30))

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

    def test_settings_changes_only_from_this_dashboard(self):
        tmp = tempfile.TemporaryDirectory()
        path = Path(tmp.name) / "t.db"
        seed(path)
        old_env = os.environ.get("DB_PATH")
        os.environ["DB_PATH"] = str(path)
        hub = server.Hub()
        srv = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(hub))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        port = srv.server_address[1]

        def post(body, token=hub.token, host=None, origin=None):
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            h = {"Content-Type": "application/json", "Host": host or f"localhost:{port}"}
            if token is not None:
                h["X-Dashboard-Token"] = token
            if origin:
                h["Origin"] = origin
            c.request("POST", "/api/settings", body=json.dumps(body), headers=h)
            r = c.getresponse()
            return r.status, json.loads(r.read() or b"{}")

        try:
            kv = lambda: dict(sqlite3.connect(path).execute("SELECT key, value FROM kv WHERE key LIKE 'override.%'").fetchall())
            raise_cap = {"setting": "helius_daily_mb_cap", "value": 4000}
            # refused: no token, wrong token, another site, a rebinding hostname
            self.assertEqual(post(raise_cap, token=None)[0], 403)
            self.assertEqual(post(raise_cap, token="guess")[0], 403)
            self.assertEqual(post(raise_cap, origin="https://evil.example")[0], 403)
            self.assertEqual(post(raise_cap, host="evil.example:8080")[0], 403)
            # refused: bad values, other settings
            self.assertEqual(post({"setting": "helius_daily_mb_cap", "value": 50})[0], 400)
            self.assertEqual(post({"setting": "helius_daily_mb_cap", "value": "lots"})[0], 400)
            self.assertEqual(post({"setting": "madeonsol_stop_pct", "value": 101})[0], 400)
            self.assertEqual(post({"setting": "MAX_OPEN_POSITIONS", "value": 99})[0], 400)
            self.assertEqual(kv(), {})
            # accepted from the page itself
            code, res = post(raise_cap, origin=f"http://localhost:{port}")
            self.assertEqual((code, res["value"], res["overridden"]), (200, 4000, True))
            self.assertEqual(post({"setting": "madeonsol_stop_pct", "value": 100})[0], 200)
            self.assertEqual(kv(), {"override.helius_daily_mb_cap": "4000", "override.madeonsol_stop_pct": "100"})
            # back to normal
            code, res = post({"setting": "helius_daily_mb_cap", "value": None})
            self.assertEqual((code, res["value"], res["overridden"]), (200, 1500, False))
            self.assertEqual(kv(), {"override.madeonsol_stop_pct": "100"})
            # every change is announced on Telegram (alerts outbox)
            notes = [json.loads(d) for (d,) in sqlite3.connect(path).execute("SELECT data FROM alerts WHERE kind = 'setting_changed' ORDER BY id")]
            self.assertEqual([(n["setting"], n["from"], n["to"], n["reset"]) for n in notes],
                             [("helius_daily_mb_cap", 1500, 4000, False), ("madeonsol_stop_pct", 90, 100, False), ("helius_daily_mb_cap", 4000, 1500, True)])
        finally:
            srv.shutdown()
            srv.server_close()
            if old_env is None:
                os.environ.pop("DB_PATH", None)
            else:
                os.environ["DB_PATH"] = old_env
            tmp.cleanup()

    def test_every_limit_on_the_limits_tab(self):
        tmp = tempfile.TemporaryDirectory()
        path = Path(tmp.name) / "t.db"
        seed(path)
        kv = lambda: dict(sqlite3.connect(path).execute("SELECT key, value FROM kv WHERE key LIKE 'override.%'").fetchall())
        try:
            # every listed setting has a normal value, a range and words
            for name, s in settings.SETTINGS.items():
                d = settings.default(name)
                self.assertIsInstance(settings.fmt(name, d), str)
                if s["type"] != "bool":
                    self.assertTrue(s["min"] <= d <= s["max"], f"{name}: normal value {d} outside its range")
            self.assertEqual(settings.default("risk.STOP_LOSS_PCT"), 0.25)
            self.assertEqual(settings.default("risk.TIME_EXIT_MS"), 1_800_000)
            self.assertEqual(settings.default("signals.token_age_s.1"), 1800)
            self.assertEqual(settings.default("collector.helius.steps_pct.2"), 95)
            self.assertEqual(settings.default("madeonsol.candidates.watch_top"), 20)
            self.assertIs(settings.default("signals.exclude_bad_creators"), False)
            # trading safety: inside the walls only
            res = settings.apply(path, "risk.STOP_LOSS_PCT", 0.15)
            self.assertEqual((res["value"], res["overridden"], res["text"]), (0.15, True, "15%"))
            with self.assertRaises(ValueError):
                settings.apply(path, "risk.STOP_LOSS_PCT", 0.9)  # past the wall
            with self.assertRaises(ValueError):
                settings.apply(path, "risk.MAX_POSITION_SOL", 5)
            with self.assertRaises(ValueError):
                settings.apply(path, "risk.MAX_OPEN_POSITIONS", True)  # a number, not on/off
            with self.assertRaises(ValueError):
                settings.apply(path, "risk.PAPER_NO_LIMITS", 1)  # on/off only
            settings.apply(path, "risk.PAPER_NO_LIMITS", False)
            settings.apply(path, "risk.MAX_OPEN_POSITIONS", 7.4)  # whole numbers
            # pair rules: min stays below max
            with self.assertRaises(ValueError) as e:
                settings.apply(path, "signals.token_age_s.0", 1800)
            self.assertIn("must stay below", str(e.exception))
            with self.assertRaises(ValueError):
                settings.apply(path, "madeonsol_stop_pct", 60)  # warns at 70
            settings.apply(path, "madeonsol.warn_pct", 50)
            settings.apply(path, "madeonsol_stop_pct", 60)
            with self.assertRaises(ValueError):
                settings.apply(path, "madeonsol.warn_pct", None)  # back to 70 would pass the stop point
            with self.assertRaises(ValueError):
                settings.apply(path, "no.such.thing", 1)
            self.assertEqual(kv(), {"override.risk.STOP_LOSS_PCT": "0.15", "override.risk.PAPER_NO_LIMITS": "0", "override.risk.MAX_OPEN_POSITIONS": "7",
                                    "override.madeonsol.warn_pct": "50", "override.madeonsol_stop_pct": "60"})
            # announced with the words the page shows
            note = json.loads(sqlite3.connect(path).execute("SELECT data FROM alerts WHERE kind = 'setting_changed' ORDER BY id LIMIT 1").fetchone()[0])
            self.assertEqual((note["label"], note["fromText"], note["toText"], note["group"]), ("Sell when the price is down", "25%", "15%", "safety"))
            # the page shows the owner's values
            c = data.connect_ro(path)
            snap = data.Snapshot(c, path).build({})
            stop = snap["settings"]["risk.STOP_LOSS_PCT"]
            self.assertEqual({k: stop[k] for k in ("value", "default", "overridden", "min", "max")},
                             {"value": 0.15, "default": 0.25, "overridden": True, "min": 0.02, "max": 0.5})
            self.assertEqual((stop["trades_since"], stop["judge_after"]), (2, 30))  # the seed's 2 closed trades close after the change
            self.assertNotIn("changed_at", snap["settings"]["madeonsol.warn_pct"])  # only settings that change how we trade
            self.assertEqual(snap["risk"]["limits"]["STOP_LOSS_PCT"], 0.15)
            self.assertFalse(snap["risk"]["paper_no_limits"])
            self.assertEqual(snap["risk"]["max_open"], 7)
            self.assertEqual(len(snap["settings_meta"]["settings"]), len(settings.SETTINGS))
            # the trade journal and the proven balance trades are sized from
            j = snap["learner"]["journal"]
            self.assertEqual((j["trades"], len(j["last"])), (2, 2))
            self.assertIn("size_base", snap["risk"])
        finally:
            tmp.cleanup()

    def test_warns_when_a_trading_setting_changes_again_too_soon(self):
        """One strategy: a change needs 30 closed trades before it can be judged. Changing it sooner is allowed, with a warning."""
        tmp = tempfile.TemporaryDirectory()
        path = Path(tmp.name) / "t.db"
        seed(path)
        try:
            first = settings.apply(path, "signals.min_leader_buy_sol", 0.2)
            self.assertNotIn("too_soon", first)  # never changed before
            again = settings.apply(path, "signals.min_leader_buy_sol", 0.3)
            self.assertEqual(again["too_soon"], {"trades_since": 2, "judge_after": 30})
            self.assertEqual(again["value"], 0.3)  # saved anyway: the owner decides
            c = sqlite3.connect(path)
            for i in range(30):
                c.execute("""INSERT INTO paper_positions (signal_id, mint, leader_wallet, status, size_sol, leader_price, entry_due_at, closed_at, pnl_sol)
                             VALUES (1, ?, ?, 'closed', 0.02, 3e-8, ?, ?, 0)""", (MINT, W1, NOW - 1000, NOW - 1000 + i))
            c.commit()
            c.close()
            self.assertNotIn("too_soon", settings.apply(path, "signals.min_leader_buy_sol", 0.25))
            self.assertNotIn("too_soon", settings.apply(path, "madeonsol.warn_pct", 50))  # data limits aren't a trading plan
            self.assertNotIn("too_soon", settings.apply(path, "madeonsol.warn_pct", 60))
        finally:
            tmp.cleanup()

    def test_refuses_public_bind(self):
        argv = sys.argv
        sys.argv = ["server.py", "--host", "0.0.0.0"]
        try:
            self.assertEqual(server.main(), 2)
        finally:
            sys.argv = argv


if __name__ == "__main__":
    unittest.main()
