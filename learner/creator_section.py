"""Weekly report section: does the MadeOnSol creator check help? Practice results with and without it.

"Without" is the shadow variant `live` (our current settings), "with" is `creator_check` (the same
plus "skip coins whose creator has a bad record"). Both are simulated on every signal with the
same execution model, and the check only uses creator records stored BEFORE each decision.
"""
from __future__ import annotations

import json
import sqlite3

WITHOUT, WITH = "live", "creator_check"


def _has(c: sqlite3.Connection, table: str) -> bool:
    return c.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (table,)).fetchone() is not None


def section(c: sqlite3.Connection, since: int, until: int, table, sol, pct) -> list[str]:
    md = ["## Does the creator check help? (MadeOnSol)", "",
          "_The creator check skips coins whose creator launched many coins before and almost none of them filled their "
          "curve. It only uses creator records we had stored before each decision. It is tested in practice only: "
          "real practice trades don't use it yet._", ""]
    if not _has(c, "creator_reputation"):
        return md + ["- Not running yet.", ""]

    total = known = 0
    for (f,) in c.execute("SELECT features FROM signals WHERE ts >= ? AND ts < ?", (since, until)):
        total += 1
        known += json.loads(f or "{}").get("creator_launches") is not None
    reqs = c.execute("SELECT count(*), SUM(ok) FROM intel_requests WHERE provider = 'madeonsol' AND ts >= ? AND ts < ?", (since, until)).fetchone()
    md += [f"- We knew the creator's record for **{known} of {total}** buys our wallets made "
           f"({known / total * 100:.0f}%)." if total else "- No buys by our wallets this week.",
           f"- MadeOnSol requests this week: {reqs[0]} ({reqs[1] or 0} answered), about {reqs[0] / 7:.0f} a day of the 200 free."]

    rows = {}
    for v in (WITHOUT, WITH):
        rows[v] = c.execute(
            """SELECT count(*), SUM(pnl_sol > 0), COALESCE(SUM(pnl_sol), 0), AVG(roi) FROM shadow_trades
               WHERE variant = ? AND status = 'closed' AND signal_at >= ? AND signal_at < ?""", (v, since, until)).fetchone()
    if not rows[WITHOUT][0] and not rows[WITH][0]:
        return md + ["- No practice results yet for the comparison.", ""]
    md += ["", table(["", "trades", "winners", "PnL SOL", "avg per trade"], [
        [label, str(n), f"{(w or 0) / n * 100:.0f}%" if n else "-", sol(p), pct(r)]
        for label, (n, w, p, r) in (("without the creator check", rows[WITHOUT]), ("with the creator check", rows[WITH]))])]

    # the trades the check would have skipped: in `live`, filtered out by `creator_check` for a bad creator
    skipped = c.execute(
        """SELECT count(*), COALESCE(SUM(l.pnl_sol), 0), SUM(l.pnl_sol > 0) FROM shadow_trades l
           JOIN shadow_trades k ON k.signal_id = l.signal_id AND k.variant = ? AND k.status = 'filtered' AND k.reasons LIKE '%bad creator%'
           WHERE l.variant = ? AND l.status = 'closed' AND l.signal_at >= ? AND l.signal_at < ?""", (WITH, WITHOUT, since, until)).fetchone()
    n, pnl, wins = skipped
    md += [f"- The check would have skipped **{n}** trades. Together they made **{sol(pnl)} SOL** ({wins or 0} winners)."]
    if n < 5:
        md += [f"- **Verdict:** not enough skipped trades yet to tell (we want at least 5; there were {n}). Keep the check off for now."]
    elif pnl < 0:
        md += ["- **Verdict:** the check helps: the trades it skips lose money. Worth turning on for practice trades "
               "(`signals.exclude_bad_creators: true`) and watching another week."]
    else:
        md += ["- **Verdict:** the check doesn't help yet: the trades it skips made money. Keep it off."]
    return md + [""]
