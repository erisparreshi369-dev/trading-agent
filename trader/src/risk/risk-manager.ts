import { existsSync } from "node:fs";
import type { DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import { RISK, type RiskLimits } from "./limits.js";
import { nextSizeBase, type Results, type SizeBase } from "./size-base.js";

export type EntryDecision = { ok: true; sizeSol: number } | { ok: false; reason: string };

export interface AccountSnapshot {
  equity: number; // free balance + marked value of everything held
  freeBalance: number;
  startBalance: number;
  openPositions: number; // pending + open
  entriesToday: number;
  leaderRecentEntries: number; // this signal's leader among our last WALLET_SHARE_WINDOW entries
}

export interface PositionView {
  entryPrice: number;
  openedAt: number;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** How often the proven balance is re-judged (it changes at most weekly). */
const SIZE_CHECK_MS = 60_000;

/**
 * Enforces the limits it's given (RISK unless the caller passes limitsFor(mode), or a function returning
 * them: then they are read again at every check, so a dashboard change applies within a tick). It takes
 * only account facts as input: no signal score, no model output, no config. Exits are never blocked; the kill switch and loss caps only stop new entries
 * (and the kill switch also makes the engine flatten everything).
 *
 * Size comes from min(equity, proven balance) (size-base.ts): `results` gives the realized P&L of the
 * book being traded, so the proven balance can step up after consistent weeks. Without it, it stays
 * at the starting balance.
 */
export class RiskManager {
  constructor(
    private db: DB,
    private killFile: string,
    private now: () => number = Date.now,
    private source: RiskLimits | (() => RiskLimits) = RISK,
    private results?: Results,
  ) {}

  private sizeCheckedAt = -Infinity;

  /** The limits in force right now. */
  get limits(): RiskLimits {
    return typeof this.source === "function" ? this.source() : this.source;
  }

  isKilled(): { killed: boolean; reason: string | null } {
    const row = this.db.prepare("SELECT kill_switch, kill_reason FROM risk_state WHERE id = 1").get() as { kill_switch: number; kill_reason: string | null };
    if (row.kill_switch) return { killed: true, reason: row.kill_reason };
    if (existsSync(this.killFile)) return { killed: true, reason: `kill file ${this.killFile}` };
    return { killed: false, reason: null };
  }

  /** Trip the kill switch. There is deliberately no way to clear it from here (see scripts/unkill). */
  kill(reason: string): void {
    const r = this.db.prepare("UPDATE risk_state SET kill_switch = 1, kill_reason = ?, kill_at = ? WHERE id = 1 AND kill_switch = 0").run(reason, this.now());
    if (r.changes) log.error({ alert: "kill_switch", reason }, "KILL SWITCH TRIPPED");
  }

  /** Called every tick with current equity: rolls the UTC day and trips the loss limits. */
  tick(a: Pick<AccountSnapshot, "equity" | "startBalance">): void {
    const today = utcDay(this.now());
    const st = this.state();
    if (st.day !== today) {
      this.db.prepare("UPDATE risk_state SET day = ?, day_start_equity = ? WHERE id = 1").run(today, a.equity);
      st.day_start_equity = a.equity;
    }
    const L = this.limits;
    this.stepSizeBase(a, L);
    if (a.equity < a.startBalance * (1 - L.MAX_DRAWDOWN_PCT)) {
      this.kill(`max drawdown: equity ${a.equity.toFixed(4)} < ${(1 - L.MAX_DRAWDOWN_PCT) * 100}% of start ${a.startBalance}`);
    }
    if (st.halted_day !== today && st.day_start_equity !== null && a.equity < st.day_start_equity * (1 - L.DAILY_LOSS_CAP_PCT)) {
      this.db.prepare("UPDATE risk_state SET halted_day = ? WHERE id = 1").run(today);
      log.warn({ alert: "daily_loss_cap", equity: a.equity, dayStart: st.day_start_equity }, "daily loss cap hit: no new entries until 00:00 UTC");
    }
  }

  haltedToday(): boolean {
    return this.state().halted_day === utcDay(this.now());
  }

  checkEntry(a: AccountSnapshot): EntryDecision {
    this.tick(a);
    const kill = this.isKilled();
    if (kill.killed) return { ok: false, reason: `kill switch: ${kill.reason}` };
    if (this.haltedToday()) return { ok: false, reason: "daily loss cap reached" };
    const L = this.limits;
    if (a.openPositions >= L.MAX_OPEN_POSITIONS) return { ok: false, reason: `max open positions (${L.MAX_OPEN_POSITIONS})` };
    if (a.entriesToday >= L.MAX_ENTRIES_PER_DAY) return { ok: false, reason: `max entries per day (${L.MAX_ENTRIES_PER_DAY})` };
    const maxPerLeader = Math.floor(L.MAX_WALLET_SHARE * L.WALLET_SHARE_WINDOW);
    if (a.leaderRecentEntries >= maxPerLeader) {
      return { ok: false, reason: `leader has ${a.leaderRecentEntries} of our last ${L.WALLET_SHARE_WINDOW} entries (max ${maxPerLeader})` };
    }
    const size = Math.min(Math.min(a.equity, this.sizeBase().base) * L.MAX_POSITION_PCT, L.MAX_POSITION_SOL);
    if (size < L.MIN_POSITION_SOL) return { ok: false, reason: `position size ${size.toFixed(4)} below minimum ${L.MIN_POSITION_SOL}` };
    if (a.freeBalance - size < L.MIN_FREE_BALANCE_SOL) return { ok: false, reason: "free balance would drop below reserve" };
    return { ok: true, sizeSol: size };
  }

  /** The proven balance trades are sized from (set by tick: call it first). */
  sizeBase(): SizeBase {
    const r = this.db.prepare("SELECT size_base, size_base_prev, size_base_at FROM risk_state WHERE id = 1").get() as
      { size_base: number | null; size_base_prev: number | null; size_base_at: number | null };
    return r.size_base === null ? { base: Infinity, prev: null, stepAt: this.now() } : { base: r.size_base, prev: r.size_base_prev, stepAt: r.size_base_at ?? this.now() };
  }

  /** Start the proven balance at the starting balance, then step it when size-base.ts says so. */
  private stepSizeBase(a: Pick<AccountSnapshot, "equity" | "startBalance">, L: RiskLimits): void {
    const save = (s: SizeBase) => this.db.prepare("UPDATE risk_state SET size_base = ?, size_base_prev = ?, size_base_at = ? WHERE id = 1").run(s.base, s.prev, s.stepAt);
    const cur = this.sizeBase();
    if (cur.base === Infinity) {
      save({ base: a.startBalance, prev: null, stepAt: this.now() });
      return;
    }
    if (!this.results || this.now() - this.sizeCheckedAt < SIZE_CHECK_MS) return;
    this.sizeCheckedAt = this.now();
    const step = nextSizeBase(cur, a.equity, this.now(), this.results, L.SIZE_STEP_WEEKS, L.SIZE_STEP_PCT);
    if (!step) return;
    save(step.state);
    if (step.event === "kept") return;
    log.warn({ alert: "size_step", direction: step.event, from: cur.base, to: step.state.base, weeks: L.SIZE_STEP_WEEKS },
      step.event === "up" ? "proven balance stepped up after consistent weeks" : "proven balance back down: the week after the step-up lost");
  }

  /** Hard exits. Returns a reason to exit, or null. */
  checkExit(p: PositionView, price: number): string | null {
    const L = this.limits;
    if (price <= p.entryPrice * (1 - L.STOP_LOSS_PCT)) return "stop_loss";
    if (this.now() - p.openedAt >= L.TIME_EXIT_MS) return "time_exit";
    return null;
  }

  private state() {
    return this.db.prepare("SELECT day, day_start_equity, halted_day FROM risk_state WHERE id = 1").get() as {
      day: string | null;
      day_start_equity: number | null;
      halted_day: string | null;
    };
  }
}
