"""python -m unittest discover -s learner"""
from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "shared"))
import veteran  # noqa: E402
import weekly_report as wr  # noqa: E402
from migrate import connect, migrate  # noqa: E402

DAY = 86_400_000
NOW = 1_800_000_000_000


class Veteran(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.c = connect(str(Path(self.tmp.name) / "t.db"))
        migrate(self.c)

    def tearDown(self):
        self.c.close()
        self.tmp.cleanup()

    def row(self, i: int, variant: str, status: str, roi: float | None = None) -> None:
        self.c.execute("INSERT OR IGNORE INTO signals (id, ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) "
                       "VALUES (?, ?, 'w', 'm', 0, 'curve', 'enter', '[]', '{}')", (i, NOW - DAY))
        self.c.execute("""INSERT INTO shadow_trades (signal_id, variant, mint, leader_wallet, signal_at, status, size_sol, pnl_sol, roi)
                          VALUES (?, ?, 'm', 'w', ?, ?, 0.02, ?, ?)""", (i, variant, NOW - DAY, status, None if roi is None else roi * 0.02, roi))

    def test_results_by_hour_of_day(self):
        self.assertEqual(veteran.by_hour(self.c, 0, NOW), [])
        for i, roi in enumerate([0.2, -0.1, -0.4]):
            self.row(i, "all_signals", "closed", roi)
        self.row(9, "all_signals", "filtered")  # only closed trades count
        hour = time.gmtime((NOW - DAY) / 1000).tm_hour
        [h] = veteran.by_hour(self.c, 0, NOW)
        self.assertEqual((h["hour"], h["n"]), (hour, 3))
        self.assertAlmostEqual(h["roi"], -0.1)
        self.assertAlmostEqual(h["win"], 1 / 3)
        self.assertIn(f"| {hour:02d}:00 | 3 |", "\n".join(veteran.section(self.c, 0, NOW, wr.table, wr.sol, wr.pct)))

    def test_a_filter_that_skips_losers_helps(self):
        for i in range(40):
            loser = i % 2 == 0
            self.row(i, "live", "closed", -0.3 if loser else 0.1)
            if loser:
                self.row(i, "vet_no_chase", "filtered")  # skipped: counts as 0
            else:
                self.row(i, "vet_no_chase", "closed", 0.1)
        r = veteran.compare(self.c, "vet_no_chase", NOW - 7 * DAY, NOW)
        self.assertEqual((r["n"], r["trades"], r["base_trades"]), (40, 20, 40))
        self.assertAlmostEqual(r["diff"], 0.15)
        self.assertEqual(r["verdict"], "helps")

    def test_too_early_and_unsettled_rows_left_out(self):
        for i in range(10):
            self.row(i, "live", "closed", 0.1)
            self.row(i, "vet_stop_15", "closed", 0.0)
        self.row(99, "live", "closed", 0.5)
        self.row(99, "vet_stop_15", "pending")
        r = veteran.compare(self.c, "vet_stop_15", NOW - 7 * DAY, NOW)
        self.assertEqual((r["n"], r["verdict"]), (10, "too early"))

    def test_section_renders(self):
        for i in range(3):
            self.row(i, "live", "closed", 0.1)
            self.row(i, "veteran", "filtered")
        md = "\n".join(veteran.section(self.c, NOW - 7 * DAY, NOW, wr.table, wr.sol, wr.pct))
        self.assertIn("## Veteran habits", md)
        self.assertIn("`veteran`", md)
        self.assertIn("too early", md)
        self.assertEqual(veteran.section(self.c, 0, 1, wr.table, wr.sol, wr.pct), [])


if __name__ == "__main__":
    unittest.main()
