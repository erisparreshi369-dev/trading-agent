/** Daily wallet re-scoring: `npm run score` (systemd timer in Phase 3). */
import { env, loadConfig } from "../lib/config.js";
import { heartbeat, openDb } from "../lib/db.js";
import { log } from "../lib/log.js";
import { applyScores, scoreWallets } from "./score.js";

const cfg = loadConfig();
const db = openDb(env.dbPath);
const t0 = Date.now();
const scores = scoreWallets(db, cfg.scoring, cfg.paper);
const res = applyScores(db, scores, cfg.scoring);
const eligible = scores.filter((s) => s.eligible);
const reasons: Record<string, number> = {};
for (const s of scores) if (s.reject_reason && s.closed_positions >= 3) {
  const key = s.reject_reason.replace(/[\d.]+/g, "N");
  reasons[key] = (reasons[key] ?? 0) + 1;
}
const summary = {
  seconds: +((Date.now() - t0) / 1000).toFixed(1),
  walletsSeen: scores.length,
  walletsWith3Plus: scores.filter((s) => s.closed_positions >= 3).length,
  eligible: eligible.length,
  tracked: res.added.length + res.kept.length,
  added: res.added.length,
  removed: res.removed.length,
  rejectReasons: reasons,
};
heartbeat(db, "scoring", summary);
log.info(summary, "wallet scoring done");
for (const s of eligible.slice(0, cfg.scoring.track_top_n)) {
  console.log(`${s.wallet}  score=${s.score!.toFixed(3)}  copyROI=${(s.copy_roi! * 100).toFixed(1)}%  n=${s.copy_trades}  ` +
    `ownPnL=${s.realized_pnl_sol.toFixed(2)}  win=${((s.win_rate ?? 0) * 100).toFixed(0)}%  hold=${s.median_hold_s?.toFixed(0)}s`);
}
db.close();
