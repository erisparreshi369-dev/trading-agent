"""Tests for the YouTube study: python -m unittest discover -s learner"""
from __future__ import annotations

import json
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "learner"))
sys.path.insert(0, str(ROOT / "shared"))
import youtube  # noqa: E402
from migrate import migrate  # noqa: E402

CFG = {"enabled": True, "per_search": 3, "max_videos": 4, "sleep_s": 0, "max_duration_min": 240, "min_n": 30, "min_diff": 0.02,
       "traders": ["Paul Tudor Jones", "Peter Brandt"], "topics": ["risk management"]}

VTT = """WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:03.000
<c>you</c> have to cut your losses

00:00:03.000 --> 00:00:05.000
you have to cut your losses
and let your winners run

00:00:05.000 --> 00:00:07.000
the stop-loss is everything
"""


def db() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:", isolation_level=None)
    migrate(c)
    return c


def shadow(c: sqlite3.Connection, variant: str, rois: list[float]) -> None:
    for i, roi in enumerate(rois, 1):
        c.execute("""INSERT INTO shadow_trades (signal_id, variant, mint, leader_wallet, signal_at, status, size_sol, roi)
                     VALUES (?, ?, 'm', 'w', ?, 'closed', 0.02, ?)""", (i, variant, i, roi))


class Transcripts(unittest.TestCase):
    def test_vtt_text_drops_timings_tags_and_repeats(self):
        t = youtube.vtt_text(VTT)
        self.assertEqual(t, "you have to cut your losses and let your winners run the stop-loss is everything")

    def test_count_rules(self):
        r = youtube.count_rules(youtube.vtt_text(VTT))
        self.assertEqual(r["cut_losses"], 2)
        self.assertEqual(r["let_winners_run"], 1)
        self.assertNotIn("psychology", r)

    def test_config_loads(self):
        cfg = youtube.load_config()
        self.assertTrue(cfg["traders"])
        self.assertIsInstance(cfg["max_videos"], int)

    def test_searches_rotate(self):
        self.assertEqual(youtube.searches(CFG, 0)[0], ("Paul Tudor Jones trading interview", "Paul Tudor Jones"))
        self.assertEqual(youtube.searches(CFG, 1)[0][1], "Peter Brandt")
        self.assertEqual(youtube.searches(CFG, 2)[0], ("risk management", None))


class Checking(unittest.TestCase):
    def test_paired_verdicts(self):
        c = db()
        shadow(c, "trail_20", [0.10] * 40)
        shadow(c, "trail_35", [0.02] * 40)
        rule = next(r for r in youtube.RULES if r["key"] == "cut_losses")
        v = youtube.check(c, rule, CFG, {})
        self.assertEqual(v["verdict"], "agrees")
        self.assertAlmostEqual(v["diff"], 0.08)
        shadow(c, "tp_50", [-0.2] * 40)
        rule = next(r for r in youtube.RULES if r["key"] == "let_winners_run")
        self.assertEqual(youtube.check(c, rule, CFG, {})["verdict"], "agrees")  # trail_35 +2% vs tp_50 -20%
        rule = next(r for r in youtube.RULES if r["key"] == "take_profits")
        self.assertEqual(youtube.check(c, rule, CFG, {})["n"], 0)  # no live rows

    def test_few_trades_is_not_enough(self):
        c = db()
        shadow(c, "trail_20", [0.5] * 5)
        shadow(c, "trail_35", [0.0] * 5)
        rule = next(r for r in youtube.RULES if r["key"] == "cut_losses")
        self.assertEqual(youtube.check(c, rule, CFG, {})["verdict"], "not_enough_data")

    def test_lesson_sign(self):
        rule = next(r for r in youtube.RULES if r["key"] == "avoid_rugs")
        lessons = {"dev_sold": {"with_n": 50, "without_n": 50, "with_avg": -0.3, "without_avg": 0.1, "diff": -0.4}}
        self.assertEqual(youtube.check(db(), rule, CFG, lessons)["verdict"], "agrees")  # dev sold -> worse, as the rule says

    def test_untestable(self):
        rule = next(r for r in youtube.RULES if r["key"] == "psychology")
        self.assertEqual(youtube.check(db(), rule, CFG, {})["verdict"], "untested")

    def test_built_in(self):
        rule = next(r for r in youtube.RULES if r["key"] == "same_risk")
        v = youtube.check(db(), rule, CFG, {})
        self.assertEqual(v["verdict"], "built_in")
        self.assertIn("already works this way", youtube.rule_text(rule, {}, v))

    def test_habit_counts_skipped_signals_as_zero(self):
        c = db()
        shadow(c, "live", [0.10] * 40)
        shadow(c, "vet_cool_off", [0.10] * 20)  # traded the first 20 like live...
        for i in range(21, 41):  # ...and sat out the other 20, which live won
            c.execute("""INSERT INTO shadow_trades (signal_id, variant, mint, leader_wallet, signal_at, status, size_sol)
                         VALUES (?, 'vet_cool_off', 'm', 'w', ?, 'filtered', 0.02)""", (i, i))
        c.execute("UPDATE shadow_trades SET pnl_sol = roi * size_sol WHERE status = 'closed'")
        rule = next(r for r in youtube.RULES if r["key"] == "take_every_setup")
        v = youtube.check(c, rule, CFG, {})
        self.assertEqual(v["n"], 40)
        self.assertAlmostEqual(v["diff"], 0.05)  # taking every signal: 5 points better per signal
        self.assertEqual(v["verdict"], "agrees")
        self.assertEqual(youtube.check(db(), rule, CFG, {})["verdict"], "not_enough_data")


class Douglas(unittest.TestCase):
    # lines from "9 Years of Trading Psychology in 37 Minutes" (Trading in the Zone), watched 2026-10-21
    def test_his_lines_are_heard(self):
        said = {
            "take_every_setup": "if you don't take every single valid setup, then you are losing probability",
            "probabilities": "number one, within trading, anything can happen",
            "accept_risk_first": "you have to accept the risk that you guys are taking before entering the trade",
            "same_risk": "you have to manage your risk identically each time",
            "no_revenge": "and then you start revenge trading",
        }
        for key, line in said.items():
            self.assertIn(key, youtube.count_rules(line), line)

    def test_old_transcripts_are_counted_again(self):
        c = db()
        youtube.save_video(c, {"id": "old"}, "q", None, 1, "ok", "anything can happen")
        c.execute("UPDATE yt_videos SET rules = '{}'")  # counted before the rule existed
        self.assertEqual(youtube.heard(c)["probabilities"]["videos"], 1)

    def test_add_video_by_hand(self):
        c = db()
        found = lambda link: [{"id": "88tyzO9CxGA", "title": "9 Years", "channel": None, "duration_s": 2236.0}]  # noqa: E731
        v = youtube.add_video(c, "https://www.youtube.com/watch?v=88tyzO9CxGA", 5, find=found, subs=lambda vid: "revenge trading")
        self.assertEqual(v["rules"], {"no_revenge": 1})
        self.assertEqual(c.execute("SELECT search, status FROM yt_videos").fetchone(), ("added by hand", "ok"))
        with self.assertRaises(ValueError):
            youtube.add_video(c, "nope", 5, find=lambda link: [], subs=lambda vid: None)


def ytdlp_result(stderr: str, code: int = 0, vtt: str | None = None):
    """A fake yt-dlp run: writes the subtitle file into the -o folder if `vtt` is given."""
    import subprocess

    def run(args):
        if vtt is not None:
            out = args[args.index("-o") + 1].replace("%(id)s", "vid")
            Path(out + ".en.vtt").write_text(vtt)
        return subprocess.CompletedProcess(args, code, "", stderr)
    return run


# what yt-dlp printed on 2026-10-21 when YouTube blocked this machine
BOT_CHECK = """WARNING: [youtube] x: Unable to download webpage: HTTP Error 429: Too Many Requests (caused by <HTTPError 429: Too Many Requests>)
ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication."""


class Fetching(unittest.TestCase):
    def test_bot_check_is_a_block_not_missing_subtitles(self):
        with self.assertRaises(youtube.Blocked) as e:
            youtube.subtitles("x", run=ytdlp_result(BOT_CHECK, code=1))
        self.assertIn("not a bot", str(e.exception))

    def test_a_429_warning_alone_is_a_block_when_nothing_came_back(self):
        with self.assertRaises(youtube.Blocked):
            youtube.subtitles("x", run=ytdlp_result("WARNING: Unable to download video subtitles for 'en-orig': HTTP Error 429: Too Many Requests"))

    def test_any_error_means_couldnt_check(self):
        with self.assertRaises(youtube.Blocked):
            youtube.subtitles("x", run=ytdlp_result("ERROR: [youtube] x: Video unavailable", code=1))

    def test_clean_run_without_subtitles_is_no_subtitles(self):
        self.assertIsNone(youtube.subtitles("x", run=ytdlp_result("WARNING: There are no subtitles for the requested languages")))

    def test_subtitles_that_arrived_count_even_after_a_429_on_the_page(self):
        vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\ncut your losses fast\n"
        text = youtube.subtitles("x", run=ytdlp_result(BOT_CHECK.splitlines()[0], vtt=vtt))
        self.assertIn("cut your losses fast", text)


class Night(unittest.TestCase):
    def fake(self, blocked_after: int | None = None):
        calls = {"subs": 0}

        def find(query, n):
            return [{"id": f"{query[:5].replace(' ', '_'):_<5}{i:06d}", "title": f"{query} {i}", "channel": "ch", "duration_s": 600.0} for i in range(n)]

        def subs(vid):
            calls["subs"] += 1
            if blocked_after is not None and calls["subs"] > blocked_after:
                raise youtube.Blocked("429")
            return "cut your losses fast. trust the trend." if calls["subs"] % 2 else None

        return {"find": find, "subs": subs, "sleep": lambda s: None}, calls

    def test_night_saves_videos_and_memory(self):
        c = db()
        f, calls = self.fake()
        r = youtube.study(c, CFG, now_ms=86_400_000 * 10, **f)
        self.assertEqual(len(r["new_videos"]), CFG["max_videos"])
        self.assertIsNone(r["blocked"])
        self.assertEqual(c.execute("SELECT count(*) FROM yt_videos").fetchone()[0], 4)
        self.assertEqual(c.execute("SELECT count(*) FROM yt_videos WHERE status = 'no_subs'").fetchone()[0], 2)
        rules = {k: (v, n) for k, v, n in c.execute("SELECT key, verdict, videos FROM yt_rules")}
        self.assertEqual(rules["cut_losses"], ("not_enough_data", 2))
        self.assertEqual(rules["trend"], ("untested", 2))
        mem = {k: s for k, s in c.execute("SELECT key, status FROM brain_memory WHERE kind = 'youtube'")}
        self.assertEqual(mem, {"yt:cut_losses": "not_enough_data", "yt:trend": "untested"})
        self.assertEqual(c.execute("SELECT count(*) FROM brain_notes WHERE kind = 'youtube'").fetchone()[0], 2)
        # the next night skips what it saw and doesn't repeat diary notes
        r2 = youtube.study(c, CFG, now_ms=86_400_000 * 11, **f)
        self.assertTrue(all(v["id"] not in {x["id"] for x in r["new_videos"]} for v in r2["new_videos"]))
        self.assertEqual(c.execute("SELECT count(*) FROM brain_notes WHERE kind = 'youtube'").fetchone()[0], 2)

    def test_blocked_stops_the_night_and_retries_later(self):
        c = db()
        f, _ = self.fake(blocked_after=1)
        r = youtube.study(c, CFG, now_ms=86_400_000 * 10, **f)
        self.assertEqual(r["blocked"], "429")  # stops after two refusals in a row
        self.assertEqual([s for (s,) in c.execute("SELECT status FROM yt_videos ORDER BY status")], ["blocked", "blocked", "ok"])
        f, _ = self.fake()
        youtube.study(c, CFG, now_ms=86_400_000 * 10, **f)
        self.assertEqual(c.execute("SELECT count(*) FROM yt_videos WHERE status = 'blocked'").fetchone()[0], 0)

    def test_one_refused_video_does_not_stop_the_night(self):
        c = db()
        f, _ = self.fake()
        good = f["subs"]
        f["subs"] = lambda vid: (_ for _ in ()).throw(youtube.Blocked("429")) if vid.endswith("000000") else good(vid)
        r = youtube.study(c, CFG, now_ms=86_400_000 * 10, **f)
        self.assertIsNone(r["blocked"])
        self.assertEqual(len(r["new_videos"]), CFG["max_videos"])
        youtube.study(c, CFG, now_ms=86_400_000 * 11, **f)  # refused again: given up for good
        self.assertIn("refused", {s for (s,) in c.execute("SELECT status FROM yt_videos")})

    def test_retry_videos_are_checked_again(self):
        c = db()
        f, _ = self.fake()
        youtube.study(c, CFG, now_ms=86_400_000 * 10, **f)
        c.execute("UPDATE yt_videos SET status = 'retry'")
        r = youtube.study(c, CFG, now_ms=86_400_000 * 10, **f)  # same day: the same searches find the same videos
        self.assertEqual(len(r["new_videos"]), CFG["max_videos"])
        self.assertEqual(c.execute("SELECT count(*) FROM yt_videos WHERE status = 'retry'").fetchone()[0], 0)

    def test_dry_run_writes_nothing(self):
        c = db()
        f, _ = self.fake()
        youtube.study(c, CFG, now_ms=86_400_000 * 10, write=False, **f)
        self.assertEqual(c.execute("SELECT count(*) FROM yt_videos").fetchone()[0], 0)
        self.assertEqual(c.execute("SELECT count(*) FROM brain_memory").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
