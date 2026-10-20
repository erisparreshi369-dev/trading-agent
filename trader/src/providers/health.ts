import type { JobName, ProviderName, ProvidersConfig } from "../lib/config.js";

/**
 * Per-provider health from what actually happens: messages, request results, timeouts, budget.
 * Pure bookkeeping (no network) so every rule is testable with a fake clock.
 */
export interface ProviderState {
  healthy: boolean;
  reason: string | null; // why it's unhealthy
  healthySince: number | null; // continuously healthy since (null while unhealthy)
  errorsInARow: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastMessageAt: number | null;
  /** silence only counts while we expect steady traffic (a busy stream is running) */
  expectTraffic: boolean;
  budgetPct: number;
  messages: number;
  requests: number;
  failures: number;
  /** delay of the last request, ms */
  lastLatencyMs: number | null;
  /** first success after a failure: when it's judged healthy again, it counts as healthy from here */
  recoveredAt: number | null;
}

type HealthCfg = ProvidersConfig["health"];

export class ProviderHealth {
  private states = new Map<ProviderName, ProviderState>();

  constructor(private cfg: HealthCfg, private now: () => number = Date.now) {}

  private s(p: ProviderName): ProviderState {
    let st = this.states.get(p);
    if (!st) {
      st = { healthy: true, reason: null, healthySince: this.now(), errorsInARow: 0, lastError: null, lastErrorAt: null, lastMessageAt: null,
        expectTraffic: false, budgetPct: 0, messages: 0, requests: 0, failures: 0, lastLatencyMs: null, recoveredAt: null };
      this.states.set(p, st);
    }
    return st;
  }

  /** A live-stream message arrived from this provider. */
  message(p: ProviderName): void {
    const st = this.s(p);
    st.messages++;
    st.lastMessageAt = this.now();
    this.succeeded(st);
  }

  /**
   * Whether this provider should be delivering steady traffic right now. Off-hours discovery or a
   * quiet set of followed traders is not a fault, so silence is only judged while this is on.
   */
  expectTraffic(p: ProviderName, on: boolean): void {
    const st = this.s(p);
    if (on && !st.expectTraffic) st.lastMessageAt = this.now(); // measure silence from now, not from the last busy period
    st.expectTraffic = on;
  }

  /** A stream connected (counts as a sign of life; silence is measured from here). */
  connected(p: ProviderName): void {
    const st = this.s(p);
    st.lastMessageAt = this.now();
    this.succeeded(st);
  }

  /** A request finished. Slower than timeout_s counts as a failure even if it succeeded. */
  request(p: ProviderName, ok: boolean, latencyMs: number, error?: string): void {
    const st = this.s(p);
    st.requests++;
    st.lastLatencyMs = latencyMs;
    if (ok && latencyMs <= this.cfg.timeout_s * 1000) this.succeeded(st);
    else this.fail(st, ok ? `slow answer (${Math.round(latencyMs / 1000)}s)` : error ?? "request failed");
  }

  /** A stream dropped or a request errored. */
  error(p: ProviderName, error: string): void {
    this.fail(this.s(p), error);
  }

  budget(p: ProviderName, pct: number): void {
    this.s(p).budgetPct = pct;
  }

  /** Recompute healthy/unhealthy. Call before reading state (the router does). */
  evaluate(): void {
    const now = this.now();
    for (const st of this.states.values()) {
      const reason = st.errorsInARow >= this.cfg.errors_in_a_row ? `${st.errorsInARow} failures in a row${st.lastError ? `: ${st.lastError}` : ""}`
        : st.budgetPct >= this.cfg.budget_pct ? `daily budget ${Math.round(st.budgetPct)}% used`
        : st.expectTraffic && st.lastMessageAt !== null && now - st.lastMessageAt > this.cfg.silent_s * 1000 ? `silent for ${Math.round((now - st.lastMessageAt) / 1000)}s`
        : null;
      if (reason && st.healthy) {
        st.healthy = false;
        st.healthySince = null;
      } else if (!reason && !st.healthy) {
        st.healthy = true;
        st.healthySince = st.recoveredAt ?? now;
        st.recoveredAt = null;
      }
      st.reason = reason;
    }
  }

  state(p: ProviderName): ProviderState {
    return this.s(p);
  }

  all(): [ProviderName, ProviderState][] {
    return [...this.states.entries()];
  }

  private succeeded(st: ProviderState): void {
    st.errorsInARow = 0;
    if (!st.healthy) st.recoveredAt ??= this.now();
  }

  private fail(st: ProviderState, error: string): void {
    st.recoveredAt = null; // a new failure cancels a recovery in progress
    st.errorsInARow++;
    st.failures++;
    st.lastError = error.slice(0, 200);
    st.lastErrorAt = this.now();
    if (st.errorsInARow >= this.cfg.errors_in_a_row && st.healthy) {
      // flip at once: a burst followed by one lucky success must not slip between evaluations,
      // and it restarts the "healthy for 2 minutes" clock for switching back
      st.healthy = false;
      st.healthySince = null;
      st.reason = `${st.errorsInARow} failures in a row: ${st.lastError}`;
    }
  }
}

export interface Switch {
  job: JobName;
  from: ProviderName | null;
  to: ProviderName | null; // null = no provider is usable
  reason: string;
  at: number;
}

/**
 * Picks the provider for one job, failover style: the first healthy one in the job's order.
 * Moving to a WORSE provider happens at once; moving back to a better one only after it has been
 * healthy for switch_back_after_healthy_s without a break (so a flapping provider can't bounce us).
 */
export class JobRouter {
  private current: ProviderName | null;

  constructor(
    readonly job: JobName,
    private order: ProviderName[],
    private health: ProviderHealth,
    private cfg: HealthCfg,
    private onSwitch: (s: Switch) => void,
    private now: () => number = Date.now,
  ) {
    this.current = order[0] ?? null;
  }

  get active(): ProviderName | null {
    return this.current;
  }

  get primary(): ProviderName | null {
    return this.order[0] ?? null;
  }

  /** Re-decide; returns the switch if one happened. */
  evaluate(): Switch | null {
    this.health.evaluate();
    const now = this.now();
    const ok = (p: ProviderName) => this.health.state(p).healthy;
    const settled = (p: ProviderName) => {
      const since = this.health.state(p).healthySince;
      return since !== null && now - since >= this.cfg.switch_back_after_healthy_s * 1000;
    };
    const rank = (p: ProviderName | null) => (p === null ? Infinity : this.order.indexOf(p));
    let next = this.current;
    if (next === null || !ok(next)) {
      // current is unusable: take the best healthy one right away
      next = this.order.find(ok) ?? null;
    }
    // a better-ranked provider that has been healthy long enough wins it back
    const better = this.order.find((p) => rank(p) < rank(next) && ok(p) && settled(p));
    if (better) next = better;
    if (next === this.current) return null;
    const from = this.current;
    const why = next === null ? `no usable provider (${this.order.map((p) => `${p}: ${this.health.state(p).reason ?? "?"}`).join("; ")})`
      : from === null ? `${next} is usable again`
      : rank(next) < rank(from) ? `${next} healthy for ${this.cfg.switch_back_after_healthy_s}s`
      : `${from}: ${this.health.state(from).reason ?? "unhealthy"}`;
    this.current = next;
    const s: Switch = { job: this.job, from, to: next, reason: why, at: now };
    this.onSwitch(s);
    return s;
  }
}
