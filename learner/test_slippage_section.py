"""python -m unittest discover -s learner"""
from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "shared"))
import slippage_section as ss  # noqa: E402
import weekly_report as wr  # noqa: E402
from migrate import connect, migrate  # noqa: E402

DAY = 86_400_000
NOW = 1_800_000_000_000


class SlippageSection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.c = connect(str(Path(self.tmp.name) / "t.db"))
        migrate(self.c)

    def tearDown(self):
        self.c.close()
        self.tmp.cleanup()

    def signal(self, i: int) -> None:
        self.c.execute("INSERT INTO signals (id, ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (?, ?, 'w', 'm', 0, 'curve', 'enter', '[]', '{}')",
                       (i, NOW - DAY))

    def shadow(self, i: int, slip_bps: float, roi: float) -> None:
        self.c.execute("""INSERT INTO shadow_trades (signal_id, variant, mint, leader_wallet, signal_at, status, size_sol, slippage_bps, pnl_sol, roi)
                          VALUES (?, 'no_slip_limit', 'm', 'w', ?, 'closed', 0.02, ?, ?, ?)""", (i, NOW - DAY, slip_bps, roi * 0.02, roi))

    def skipped(self, i: int, slip_bps: float) -> None:
        pid = self.c.execute("""INSERT INTO paper_positions (signal_id, mint, leader_wallet, status, size_sol, leader_price, entry_due_at, closed_at, exit_reason, pnl_sol)
            VALUES (?, 'm', 'w', 'failed', 0.02, 1e-8, ?, ?, ?, -0.0003)""",
            (i, NOW - DAY, NOW - DAY, f"skipped: price moved too much (slippage {slip_bps:.0f}bps > 300bps limit)")).lastrowid
        self.c.execute("INSERT INTO paper_fills (position_id, ts, side, venue, ok, sol, slippage_bps, fees_sol, reason) VALUES (?, ?, 'buy', 'curve', 0, 0.0003, ?, 0.0003, 'x')",
                       (pid, NOW - DAY, slip_bps))

    def test_skipped_trades_and_what_they_would_have_done(self):
        for i in range(1, 7):  # six cheap buys that made +10% each
            self.signal(i)
            self.shadow(i, 150, 0.10)
        for i in range(7, 13):  # six expensive buys we skip; they would have lost 20% each
            self.signal(i)
            self.shadow(i, 686, -0.20)
            self.skipped(i, 686)
        md = "\n".join(ss.section(self.c, NOW - 7 * DAY, NOW, wr.table, wr.sol, wr.pct))
        self.assertIn("limit 3%", md)
        self.assertIn("Skipped this week: **6** buys", md)
        self.assertIn("If we had bought them anyway: 6 trades, 0 winners, **-0.0240 SOL**", md)
        self.assertIn("Skipping them **saved** money", md)
        self.assertIn("| 5% to 10% (we skip these) | 6 |", md)
        self.assertIn("It looks right", md)

    def test_learner_can_only_tighten_the_limit_the_report_uses(self):
        self.c.execute("INSERT INTO kv (key, value) VALUES ('learner.max_slippage_bps', '900')")
        self.assertEqual(ss.limit_bps(self.c), 300)
        self.c.execute("UPDATE kv SET value = '200' WHERE key = 'learner.max_slippage_bps'")
        self.assertEqual(ss.limit_bps(self.c), 200)

    def test_no_shadow_data_yet(self):
        md = "\n".join(ss.section(self.c, NOW - 7 * DAY, NOW, wr.table, wr.sol, wr.pct))
        self.assertIn("not measured yet", md)


if __name__ == "__main__":
    unittest.main()


class CreatorSection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.c = connect(str(Path(self.tmp.name) / "t.db"))
        migrate(self.c)

    def tearDown(self):
        self.c.close()
        self.tmp.cleanup()

    def test_with_and_without_the_creator_check(self):
        import creator_section as cs
        for i in range(1, 11):
            bad = i > 4  # six coins from bad creators, each lost 30%; four good ones made 10%
            feats = '{"creator_launches": 558}' if bad else '{}'
            self.c.execute("INSERT INTO signals (id, ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (?, ?, 'w', 'm', 0, 'curve', 'enter', '[]', ?)",
                           (i, NOW - DAY, feats))
            roi = -0.3 if bad else 0.1
            self.c.execute("""INSERT INTO shadow_trades (signal_id, variant, mint, leader_wallet, signal_at, status, size_sol, pnl_sol, roi)
                              VALUES (?, 'live', 'm', 'w', ?, 'closed', 0.02, ?, ?)""", (i, NOW - DAY, roi * 0.02, roi))
            self.c.execute("""INSERT INTO shadow_trades (signal_id, variant, mint, leader_wallet, signal_at, status, reasons, size_sol, pnl_sol, roi)
                              VALUES (?, 'creator_check', 'm', 'w', ?, ?, ?, 0.02, ?, ?)""",
                           (i, NOW - DAY, "filtered" if bad else "closed", '["bad creator: 558 launches, 0% filled their curve"]' if bad else None,
                            None if bad else roi * 0.02, None if bad else roi))
        self.c.execute("INSERT INTO intel_requests (ts, provider, endpoint, ok) VALUES (?, 'madeonsol', 'token/batch', 1)", (NOW - DAY,))
        md = "\n".join(cs.section(self.c, NOW - 7 * DAY, NOW, wr.table, wr.sol, wr.pct))
        self.assertIn("**6 of 10**", md)
        self.assertIn("| without the creator check | 10 | 40% | -0.0280 |", md)
        self.assertIn("| with the creator check | 4 | 100% | +0.0080 |", md)
        self.assertIn("would have skipped **6** trades. Together they made **-0.0360 SOL**", md)
        self.assertIn("the check helps", md)
        self.assertIn("MadeOnSol requests this week: 1", md)
