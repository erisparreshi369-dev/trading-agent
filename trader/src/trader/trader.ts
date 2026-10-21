import { existsSync, statSync } from "node:fs";
import type { Config } from "../lib/config.js";
import { heartbeat, type DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import { PaperEngine } from "../paper/engine.js";
import { ShadowBook } from "../paper/shadow.js";
import { RiskManager } from "../risk/risk-manager.js";
import { limitsFor } from "../risk/limits.js";
import { SignalEngine, type LeaderTrade } from "../signals/engine.js";
import type { TokenInfoSource } from "../signals/token-info.js";

export const SERVICE = "trader";
/** A tracked wallet's buy older than this when we read it is stale news: don't act on it. */
const MAX_SIGNAL_AGE_MS = 5_000;

/**
 * The trading loop. The collector is the only thing talking to the chain's streams; this reads
 * what it writes. SQLite is the bus: restart-safe, nothing lost if either side restarts.
 */
export class Trader {
  readonly paper: PaperEngine;
  readonly risk: RiskManager;
  readonly signals: SignalEngine;
  readonly shadow: ShadowBook;
  private cursor = 0;
  private tracked = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  readonly stats = { tradesSeen: 0, leaderBuys: 0, staleSkipped: 0, signals: 0, entered: 0, errors: 0 };

  constructor(
    private db: DB,
    private cfg: Config,
    info: TokenInfoSource,
    killFile: string,
    private now: () => number = Date.now,
  ) {
    // paper trading: the owner's limits, re-read at every check (limits.ts); the Phase 5 live executor must use limitsFor("live", db)
    this.risk = new RiskManager(db, killFile, now, () => limitsFor("paper", db));
    this.paper = new PaperEngine(db, cfg.paper, this.risk, now);
    this.signals = new SignalEngine(db, cfg.signals, info, this.paper, now);
    this.shadow = new ShadowBook(db, cfg, now);
    this.signals.setObserver(this.shadow);
  }

  start(): void {
    this.paper.init();
    const saved = this.db.prepare("SELECT value FROM kv WHERE key = 'trader.cursor'").get() as { value: string } | undefined;
    // first start: begin at the head; never replay old history as if it were live
    this.cursor = saved ? Number(saved.value) : ((this.db.prepare("SELECT COALESCE(MAX(id), 0) m FROM trades").get() as { m: number }).m);
    this.loadTracked();
    const backfilled = this.shadow.backfill();
    if (backfilled) log.info({ signals: backfilled, variants: this.shadow.variants.length }, "shadow variants backfilled");
    this.timers.push(
      setInterval(() => this.safe(() => this.poll()), 200),
      setInterval(() => this.safe(() => this.paper.tick()), 250),
      setInterval(() => this.loadTracked(), 30_000),
      setInterval(() => this.safe(() => this.shadow.settle()), 30_000),
      setInterval(() => this.beat(), 30_000),
    );
    this.beat();
    log.info({ cursor: this.cursor, tracked: this.tracked.size, mode: "paper" }, "trader started");
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.queue;
    this.beat();
  }

  /** Process every trade the collector wrote since last time. */
  poll(): number {
    const rows = this.db.prepare("SELECT * FROM trades WHERE id > ? ORDER BY id LIMIT 2000").all(this.cursor) as LeaderTrade[];
    for (const t of rows) {
      this.stats.tradesSeen++;
      this.paper.onTrade(t);
      if (t.is_buy && this.tracked.has(t.wallet)) {
        this.stats.leaderBuys++;
        if (this.now() - t.received_at > MAX_SIGNAL_AGE_MS) {
          this.stats.staleSkipped++;
          continue;
        }
        // one evaluation at a time: entries must see each other's effect on balance/positions
        this.queue = this.queue.then(() => this.signals.evaluate(t)).then(
          (r) => {
            this.stats.signals++;
            if (r.decision === "enter") this.stats.entered++;
          },
          (err) => {
            this.stats.errors++;
            log.error({ err: String(err), mint: t.mint }, "signal evaluation failed");
          },
        );
      }
    }
    if (rows.length) {
      this.cursor = rows[rows.length - 1]!.id;
      this.db.prepare("INSERT INTO kv (key, value) VALUES ('trader.cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(this.cursor));
    }
    return rows.length;
  }

  /** The dashboard changed a limit in cfg (lib/overrides.ts): rebuild what copied it at start. */
  settingsChanged(): void {
    this.shadow.reload();
  }

  /** Wait for queued signal evaluations (tests). */
  idle(): Promise<unknown> {
    return this.queue;
  }

  private loadTracked(): void {
    const rows = this.db.prepare("SELECT wallet FROM tracked_wallets WHERE active = 1").all() as { wallet: string }[];
    this.tracked = new Set(rows.map((r) => r.wallet));
  }

  private safe(fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      // a DB error here is not recoverable in-process; let systemd restart us
      log.fatal({ err: err instanceof Error ? err.stack : String(err) }, "trader loop failed");
      throw err;
    }
  }

  summary() {
    const { balance, start } = this.paper.account();
    const equity = this.paper.equity();
    const dayStart = Date.parse(new Date(this.now()).toISOString().slice(0, 10));
    const today = this.db.prepare(`SELECT COALESCE(SUM(pnl_sol), 0) pnl, count(*) n, SUM(pnl_sol > 0) wins FROM paper_positions
      WHERE status IN ('closed', 'failed') AND closed_at >= ?`).get(dayStart) as { pnl: number; n: number; wins: number | null };
    return {
      mode: "paper", balance: +balance.toFixed(5), equity: +equity.toFixed(5), start, totalPnl: +(equity - start).toFixed(5),
      todayRealized: +today.pnl.toFixed(5), todayClosed: today.n, todayWins: today.wins ?? 0,
      live: this.paper.live().length, tracked: this.tracked.size, killed: this.risk.isKilled().killed, haltedToday: this.risk.haltedToday(),
    };
  }

  private beat(): void {
    this.logDbSize();
    heartbeat(this.db, SERVICE, { ...this.stats, ...this.summary(), shadow: this.shadow.stats, rss_mb: Math.round(process.memoryUsage().rss / 1e6) });
  }

  /** Latest database size per UTC day (db + wal): disk growth per day for reports. */
  private logDbSize(): void {
    const file = this.db.name;
    if (!file || file === ":memory:") return;
    const size = [file, `${file}-wal`].reduce((a, f) => a + (existsSync(f) ? statSync(f).size : 0), 0);
    const now = this.now();
    this.db.prepare(`INSERT INTO db_size_log (day, bytes, ts) VALUES (?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET bytes = excluded.bytes, ts = excluded.ts`).run(new Date(now).toISOString().slice(0, 10), size, now);
  }
}
