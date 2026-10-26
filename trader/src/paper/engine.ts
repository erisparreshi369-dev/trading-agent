import type { PaperConfig } from "../lib/config.js";
import type { DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import { bondingCurve, canonicalPool } from "../collector/pools.js";
import type { EntryDecision, RiskManager } from "../risk/risk-manager.js";
import type { Results } from "../risk/size-base.js";
import { maxSlippageBps } from "../lib/safe-settings.js";
import { simulateBuy, simulateSell, slippageBps, stateFromTrade, type CostBreakdown, type CostModel, type MarketState, type TradeRowLike } from "../sim/market.js";

/** A failed order still pays its network fee. */
const priorityOnly = (sol: number): CostBreakdown => ({ platformSol: 0, executorSol: 0, prioritySol: sol, slippageSol: 0, rentSol: 0 });

/** The collector's data modes in which it no longer watches the wallets we copy (see collector/budget.ts). */
const NO_NEW_TRADES_MODES = ["positions_only", "off"];

/** The collector writes a heartbeat every 30 s: three missed ones and we treat it as gone. */
export const COLLECTOR_SILENT_MS = 90_000;

/**
 * If you feel off, don't trade. The bot's version: it is "off" when it can't see. Following a trader
 * means selling when they sell; if no stream is watching them, that sell would go unseen. Null = fine.
 * No collector heartbeat at all means no collector ever ran on this database (nothing to judge).
 */
export function blindReason(db: DB, now: number): string | null {
  const hb = db.prepare("SELECT ts, info FROM service_heartbeats WHERE service = 'collector'").get() as { ts: number; info: string | null } | undefined;
  if (!hb) return null;
  if (now - hb.ts > COLLECTOR_SILENT_MS) return `can't see the market: collector silent for ${Math.round((now - hb.ts) / 1000)}s`;
  let streams: { targeted?: boolean | null; firehose?: boolean | null } | undefined;
  try {
    streams = (JSON.parse(hb.info ?? "{}") as { streams?: typeof streams }).streams;
  } catch {
    streams = undefined;
  }
  if (streams && streams.targeted !== true && streams.firehose !== true) return "can't see the traders we copy: no stream is watching them";
  return null;
}

/** Realized result of our paper trades that closed in [from, to): what the proven balance is judged on. */
export function paperResults(db: DB): Results {
  return (from, to) => {
    const r = db.prepare(`SELECT COALESCE(SUM(pnl_sol), 0) pnl, COALESCE(SUM(status = 'closed'), 0) trades FROM paper_positions
      WHERE status IN ('closed', 'failed') AND closed_at >= ? AND closed_at < ?`).get(from, to) as { pnl: number; trades: number };
    return { pnl: r.pnl, trades: r.trades };
  };
}

/** Trades reach SQLite ~0.3-1s after we'd have seen them; wait this long past a fill's due time. */
export const INGEST_MARGIN_MS = 1_000;
/** If the curve completed and the pool hasn't traded yet, an exit waits at most this long. */
const MIGRATION_WAIT_MS = 10 * 60_000;

export interface Position {
  id: number;
  signal_id: number;
  mint: string;
  leader_wallet: string;
  status: "pending" | "open" | "closed" | "failed";
  size_sol: number;
  leader_price: number;
  entry_due_at: number;
  exit_due_at: number | null;
  exit_trigger: string | null;
  leader_exited_at: number | null;
  opened_at: number | null;
  cost_sol: number | null;
  tokens: number | null;
  entry_price: number | null;
  last_price: number | null;
  last_price_at: number | null;
  peak_price: number | null;
  closed_at: number | null;
  exit_reason: string | null;
  proceeds_sol: number | null;
  pnl_sol: number | null;
}

export interface TradeRow extends TradeRowLike {
  id: number;
  mint: string;
  wallet: string;
  is_buy: number;
}

export type PaperEvent =
  | { type: "entry"; position: Position; slippageBps: number }
  | { type: "entry_failed"; position: Position; reason: string }
  | { type: "exit"; position: Position; reason: string }
  | { type: "kill"; reason: string };

export class PaperEngine {
  private cost: CostModel;
  private listeners: ((e: PaperEvent) => void)[] = [];

  constructor(
    private db: DB,
    private cfg: PaperConfig,
    private risk: RiskManager,
    private now: () => number = Date.now,
  ) {
    this.cost = {
      priorityFeeSol: cfg.priority_fee_sol,
      executorFeeBps: cfg.executor_fee_bps,
      extraSlippageBps: cfg.extra_slippage_bps,
      tokenAccountRentSol: cfg.token_account_rent_sol,
    };
  }

  init(): void {
    this.db.prepare("INSERT OR IGNORE INTO paper_account (id, balance_sol, start_balance, created_at) VALUES (1, ?, ?, ?)")
      .run(this.cfg.start_balance_sol, this.cfg.start_balance_sol, this.now());
  }

  on(fn: (e: PaperEvent) => void): void {
    this.listeners.push(fn);
  }

  account(): { balance: number; start: number } {
    const r = this.db.prepare("SELECT balance_sol, start_balance FROM paper_account WHERE id = 1").get() as { balance_sol: number; start_balance: number };
    return { balance: r.balance_sol, start: r.start_balance };
  }

  live(): Position[] {
    return this.db.prepare("SELECT * FROM paper_positions WHERE status IN ('pending', 'open') ORDER BY id").all() as Position[];
  }

  /** Free SOL + reserved SOL of pending entries + what open positions would sell for now (+ rent back). */
  equity(): number {
    let eq = this.account().balance;
    for (const p of this.live()) {
      if (p.status === "pending") eq += p.size_sol;
      else eq += this.markValue(p);
    }
    return eq;
  }

  /** A tracked wallet bought and the signal engine accepted it. Risk decides if and how much. */
  async enter(signalId: number, leader: { mint: string; wallet: string; venue: string; received_at: number; price_sol: number }): Promise<EntryDecision> {
    const { balance, start } = this.account();
    const live = this.live();
    if (live.some((p) => p.mint === leader.mint)) return { ok: false, reason: "already in this token" };
    // the day's data budget is nearly gone: what's left is kept for watching the trades already open
    const mode = this.db.prepare("SELECT value FROM kv WHERE key = 'collector.data_mode'").get() as { value: string } | undefined;
    if (mode && NO_NEW_TRADES_MODES.includes(mode.value)) return { ok: false, reason: "data budget nearly used: no new trades until 00:00 UTC" };
    const blind = blindReason(this.db, this.now());
    if (blind) return { ok: false, reason: blind };
    const dayStart = Date.parse(new Date(this.now()).toISOString().slice(0, 10));
    const entriesToday = (this.db.prepare("SELECT count(*) n FROM paper_positions WHERE entry_due_at >= ?").get(dayStart) as { n: number }).n;
    const leaderRecentEntries = (this.db.prepare(`SELECT count(*) n FROM (SELECT leader_wallet FROM paper_positions WHERE status != 'failed'
      ORDER BY id DESC LIMIT ?) WHERE leader_wallet = ?`).get(this.risk.limits.WALLET_SHARE_WINDOW, leader.wallet) as { n: number }).n;
    const decision = await this.risk.checkEntry({ equity: this.equity(), freeBalance: balance, startBalance: start, openPositions: live.length, entriesToday, leaderRecentEntries });
    if (!decision.ok) return decision;

    const due = leader.received_at + this.cfg.execution_delay_ms;
    this.db.transaction(() => {
      this.db.prepare("UPDATE paper_account SET balance_sol = balance_sol - ? WHERE id = 1").run(decision.sizeSol);
      this.db.prepare(`INSERT INTO paper_positions (signal_id, mint, leader_wallet, status, size_sol, leader_price, entry_due_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?)`).run(signalId, leader.mint, leader.wallet, decision.sizeSol, leader.price_sol, due);
      // make sure the collector follows this token until we're out (a day is far beyond TIME_EXIT)
      const addr = leader.venue === "amm" ? canonicalPool(leader.mint) : bondingCurve(leader.mint);
      this.db.prepare(`INSERT INTO watchlist (address, kind, mint, until, priority, reason) VALUES (?, ?, ?, ?, 1, 'paper position')
        ON CONFLICT(address) DO UPDATE SET until = MAX(until, excluded.until), priority = MIN(priority, 1)`)
        .run(addr, leader.venue === "amm" ? "pool" : "curve", leader.mint, this.now() + 86_400_000);
    }).immediate();
    log.info({ mint: leader.mint, leader: leader.wallet, size: decision.sizeSol, due }, "paper entry scheduled");
    return decision;
  }

  /** Every new trade from the collector goes through here. */
  onTrade(t: TradeRow): void {
    if (t.price_sol === null) return;
    for (const p of this.live().filter((x) => x.mint === t.mint)) {
      if (p.status === "open" && t.received_at >= (p.opened_at ?? 0)) {
        this.db.prepare("UPDATE paper_positions SET last_price = ?, last_price_at = ?, peak_price = MAX(COALESCE(peak_price, 0), ?) WHERE id = ?")
          .run(t.price_sol, t.received_at, t.price_sol, p.id);
        const hard = this.risk.checkExit({ entryPrice: p.entry_price!, openedAt: p.opened_at! }, t.price_sol);
        // let winners run: sell once the price falls trailing_stop_pct below its best since our buy (same rule as sim/follow.ts)
        const peak = Math.max(p.peak_price ?? 0, p.entry_price!, t.price_sol);
        const trail = this.cfg.trailing_stop_pct;
        if (hard === "stop_loss") this.triggerExit(p, "stop_loss", t.received_at);
        else if (trail !== null && t.price_sol <= peak * (1 - trail / 100)) this.triggerExit(p, "trailing_stop", t.received_at);
      }
      if (this.cfg.follow_leader_exit && t.wallet === p.leader_wallet && !t.is_buy) {
        if (p.status === "open") this.triggerExit(p, "leader_exit", t.received_at);
        else this.db.prepare("UPDATE paper_positions SET leader_exited_at = COALESCE(leader_exited_at, ?) WHERE id = ?").run(t.received_at, p.id);
      }
    }
  }

  /** Run fills that are due, time exits, loss limits and the kill switch. Call every ~250ms. */
  tick(): void {
    const { start } = this.account();
    this.risk.tick({ equity: this.equity(), startBalance: start });
    const kill = this.risk.isKilled();
    const now = this.now();
    const timeExitMs = this.risk.limits.TIME_EXIT_MS;
    for (const p of this.live()) {
      if (kill.killed) {
        if (p.status === "pending") this.failEntry(p, "kill switch", 0);
        else this.triggerExit(p, "kill_switch", now);
        continue;
      }
      if (p.status === "pending" && now >= p.entry_due_at + INGEST_MARGIN_MS) this.fillEntry(p);
      else if (p.status === "open" && p.exit_due_at === null && now - p.opened_at! >= timeExitMs) {
        this.triggerExit(p, "time_exit", p.opened_at! + timeExitMs);
      }
    }
    for (const p of this.live()) {
      if (p.status === "open" && p.exit_due_at !== null && now >= p.exit_due_at + INGEST_MARGIN_MS) this.fillExit(p);
    }
  }

  private triggerExit(p: Position, reason: string, at: number): void {
    if (p.exit_due_at !== null) return;
    const due = Math.max(at, p.opened_at ?? at) + this.cfg.execution_delay_ms;
    this.db.prepare("UPDATE paper_positions SET exit_due_at = ?, exit_trigger = ? WHERE id = ? AND exit_due_at IS NULL").run(due, reason, p.id);
    p.exit_due_at = due;
    p.exit_trigger = reason;
    log.info({ id: p.id, mint: p.mint, reason }, "paper exit triggered");
  }

  private fillEntry(p: Position): void {
    const m = this.marketAt(p.mint, p.entry_due_at);
    if (!m) return this.failEntry(p, "no market data", this.cost.priorityFeeSol);
    if (m.venue === "curve" && this.curveCompleted(p.mint, p.entry_due_at)) return this.failEntry(p, "curve completed", this.cost.priorityFeeSol);
    const buy = simulateBuy(m, p.size_sol, this.cost);
    if (!buy) return this.failEntry(p, "size too small after fixed costs", this.cost.priorityFeeSol);
    const slip = slippageBps(buy.price, p.leader_price);
    const delay = this.cfg.execution_delay_ms;
    const limit = maxSlippageBps(this.db, this.cfg);
    if (slip > limit) {
      // like a real order sent with a slippage limit: refused, the network fee is still paid
      const reason = `skipped: price moved too much (slippage ${slip.toFixed(0)}bps > ${limit.toFixed(0)}bps limit)`;
      this.recordFill(p.id, "buy", m.venue, false, this.cost.priorityFeeSol, null, buy.price, p.leader_price, slip, delay, this.cost.priorityFeeSol, reason, priorityOnly(this.cost.priorityFeeSol));
      return this.failEntry(p, reason, this.cost.priorityFeeSol, false);
    }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE paper_positions SET status = 'open', opened_at = ?, cost_sol = ?, tokens = ?, entry_price = ?,
        last_price = ?, last_price_at = ?, peak_price = ? WHERE id = ?`)
        .run(p.entry_due_at, p.size_sol, buy.tokens, buy.price, m.price, m.ts, m.price, p.id);
      this.recordFill(p.id, "buy", m.venue, true, p.size_sol, buy.tokens, buy.price, p.leader_price, slip, delay, buy.feesSol + buy.rentSol, null, buy.costs,
        buy.curveSol * (1 - p.leader_price / m.price));
    }).immediate();
    const opened = this.get(p.id);
    log.info({ id: p.id, mint: p.mint, tokens: buy.tokens, price: buy.price, slipBps: Math.round(slip) }, "paper entry filled");
    this.emit({ type: "entry", position: opened, slippageBps: slip });
    // the leader already sold while our order was in flight: follow them straight out
    if (p.leader_exited_at !== null) this.triggerExit(opened, "leader_exit", p.entry_due_at);
  }

  private failEntry(p: Position, reason: string, feePaid: number, record = true): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE paper_account SET balance_sol = balance_sol + ? WHERE id = 1").run(p.size_sol - feePaid);
      this.db.prepare("UPDATE paper_positions SET status = 'failed', closed_at = ?, exit_reason = ?, pnl_sol = ? WHERE id = ?")
        .run(this.now(), reason, -feePaid, p.id);
      if (record) this.recordFill(p.id, "buy", "curve", false, feePaid, null, null, p.leader_price, null, null, feePaid, reason, priorityOnly(feePaid));
    }).immediate();
    log.info({ id: p.id, mint: p.mint, reason }, "paper entry failed");
    this.emit({ type: "entry_failed", position: this.get(p.id), reason });
  }

  private fillExit(p: Position): void {
    let m = this.marketAt(p.mint, p.exit_due_at!);
    if (!m) return; // nothing to price against yet
    if (m.venue === "curve" && this.curveCompleted(p.mint, p.exit_due_at!)) {
      // curve is done and the pool hasn't traded: we can't sell until it does
      const pool = this.marketAt(p.mint, this.now(), "amm");
      if (pool) m = pool;
      else if (this.now() - p.exit_due_at! < MIGRATION_WAIT_MS) return;
    }
    const sell = simulateSell(m, p.tokens!, this.cost);
    const proceeds = sell.netSol + this.cost.tokenAccountRentSol; // account closed: rent comes back
    const pnl = proceeds - p.cost_sol!;
    // slippage vs the price when we decided to sell (positive = we got less). Never blocks an exit.
    const ref = this.marketAt(p.mint, p.exit_due_at! - this.cfg.execution_delay_ms)?.price ?? m.price;
    const slip = slippageBps(ref, sell.price);
    const limit = maxSlippageBps(this.db, this.cfg);
    if (slip > limit) log.info({ id: p.id, mint: p.mint, slipBps: Math.round(slip), limitBps: limit }, "paper exit: price moved too much, sold anyway");
    this.db.transaction(() => {
      this.db.prepare("UPDATE paper_account SET balance_sol = balance_sol + ? WHERE id = 1").run(proceeds);
      this.db.prepare("UPDATE paper_positions SET status = 'closed', closed_at = ?, exit_reason = ?, proceeds_sol = ?, pnl_sol = ? WHERE id = ?")
        .run(p.exit_due_at, p.exit_trigger, proceeds, pnl, p.id);
      this.recordFill(p.id, "sell", m.venue, true, proceeds, p.tokens, sell.price, ref, slip, this.cfg.execution_delay_ms, sell.feesSol, p.exit_trigger,
        { ...sell.costs, rentSol: -this.cost.tokenAccountRentSol });
      this.db.prepare("UPDATE watchlist SET until = MIN(until, ?) WHERE mint = ? AND reason = 'paper position'").run(this.now() + 5 * 60_000, p.mint);
    }).immediate();
    const closed = this.get(p.id);
    log.info({ id: p.id, mint: p.mint, reason: p.exit_trigger, pnl: +pnl.toFixed(5) }, "paper exit filled");
    this.emit({ type: "exit", position: closed, reason: p.exit_trigger ?? "?" });
  }

  /** Latest market state at or before `t` (by our receive time, i.e. what we could have known). */
  marketAt(mint: string, t: number, venue?: "curve" | "amm"): MarketState | null {
    const row = this.db.prepare(`SELECT * FROM trades WHERE mint = ? AND received_at <= ? ${venue ? "AND venue = ?" : ""}
      ORDER BY received_at DESC, id DESC LIMIT 1`).get(...(venue ? [mint, t, venue] : [mint, t])) as TradeRowLike | undefined;
    return row ? stateFromTrade(row) : null;
  }

  private markValue(p: Position): number {
    if (!p.tokens || !p.last_price) return p.cost_sol ?? 0;
    const m = this.marketAt(p.mint, this.now());
    if (!m) return p.cost_sol ?? 0;
    return simulateSell(m, p.tokens, this.cost).netSol + this.cost.tokenAccountRentSol;
  }

  private curveCompleted(mint: string, t: number): boolean {
    const r = this.db.prepare("SELECT completed_at FROM tokens WHERE mint = ?").get(mint) as { completed_at: number | null } | undefined;
    return !!r?.completed_at && r.completed_at <= t;
  }

  private recordFill(positionId: number, side: string, venue: string, ok: boolean, sol: number | null, tokens: number | null, price: number | null,
    refPrice: number | null, slip: number | null, delay: number | null, fees: number | null, reason: string | null, c: CostBreakdown, delaySol: number | null = null): void {
    this.db.prepare(`INSERT INTO paper_fills (position_id, ts, side, venue, ok, sol, tokens, price, ref_price, slippage_bps, delay_ms, fees_sol, reason,
      platform_fee_sol, executor_fee_sol, priority_fee_sol, slippage_sol, rent_sol, delay_sol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(positionId, this.now(), side, venue, ok ? 1 : 0, sol, tokens, price, refPrice, slip, delay, fees, reason,
        c.platformSol, c.executorSol, c.prioritySol, c.slippageSol, c.rentSol, delaySol);
  }

  private get(id: number): Position {
    return this.db.prepare("SELECT * FROM paper_positions WHERE id = ?").get(id) as Position;
  }

  private emit(e: PaperEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        log.warn({ err: String(err) }, "paper event listener failed");
      }
    }
  }
}
