import type { PaperConfig, ScoringConfig } from "../lib/config.js";
import type { DB } from "../lib/db.js";
import { scoreWallets } from "./score.js";

/**
 * Out-of-sample check: does a good score predict anything? Score wallets on the older part of
 * the lookback window exactly as the daily run would have, then measure the same wallets'
 * simulated follower ROI on the newest `oos_days` only. Positions open at the split belong to
 * neither side (in-sample can't see their exit, out-of-sample skips sells without a buy).
 */
export interface OosRow {
  wallet: string;
  is_trades: number;
  is_roi: number | null;
  is_score: number | null;
  is_eligible: boolean;
  is_rank: number | null;
  oos_trades: number;
  oos_roi: number | null;
  oos_pnl_sol: number;
}

export function outOfSample(db: DB, cfg: ScoringConfig, paper: PaperConfig, now = Date.now()): { splitAt: number; rows: OosRow[] } {
  const splitAt = now - cfg.oos_days * 86_400_000;
  const inSample = scoreWallets(db, cfg, paper, splitAt, undefined, { since: now - cfg.lookback_days * 86_400_000 });
  const outSample = new Map(scoreWallets(db, cfg, paper, now, undefined, { since: splitAt }).map((s) => [s.wallet, s]));
  let rank = 0;
  const rows: OosRow[] = [];
  for (const s of inSample) { // sorted by score
    if (s.eligible) rank++;
    if (s.copy_trades < 5 && !s.eligible) continue; // too little to say anything
    const o = outSample.get(s.wallet);
    rows.push({
      wallet: s.wallet, is_trades: s.copy_trades, is_roi: s.copy_roi, is_score: s.score, is_eligible: s.eligible, is_rank: s.eligible ? rank : null,
      oos_trades: o?.copy_trades ?? 0, oos_roi: o?.copy_roi ?? null, oos_pnl_sol: o?.copy_pnl_sol ?? 0,
    });
  }
  return { splitAt, rows };
}

export function saveOutOfSample(db: DB, runAt: number, res: ReturnType<typeof outOfSample>): void {
  const ins = db.prepare(`INSERT OR REPLACE INTO wallet_oos (run_at, wallet, split_at, is_trades, is_roi, is_score, is_eligible, is_rank, oos_trades, oos_roi, oos_pnl_sol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const r of res.rows) {
      ins.run(runAt, r.wallet, res.splitAt, r.is_trades, r.is_roi, r.is_score, r.is_eligible ? 1 : 0, r.is_rank, r.oos_trades, r.oos_roi, r.oos_pnl_sol);
    }
  })();
}
