import type { Config, SignalsConfig } from "../lib/config.js";
import type { DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import { RISK } from "../risk/limits.js";
import { cheapReasons, rejectReasons, type Features } from "../signals/filters.js";
import { simulateFollow, stateAt, type ExitRule, type FollowTrade } from "../sim/follow.js";
import type { CostModel } from "../sim/market.js";

/**
 * Shadow variants: every signal paper-traded under other exit rules / filters / sizes, in
 * parallel with the live paper engine and without touching it. A variant is decided at signal
 * time from the signal's feature snapshot (same filter code as live) and settled later by
 * replaying the recorded tape (same execution model as live). No balance, no portfolio limits:
 * each variant measures a rule, not a portfolio.
 *
 * The same settle loop records what the market did after every signal (signal_outcomes), so
 * rejected signals can be judged too.
 */

export interface Variant {
  name: string;
  filters: SignalsConfig | null; // null = take every signal
  exit: ExitRule;
  sizeSol: number;
  maxSlippageBps: number;
}

/** Collector outages that can hide a watched token's trades. */
const GAP_SOURCES = ["targeted", "all", "helius"];
/**
 * Outages shorter than this are tolerated: every trade row carries the post-trade reserves, so
 * the market state is right again at the next trade; only a trigger inside the outage (a leader
 * sell, a stop crossing) can be missed. Restarts and reconnects take 1-30s; the daily cap, hours.
 */
const TOLERATED_GAP_MS = 30_000;
/** Trades land in SQLite ~1s after the chain; don't settle on the last few seconds. */
const SETTLE_MARGIN_MS = 5_000;
/** Give up on rows that still can't be settled after this long (no trades recorded at all). */
const GIVE_UP_MS = 2 * 3_600_000;
const OUTCOME_HORIZON_MS = 30 * 60_000;

export function resolveVariants(cfg: Config): Variant[] {
  const base: ExitRule = {
    leaderExit: cfg.paper.follow_leader_exit, stopLossPct: RISK.STOP_LOSS_PCT, takeProfitPct: null, trailingStopPct: null, maxHoldMs: RISK.TIME_EXIT_MS,
  };
  return Object.entries(cfg.shadow.variants).map(([name, v]) => {
    const x = v.exit ?? {};
    return {
      name,
      filters: v.filters === "none" ? null : { ...cfg.signals, ...v.filters },
      exit: {
        ...base,
        ...(x.leader_exit !== undefined && { leaderExit: x.leader_exit }),
        ...(x.take_profit_pct !== undefined && { takeProfitPct: x.take_profit_pct === null ? null : x.take_profit_pct / 100 }),
        ...(x.trailing_stop_pct !== undefined && { trailingStopPct: x.trailing_stop_pct === null ? null : x.trailing_stop_pct / 100 }),
        ...(x.max_hold_s !== undefined && { maxHoldMs: Math.min(x.max_hold_s * 1000, RISK.TIME_EXIT_MS) }),
      },
      sizeSol: v.size_sol ?? cfg.shadow.size_sol,
      maxSlippageBps: v.max_slippage_bps ?? cfg.paper.max_slippage_bps,
    };
  });
}

interface PendingRow {
  signal_id: number;
  variant: string;
  mint: string;
  leader_wallet: string;
  signal_at: number;
  size_sol: number;
}

export class ShadowBook {
  readonly variants: Variant[];
  private byName: Map<string, Variant>;
  private cost: CostModel;
  readonly stats = { recorded: 0, settled: 0, outcomes: 0, errors: 0 };

  constructor(
    private db: DB,
    private cfg: Config,
    private now: () => number = Date.now,
  ) {
    this.variants = cfg.shadow.enabled ? resolveVariants(cfg) : [];
    this.byName = new Map(this.variants.map((v) => [v.name, v]));
    const p = cfg.paper;
    this.cost = { priorityFeeSol: p.priority_fee_sol, executorFeeBps: p.executor_fee_bps, extraSlippageBps: p.extra_slippage_bps, tokenAccountRentSol: p.token_account_rent_sol };
  }

  wantsOnChain(f: Features, mint: string, at: number): boolean {
    return this.variants.some((v) => v.filters && cheapReasons(f, v.filters, this.inCooldown(v, mint, at)).length === 0);
  }

  /** Decide every variant for this signal now (later signals' cooldowns depend on it); settle later. */
  record(signalId: number, f: Features, t: { mint: string; wallet: string; received_at: number }): void {
    if (!this.variants.length) return;
    const ins = this.db.prepare(`INSERT OR IGNORE INTO shadow_trades (signal_id, variant, mint, leader_wallet, signal_at, status, reasons, size_sol)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.transaction(() => {
      for (const v of this.variants) {
        const reasons = v.filters ? rejectReasons(f, v.filters, this.inCooldown(v, t.mint, t.received_at)) : [];
        ins.run(signalId, v.name, t.mint, t.wallet, t.received_at, reasons.length ? "filtered" : "pending", reasons.length ? JSON.stringify(reasons) : null, v.sizeSol);
      }
    })();
    this.stats.recorded++;
  }

  /** A variant holding (or recently out of) this token sits out, like the live re-entry cooldown. */
  private inCooldown(v: Variant, mint: string, at: number): boolean {
    const r = this.db.prepare(`SELECT max(CASE WHEN status = 'pending' THEN ? ELSE COALESCE(exit_at, entry_at, signal_at) END) last
      FROM shadow_trades WHERE variant = ? AND mint = ? AND status != 'filtered' AND signal_at <= ?`).get(Number.MAX_SAFE_INTEGER, v.name, mint, at) as { last: number | null };
    return r.last !== null && at - r.last < v.filters!.reentry_cooldown_s * 1000;
  }

  /**
   * Signals evaluated before shadow variants existed: decide them from their stored features
   * (older snapshots lack a few fields; they're inferred). Runs once per signal, in order.
   */
  backfill(): number {
    if (!this.variants.length) return 0;
    const rows = this.db.prepare(`SELECT s.id, s.mint, s.wallet, s.reasons, s.features, t.received_at FROM signals s JOIN trades t ON t.id = s.leader_trade_id
      WHERE NOT EXISTS (SELECT 1 FROM shadow_trades x WHERE x.signal_id = s.id) ORDER BY s.id`).all() as
      { id: number; mint: string; wallet: string; reasons: string; features: string; received_at: number }[];
    for (const r of rows) {
      const f = JSON.parse(r.features) as Features;
      const reasons = JSON.parse(r.reasons) as string[];
      f.token_known ??= f.token_age_s !== undefined;
      f.leader_is_dev ??= reasons.includes("leader is the token's dev");
      f.onchain_checked ??= f.top10_pct !== undefined || reasons.some((x) => x.startsWith("on-chain check failed"));
      if (f.onchain_checked && f.top10_pct === undefined) f.onchain_error ??= "failed";
      this.record(r.id, f, { mint: r.mint, wallet: r.wallet, received_at: r.received_at });
    }
    return rows.length;
  }

  /** Settle what can be settled. Cheap enough to call every few seconds; the trader calls it every 30s. */
  settle(): void {
    const now = this.now();
    const dataUntil = now - SETTLE_MARGIN_MS;
    const pending = this.db.prepare(`SELECT signal_id, variant, mint, leader_wallet, signal_at, size_sol FROM shadow_trades
      WHERE status = 'pending' AND signal_at < ? ORDER BY signal_id`).all(dataUntil - this.cfg.paper.execution_delay_ms) as PendingRow[];
    const bySignal = new Map<number, PendingRow[]>();
    for (const r of pending) bySignal.set(r.signal_id, [...(bySignal.get(r.signal_id) ?? []), r]);
    for (const rows of bySignal.values()) {
      try {
        this.settleSignal(rows, dataUntil, now);
      } catch (err) {
        this.stats.errors++;
        log.error({ err: String(err), signal: rows[0]!.signal_id }, "shadow settle failed");
      }
    }
    this.settleOutcomes(dataUntil, now);
  }

  private tape(mint: string, from: number, to: number): FollowTrade[] {
    // the state right before `from` too: a quiet token's market is its last trade
    return this.db.prepare(`SELECT * FROM (SELECT wallet, is_buy, venue, v_sol_reserves, v_token_reserves, real_token_reserves, sol_lamports, fee_lamports,
        creator_fee_lamports, price_sol, received_at, id FROM trades WHERE mint = ? AND received_at < ? ORDER BY received_at DESC, id DESC LIMIT 1)
      UNION ALL SELECT wallet, is_buy, venue, v_sol_reserves, v_token_reserves, real_token_reserves, sol_lamports, fee_lamports,
        creator_fee_lamports, price_sol, received_at, id FROM trades WHERE mint = ? AND received_at BETWEEN ? AND ?
      ORDER BY received_at, id`).all(mint, from, mint, from, to) as FollowTrade[];
  }

  private gapBetween(a: number, b: number, now: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM collector_gaps WHERE source IN (${GAP_SOURCES.map(() => "?").join(",")})
      AND started_at < ? AND COALESCE(ended_at, ?) > ? AND COALESCE(ended_at, ?) - started_at >= ? LIMIT 1`).get(...GAP_SOURCES, b, now, a, now, TOLERATED_GAP_MS);
  }

  private settleSignal(rows: PendingRow[], dataUntil: number, now: number): void {
    const s = rows[0]!;
    const leader = this.db.prepare("SELECT t.price_sol FROM signals g JOIN trades t ON t.id = g.leader_trade_id WHERE g.id = ?").get(s.signal_id) as { price_sol: number | null } | undefined;
    const delay = this.cfg.paper.execution_delay_ms;
    const tape = this.tape(s.mint, s.signal_at, s.signal_at + delay + RISK.TIME_EXIT_MS + delay + 60_000);
    const upd = this.db.prepare(`UPDATE shadow_trades SET status = @status, reasons = @reasons, entry_at = @entry_at, exit_at = @exit_at, exit_reason = @exit_reason,
      entry_price = @entry_price, exit_price = @exit_price, slippage_bps = @slippage_bps, pnl_sol = @pnl_sol, roi = @roi, platform_fee_sol = @platform,
      executor_fee_sol = @executor, priority_fee_sol = @priority, slippage_sol = @slippage, rent_sol = @rent, delay_sol = @delay, settled_at = @now
      WHERE signal_id = @signal_id AND variant = @variant`);
    const blank = { reasons: null, entry_at: null, exit_at: null, exit_reason: null, entry_price: null, exit_price: null, slippage_bps: null, pnl_sol: null,
      roi: null, platform: null, executor: null, priority: null, slippage: null, rent: null, delay: null, now };
    this.db.transaction(() => {
      for (const r of rows) {
        const v = this.byName.get(r.variant);
        const key = { signal_id: r.signal_id, variant: r.variant };
        if (!v) {
          upd.run({ ...blank, ...key, status: "gap", reasons: JSON.stringify(["variant removed from config"]) });
          continue;
        }
        const res = simulateFollow(tape, {
          leaderWallet: r.leader_wallet, leaderAt: r.signal_at, leaderPrice: leader?.price_sol ?? null, sizeSol: r.size_sol, delayMs: delay,
          maxSlippageBps: v.maxSlippageBps, cost: this.cost, exit: v.exit, dataUntil,
        });
        if (res.status === "unknown") {
          if (now - r.signal_at > GIVE_UP_MS) upd.run({ ...blank, ...key, status: "gap", reasons: JSON.stringify(["no market data"]) });
          continue;
        }
        const end = res.status === "closed" ? res.exitAt : r.signal_at + delay;
        if (this.gapBetween(r.signal_at - 60_000, end, now)) {
          upd.run({ ...blank, ...key, status: "gap", reasons: JSON.stringify(["collector outage during the trade"]) });
        } else if (res.status === "missed") {
          upd.run({ ...blank, ...key, status: "missed", reasons: JSON.stringify([res.reason]), entry_at: r.signal_at + delay, slippage_bps: res.slippageBps });
        } else {
          const c = res.costs;
          upd.run({
            ...blank, ...key, status: "closed", entry_at: res.entryAt, exit_at: res.exitAt, exit_reason: res.exitReason, entry_price: res.entryPrice,
            exit_price: res.exitPrice, slippage_bps: res.slippageBps, pnl_sol: res.pnlSol, roi: res.roi, platform: c.platformSol, executor: c.executorSol,
            priority: c.prioritySol, slippage: c.slippageSol, rent: c.rentSol, delay: res.delaySol,
          });
        }
        this.stats.settled++;
      }
    }).immediate();
  }

  /** Market path after every signal (accepted or not), once 30 minutes have passed. */
  private settleOutcomes(dataUntil: number, now: number): void {
    const delay = this.cfg.paper.execution_delay_ms;
    const due = this.db.prepare(`SELECT s.id, s.mint, t.received_at, t.price_sol FROM signals s JOIN trades t ON t.id = s.leader_trade_id
      WHERE t.received_at < ? AND NOT EXISTS (SELECT 1 FROM signal_outcomes o WHERE o.signal_id = s.id) ORDER BY s.id LIMIT 200`)
      .all(dataUntil - OUTCOME_HORIZON_MS) as { id: number; mint: string; received_at: number; price_sol: number | null }[];
    const ins = this.db.prepare(`INSERT OR REPLACE INTO signal_outcomes (signal_id, status, leader_price, entry_spot, price_1m, price_5m, price_30m, min_30m, max_30m, settled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const s of due) {
      const at = s.received_at;
      if (this.gapBetween(at - 60_000, at + OUTCOME_HORIZON_MS, now)) {
        ins.run(s.id, "gap", s.price_sol, null, null, null, null, null, null, now);
        continue;
      }
      const tape = this.tape(s.mint, at, at + OUTCOME_HORIZON_MS);
      const px = (t: number) => stateAt(tape, t)?.price ?? null;
      const entry = px(at + delay);
      let lo = entry, hi = entry;
      for (const t of tape) {
        if (t.received_at <= at + delay || t.price_sol === null) continue;
        lo = lo === null ? t.price_sol : Math.min(lo, t.price_sol);
        hi = hi === null ? t.price_sol : Math.max(hi, t.price_sol);
      }
      ins.run(s.id, entry === null ? "no_data" : "ok", s.price_sol, entry, px(at + 60_000), px(at + 300_000), px(at + OUTCOME_HORIZON_MS), lo, hi, now);
      this.stats.outcomes++;
    }
  }
}
