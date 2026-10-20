import { existsSync } from "node:fs";
import type { DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import { RISK, type RiskLimits } from "./limits.js";

export type EntryDecision = { ok: true; sizeSol: number } | { ok: false; reason: string };

export interface AccountSnapshot {
  equity: number; // free balance + marked value of everything held
  freeBalance: number;
  startBalance: number;
  openPositions: number; // pending + open
  entriesToday: number;
  leaderRecentEntries: number; // this signal's leader among our last RISK.WALLET_SHARE_WINDOW entries
}

export interface PositionView {
  entryPrice: number;
  openedAt: number;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Enforces the limits it's given (RISK unless the caller passes limitsFor(mode)). It takes only account facts as input: no signal score, no model output, no
 * config. Exits are never blocked; the kill switch and loss caps only stop new entries
 * (and the kill switch also makes the engine flatten everything).
 */
export class RiskManager {
  constructor(
    private db: DB,
    private killFile: string,
    private now: () => number = Date.now,
    private limits: RiskLimits = RISK,
  ) {}

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
    if (a.equity < a.startBalance * (1 - this.limits.MAX_DRAWDOWN_PCT)) {
      this.kill(`max drawdown: equity ${a.equity.toFixed(4)} < ${(1 - this.limits.MAX_DRAWDOWN_PCT) * 100}% of start ${a.startBalance}`);
    }
    if (st.halted_day !== today && st.day_start_equity !== null && a.equity < st.day_start_equity * (1 - this.limits.DAILY_LOSS_CAP_PCT)) {
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
    if (a.openPositions >= this.limits.MAX_OPEN_POSITIONS) return { ok: false, reason: `max open positions (${this.limits.MAX_OPEN_POSITIONS})` };
    if (a.entriesToday >= this.limits.MAX_ENTRIES_PER_DAY) return { ok: false, reason: `max entries per day (${this.limits.MAX_ENTRIES_PER_DAY})` };
    const maxPerLeader = Math.floor(this.limits.MAX_WALLET_SHARE * this.limits.WALLET_SHARE_WINDOW);
    if (a.leaderRecentEntries >= maxPerLeader) {
      return { ok: false, reason: `leader has ${a.leaderRecentEntries} of our last ${this.limits.WALLET_SHARE_WINDOW} entries (max ${maxPerLeader})` };
    }
    const size = Math.min(a.equity * this.limits.MAX_POSITION_PCT, this.limits.MAX_POSITION_SOL);
    if (size < this.limits.MIN_POSITION_SOL) return { ok: false, reason: `position size ${size.toFixed(4)} below minimum ${this.limits.MIN_POSITION_SOL}` };
    if (a.freeBalance - size < this.limits.MIN_FREE_BALANCE_SOL) return { ok: false, reason: "free balance would drop below reserve" };
    return { ok: true, sizeSol: size };
  }

  /** Hard exits. Returns a reason to exit, or null. */
  checkExit(p: PositionView, price: number): string | null {
    if (price <= p.entryPrice * (1 - this.limits.STOP_LOSS_PCT)) return "stop_loss";
    if (this.now() - p.openedAt >= this.limits.TIME_EXIT_MS) return "time_exit";
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
