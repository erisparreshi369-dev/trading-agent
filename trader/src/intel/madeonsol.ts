import { raiseAlert } from "../lib/alerts.js";
import type { MadeOnSolConfig } from "../lib/config.js";
import type { DB } from "../lib/db.js";
import { log, registerSecret, scrubSecrets } from "../lib/log.js";

export const PROVIDER = "madeonsol";
const SOURCE = "intel";
/** The dashboard's override of where the daily job stops (kv), set until changed back. */
export const STOP_OVERRIDE_KEY = "override.madeonsol_stop_pct";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const dayStart = (ms: number) => ms - (ms % 86_400_000);

/**
 * The only way anything talks to MadeOnSol. Every request is counted against the daily budget
 * (ours and theirs, whichever is higher), has a timeout, and is logged in intel_requests.
 * It never throws: any failure, timeout or used-up budget returns null, and callers carry on
 * without the data. The key is registered with the log scrubber and never stored or printed.
 */
export class MadeOnSol {
  private minute: number[] = [];

  constructor(
    private db: DB,
    private cfg: MadeOnSolConfig,
    private key: string,
    private now: () => number = Date.now,
    private fetchFn: Fetch = fetch as unknown as Fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    registerSecret(key);
  }

  /** Requests counted today: our own log, or MadeOnSol's count if it says more (e.g. your manual tests). */
  usedToday(): number {
    const r = this.db.prepare("SELECT count(*) n, MAX(remote_used) remote FROM intel_requests WHERE provider = ? AND ts >= ?")
      .get(PROVIDER, dayStart(this.now())) as { n: number; remote: number | null };
    return Math.max(r.n, r.remote ?? 0);
  }

  /** Where the job stops: config stop_pct, or the dashboard's override (1-100%; 100% = all of MadeOnSol's daily requests). */
  get stopPct(): number {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(STOP_OVERRIDE_KEY) as { value: string } | undefined;
    const v = row ? Number(row.value) : NaN;
    return Number.isFinite(v) && v >= 1 && v <= 100 ? v : this.cfg.stop_pct;
  }

  get stopAt(): number {
    return Math.floor((this.cfg.daily_requests * this.stopPct) / 100);
  }

  canRequest(): boolean {
    return this.usedToday() < this.stopAt;
  }

  /** GET/POST `path` (relative to base_url). Returns the parsed JSON, or null on any problem. */
  async request(path: string, body?: unknown, items = 0): Promise<any | null> {
    if (!this.canRequest()) return null;
    await this.pace();
    const endpoint = path.split("?")[0]!;
    const t0 = this.now();
    let status: number | null = null;
    let remoteUsed: number | null = null;
    let error: string | null = null;
    let result: unknown = null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeout_s * 1000);
    try {
      const res = await this.fetchFn(`${this.cfg.base_url}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${this.key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), Accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ctl.signal,
      });
      status = res.status;
      const used = Number(res.headers.get("x-ratelimit-used"));
      if (Number.isFinite(used) && res.headers.get("x-ratelimit-used") !== null) remoteUsed = used;
      if (res.status === 429) remoteUsed = this.cfg.daily_requests; // out of requests for today
      if (!res.ok) error = `http ${res.status}`;
      else result = await res.json();
    } catch (err) {
      error = ctl.signal.aborted ? `timeout after ${this.cfg.timeout_s}s` : String(err);
    } finally {
      clearTimeout(timer);
    }
    const ok = error === null;
    this.db.prepare(`INSERT INTO intel_requests (ts, provider, endpoint, ok, status, ms, items, error, remote_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t0, PROVIDER, endpoint, ok ? 1 : 0, status, this.now() - t0, items, error ? scrubSecrets(error).slice(0, 300) : null, remoteUsed);
    if (!ok) log.warn({ endpoint, status, error: error && scrubSecrets(error) }, "madeonsol request failed (the bot carries on without it)");
    this.warnBudget();
    return ok ? result : null;
  }

  /** Stay under the per-minute limit. */
  private async pace(): Promise<void> {
    const now = this.now();
    this.minute = this.minute.filter((t) => now - t < 60_000);
    if (this.minute.length >= this.cfg.per_minute) await this.sleep(60_000 - (now - this.minute[0]!) + 50);
    this.minute.push(this.now());
  }

  /** One Telegram message per step per UTC day: at warn_pct, at stop_pct (the job stops), and when out. */
  private warnBudget(): void {
    const used = this.usedToday();
    const limit = this.cfg.daily_requests;
    const pct = used >= limit ? 100 : used >= this.stopAt ? this.stopPct : (used / limit) * 100 >= this.cfg.warn_pct ? this.cfg.warn_pct : 0;
    if (!pct) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const key = "madeonsol.warned";
    const prev = (this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value.split(":");
    if (prev && prev[0] === day && Number(prev[1]) >= pct) return;
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, `${day}:${pct}`);
    raiseAlert(this.db, { kind: "madeonsol_budget", source: SOURCE, level: pct >= 100 ? "warn" : "info", text: `MadeOnSol: ${used} of ${limit} requests used today`,
      data: { pct, used, limit, stopAt: this.stopAt } }, this.now());
  }
}
