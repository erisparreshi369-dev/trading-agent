"""python -m unittest discover -s learner"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "shared"))
import honest_stats as hs  # noqa: E402
import weekly_report as wr  # noqa: E402
from migrate import connect, migrate  # noqa: E402

DAY = 86_400_000
NOW = 1_800_000_000_000


class Stats(unittest.TestCase):
    def test_numbers(self):
        s = hs.stats([(0.01, 0.1), (-0.005, 0.1), (-0.003, 0.1), (0.002, 0.1)], 1.0)
        self.assertAlmostEqual(s["profit_factor"], 0.012 / 0.008)
        self.assertAlmostEqual(s["max_drawdown"], 0.008)  # 1.01 high point, down to 1.002
        self.assertAlmostEqual(s["max_drawdown_pct"], 0.008 / 1.01)
        self.assertEqual(s["losing_streak"], 2)
        self.assertAlmostEqual(s["without_best"], -0.006)
        self.assertTrue(s["carried_by_best"])  # +0.004 overall, all of it from the one +0.01 trade
        self.assertAlmostEqual(s["avg_win"], 0.006)
        self.assertAlmostEqual(s["avg_loss"], -0.004)
        self.assertEqual(s["verdict"], "too early")
        self.assertEqual(s["why"], {})

    def test_says_unknown_instead_of_guessing(self):
        s = hs.stats([(0.01, 0.1)], 1.0)
        self.assertIsNone(s["profit_factor"])  # not infinite: there is no losing trade to divide by
        self.assertEqual(s["why"]["profit_factor"], "no losing trade yet")
        self.assertIsNone(s["without_best"])
        self.assertIsNone(s["lo"])
        self.assertEqual(set(s["why"]), {"profit_factor", "without_best", "range"})
        self.assertIn("unknown (no losing trade yet)", "\n".join(hs.lines(s, wr.sol, wr.pct)))
        self.assertEqual(hs.stats([], 1.0)["why"]["profit_factor"], "no trades")

    def test_drawdown_counts_the_starting_money(self):
        s = hs.stats([(-0.1, 0.2)], 1.0)  # the first trade loses: the high point is the 1 SOL we started with
        self.assertAlmostEqual(s["max_drawdown"], 0.1)
        self.assertAlmostEqual(s["max_drawdown_pct"], 0.1)
        self.assertEqual(s["profit_factor"], 0.0)  # no wins is a real number

    def test_verdict_needs_enough_trades_and_a_range_on_one_side_of_zero(self):
        losing = [(-0.002 - 0.0001 * (i % 3), 0.02) for i in range(hs.MIN_N)]
        self.assertEqual(hs.stats(losing, 1.0)["verdict"], "losing")
        self.assertEqual(hs.stats(losing[:-1], 1.0)["verdict"], "too early")
        mixed = [(0.004 if i % 2 else -0.004, 0.02) for i in range(hs.MIN_N)]
        self.assertEqual(hs.stats(mixed, 1.0)["verdict"], "can't tell yet")


class Report(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.c = connect(str(Path(self.tmp.name) / "t.db"))
        migrate(self.c)
        self.n = 0

    def tearDown(self):
        self.c.close()
        self.tmp.cleanup()

    def trade(self, pnl: float, closed: int) -> None:
        self.n += 1
        self.c.execute("INSERT INTO signals (id, ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (?, ?, 'w', ?, 0, 'curve', 'enter', '[]', '{}')",
                       (self.n, closed - 60_000, f"m{self.n}"))
        self.c.execute("""INSERT INTO paper_positions (id, signal_id, mint, leader_wallet, status, size_sol, leader_price, entry_due_at, opened_at, cost_sol,
                          entry_price, closed_at, exit_reason, pnl_sol) VALUES (?, ?, ?, 'w', 'closed', 0.02, 1, ?, ?, 0.02, 1, ?, 'leader_exit', ?)""",
                       (self.n, self.n, f"m{self.n}", closed - 60_000, closed - 60_000, closed, pnl))

    def test_week_and_all_time_in_the_weekly_report(self):
        self.trade(0.5, NOW - 30 * DAY)  # an old win: this week starts from a higher balance
        self.trade(-0.004, NOW - DAY)
        self.trade(0.002, NOW - DAY + 1)
        self.assertAlmostEqual(hs.balance_at(self.c, NOW - 7 * DAY), hs.balance_at(self.c, 0) + 0.5)
        md = wr.build(self.c, NOW, 7)
        self.assertIn("## Honest numbers", md)
        self.assertIn("This week (2 trades):", md)
        self.assertIn("Since the start (3 trades):", md)
        self.assertIn("**Profit factor:** 0.50 (the losses are bigger than the wins)", md)

    def test_nothing_without_trades(self):
        self.assertEqual(hs.section(self.c, 0, NOW, wr.table, wr.sol, wr.pct), [])


if __name__ == "__main__":
    unittest.main()
