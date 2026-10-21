"""The brain studies YouTube: what the best traders teach, checked against our own results.

Every night it searches YouTube for talks and interviews of well-known traders (config `youtube:`),
downloads the subtitles of videos it has not seen yet (free, no key, no AI: yt-dlp), and keeps
every transcript. It counts which trading rules each video talks about ("cut your losses fast",
"let your winners run", ...) by key phrases, then checks each rule against our own data: the
shadow variants that follow the rule versus the ones that don't, or the brain's lessons. The
answer (agrees / disagrees / no difference / not enough data / untested) goes into the brain's
long-term memory (brain_memory kind 'youtube'), and a diary note when it changes.

Videos never change what the bot does. A rule that sounds wise but loses money on our trades is
written down as "our data disagrees". Phrase counts only say what traders talk about, not
whether a sentence agrees with the rule ("don't worry about stop losses" still counts).

YouTube blocks fast downloads ("Too Many Requests"), so it goes slowly and stops for the night
when blocked (two refusals in a row); the next night carries on.

Usage: python learner/youtube.py [--db path] [--dry-run] [--no-fetch]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "shared"))
sys.path.insert(0, str(ROOT / "learner"))
from migrate import connect, migrate  # noqa: E402
import brain  # noqa: E402

# The rules it listens for. Each has the phrases that point to it and how our data checks it:
#   ("variants", a, b): paired shadow results, variant a (follows the rule) minus variant b (doesn't)
#   ("lesson", key, sign): the brain's lesson `key`; sign -1 = the rule says those signals should do worse
#   None: our bot can't test it (yet): kept as notes
RULES: list[dict] = [
    {"key": "cut_losses", "words": "cut your losses fast",
     "phrases": r"cut (?:your |the )?loss|stop[- ]loss|small loss|take the loss|losers? (?:fast|quick)|get out when you'?re wrong",
     "test": ("variants", "trail_20", "trail_35"), "how": "tighter trailing stop (20%) vs looser (35%)"},
    {"key": "let_winners_run", "words": "let your winners run",
     "phrases": r"let (?:your |the )?(?:winners?|profits?) run|ride (?:the |your )?winners?|trailing stop|don'?t sell (?:your )?winners",
     "test": ("variants", "trail_35", "tp_50"), "how": "riding with a trailing stop vs selling at +50%"},
    {"key": "take_profits", "words": "take profits along the way",
     "phrases": r"take (?:some )?profits?|taking profits?|scale out|scaling out|sell into strength|lock in (?:your )?(?:profits?|gains)",
     "test": ("variants", "tp_50", "live"), "how": "selling at +50% vs our normal exit"},
    {"key": "time_stop", "words": "if a trade doesn't work quickly, get out",
     "phrases": r"time stop|dead money|(?:isn'?t|not) working,? (?:just )?get out|if it doesn'?t (?:move|work)",
     "test": ("variants", "hold_5m", "live"), "how": "selling after 5 minutes vs our normal exit"},
    {"key": "small_risk", "words": "risk only a small amount per trade",
     "phrases": r"position siz|risk management|risk (?:only )?(?:1|one|2|two) ?(?:%|percent)|never risk|bet siz|size (?:down|small)|manage (?:your )?risk",
     "test": ("variants", "live", "size_0.25"), "how": "our small 0.02 SOL trades vs 0.25 SOL (bigger trades pay a smaller share in fees)"},
    {"key": "dont_chase", "words": "don't chase a price that already ran",
     "phrases": r"chas(?:e|ing)|fomo|buy(?:ing)? the top|wait for (?:a |the )?pull ?back|don'?t buy (?:the )?(?:pump|spike)",
     "test": ("variants", "live", "no_slip_limit"), "how": "skipping when the price moved over 3% vs buying anyway"},
    {"key": "be_selective", "words": "be patient and take fewer, better trades",
     "phrases": r"overtrad|be patient|patience|fewer trades|best setups?|a\+ setups?|quality over quantity|wait for (?:the |your )?(?:pitch|setup)",
     "test": ("variants", "conf_2", "live"), "how": "only when 2+ of our traders buy vs our normal rules"},
    {"key": "follow_smart_money", "words": "follow the smart money",
     "phrases": r"smart money|follow (?:the )?(?:whales?|insiders?|money)|copy ?trad|institutional (?:buying|money)",
     "test": ("lesson", "two_traders", 1), "how": "brain lesson: 2 or more of our traders bought"},
    {"key": "liquidity", "words": "trade where there is liquidity and volume",
     "phrases": r"liquidity|liquid market|(?:high|big|low|thin) volume|illiquid",
     "test": ("lesson", "deep", 1), "how": "brain lesson: over 30 SOL in the coin"},
    {"key": "avoid_rugs", "words": "avoid coins where insiders are selling",
     "phrases": r"rug ?pull|\brugg?ed\b|scam|dev (?:sold|dump)|insiders? (?:are )?(?:selling|sold|dump)|red flags?",
     "test": ("lesson", "dev_sold", -1), "how": "brain lesson: the creator had already sold half or more"},
    {"key": "get_in_early", "words": "get in early",
     "phrases": r"get in early|early entr|first (?:few )?minutes|before (?:it|they) pump|be early",
     "test": ("lesson", "very_new", 1), "how": "brain lesson: the coin was under 1 minute old"},
    {"key": "trend", "words": "trade with the trend and momentum",
     "phrases": r"\btrend|momentum|relative strength|breakouts?|higher highs",
     "test": None, "how": "needs a new practice variant (buy only coins already rising)"},
    {"key": "psychology", "words": "control your emotions and keep discipline",
     "phrases": r"psycholog|emotion|discipline|mindset|journal|ego\b",
     "test": None, "how": "can't be tested on a bot (it has no emotions): notes only"},
]
for _r in RULES:
    _r["rx"] = re.compile(_r["phrases"], re.I)


# ---------------------------------------------------------------- config

def load_config(path: Path = ROOT / "config/config.yaml") -> dict:
    """The `youtube:` section: flat numbers plus the `traders:` and `topics:` lists."""
    text = path.read_text() + "\n"
    m = re.search(r"^youtube:\n((?:[ \t]+.*\n|\n)*)", text, re.M)
    body = m.group(1) if m else ""
    out: dict = {"traders": [], "topics": []}
    lst = None
    for line in body.splitlines():
        s = line.split(" #")[0].rstrip()
        if not s.strip() or s.strip().startswith("#"):
            continue
        k = re.match(r"^[ \t]+(\w+):\s*(.*)$", s)
        if k and not s.strip().startswith("-"):
            lst = k.group(1) if k.group(1) in out and not k.group(2) else None
            if not k.group(2):
                continue
            v = k.group(2).strip()
            out[k.group(1)] = (v == "true") if v in ("true", "false") else float(v)
        elif lst and s.strip().startswith("-"):
            out[lst].append(s.strip()[1:].strip().strip('"'))
    for k in ("per_search", "max_videos", "min_n"):
        if k in out:
            out[k] = int(out[k])
    missing = {"enabled", "per_search", "max_videos", "sleep_s", "max_duration_min", "min_n", "min_diff"} - out.keys()
    if missing:
        raise ValueError(f"config.yaml youtube: missing {sorted(missing)}")
    return out


def searches(cfg: dict, day: int) -> list[tuple[str, str | None]]:
    """(search, trader) pairs, rotated by the UTC day so every name gets its turn first."""
    out = [(f"{t} trading interview", t) for t in cfg["traders"]] + [(q, None) for q in cfg["topics"]]
    if not out:
        return out
    k = day % len(out)
    return out[k:] + out[:k]


# ---------------------------------------------------------------- fetching (yt-dlp)

class Blocked(Exception):
    """YouTube said "Too Many Requests": stop for tonight."""


def ytdlp() -> str:
    own = ROOT / ".venv/bin/yt-dlp"
    if own.exists():
        return str(own)
    found = shutil.which("yt-dlp")
    if not found:
        raise SystemExit("yt-dlp not installed: run make install")
    return found


def run(args: list[str], timeout: int = 180) -> subprocess.CompletedProcess:
    p = subprocess.run([ytdlp(), "--no-warnings", "--ignore-config", *args], capture_output=True, text=True, timeout=timeout)
    if "429" in p.stderr or "Too Many Requests" in p.stderr:
        raise Blocked(p.stderr.strip().splitlines()[-1] if p.stderr.strip() else "429")
    return p


def search(query: str, n: int) -> list[dict]:
    p = run([f"ytsearch{n}:{query}", "--flat-playlist", "--print", "%(id)s\t%(title)s\t%(channel,uploader)s\t%(duration)s"])
    out = []
    for line in p.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) == 4 and re.fullmatch(r"[\w-]{11}", parts[0]):
            try:
                dur = float(parts[3])
            except ValueError:
                dur = None
            out.append({"id": parts[0], "title": parts[1], "channel": None if parts[2] == "NA" else parts[2], "duration_s": dur})
    return out


def subtitles(video_id: str) -> str | None:
    """The English subtitles as plain text, or None if the video has none."""
    # the original English captions first: "en" on a dubbed video is a bundle of translations YouTube refuses (429)
    for lang in ("en-orig", "en"):
        with tempfile.TemporaryDirectory() as d:
            run(["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", lang, "--sub-format", "vtt",
                 "--sleep-requests", "2", "--sleep-subtitles", "3", "-o", f"{d}/%(id)s", "--", video_id])
            files = sorted(Path(d).glob("*.vtt"))
            if files:
                return vtt_text(files[0].read_text(errors="replace"))
    return None


def vtt_text(vtt: str) -> str:
    """WebVTT to plain text: no timings or tags, and without the repeated lines auto-captions have."""
    out: list[str] = []
    seen: set[str] = set()
    for line in vtt.splitlines():
        line = line.strip()
        if not line or "-->" in line or line.startswith(("WEBVTT", "Kind:", "Language:", "NOTE")) or line.isdigit():
            continue
        line = re.sub(r"<[^>]+>", "", line).replace("&nbsp;", " ").replace("&amp;", "&").strip()
        if line and line not in seen:
            seen.add(line)
            out.append(line)
    return " ".join(out)


# ---------------------------------------------------------------- studying

def count_rules(text: str) -> dict:
    """{rule: mentions} for the rules this transcript talks about."""
    return {r["key"]: n for r in RULES if (n := len(r["rx"].findall(text)))}


BLOCKS_IN_A_ROW = 2  # one refusal can be that video; two in a row means YouTube is blocking us: stop for tonight


def fetch_new(c: sqlite3.Connection, cfg: dict, now_ms: int, write: bool, find=search, subs=subtitles, sleep=time.sleep) -> dict:
    """Look at new videos (and retry refused ones once) until max_videos, the searches run out, or YouTube blocks us."""
    known = {r[0]: r[1] for r in c.execute("SELECT id, status FROM yt_videos")}
    done, in_a_row, blocked, news = 0, 0, None, []
    try:
        for query, trader in searches(cfg, now_ms // 86_400_000):
            if done >= cfg["max_videos"] or blocked:
                break
            for v in find(query, cfg["per_search"]):
                if done >= cfg["max_videos"]:
                    break
                if known.get(v["id"]) in ("ok", "no_subs", "refused") or (v["duration_s"] or 0) > cfg["max_duration_min"] * 60:
                    continue
                sleep(cfg["sleep_s"])
                try:
                    text = subs(v["id"])
                except Blocked as e:
                    # a second refusal of the same video: give up on that one for good
                    known[v["id"]] = "refused" if known.get(v["id"]) == "blocked" else "blocked"
                    if write:
                        save_video(c, v, query, trader, now_ms, known[v["id"]], None)
                    in_a_row += 1
                    if in_a_row >= BLOCKS_IN_A_ROW:
                        blocked = str(e)
                        break
                    continue
                in_a_row = 0
                done += 1
                known[v["id"]] = "ok" if text else "no_subs"
                if write:
                    save_video(c, v, query, trader, now_ms, known[v["id"]], text)
                news.append({**v, "trader": trader, "subs": bool(text), "rules": count_rules(text) if text else {}})
            sleep(cfg["sleep_s"])
    except Blocked as e:  # the search itself was refused
        blocked = str(e)
    except (subprocess.TimeoutExpired, OSError) as e:
        blocked = f"yt-dlp failed: {e}"
    return {"videos": news, "blocked": blocked}


def save_video(c: sqlite3.Connection, v: dict, query: str, trader: str | None, now_ms: int, status: str, text: str | None) -> None:
    c.execute("""INSERT OR REPLACE INTO yt_videos (id, search, trader, title, channel, duration_s, found_at, status, words, transcript, rules)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
              (v["id"], query, trader, v.get("title"), v.get("channel"), v.get("duration_s"), now_ms, status,
               len(text.split()) if text else None, text, json.dumps(count_rules(text)) if text else None))


def heard(c: sqlite3.Connection) -> dict:
    """What every video ever studied said: {rule: {videos, mentions, traders, first, last}}."""
    out: dict = {}
    for trader, found_at, rules in c.execute("SELECT trader, found_at, rules FROM yt_videos WHERE status = 'ok' ORDER BY found_at"):
        for k, n in json.loads(rules or "{}").items():
            h = out.setdefault(k, {"videos": 0, "mentions": 0, "traders": [], "first": found_at, "last": found_at})
            h["videos"] += 1
            h["mentions"] += n
            h["last"] = found_at
            if trader and trader not in h["traders"]:
                h["traders"].append(trader)
    return out


def paired(c: sqlite3.Connection, a: str, b: str) -> dict:
    """Average follower ROI of variant a minus variant b, on the same signals (both closed)."""
    rows = c.execute("""SELECT x.roi, y.roi FROM shadow_trades x JOIN shadow_trades y ON y.signal_id = x.signal_id AND y.variant = ?
                        WHERE x.variant = ? AND x.status = 'closed' AND y.status = 'closed' AND x.roi IS NOT NULL AND y.roi IS NOT NULL""",
                     (b, a)).fetchall()
    cap = lambda r: max(-1.0, min(brain.ROI_CAP, float(r)))
    xs, ys = [cap(r[0]) for r in rows], [cap(r[1]) for r in rows]
    if not rows:
        return {"n": 0}
    return {"n": len(rows), "with_avg": brain.avg(xs), "without_avg": brain.avg(ys), "diff": brain.avg(xs) - brain.avg(ys)}


def check(c: sqlite3.Connection, rule: dict, cfg: dict, lessons: dict) -> dict:
    """What our data says about one rule: {verdict, diff, n, ...}."""
    t = rule["test"]
    if t is None:
        return {"verdict": "untested"}
    if t[0] == "variants":
        r = paired(c, t[1], t[2])
        n, diff = r["n"], r.get("diff")
    else:
        l = lessons.get(t[1])
        if not l:
            return {"verdict": "not_enough_data", "n": 0}
        n = min(l["with_n"], l["without_n"])
        diff = l["diff"] * t[2]
        r = {"n": n, "with_avg": l["with_avg"], "without_avg": l["without_avg"], "diff": diff}
    if n < cfg["min_n"] or diff is None:
        return {**r, "verdict": "not_enough_data"}
    d = brain.direction(diff, cfg["min_diff"])
    return {**r, "verdict": {1: "agrees", -1: "disagrees", 0: "no_difference"}[d]}


VERDICT_WORDS = {"agrees": "our data agrees", "disagrees": "our data disagrees", "no_difference": "our data sees no real difference",
                 "not_enough_data": "not enough of our data yet", "untested": "we can't test it yet"}


def rule_text(rule: dict, h: dict, v: dict) -> str:
    who = f" ({', '.join(h['traders'][:4])}{'…' if len(h['traders']) > 4 else ''})" if h.get("traders") else ""
    s = f"\"{rule['words']}\": heard in {h.get('videos', 0)} videos{who}; {VERDICT_WORDS[v['verdict']]}"
    if v["verdict"] in ("agrees", "disagrees", "no_difference"):
        s += f" — {rule['how']}: {abs(v['diff']) * 100:.1f} points {'better' if v['diff'] > 0 else 'worse'} ({v['n']} trades)"
    elif v["verdict"] == "untested":
        s += f" — {rule['how']}"
    return s + "."


def study(c: sqlite3.Connection, cfg: dict, now_ms: int | None = None, write: bool = True, fetch: bool = True, **fetchers) -> dict:
    now_ms = now_ms or int(time.time() * 1000)
    got = fetch_new(c, cfg, now_ms, write, **fetchers) if fetch and cfg["enabled"] else {"videos": [], "blocked": None}
    h = heard(c)
    lessons = {l["key"]: l for l in brain.lessons(brain.load_examples(c), cfg["min_n"], top=None)}
    rules, events = [], []
    for rule in RULES:
        hr = h.get(rule["key"], {})
        v = check(c, rule, cfg, lessons)
        text = rule_text(rule, hr, v)
        rules.append({"key": rule["key"], "words": rule["words"], "heard": hr, **v, "text": text})
        if not write:
            continue
        c.execute("""INSERT OR REPLACE INTO yt_rules (key, words, videos, mentions, traders, first_heard, last_heard, verdict, test, data, checked_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                  (rule["key"], rule["words"], hr.get("videos", 0), hr.get("mentions", 0), json.dumps(hr.get("traders", [])), hr.get("first"),
                   hr.get("last"), v["verdict"], rule["how"], json.dumps(v), now_ms))
        if not hr.get("videos"):
            continue  # nothing heard yet: nothing to remember
        d = {"agrees": 1, "disagrees": -1}.get(v["verdict"], 0)
        key = f"yt:{rule['key']}"
        prev = brain.recall(c, key)
        row, event = brain.update_memory(prev, key, "youtube", rule["words"], now_ms, d,
                                         {"diff": v.get("diff"), "with_avg": v.get("with_avg"), "with_n": v.get("n"),
                                          "without_avg": v.get("without_avg"), "data": {**v, "heard": hr}})
        if not d:
            row["status"] = v["verdict"]  # no_difference / not_enough_data / untested: shown as they are
        brain.save_memory(c, row)
        if event or prev is None:
            events.append(text)
            c.execute("INSERT INTO brain_notes (ts, model_id, kind, text, data) VALUES (?, NULL, 'youtube', ?, ?)",
                      (now_ms, "From YouTube: " + text, json.dumps({"rule": rule["key"], **v})))
    rules.sort(key=lambda r: -r["heard"].get("videos", 0))
    return {"new_videos": got["videos"], "blocked": got["blocked"], "rules": rules, "memory": events,
            "studied": c.execute("SELECT count(*) FROM yt_videos WHERE status = 'ok'").fetchone()[0]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", default=os.environ.get("DB_PATH", str(ROOT / "data/trading.db")))
    ap.add_argument("--dry-run", action="store_true", help="study and print, write nothing")
    ap.add_argument("--no-fetch", action="store_true", help="don't download anything, just re-check the rules")
    a = ap.parse_args()
    cfg = load_config()
    c = connect(a.db)
    if not a.dry_run:
        migrate(c)
    r = study(c, cfg, write=not a.dry_run, fetch=not a.no_fetch)
    c.close()
    ok = sum(1 for v in r["new_videos"] if v["subs"])
    print(f"youtube: {len(r['new_videos'])} new videos tonight ({ok} with subtitles) · {r['studied']} studied in all"
          + (f" · stopped: {r['blocked']}" if r["blocked"] else ""))
    for v in r["new_videos"]:
        print(f"  video: {v['title']} [{v.get('channel') or '?'}] rules: {', '.join(v['rules']) or 'none'}")
    for rl in r["rules"]:
        print("  rule: " + rl["text"])
    for e in r["memory"]:
        print("  memory: " + e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
