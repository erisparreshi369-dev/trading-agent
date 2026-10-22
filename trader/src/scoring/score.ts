import type { PaperConfig, ScoringConfig } from "../lib/config.js";
import type { DB } from "../lib/db.js";
import { RISK } from "../risk/limits.js";
import { simulateFollow, type ExitRule } from "../sim/follow.js";
import type { CostBreakdown, CostModel, TradeRowLike } from "../sim/market.js";

/**
 * Wallet scoring.
 *
 * For every wallet, every position in the lookback window is replayed twice:
 *  - as the wallet did it (realized PnL, win rate, hold time), and
 *  - as WE would have done it following them: enter `execution_delay_ms` after their buy at
 *    whatever the market was then, exit on their first sell / stop loss / time exit, with every
 *    fee, priority fee, rent and slippage of the paper engine.
 * The second number is what ranks wallets. Snipers and bundlers look great on the first and
 * terrible on the second, which is the point.
 */

interface Trade extends TradeRowLike {
  id: number;
  mint: string;
  wallet: string;
  is_buy: number;
  token_amount: number;
  slot: number | null;
}

export interface PositionStats {
  wallet: string;
  entryAt: number;
  exitAt: number | null;
  closed: boolean;
  cost: number;
  proceeds: number;
  sniped: boolean;
  buySol: number;
  copy: { pnl: number; roi: number; entryAt: number; exitAt: number; entryPrice: number; exitPrice: number; trigger: string; costs: CostBreakdown } | "missed" | "unknown";
  mint: string;
}

interface WalletAgg {
  tokens: number;
  closed: number;
  realized: number;
  wins: number;
  holds: number[];
  buySol: number;
  entries: number;
  snipes: number;
  posPnl: number;
  snipePosPnl: number;
  copyN: number;
  copyPnl: number;
  copyRoiSum: number;
  copyWins: number;
  copyMissed: number;
  firstAt: number;
  lastAt: number;
}

export interface WalletScore {
  wallet: string;
  tokens_traded: number;
  closed_positions: number;
  realized_pnl_sol: number;
  win_rate: number | null;
  median_hold_s: number | null;
  avg_buy_sol: number | null;
  snipe_frac: number;
  snipe_pnl_frac: number;
  copy_trades: number;
  copy_missed: number;
  copy_pnl_sol: number;
  copy_roi: number | null;
  copy_win_rate: number | null;
  last_trade_at: number;
  score: number | null;
  eligible: boolean;
  reject_reason: string | null;
}

interface Gap {
  start: number;
  end: number;
}

const SHRINK_K = 10; // pseudo-trades of zero ROI: a wallet needs volume before a high mean counts

export function scoreWallets(
  db: DB, cfg: ScoringConfig, paper: PaperConfig, now = Date.now(),
  /** Every fully observed position, for debugging and as learner labels. */
  onPosition?: (p: PositionStats) => void,
  /** Score only positions entered from `since` (default: lookback_days before now). Data after `now` is never read. */
  opts: { since?: number } = {},
): WalletScore[] {
  const since = opts.since ?? now - cfg.lookback_days * 86_400_000;
  const cost: CostModel = {
    priorityFeeSol: paper.priority_fee_sol,
    executorFeeBps: paper.executor_fee_bps,
    extraSlippageBps: paper.extra_slippage_bps,
    tokenAccountRentSol: paper.token_account_rent_sol,
  };
  // judge a wallet by what copying it would earn with OUR exits (leader sell and/or trailing stop, as configured)
  const exitRule: ExitRule = {
    leaderExit: paper.follow_leader_exit, stopLossPct: RISK.STOP_LOSS_PCT, takeProfitPct: null,
    trailingStopPct: paper.trailing_stop_pct === null ? null : paper.trailing_stop_pct / 100, maxHoldMs: RISK.TIME_EXIT_MS,
  };

  const tracked = new Set((db.prepare("SELECT wallet FROM tracked_wallets WHERE active = 1").all() as { wallet: string }[]).map((r) => r.wallet));
  // ranked wallets on a trial watch (intel job) are covered by targeted streams during the trial
  const trial = new Map((db.prepare("SELECT wallet, since, until FROM candidate_watch").all() as { wallet: string; since: number; until: number }[])
    .map((r) => [r.wallet, r]));
  const loadGaps = (sources: string[]) =>
    (db.prepare(`SELECT started_at s, COALESCE(ended_at, ?) e FROM collector_gaps WHERE source IN (${sources.map(() => "?").join(",")}) AND COALESCE(ended_at, ?) > ?`)
      .all(now, ...sources, now, since) as { s: number; e: number }[]).map((g) => ({ start: g.s, end: g.e }));
  // the full stream's gaps matter for everyone; tracked wallets are also covered by targeted streams
  const firehoseGaps = loadGaps(["firehose", "helius", "all"]);
  const targetedGaps = loadGaps(["targeted", "all"]);
  const overlaps = (gaps: Gap[], a: number, b: number) => gaps.some((g) => g.start < b && g.end > a);

  const tokens = new Map(
    (db.prepare("SELECT mint, creator, created_slot, created_at FROM tokens WHERE created_at > ?").all(since - 86_400_000) as {
      mint: string; creator: string | null; created_slot: number | null; created_at: number;
    }[]).map((t) => [t.mint, t]),
  );
  const aggs = new Map<string, WalletAgg>();

  const stmt = db.prepare(`SELECT id, mint, wallet, is_buy, token_amount, sol_lamports, fee_lamports, creator_fee_lamports, venue,
    v_sol_reserves, v_token_reserves, real_token_reserves, price_sol, received_at, slot
    FROM trades WHERE received_at > ? AND received_at <= ? ORDER BY mint, received_at, id`);
  let current: Trade[] = [];
  const flushToken = () => {
    if (current.length) processToken(current);
    current = [];
  };
  for (const t of stmt.iterate(since, now) as IterableIterator<Trade>) {
    if (current.length && current[0]!.mint !== t.mint) flushToken();
    current.push(t);
  }
  flushToken();

  function processToken(trades: Trade[]) {
    const tok = tokens.get(trades[0]!.mint);
    if (!tok) return; // launch not observed: no creator, no snipe detection, no full history
    const byWallet = new Map<string, Trade[]>();
    for (const t of trades) {
      if (t.wallet === tok.creator) continue; // devs trading their own launch aren't copy targets
      let arr = byWallet.get(t.wallet);
      if (!arr) byWallet.set(t.wallet, (arr = []));
      arr.push(t);
    }
    const lastSeen = trades[trades.length - 1]!.received_at;
    for (const [wallet, wt] of byWallet) {
      for (const p of positionsOf(wallet, wt, tok, trades, lastSeen)) {
        const t = trial.get(wallet);
        const watched = tracked.has(wallet) || (!!t && p.entryAt - 60_000 >= t.since && (p.exitAt ?? lastSeen) <= t.until);
        const gaps = watched ? targetedGaps : firehoseGaps;
        if (overlaps(gaps, p.entryAt - 60_000, p.exitAt ?? lastSeen)) continue; // not fully observed
        onPosition?.(p);
        add(p);
      }
    }
  }

  function positionsOf(wallet: string, wt: Trade[], tok: { created_slot: number | null; created_at: number }, all: Trade[], lastSeen: number): PositionStats[] {
    const out: PositionStats[] = [];
    let i = 0;
    while (i < wt.length) {
      while (i < wt.length && !wt[i]!.is_buy) i++; // sells of tokens bought before the window
      if (i >= wt.length) break;
      const first = wt[i]!;
      let held = 0, bought = 0, cost = 0, proceeds = 0, buySol = 0, exitAt: number | null = null;
      for (; i < wt.length; i++) {
        const t = wt[i]!;
        const fees = (t.fee_lamports ?? 0) + (t.creator_fee_lamports ?? 0);
        if (t.is_buy) {
          held += t.token_amount;
          bought += t.token_amount;
          cost += (t.sol_lamports + fees) / 1e9;
          buySol += t.sol_lamports / 1e9;
        } else {
          held -= t.token_amount;
          proceeds += (t.sol_lamports - fees) / 1e9;
          if (held <= bought * 0.05) {
            exitAt = t.received_at;
            i++;
            break;
          }
        }
      }
      const sniped = tok.created_slot !== null && first.slot !== null
        ? first.slot - tok.created_slot <= cfg.snipe_window_slots
        : first.received_at - tok.created_at <= 1_500;
      out.push({
        wallet, mint: first.mint, entryAt: first.received_at, exitAt, closed: exitAt !== null, cost, proceeds, sniped, buySol,
        copy: simulateCopy(first, all, lastSeen),
      });
    }
    return out;
  }

  /** Follow this buy exactly like the paper engine would. */
  function simulateCopy(leaderBuy: Trade, all: Trade[], lastSeen: number): PositionStats["copy"] {
    if (leaderBuy.received_at + paper.execution_delay_ms > lastSeen) return "unknown"; // tape ends before our order lands
    const r = simulateFollow(all, {
      leaderWallet: leaderBuy.wallet, leaderAt: leaderBuy.received_at, leaderPrice: leaderBuy.price_sol, sizeSol: cfg.copy_size_sol,
      delayMs: paper.execution_delay_ms, maxSlippageBps: paper.max_slippage_bps, cost, exit: exitRule, dataUntil: now,
    });
    if (r.status === "unknown") return "unknown";
    if (r.status === "missed") return "missed";
    return { pnl: r.pnlSol, roi: r.roi, entryAt: r.entryAt, exitAt: r.exitAt, entryPrice: r.entryPrice, exitPrice: r.exitPrice, trigger: r.exitReason, costs: r.costs };
  }

  function add(p: PositionStats) {
    let a = aggs.get(p.wallet);
    if (!a) {
      a = { tokens: 0, closed: 0, realized: 0, wins: 0, holds: [], buySol: 0, entries: 0, snipes: 0, posPnl: 0, snipePosPnl: 0,
        copyN: 0, copyPnl: 0, copyRoiSum: 0, copyWins: 0, copyMissed: 0, firstAt: p.entryAt, lastAt: p.entryAt };
      aggs.set(p.wallet, a);
    }
    a.tokens++;
    a.entries++;
    a.buySol += p.buySol;
    a.firstAt = Math.min(a.firstAt, p.entryAt);
    a.lastAt = Math.max(a.lastAt, p.exitAt ?? p.entryAt);
    if (p.sniped) a.snipes++;
    if (p.closed) {
      const pnl = p.proceeds - p.cost;
      a.closed++;
      a.realized += pnl;
      if (pnl > 0) {
        a.wins++;
        a.posPnl += pnl;
        if (p.sniped) a.snipePosPnl += pnl;
      }
      a.holds.push((p.exitAt! - p.entryAt) / 1000);
    }
    if (p.copy === "missed") a.copyMissed++;
    else if (p.copy !== "unknown") {
      a.copyN++;
      a.copyPnl += p.copy.pnl;
      a.copyRoiSum += Math.min(p.copy.roi, cfg.copy_roi_cap); // winsorised: robust to one lucky moonshot
      if (p.copy.pnl > 0) a.copyWins++;
    }
  }

  const out: WalletScore[] = [];
  for (const [wallet, a] of aggs) {
    const holds = a.holds.sort((x, y) => x - y);
    const median = holds.length ? holds[Math.floor(holds.length / 2)]! : null;
    const days = Math.max(1, (a.lastAt - a.firstAt) / 86_400_000);
    const copyRoi = a.copyN ? a.copyRoiSum / a.copyN : null;
    const s: WalletScore = {
      wallet, tokens_traded: a.tokens, closed_positions: a.closed, realized_pnl_sol: a.realized,
      win_rate: a.closed ? a.wins / a.closed : null, median_hold_s: median, avg_buy_sol: a.entries ? a.buySol / a.entries : null,
      snipe_frac: a.entries ? a.snipes / a.entries : 0, snipe_pnl_frac: a.posPnl > 0 ? a.snipePosPnl / a.posPnl : 0,
      copy_trades: a.copyN, copy_missed: a.copyMissed, copy_pnl_sol: a.copyPnl, copy_roi: copyRoi, copy_win_rate: a.copyN ? a.copyWins / a.copyN : null,
      last_trade_at: a.lastAt, score: copyRoi === null ? null : (copyRoi * a.copyN) / (a.copyN + SHRINK_K),
      eligible: false, reject_reason: null,
    };
    s.reject_reason =
      a.closed < cfg.min_positions ? `only ${a.closed} closed positions`
      : a.tokens / days > cfg.max_tokens_per_day ? `${Math.round(a.tokens / days)} tokens/day looks like a bot`
      : s.snipe_pnl_frac > cfg.max_snipe_pnl_frac ? `${Math.round(s.snipe_pnl_frac * 100)}% of profit from snipes`
      : median !== null && median < cfg.min_median_hold_s ? `median hold ${median.toFixed(0)}s too fast to copy`
      : a.copyN < cfg.min_copy_trades ? `only ${a.copyN} copyable trades < ${cfg.min_copy_trades} (${a.copyMissed} missed on slippage)`
      : copyRoi! <= cfg.min_copy_roi ? `follower ROI ${(copyRoi! * 100).toFixed(1)}% after costs`
      : null;
    s.eligible = s.reject_reason === null;
    out.push(s);
  }
  return out.sort((x, y) => (y.score ?? -Infinity) - (x.score ?? -Infinity));
}

/** Persist a run and update the tracked set: top N eligible in, everyone else out (with the reason). */
export function applyScores(db: DB, scores: WalletScore[], cfg: ScoringConfig, now = Date.now()): { added: string[]; removed: { wallet: string; reason: string }[]; kept: string[] } {
  const ins = db.prepare(`INSERT INTO wallet_scores (run_at, wallet, tokens_traded, closed_positions, realized_pnl_sol, win_rate, median_hold_s,
    avg_buy_sol, snipe_frac, snipe_pnl_frac, copy_trades, copy_missed, copy_pnl_sol, copy_roi, copy_win_rate, last_trade_at, score, eligible, reject_reason)
    VALUES (@run_at, @wallet, @tokens_traded, @closed_positions, @realized_pnl_sol, @win_rate, @median_hold_s, @avg_buy_sol, @snipe_frac,
    @snipe_pnl_frac, @copy_trades, @copy_missed, @copy_pnl_sol, @copy_roi, @copy_win_rate, @last_trade_at, @score, @eligible, @reject_reason)`);
  const top = scores.filter((s) => s.eligible).slice(0, cfg.track_top_n);
  const topSet = new Set(top.map((s) => s.wallet));
  const byWallet = new Map(scores.map((s) => [s.wallet, s]));
  const added: string[] = [], kept: string[] = [], removed: { wallet: string; reason: string }[] = [];

  db.transaction(() => {
    // keep only wallets that traded enough to matter: the history table would otherwise grow by every wallet seen
    for (const s of scores) if (s.closed_positions >= 3) ins.run({ ...s, run_at: now, eligible: s.eligible ? 1 : 0 });
    const current = db.prepare("SELECT wallet, source, active FROM tracked_wallets").all() as { wallet: string; source: string; active: number }[];
    const known = new Map(current.map((c) => [c.wallet, c]));
    for (const s of top) {
      const c = known.get(s.wallet);
      if (c?.active) kept.push(s.wallet);
      else added.push(s.wallet);
      db.prepare(`INSERT INTO tracked_wallets (wallet, added_at, active, source, score, last_scored_at) VALUES (?, ?, 1, 'scoring', ?, ?)
        ON CONFLICT(wallet) DO UPDATE SET active = 1, score = excluded.score, last_scored_at = excluded.last_scored_at,
        deactivated_at = NULL, deactivated_reason = NULL`).run(s.wallet, now, s.score, now);
    }
    for (const c of current) {
      if (!c.active || topSet.has(c.wallet) || c.source === "manual") continue;
      const s = byWallet.get(c.wallet);
      const reason = !s || s.last_trade_at < now - cfg.cold_after_hours * 3_600_000 ? "went cold"
        : s.reject_reason ?? "dropped out of top N";
      db.prepare("UPDATE tracked_wallets SET active = 0, deactivated_at = ?, deactivated_reason = ?, score = ?, last_scored_at = ? WHERE wallet = ?")
        .run(now, reason, s?.score ?? null, now, c.wallet);
      removed.push({ wallet: c.wallet, reason });
    }
  }).immediate();
  return { added, removed, kept };
}
