"""Tests for the learning brain: python -m unittest discover -s learner"""
from __future__ import annotations

import json
import random
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "learner"))
sys.path.insert(0, str(ROOT / "shared"))
import brain  # noqa: E402
from migrate import migrate  # noqa: E402

CFG = {"min_signals": 200, "min_test_trades": 20, "test_share": 0.25, "min_gain": 0.01, "min_kept": 5,
       "skip_below_roi": -0.04, "ridge": 2.0, "lesson_min_n": 15, "lesson_min_diff": 0.02, "own_skips_min": 10, "use_brain": True}


def signal(i: int, dev_sold: float, roi: float, taken: bool = True) -> dict:
    f = {"venue": "curve", "leader_buy_sol": 0.3, "token_known": True, "token_age_s": 40 + i % 50, "liquidity_sol": 8,
         "confirmations": 1, "wallet_score": 0.04, "dev_sold_frac": dev_sold, "top10_pct": 20, "dev_hold_pct": 1, "dev_tokens_24h": 1}
    return {"id": i, "ts": 1_000 + i, "features": f, "roi": roi, "taken": taken}


def world(n: int, seed: int = 1) -> list[dict]:
    """Coins where the creator already sold lose; the rest win a little."""
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        sold = rnd.random() < 0.5
        out.append(signal(i, 0.9 if sold else 0.0, (-0.3 if sold else 0.1) + rnd.uniform(-0.05, 0.05)))
    return out


def db_with(examples: list[dict], c: sqlite3.Connection | None = None) -> sqlite3.Connection:
    if c is None:
        c = sqlite3.connect(":memory:", isolation_level=None)
        migrate(c)
    for e in examples:
        c.execute("INSERT INTO signals (id, ts, wallet, mint, leader_trade_id, venue, score, decision, reasons, features) VALUES (?, ?, 'W', ?, 0, 'curve', 0, ?, ?, ?)",
                  (e["id"], e["ts"], f"M{e['id']}", "enter" if e["taken"] else "reject", json.dumps(e.get("reasons", [])), json.dumps(e["features"])))
        c.execute("INSERT INTO shadow_trades (signal_id, variant, mint, leader_wallet, signal_at, status, size_sol, roi) VALUES (?, 'all_signals', ?, 'W', ?, 'closed', 0.02, ?)",
                  (e["id"], f"M{e['id']}", e["ts"], e["roi"]))
    return c


class BrainTest(unittest.TestCase):
    def test_learns_that_creator_selling_loses(self):
        m = brain.fit(world(300), ridge=10)
        sold, kept = signal(0, 0.9, 0), signal(0, 0.0, 0)
        self.assertLess(brain.predict(m, sold["features"]), -0.15)
        self.assertGreater(brain.predict(m, kept["features"]), 0.05)
        self.assertEqual(brain.top_features(m)[0][0], "dev_sold_frac")

    def test_feature_kinds(self):
        spec = {s["name"]: s for s in brain.FEATURES}
        f = {"leader_buy_sol": 1.0, "mayhem": True, "venue": "amm", "top10_pct": None}
        self.assertAlmostEqual(brain.raw(f, spec["leader_buy_sol"]), 0.693147, places=5)
        self.assertEqual(brain.raw(f, spec["mayhem"]), 1.0)
        self.assertEqual(brain.raw(f, spec["venue"]), 1.0)
        self.assertIsNone(brain.raw(f, spec["top10_pct"]))
        self.assertEqual(brain.raw(f, spec["top10_pct_missing"]), 1.0)
        self.assertEqual(brain.raw({"top10_pct": 30}, spec["top10_pct_missing"]), 0.0)

    def test_exam_passes_only_with_enough_data_and_a_real_edge(self):
        self.assertTrue(brain.exam(world(400), CFG)["passed"])
        small = brain.exam(world(120), CFG)
        self.assertFalse(small["passed"])
        self.assertEqual([c["key"] for c in small["checks"] if not c["ok"]], ["enough_signals"])
        rnd = random.Random(3)  # no feature tells winners from losers: nothing to learn, so no skipping
        noise = [signal(i, 0.9 if rnd.random() < 0.5 else 0.0, rnd.uniform(-0.3, 0.3)) for i in range(400)]
        self.assertFalse(brain.exam(noise, CFG)["passed"])

    def test_brain_skips_and_risk_blocks_count_as_taken_by_the_rules(self):
        self.assertTrue(brain.taken_by_rules("enter", []))
        self.assertTrue(brain.taken_by_rules("risk_block", ["risk: already in this token"]))
        self.assertTrue(brain.taken_by_rules("reject", ["model expects -8.0% follower ROI < 0.0% threshold"]))
        self.assertFalse(brain.taken_by_rules("reject", ["re-entry cooldown"]))

    def test_study_remembers_every_night_and_alerts_only_on_change(self):
        c = db_with(world(400))
        r1 = brain.study(c, CFG, now_ms=1)
        r2 = brain.study(c, CFG, now_ms=2)
        self.assertTrue(r1["active"] and r2["active"])
        self.assertEqual(c.execute("SELECT count(*) FROM brain_models").fetchone()[0], 2)  # nothing replaced
        self.assertGreater(c.execute("SELECT count(*) FROM brain_notes WHERE kind = 'lesson'").fetchone()[0], 0)
        self.assertEqual(c.execute("SELECT count(*) FROM alerts WHERE kind = 'brain'").fetchone()[0], 1)  # switched on once
        model = json.loads(c.execute("SELECT model FROM brain_models ORDER BY id DESC").fetchone()[0])
        self.assertTrue(model["active"])
        self.assertEqual(len(model["weights"]), len(model["features"]))
        lesson = json.loads(c.execute("SELECT data FROM brain_notes WHERE kind = 'lesson' ORDER BY id").fetchone()[0])
        self.assertEqual(lesson["key"], "dev_sold")

    def test_too_little_data_waits(self):
        c = db_with(world(10))
        r = brain.study(c, CFG, now_ms=1)
        self.assertFalse(r["active"])
        self.assertEqual(c.execute("SELECT count(*) FROM brain_models").fetchone()[0], 0)
        self.assertEqual(c.execute("SELECT kind FROM brain_notes").fetchone()[0], "study")

    def test_memory_learns_confirms_and_changes_its_mind(self):
        c = db_with(world(400))
        DAY = 86_400_000
        brain.study(c, CFG, now_ms=DAY)
        brain.study(c, CFG, now_ms=DAY + 5_000)  # studied again by hand the same day: not another night
        self.assertEqual(brain.recall(c, "dev_sold")["nights_seen"], 1)
        for night in (2, 3):
            brain.study(c, CFG, now_ms=night * DAY)
        m = brain.recall(c, "dev_sold")
        self.assertEqual((m["status"], m["nights_seen"], m["nights_same"], m["direction"], m["first_seen_at"]), ("confirmed", 3, 3, -1, DAY))
        diary = [r[0] for r in c.execute("SELECT text FROM brain_notes WHERE kind = 'memory' ORDER BY id")]
        self.assertTrue(any(t.startswith("New lesson: when the creator had already sold half or more") for t in diary))
        self.assertTrue(any(t.startswith("Confirmed 3 days in a row: when the creator had already sold") for t in diary))
        # every lesson it can judge is kept every night, not just the top few
        self.assertGreaterEqual(c.execute("SELECT count(*) FROM brain_notes WHERE kind = 'observation'").fetchone()[0], 3)
        # the market flips: now creators selling is followed by gains
        rnd = random.Random(9)
        flipped = []
        for i in range(400, 1600):
            sold = rnd.random() < 0.5
            flipped.append(signal(i, 0.9 if sold else 0.0, (0.2 if sold else -0.1) + rnd.uniform(-0.05, 0.05)))
        db_with(flipped, c)
        brain.study(c, CFG, now_ms=4 * DAY)
        m = brain.recall(c, "dev_sold")
        self.assertEqual((m["status"], m["direction"], m["changed_at"], m["first_seen_at"]), ("changed_mind", 1, 4 * DAY, DAY))
        self.assertLess(m["first_diff"], 0)  # it still remembers what it thought at first
        self.assertTrue(c.execute("SELECT text FROM brain_notes WHERE kind = 'memory' AND text LIKE 'Changed its mind: when the creator had already sold%'").fetchone())

    def test_its_own_skips_that_did_not_lose_make_it_fail(self):
        c = db_with(world(400))
        self.assertTrue(brain.study(c, CFG, now_ms=1)["active"])
        rnd = random.Random(5)
        bad_skips = [{**signal(i, 0.0, 0.15 + rnd.uniform(-0.02, 0.02)), "taken": False, "reasons": ["model expects -5.0% follower ROI < 0.0% threshold"]}
                     for i in range(400, 412)]
        db_with(bad_skips, c)
        r = brain.study(c, CFG, now_ms=1 + brain.ALERT_QUIET_MS)
        self.assertFalse(r["active"])
        self.assertEqual([ch["key"] for ch in r["exam"]["checks"] if not ch["ok"]], ["own_skips_right"])
        self.assertIn("the trades it really skipped didn't lose", brain.exam_text(r["exam"], CFG))
        own = brain.recall(c, "own_skips")
        self.assertEqual((own["with_n"], own["direction"]), (12, 1))
        self.assertEqual(c.execute("SELECT count(*) FROM alerts WHERE kind = 'brain'").fetchone()[0], 2)  # on, then off

    def test_a_lesson_it_holds_does_not_flicker_at_the_edge(self):
        self.assertEqual(brain.direction(-0.015, 0.02), 0)  # new: needs the full 2 points
        self.assertEqual(brain.direction(-0.015, 0.02, prev=-1), -1)  # held: stays until under 1 point
        self.assertEqual(brain.direction(-0.009, 0.02, prev=-1), 0)
        self.assertEqual(brain.direction(0.015, 0.02, prev=-1), 0)  # the other way: no instant flip
        self.assertEqual(brain.direction(0.03, 0.02, prev=-1), 1)
        self.assertEqual(brain.direction(None, 0.02, prev=1), 0)

    def test_telegram_hears_a_switch_at_most_once_an_hour(self):
        c = db_with(world(400))
        H = brain.ALERT_QUIET_MS
        self.assertTrue(brain.study(c, CFG, now_ms=H)["alert"])  # on: said
        off = dict(CFG, min_gain=5.0)  # an impossible exam: it switches off
        self.assertFalse(brain.study(c, off, now_ms=H + 60_000)["alert"])  # off 1 minute later: quiet
        self.assertFalse(brain.study(c, CFG, now_ms=H + 120_000)["alert"])  # back on: same as last said, nothing to say
        brain.study(c, off, now_ms=H + 180_000)
        self.assertTrue(brain.study(c, off, now_ms=2 * H + 1)["alert"])  # still off an hour later: now it says so
        said = [json.loads(r[0])["active"] for r in c.execute("SELECT data FROM alerts WHERE kind = 'brain' ORDER BY id")]
        self.assertEqual(said, [True, False])
        self.assertFalse(brain.study(c, off, now_ms=3 * H)["alert"])

    def test_watch_studies_again_only_when_a_new_result_is_in(self):
        with tempfile.TemporaryDirectory() as d:
            path = str(Path(d) / "t.db")
            c = sqlite3.connect(path, isolation_level=None)
            migrate(c)
            db_with(world(60), c)
            brain.watch(path, poll_s=0, rounds=3)
            self.assertEqual(c.execute("SELECT count(*) FROM brain_models").fetchone()[0], 1)  # 3 looks, 1 new set of results
            hb = json.loads(c.execute("SELECT info FROM service_heartbeats WHERE service = 'brain'").fetchone()[0])
            self.assertEqual((hb["studies"], hb["last"]["studied"]), (1, 60))
            db_with([signal(60, 0.0, 0.1)], c)  # one more trade's result
            c.execute("UPDATE shadow_trades SET settled_at = 5 WHERE signal_id = 60")
            brain.watch(path, poll_s=0, rounds=1)
            self.assertEqual(c.execute("SELECT studied FROM brain_models ORDER BY id DESC").fetchone()[0], 61)
            c.close()

    def test_config(self):
        cfg = brain.load_config()
        self.assertEqual(cfg["min_signals"], 200)
        self.assertTrue(cfg["use_brain"])
        self.assertEqual(cfg["skip_below_roi"], -0.04)


if __name__ == "__main__":
    unittest.main()
