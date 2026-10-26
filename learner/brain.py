"""The learning brain: studies every signal the bot ever saw, after every trade, and never forgets.

For each signal (a tracked wallet's buy) the shadow variant `all_signals` recorded what following
it would have made, after every cost, whether the bot took it or not. The brain learns which
signal features predict that result, with a small, careful model (ridge regression on the
features the trader stores with every signal), and writes down lessons in plain words.

It runs all the time (`--watch`, systemd trading-brain): every time a trade's result is known, it
studies everything again, so each result changes the model within POLL_S seconds.

It may change what the bot does in one way only: make it skip signals it predicts will lose. And
only after passing an exam, re-taken at every study: trained on the older 70% of signals, its skips
must have improved the newest 30% the normal rules took (config `brain:`). Every model it ever built
and every lesson it ever wrote stay in the database (brain_models, brain_notes); the trader reads
the newest model. Standard library only.

Long-term memory (brain_memory): every lesson it ever noticed has one row that grows day after
day: when it first learned it, how many days in a row it held ("confirmed"), and when it changed
its mind. It also remembers how its own skips turned out, and fails its exam if they stopped being
losers, so it learns from its own mistakes.

Usage: python learner/brain.py [--db path] [--dry-run | --watch]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "shared"))
from migrate import connect, migrate  # noqa: E402

LABEL_VARIANT = "all_signals"  # follow every signal, live exit rules and costs: a result for every signal
ROI_CAP = 1.0  # one moonshot must not teach the brain that everything moons (same cap as wallet scoring)
POLL_S = 20  # --watch: how often it looks for new trade results
ALERT_QUIET_MS = 3_600_000  # at most one Telegram "switched on/off" per hour, however often a close exam flips

# The features the trader stores with every signal (trader/src/signals/engine.ts), and how each is
# turned into a number. trader/src/brain/model.ts applies the same kinds: keep the two in step.
#   num: as is · log: log(1 + x) · bool: 1/0 · eq: 1 if it equals `value` · missing: 1 if `of` is unknown
FEATURES: list[dict] = [
    {"name": "leader_buy_sol", "kind": "log"},
    {"name": "token_age_s", "kind": "log"},
    {"name": "liquidity_sol", "kind": "log"},
    {"name": "confirmations", "kind": "num"},
    {"name": "wallet_score", "kind": "num"},
    {"name": "top10_pct", "kind": "num"},
    {"name": "dev_hold_pct", "kind": "num"},
    {"name": "dev_sold_frac", "kind": "num"},
    {"name": "dev_tokens_24h", "kind": "log"},
    {"name": "creator_launches", "kind": "log"},
    {"name": "creator_success_rate", "kind": "num"},
    {"name": "early_buyer_score", "kind": "num"},
    {"name": "creator_record_age_h", "kind": "log"},
    {"name": "leader_is_dev", "kind": "bool"},
    {"name": "mayhem", "kind": "bool"},
    {"name": "token_known", "kind": "bool"},
    {"name": "venue", "kind": "eq", "value": "amm"},
    {"name": "holder_count", "kind": "log"},
    {"name": "hours_since_creation", "kind": "log"},
    {"name": "has_liquidity", "kind": "bool"},
]
FEATURES += [{"name": f"{f['name']}_missing", "kind": "missing", "of": f["name"]} for f in FEATURES if f["kind"] in ("num", "log")]

# Lessons: plain questions the brain answers from all the data it has. key -> (words, test).
CONDITIONS: list[tuple[str, str, callable]] = [
    ("two_traders", "2 or more of our traders bought", lambda f: _n(f, "confirmations") is not None and f["confirmations"] >= 2),
    ("dev_sold", "the creator had already sold half or more", lambda f: _n(f, "dev_sold_frac") is not None and f["dev_sold_frac"] >= 0.5),
    ("very_new", "the coin was under 1 minute old", lambda f: _n(f, "token_age_s") is not None and f["token_age_s"] < 60),
    ("older", "the coin was over 10 minutes old", lambda f: _n(f, "token_age_s") is not None and f["token_age_s"] > 600),
    ("big_buy", "our trader bought 0.5 SOL or more", lambda f: _n(f, "leader_buy_sol") is not None and f["leader_buy_sol"] >= 0.5),
    ("small_buy", "our trader bought under 0.1 SOL", lambda f: _n(f, "leader_buy_sol") is not None and f["leader_buy_sol"] < 0.1),
    ("concentrated", "the 10 biggest owners had over 40%", lambda f: _n(f, "top10_pct") is not None and f["top10_pct"] > 40),
    ("serial_creator", "the creator made over 5 coins that day", lambda f: _n(f, "dev_tokens_24h") is not None and f["dev_tokens_24h"] > 5),
    ("thin", "under 5 SOL was in the coin", lambda f: _n(f, "liquidity_sol") is not None and f["liquidity_sol"] < 5),
    ("deep", "over 30 SOL was in the coin", lambda f: _n(f, "liquidity_sol") is not None and f["liquidity_sol"] > 30),
    ("good_trader", "the trader scored above 0.05", lambda f: _n(f, "wallet_score") is not None and f["wallet_score"] > 0.05),
    ("launch_unseen", "we never saw the coin launch", lambda f: not f.get("token_known")),
    ("bad_creator", "the creator's coins almost never took off", lambda f: (_n(f, "creator_launches") or 0) >= 10 and (_n(f, "creator_success_rate") or 1) <= 0.01),
]


def _n(f: dict, k: str) -> float | None:
    v = f.get(k)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


# ---------------------------------------------------------------- config

def load_config(path: Path = ROOT / "config/config.yaml") -> dict:
    """The `brain:` section (flat numbers) and signals.use_brain."""
    text = path.read_text() + "\n"
    out: dict = {}
    m = re.search(r"^brain:\n((?:[ \t]+.*\n|\n)*)", text, re.M)
    for k, v in re.findall(r"^[ \t]+(\w+):\s*(-?[\d.]+)", m.group(1) if m else "", re.M):
        out[k] = float(v)
    for k in ("min_signals", "min_test_trades", "min_kept", "lesson_min_n"):
        if k in out:
            out[k] = int(out[k])
    s = re.search(r"^signals:\n((?:[ \t]+.*\n|\n)*)", text, re.M)
    u = re.search(r"^[ \t]+use_brain:\s*(\w+)", s.group(1) if s else "", re.M)
    out["use_brain"] = bool(u and u.group(1) == "true")
    for k in ("own_skips_min",):
        if k in out:
            out[k] = int(out[k])
    missing = {"min_signals", "min_test_trades", "test_share", "min_gain", "min_kept", "skip_below_roi", "ridge", "lesson_min_n",
               "lesson_min_diff", "own_skips_min"} - out.keys()
    if missing:
        raise ValueError(f"config.yaml brain: missing {sorted(missing)}")
    return out


# ---------------------------------------------------------------- data

def load_examples(c: sqlite3.Connection) -> list[dict]:
    """Every signal with a known outcome, oldest first: {id, ts, features, roi, taken}."""
    rows = c.execute(
        """SELECT s.id, s.ts, s.decision, s.reasons, s.features, t.roi FROM signals s
           JOIN shadow_trades t ON t.signal_id = s.id AND t.variant = ? AND t.status = 'closed' AND t.roi IS NOT NULL
           ORDER BY s.ts, s.id""", (LABEL_VARIANT,)).fetchall()
    out = []
    for sid, ts, decision, reasons, features, roi in rows:
        try:
            f = json.loads(features or "{}")
            rs = json.loads(reasons or "[]")
        except ValueError:
            continue
        out.append({"id": sid, "ts": ts, "features": f, "roi": max(-1.0, min(ROI_CAP, float(roi))), "taken": taken_by_rules(decision, rs)})
    return out


def taken_by_rules(decision: str, reasons: list[str]) -> bool:
    """Would the normal rules (without the brain) have taken it? Risk blocks and brain skips count as taken."""
    return decision != "reject" or (bool(reasons) and all(r.startswith("model expects") for r in reasons))


# ---------------------------------------------------------------- model

def raw(f: dict, spec: dict) -> float | None:
    v = f.get(spec.get("of", spec["name"]) if spec["kind"] == "missing" else spec["name"])
    k = spec["kind"]
    if k == "missing":
        return 0.0 if isinstance(v, (int, float)) and not isinstance(v, bool) else 1.0
    if k == "bool":
        return 1.0 if v else 0.0
    if k == "eq":
        return 1.0 if v == spec["value"] else 0.0
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
        return None
    return math.log1p(max(0.0, float(v))) if k == "log" else float(v)


def fit(examples: list[dict], ridge: float) -> dict:
    """Ridge regression on standardized features. Unknown numbers count as average (their *_missing flag carries the rest)."""
    specs = [dict(s) for s in FEATURES]
    cols = [[raw(e["features"], s) for e in examples] for s in specs]
    for s, col in zip(specs, cols):
        known = [x for x in col if x is not None]
        mean = sum(known) / len(known) if known else 0.0
        var = sum((x - mean) ** 2 for x in known) / len(known) if known else 0.0
        s["mean"], s["std"] = round(mean, 6), round(math.sqrt(var), 6)
    X = [[z(x, s) for x, s in zip(row, specs)] for row in zip(*cols)]
    y = [e["roi"] for e in examples]
    y0 = sum(y) / len(y)
    d = len(specs)
    A = [[sum(r[i] * r[j] for r in X) + (ridge if i == j else 0.0) for j in range(d)] for i in range(d)]
    b = [sum(r[i] * (t - y0) for r, t in zip(X, y)) for i in range(d)]
    w = solve(A, b)
    return {"features": specs, "weights": [round(v, 6) for v in w], "intercept": round(y0, 6)}


def z(x: float | None, s: dict) -> float:
    if x is None or s["std"] < 1e-9:
        return 0.0
    return (x - s["mean"]) / s["std"]


def solve(A: list[list[float]], b: list[float]) -> list[float]:
    """Gauss-Jordan with partial pivoting (A is symmetric positive definite thanks to the ridge term)."""
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        M[col], M[piv] = M[piv], M[col]
        p = M[col][col]
        if abs(p) < 1e-12:
            continue
        M[col] = [v / p for v in M[col]]
        for r in range(n):
            if r != col and M[r][col]:
                k = M[r][col]
                M[r] = [a - k * c for a, c in zip(M[r], M[col])]
    return [M[i][n] if abs(M[i][i]) > 1e-12 else 0.0 for i in range(n)]


def predict(model: dict, f: dict) -> float:
    """Predicted follower ROI for one signal (same math as trader/src/brain/model.ts)."""
    s = model["intercept"] + sum(w * z(raw(f, spec), spec) for w, spec in zip(model["weights"], model["features"]))
    return max(-1.0, min(ROI_CAP, s))


def top_features(model: dict, n: int = 10) -> list[list]:
    pairs = sorted(zip((s["name"] for s in model["features"]), model["weights"]), key=lambda p: -abs(p[1]))
    return [[name, round(w, 4)] for name, w in pairs[:n] if abs(w) > 1e-6]


# ---------------------------------------------------------------- exam

def avg(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def own_skips(c: sqlite3.Connection) -> dict:
    """How the signals it actually skipped turned out (what following them would have made)."""
    rois = [max(-1.0, min(ROI_CAP, r[0])) for r in c.execute(
        """SELECT t.roi FROM signals s JOIN shadow_trades t ON t.signal_id = s.id AND t.variant = ? AND t.status = 'closed' AND t.roi IS NOT NULL
           WHERE s.reasons LIKE '%model expects%'""", (LABEL_VARIANT,)).fetchall()]
    return {"n": len(rois), "avg": avg(rois), "losers": sum(1 for r in rois if r < 0)}


def exam(examples: list[dict], cfg: dict, own: dict | None = None) -> dict:
    """Train on the older part, test on the newest part: would its skips have helped the trades the rules took?
    Once it has skipped enough real signals, those must have been losers too: its own record counts."""
    n = len(examples)
    cut = int(round(n * (1 - cfg["test_share"])))
    train, test = examples[:cut], examples[cut:]
    taken = [e for e in test if e["taken"]]
    result = {"studied": n, "train": len(train), "test": len(test), "test_taken": len(taken), "checks": []}

    def check(key: str, ok: bool, have, need) -> None:
        result["checks"].append({"key": key, "ok": bool(ok), "have": have, "need": need})

    check("enough_signals", n >= cfg["min_signals"], n, cfg["min_signals"])
    check("enough_test_trades", len(taken) >= cfg["min_test_trades"], len(taken), cfg["min_test_trades"])
    if len(train) >= 20 and taken:
        m = fit(train, cfg["ridge"])
        kept = [e["roi"] for e in taken if predict(m, e["features"]) >= cfg["skip_below_roi"]]
        skipped = [e["roi"] for e in taken if predict(m, e["features"]) < cfg["skip_below_roi"]]
        all_avg = avg([e["roi"] for e in taken])
        result.update(taken_avg=all_avg, kept=len(kept), kept_avg=avg(kept), skipped=len(skipped), skipped_avg=avg(skipped),
                      taken_sum=sum(e["roi"] for e in taken), kept_sum=sum(kept))
        gain = (avg(kept) - all_avg) if kept else None
        result["gain"] = gain
        check("keeps_enough", len(kept) >= cfg["min_kept"], len(kept), cfg["min_kept"])
        check("skips_losers", bool(skipped) and avg(skipped) < 0, avg(skipped), "< 0")
        check("beats_rules", gain is not None and gain >= cfg["min_gain"], gain, cfg["min_gain"])
    else:
        check("can_test", False, len(train), 20)
    if own and own["n"] >= cfg["own_skips_min"]:
        check("own_skips_right", own["avg"] < 0, own["avg"], "< 0")
    result["passed"] = all(c["ok"] for c in result["checks"])
    return result


# ---------------------------------------------------------------- lessons

def lessons(examples: list[dict], min_n: int, top: int | None = 5) -> list[dict]:
    """The clearest differences in follower ROI between signals with and without a property."""
    out = []
    for key, words, test in CONDITIONS:
        yes, no = [], []
        for e in examples:
            try:
                (yes if test(e["features"]) else no).append(e["roi"])
            except (TypeError, KeyError):
                no.append(e["roi"])
        if len(yes) >= min_n and len(no) >= min_n:
            out.append({"key": key, "words": words, "with_avg": avg(yes), "with_n": len(yes), "without_avg": avg(no), "without_n": len(no),
                        "diff": avg(yes) - avg(no)})
    out.sort(key=lambda l: -abs(l["diff"]))
    return out if top is None else out[:top]


# ---------------------------------------------------------------- long-term memory

# The memory counts UTC days (the columns say "nights": it used to study once a night). A study
# after every trade refreshes the numbers; only a new day adds to nights_seen / nights_same.
CONFIRM_NIGHTS = 3  # a lesson pointing the same way this many days in a row is "confirmed"


def direction(diff: float | None, min_diff: float, prev: int = 0) -> int:
    """+1 better, -1 worse, 0 no real difference. A lesson it already holds stays until the difference
    falls under half of min_diff, so studying after every trade doesn't flip it back and forth at the edge."""
    if diff is None:
        return 0
    if prev and diff * prev > 0 and abs(diff) >= min_diff / 2:
        return prev
    return 0 if abs(diff) < min_diff else (1 if diff > 0 else -1)


def recall(c: sqlite3.Connection, key: str) -> dict | None:
    c.row_factory = sqlite3.Row
    try:
        r = c.execute("SELECT * FROM brain_memory WHERE key = ?", (key,)).fetchone()
        return dict(r) if r else None
    finally:
        c.row_factory = None


def update_memory(prev: dict | None, key: str, kind: str, words: str, now_ms: int, d: int, facts: dict) -> tuple[dict, str | None]:
    """The memory row after this study, and what changed in its mind (None = nothing worth a diary entry)."""
    if prev is None:
        row = {"key": key, "kind": kind, "words": words, "first_seen_at": now_ms, "nights_seen": 1, "nights_same": 1, "direction": d,
               "status": "new" if d else "no_difference", "first_diff": facts.get("diff"), "changed_at": None}
        event = "learned" if d else None
    else:
        # another study on the same UTC day (after every trade) refreshes the numbers but is not another day
        new_day = now_ms // 86_400_000 != prev["last_seen_at"] // 86_400_000
        row = {**prev, "words": words, "nights_seen": prev["nights_seen"] + new_day}
        event = None
        if d == prev["direction"]:
            row["nights_same"] = prev["nights_same"] + new_day
            if d and row["nights_same"] >= CONFIRM_NIGHTS and prev["status"] != "confirmed":
                row["status"], event = "confirmed", "confirmed"
        else:
            row["nights_same"] = 1
            if d and prev["direction"]:
                row["status"], row["changed_at"], event = "changed_mind", now_ms, "changed_mind"
            elif d:
                row["status"], event = "new", "learned"
            else:
                row["status"], event = "fading", "fading"
        row["direction"] = d
    row.update(last_seen_at=now_ms, diff=facts.get("diff"), with_avg=facts.get("with_avg"), with_n=facts.get("with_n"),
               without_avg=facts.get("without_avg"), without_n=facts.get("without_n"), data=json.dumps(facts.get("data") or {}))
    return row, event


def save_memory(c: sqlite3.Connection, row: dict) -> None:
    cols = ["key", "kind", "words", "first_seen_at", "last_seen_at", "nights_seen", "nights_same", "direction", "status", "first_diff", "diff",
            "with_avg", "with_n", "without_avg", "without_n", "changed_at", "data"]
    c.execute(f"INSERT OR REPLACE INTO brain_memory ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", [row.get(k) for k in cols])


def memory_text(event: str, row: dict) -> str:
    if row["kind"] == "own_skips":
        right = row["direction"] < 0
        return {"learned": f"Started keeping score of its own skips: so far they {'lost' if right else 'did not lose'} {pct(row['with_avg'])} on average ({row['with_n']}).",
                "confirmed": f"Its skips keep being right: {row['nights_same']} days in a row the trades it skipped lost money ({pct(row['with_avg'])} on average).",
                "changed_mind": f"Its skips {'are right again' if right else 'stopped being right'}: they {'lost' if right else 'made'} {pct(row['with_avg'])} on average ({row['with_n']}).",
                "fading": f"Its skips are now about break-even ({pct(row['with_avg'])})."}[event]
    better = "better" if row["direction"] > 0 else "worse"
    pts = f"{abs(row['diff'] or 0) * 100:.1f} points"
    return {"learned": f"New lesson: when {row['words']}, following does {better} ({pts}).",
            "confirmed": f"Confirmed {row['nights_same']} days in a row: when {row['words']}, following does {better} ({pts}).",
            "changed_mind": f"Changed its mind: when {row['words']}, following now does {better} ({pts}); it used to think the opposite.",
            "fading": f"No longer sure: when {row['words']}, results are now about the same as otherwise."}[event]


def remember(c: sqlite3.Connection, now_ms: int, model_id: int | None, observed: list[dict], own: dict, min_diff: float) -> list[dict]:
    """Fold this study into long-term memory. Every observation is kept as a note; changes of mind become diary entries."""
    events = []
    note = lambda kind, text, data: c.execute("INSERT INTO brain_notes (ts, model_id, kind, text, data) VALUES (?, ?, ?, ?, ?)",
                                              (now_ms, model_id, kind, text, json.dumps(data)))
    for l in observed:
        note("observation", lesson_text(l), l)
        prev = recall(c, l["key"])
        row, event = update_memory(prev, l["key"], "lesson", l["words"], now_ms, direction(l["diff"], min_diff, prev["direction"] if prev else 0),
                                   {**l, "data": None})
        save_memory(c, row)
        if event:
            events.append({"key": l["key"], "event": event, "text": memory_text(event, row)})
    if own["n"]:
        # its own skips: "direction" -1 = the trades it skipped lost money (it was right)
        prev = recall(c, "own_skips")
        d = direction(own["avg"], min_diff, prev["direction"] if prev else 0)
        row, event = update_memory(prev, "own_skips", "own_skips", "the trades it skipped", now_ms, d,
                                   {"diff": own["avg"], "with_avg": own["avg"], "with_n": own["n"], "data": own})
        save_memory(c, row)
        if event:
            events.append({"key": "own_skips", "event": event, "text": memory_text(event, row)})
    for e in events:
        note("memory", e["text"], e)
    return events


def pct(x: float | None) -> str:
    return "?" if x is None else f"{x * 100:+.1f}%"


def lesson_text(l: dict) -> str:
    better = "better" if l["diff"] > 0 else "worse"
    return (f"When {l['words']}, following made {pct(l['with_avg'])} on average ({l['with_n']} signals), "
            f"vs {pct(l['without_avg'])} otherwise ({l['without_n']}): {abs(l['diff']) * 100:.1f} points {better}.")


# ---------------------------------------------------------------- one study

def study(c: sqlite3.Connection, cfg: dict, now_ms: int | None = None, write: bool = True) -> dict:
    now_ms = now_ms or int(time.time() * 1000)
    examples = load_examples(c)
    prev = c.execute("SELECT active, studied FROM brain_models ORDER BY id DESC LIMIT 1").fetchone()
    result = {"studied": len(examples), "new": len(examples) - (prev[1] if prev else 0), "active": False, "model_id": None}
    if len(examples) < 20:
        result["note"] = f"only {len(examples)} signals with a known result: too few to learn from yet"
        if write:
            c.execute("INSERT INTO brain_notes (ts, kind, text, data) VALUES (?, 'study', ?, ?)",
                      (now_ms, f"Waiting for data: {len(examples)} signals with a known result so far (it starts learning at 20).",
                       json.dumps({"studied": len(examples)})))
        return result

    own = own_skips(c)
    ex_result = exam(examples, cfg, own)
    model = fit(examples, cfg["ridge"])  # the model it uses: trained on everything it has seen
    active = ex_result["passed"]
    version = time.strftime("brain-%Y%m%d-%H%M%S", time.gmtime(now_ms / 1000))
    model.update(version=version, trained_at=now_ms, active=active, threshold=cfg["skip_below_roi"], label=LABEL_VARIANT,
                 metrics={"studied": len(examples), "exam_test_trades": ex_result["test_taken"],
                          **({"exam_gain_pts": round(ex_result["gain"] * 100, 2)} if ex_result.get("gain") is not None else {})},
                 top_features=top_features(model))
    observed = lessons(examples, cfg["lesson_min_n"], top=None)
    les = observed[:5]
    all_avg = avg([e["roi"] for e in examples])
    taken = [e["roi"] for e in examples if e["taken"]]
    result.update(active=active, version=version, exam=ex_result, lessons=les, all_avg=all_avg, taken_avg=avg(taken), taken_n=len(taken),
                  changed=bool(prev) and bool(prev[0]) != active or (not prev and active))
    # Telegram hears when the switch differs from what it last said, at most once an hour
    last = c.execute("SELECT ts, data FROM alerts WHERE kind = 'brain' ORDER BY id DESC LIMIT 1").fetchone()
    said = bool(json.loads(last[1] or "{}").get("active")) if last else False
    result["alert"] = active != said and (not last or now_ms - last[0] >= ALERT_QUIET_MS)
    if not write:
        return result

    c.execute("BEGIN IMMEDIATE")
    try:
        mid = c.execute("INSERT INTO brain_models (trained_at, version, active, threshold, studied, model, exam) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (now_ms, version, int(active), cfg["skip_below_roi"], len(examples), json.dumps(model), json.dumps(ex_result))).lastrowid
        result["model_id"] = mid
        note = lambda kind, text, data: c.execute("INSERT INTO brain_notes (ts, model_id, kind, text, data) VALUES (?, ?, ?, ?, ?)",
                                                  (now_ms, mid, kind, text, json.dumps(data)))
        note("study", f"Studied {len(examples)} signals ({result['new']} new). Following all of them made {pct(all_avg)} on average; "
                      f"the ones our rules took ({len(taken)}) made {pct(avg(taken))}.",
             {"studied": len(examples), "new": result["new"], "all_avg": all_avg, "taken_avg": avg(taken), "taken_n": len(taken)})
        note("exam", exam_text(ex_result, cfg), ex_result)
        for l in les:
            note("lesson", lesson_text(l), l)
        result["memory"] = remember(c, now_ms, mid, observed, own, cfg["lesson_min_diff"])
        if result["alert"]:
            c.execute("INSERT INTO alerts (ts, level, kind, source, text, data) VALUES (?, 'info', 'brain', 'brain', ?, ?)",
                      (now_ms, f"learning brain {'ON: it may skip signals it predicts will lose' if active else 'OFF: it only studies'}",
                       json.dumps({"active": active, "studied": len(examples), "test_taken": ex_result["test_taken"],
                                   "taken_avg": ex_result.get("taken_avg"), "kept_avg": ex_result.get("kept_avg"),
                                   "skipped": ex_result.get("skipped"), "skipped_avg": ex_result.get("skipped_avg"), "use_brain": cfg["use_brain"]})))
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise
    return result


def exam_text(r: dict, cfg: dict) -> str:
    if r["passed"]:
        return (f"Passed the exam: on the newest {r['test_taken']} trades our rules took, skipping the {r.get('skipped')} it predicted would lose "
                f"lifts the average from {pct(r.get('taken_avg'))} to {pct(r.get('kept_avg'))}. It may now skip signals it predicts will lose.")
    todo = []
    for ch in r["checks"]:
        if ch["ok"]:
            continue
        if ch["key"] == "enough_signals":
            todo.append(f"needs {ch['need']} studied signals (has {ch['have']})")
        elif ch["key"] == "enough_test_trades":
            todo.append(f"needs {ch['need']} trades our rules took in the test part (has {ch['have']})")
        elif ch["key"] == "keeps_enough":
            todo.append(f"would skip too much (keeps {ch['have']}, needs {ch['need']})")
        elif ch["key"] == "skips_losers":
            todo.append("what it would skip didn't actually lose" if ch["have"] is not None else "it wouldn't skip anything")
        elif ch["key"] == "beats_rules":
            todo.append(f"its picks don't beat our rules by {cfg['min_gain'] * 100:.0f} points yet" + (f" ({ch['have'] * 100:+.1f})" if ch["have"] is not None else ""))
        elif ch["key"] == "own_skips_right":
            todo.append(f"the trades it really skipped didn't lose ({pct(ch['have'])} on average), so it stops skipping")
        elif ch["key"] == "can_test":
            todo.append("too little data to run the exam yet")
    return "Only studying, not skipping anything yet: " + "; ".join(todo) + "."


# ---------------------------------------------------------------- after every trade

def results_mark(c: sqlite3.Connection) -> tuple:
    """Changes whenever another trade's result is known (what the brain learns from)."""
    return tuple(c.execute("SELECT count(*), max(settled_at) FROM shadow_trades WHERE variant = ? AND status = 'closed' AND roi IS NOT NULL",
                           (LABEL_VARIANT,)).fetchone())


def watch(db: str, poll_s: float = POLL_S, rounds: int | None = None) -> int:
    """Run until stopped (or for `rounds` looks, in tests): study again each time new trade results are in.
    Config is re-read at every study."""
    stop = []
    signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
    c = connect(db)
    migrate(c)
    seen, studies, last = None, 0, {}
    print(f"brain: watching for trade results every {poll_s:.0f}s", flush=True)
    while not stop and (rounds is None or rounds > 0):
        rounds = None if rounds is None else rounds - 1
        try:
            mark = results_mark(c)
            if mark != seen:
                cfg = load_config()
                r = study(c, cfg)
                seen, studies = mark, studies + 1
                last = {"studied": r["studied"], "active": r["active"], "version": r.get("version"), "at": int(time.time() * 1000)}
                report(r, cfg, short=True)
            c.execute("INSERT OR REPLACE INTO service_heartbeats (service, ts, pid, info) VALUES ('brain', ?, ?, ?)",
                      (int(time.time() * 1000), os.getpid(), json.dumps({"studies": studies, "last": last})))
        except sqlite3.OperationalError as err:  # e.g. the database busy for longer than the 30 s timeout: try again next round
            print(f"brain: database error, retrying: {err}", flush=True)
        for _ in range(int(poll_s * 10)):
            if stop:
                break
            time.sleep(0.1)
    c.close()
    print("brain: stopped", flush=True)
    return 0


def report(r: dict, cfg: dict, short: bool = False) -> None:
    """What a study found, for the log. short: one line plus any change of mind (the --watch log)."""
    print(f"brain: studied {r['studied']} signals ({r['new']} new) · {'ACTIVE: may skip predicted losers' if r['active'] else 'studying only'}"
          + (f" · {r['version']}" if r.get("version") else "") + (f" · {r['note']}" if r.get("note") else ""))
    if r.get("exam") and not short:
        print("  exam: " + exam_text(r["exam"], cfg))
    for l in [] if short else r.get("lessons", []):
        print("  lesson: " + lesson_text(l))
    for e in r.get("memory", []):
        print("  memory: " + e["text"])
    sys.stdout.flush()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", default=os.environ.get("DB_PATH", str(ROOT / "data/trading.db")))
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="study and print, write nothing")
    mode.add_argument("--watch", action="store_true", help="keep running: study again after every new trade result")
    a = ap.parse_args()
    if a.watch:
        return watch(a.db)
    cfg = load_config()
    c = connect(a.db)
    if not a.dry_run:
        migrate(c)
    r = study(c, cfg, write=not a.dry_run)
    c.close()
    report(r, cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
