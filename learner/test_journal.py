"""python -m unittest discover -s learner"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "shared"))
import journal  # noqa: E402
import weekly_report as wr  # noqa: E402
from migrate import connect, migrate  # noqa: E402

DAY = 86_400_000
NOW = 1_800_000_000_000


class Journal(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.c = connect(str(Path(self.tmp.name) / "t.db"))
        migrate(self.c)
        self.n = 0

    def tearDown(self):
        self.c.close()
        self.tmp.cleanup()

    def trade(self, pnl: float, exit: str = "leader_exit", hold_s: float = 60, slip: float = 50, peak: float = 1.1, sell: float = 0.9,
              age_s: float = 60, liq: float = 10, closed: int = NOW - DAY) -> None:
        """A closed 0.02 SOL trade bought at price 1."""
        self.n += 1
        i = self.n
        feats = {"venue": "curve", "leader_buy_sol": 0.5, "confirmations": 1, "token_age_s": age_s, "liquidity_sol": liq}
        self.c.execute("INSERT INTO signals (id, ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (?, ?, 'w', ?, 0, 'curve', 'enter', '[]', ?)",
                       (i, closed - hold_s * 1000, f"m{i}", json.dumps(feats)))
        self.c.execute("""INSERT INTO paper_positions (id, signal_id, mint, leader_wallet, status, size_sol, leader_price, entry_due_at, opened_at, cost_sol,
                          entry_price, peak_price, closed_at, exit_reason, pnl_sol) VALUES (?, ?, ?, 'w', 'closed', 0.02, 1, ?, ?, 0.02, 1, ?, ?, ?, ?)""",
                       (i, i, f"m{i}", closed - hold_s * 1000, closed - hold_s * 1000, peak, closed, exit, pnl))
        self.c.execute("INSERT INTO paper_fills (position_id, ts, side, venue, ok, sol, price, slippage_bps) VALUES (?, ?, 'buy', 'curve', 1, 0.02, 1, ?)",
                       (i, closed - hold_s * 1000, slip))
        self.c.execute("INSERT INTO paper_fills (position_id, ts, side, venue, ok, sol, price) VALUES (?, ?, 'sell', 'curve', 1, 0.02, ?)", (i, closed, sell))

    def mistakes(self) -> list[list[str]]:
        return [t["mistakes"] for t in journal.trades(self.c, 0, NOW)]

    def test_names_what_went_wrong(self):
        self.trade(0.004, sell=1.2)  # a clean win
        self.trade(-0.002, slip=250)  # late
        self.trade(-0.002, age_s=30, liq=20)  # 40 SOL/min: chasing
        self.trade(-0.004, peak=1.4)  # was up 40%, still lost
        self.trade(-0.001, hold_s=10)  # leader sold within 30 s
        self.trade(-0.005, exit="stop_loss")
        self.trade(-0.001, exit="time_exit", hold_s=1800)
        self.trade(-0.0005, sell=1.01)  # price held, fees made the loss
        self.assertEqual(sorted(self.mistakes(), key=str), sorted([[], ["late"], ["chasing"], ["gave_back"], ["dumped"], ["stopped"], ["timed_out"], ["fees"]], key=str))

    def test_tally_calls_a_mistake_costly_only_with_enough_trades_doing_worse(self):
        for _ in range(journal.MIN_N):
            self.trade(-0.004, slip=300)  # late: -20%
            self.trade(0.002)  # others: +10%
        ms = {m["key"]: m for m in journal.tally(journal.trades(self.c, 0, NOW))}
        self.assertEqual((ms["late"]["n"], ms["late"]["verdict"]), (journal.MIN_N, "costly"))
        self.assertAlmostEqual(ms["late"]["avg_roi"], -0.2)
        self.assertAlmostEqual(ms["late"]["rest_avg_roi"], 0.1)
        self.trade(-0.004, exit="stop_loss")
        self.assertEqual({m["key"]: m["verdict"] for m in journal.tally(journal.trades(self.c, 0, NOW))}["stopped"], "too early")

    def test_recap_reads_like_a_journal_line(self):
        self.trade(-0.004, peak=1.4, hold_s=95)
        line = journal.recap(journal.trades(self.c, 0, NOW)[0])
        self.assertEqual(line, "m1 -0.0040 SOL (-20.0%) · in: trader bought 0.50 SOL, 1 of ours in, coin 60s old · out: the trader sold after 95s, best +40%"
                               " · went wrong: was up 30%+ and still ended in a loss")

    def test_in_the_weekly_report(self):
        for _ in range(3):
            self.trade(-0.002, slip=250)
        md = wr.build(self.c, NOW, 7)
        self.assertIn("## Trade journal", md)
        self.assertIn("3 trades, 0 without a mistake.", md)
        self.assertIn("bought late", md)

    def test_nothing_without_trades(self):
        self.assertEqual(journal.section(self.c, 0, NOW, wr.table, wr.sol, wr.pct), [])


if __name__ == "__main__":
    unittest.main()
