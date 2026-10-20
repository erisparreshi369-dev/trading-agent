import type { CollectorConfig } from "../lib/config.js";
import { heartbeat, type DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import { ReconnectingWs } from "../lib/reconnecting-ws.js";
import { BarAggregator } from "./bars.js";
import { HolderChecker } from "./holder-checks.js";
import { eventsFromLogs, isSolQuoted, priceSol, PUMP_PROGRAM, type PumpEvent } from "./pump-events.js";
import { Store } from "./store.js";

export const SERVICE = "collector";
const PUMPPORTAL_URL = "wss://pumpportal.fun/api/data";

export interface CollectorDeps {
  db: DB;
  cfg: CollectorConfig;
  heliusApiKey?: string;
  /** Overridable for tests. */
  heliusWsUrl?: string;
  pumpportalUrl?: string;
  now?: () => number;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class Collector {
  private store: Store;
  private bars: BarAggregator;
  private holders?: HolderChecker;
  private helius?: ReconnectingWs;
  private pumpportal?: ReconnectingWs;
  private timers: NodeJS.Timeout[] = [];
  private openGaps = new Map<string, number>();
  private usage = new Map<string, { messages: number; bytes: number }>();
  private heliusBytesToday = 0;
  private usageDay: string;
  private heliusPausedForCap = false;
  readonly stats = { heliusTx: 0, trades: 0, creates: 0, completes: 0, ppCreates: 0, ppMigrations: 0, nonSolSkipped: 0, decodeErrors: 0, rowsWritten: 0 };
  private now: () => number;

  constructor(private d: CollectorDeps) {
    this.now = d.now ?? Date.now;
    this.store = new Store(d.db);
    this.bars = new BarAggregator(d.cfg.bars);
    this.usageDay = utcDay(this.now());
  }

  start(): void {
    const { db, cfg } = this.d;
    this.recordRestartGap();
    this.heliusBytesToday =
      (db.prepare("SELECT bytes FROM stream_usage WHERE day = ? AND source = 'helius'").get(this.usageDay) as { bytes: number } | undefined)?.bytes ?? 0;

    if (cfg.helius_firehose) {
      if (!this.d.heliusApiKey && !this.d.heliusWsUrl) {
        log.warn("HELIUS_API_KEY not set: trade firehose disabled, only new tokens/migrations will be collected");
      } else {
        const key = this.d.heliusApiKey ?? "";
        this.helius = this.makeStream("helius", this.d.heliusWsUrl ?? `wss://mainnet.helius-rpc.com/?api-key=${key}`, () => [
          { jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "confirmed" }] },
        ]);
        this.helius.on("message", (raw: string) => this.onHelius(raw));
        if (this.heliusBytesToday >= cfg.helius_daily_mb_cap * 1e6) this.pauseHeliusForCap();
        else this.helius.start();
        if (this.d.heliusApiKey && cfg.holder_checks.enabled) {
          this.holders = new HolderChecker(db, `https://mainnet.helius-rpc.com/?api-key=${key}`, cfg.holder_checks, (m) => this.bars.tradeCount(m));
          this.holders.start();
        }
      }
    }
    if (cfg.pumpportal_streams) {
      this.pumpportal = this.makeStream("pumpportal", this.d.pumpportalUrl ?? PUMPPORTAL_URL, () => [
        { method: "subscribeNewToken" },
        { method: "subscribeMigration" },
      ]);
      this.pumpportal.on("message", (raw: string) => this.onPumpPortal(raw));
      this.pumpportal.start();
    }

    this.timers.push(
      setInterval(() => this.flush(), 250),
      setInterval(() => this.store.addBars(this.bars.flush(this.now())), 1_000),
      setInterval(() => this.beat(), cfg.heartbeat_s * 1000),
      setInterval(() => this.prune(), 3_600_000),
    );
    this.beat();
    log.info({ firehose: !!this.helius, pumpportal: !!this.pumpportal, holderChecks: !!this.holders }, "collector started");
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.helius?.stop();
    this.pumpportal?.stop();
    this.holders?.stop();
    this.store.addBars(this.bars.flush(Number.MAX_SAFE_INTEGER));
    this.flush();
    this.persistUsage();
    log.info(this.stats, "collector stopped");
  }

  /** Exposed for health checks/tests. */
  get streams() {
    return { helius: this.helius?.up ?? null, pumpportal: this.pumpportal?.up ?? null, heliusPausedForCap: this.heliusPausedForCap };
  }

  private makeStream(name: string, url: string, subs: () => unknown[]): ReconnectingWs {
    const ws = new ReconnectingWs({ name, url, onOpenMessages: subs, staleMs: this.d.cfg.stale_stream_s * 1000 });
    ws.on("message", (_raw: string, bytes: number) => this.meter(name, bytes));
    ws.on("up", () => this.closeGap(name));
    ws.on("down", (reason: string) => this.openGap(name, reason));
    return ws;
  }

  // ---- helius firehose ----

  private onHelius(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.method !== "logsNotification") {
      if (msg.error) log.error({ error: msg.error }, "helius subscription error");
      else if (msg.result !== undefined && msg.id === 1) log.info({ sub: msg.result }, "helius logsSubscribe ok");
      return;
    }
    const v = msg.params?.result?.value;
    const slot: number | null = msg.params?.result?.context?.slot ?? null;
    if (!v || v.err || !Array.isArray(v.logs)) return;
    this.stats.heliusTx++;
    const receivedAt = this.now();
    let events: PumpEvent[];
    try {
      events = eventsFromLogs(v.logs);
    } catch {
      this.stats.decodeErrors++;
      return;
    }
    events.forEach((ev, i) => this.onPumpEvent(ev, v.signature, i, slot, receivedAt));
  }

  private onPumpEvent(ev: PumpEvent, signature: string, evIndex: number, slot: number | null, receivedAt: number): void {
    if (ev.kind === "create") {
      this.stats.creates++;
      const createdAt = ev.timestamp ? ev.timestamp * 1000 : receivedAt;
      this.store.addToken({
        mint: ev.mint, name: ev.name, symbol: ev.symbol, uri: ev.uri, creator: ev.creator ?? ev.user,
        bonding_curve: ev.bondingCurve, token_program: ev.tokenProgram, quote_mint: ev.quoteMint, created_slot: slot,
        created_at: createdAt, first_seen_at: receivedAt, create_signature: signature,
        is_mayhem_mode: ev.isMayhemMode === null ? null : Number(ev.isMayhemMode), source: "helius",
      });
      if (isSolQuoted(ev.quoteMint)) {
        this.bars.addToken(ev.mint, createdAt, ev.creator ?? ev.user);
        this.holders?.track(ev.mint, ev.bondingCurve, ev.tokenProgram, createdAt);
      }
    } else if (ev.kind === "trade") {
      if (!isSolQuoted(ev.quoteMint)) {
        this.stats.nonSolSkipped++;
        return;
      }
      this.stats.trades++;
      const price = priceSol(ev.vSol, ev.vToken);
      const ts = ev.timestamp * 1000;
      this.store.addTrade({
        signature, ev_index: evIndex, slot, block_time: ts, received_at: receivedAt, mint: ev.mint, wallet: ev.user,
        is_buy: ev.isBuy ? 1 : 0, sol_lamports: ev.solLamports, token_amount: ev.tokenAmount, v_sol_reserves: ev.vSol,
        v_token_reserves: ev.vToken, real_sol_reserves: ev.realSol, real_token_reserves: ev.realToken, fee_lamports: ev.fee,
        creator_fee_lamports: ev.creatorFee, price_sol: price, is_dev: ev.creator !== null && ev.creator === ev.user ? 1 : 0,
        ix_name: ev.ixName, source: "helius",
      });
      // Bars use receive time: on-chain timestamps are whole seconds, too coarse for 5s buckets.
      this.store.addBars(this.bars.onTrade({
        mint: ev.mint, wallet: ev.user, isBuy: ev.isBuy, solLamports: ev.solLamports, tokenAmount: ev.tokenAmount,
        vSol: ev.vSol, price, ts: receivedAt,
      }));
    } else {
      this.stats.completes++;
      this.store.markCompleted(ev.mint, ev.timestamp * 1000);
    }
  }

  // ---- pumpportal (free streams) ----

  private onPumpPortal(raw: string): void {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const now = this.now();
    if (m.txType === "create" && typeof m.mint === "string") {
      this.stats.ppCreates++;
      this.store.addToken({
        mint: m.mint, name: m.name, symbol: m.symbol, uri: m.uri, creator: m.traderPublicKey,
        bonding_curve: m.bondingCurveKey, created_at: now, first_seen_at: now, create_signature: m.signature,
        initial_buy_lamports: typeof m.solAmount === "number" ? BigInt(Math.round(m.solAmount * 1e9)) : null,
        initial_buy_tokens: typeof m.initialBuy === "number" ? BigInt(Math.round(m.initialBuy * 1e6)) : null,
        is_mayhem_mode: typeof m.is_mayhem_mode === "boolean" ? Number(m.is_mayhem_mode) : null,
        source: "pumpportal",
      });
      // Without the firehose this is our only token source; still build bars if trades arrive later.
      this.bars.addToken(m.mint, now, m.traderPublicKey ?? null);
    } else if (m.txType === "migrate" && typeof m.mint === "string") {
      this.stats.ppMigrations++;
      this.flush(); // make sure the token row exists before updating it
      this.store.markMigrated(m.mint, now, m.pool ?? null);
    } else if (m.message) {
      log.info({ pumpportal: m.message }, "pumpportal");
    } else if (m.errors) {
      log.error({ pumpportal: m.errors }, "pumpportal error");
    }
  }

  // ---- bookkeeping ----

  private flush(): void {
    try {
      this.stats.rowsWritten += this.store.flush();
    } catch (err) {
      // A failed batch is lost; crash so systemd restarts us clean rather than limping on.
      log.fatal({ err: String(err) }, "db write failed");
      throw err;
    }
  }

  private meter(source: string, bytes: number): void {
    const day = utcDay(this.now());
    if (day !== this.usageDay) {
      this.persistUsage();
      this.usageDay = day;
      this.heliusBytesToday = 0;
      if (this.heliusPausedForCap) this.resumeHelius();
    }
    const u = this.usage.get(source) ?? { messages: 0, bytes: 0 };
    u.messages++;
    u.bytes += bytes;
    this.usage.set(source, u);
    if (source === "helius") {
      this.heliusBytesToday += bytes;
      if (!this.heliusPausedForCap && this.heliusBytesToday >= this.d.cfg.helius_daily_mb_cap * 1e6) this.pauseHeliusForCap();
    }
  }

  private pauseHeliusForCap(): void {
    this.heliusPausedForCap = true;
    this.openGap("helius", "daily MB cap reached"); // before stop(), whose 'down' would log a generic reason
    this.helius?.stop();
    const now = this.now();
    const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
    log.warn({ capMb: this.d.cfg.helius_daily_mb_cap, resumeAt: new Date(midnight).toISOString() }, "helius firehose paused: daily cap");
    this.timers.push(setTimeout(() => this.resumeHelius(), midnight - now + 1_000));
  }

  private resumeHelius(): void {
    if (!this.heliusPausedForCap) return;
    if (utcDay(this.now()) === this.usageDay && this.heliusBytesToday > 0) {
      // day hasn't rolled in the meter yet; reset explicitly
      this.persistUsage();
      this.usageDay = utcDay(this.now());
      this.heliusBytesToday = 0;
    }
    this.heliusPausedForCap = false;
    log.info("helius firehose resuming after daily cap");
    this.helius?.start();
  }

  private persistUsage(): void {
    const st = this.d.db.prepare(`INSERT INTO stream_usage (day, source, messages, bytes) VALUES (?, ?, ?, ?)
      ON CONFLICT(day, source) DO UPDATE SET messages = messages + excluded.messages, bytes = bytes + excluded.bytes`);
    for (const [source, u] of this.usage) st.run(this.usageDay, source, u.messages, u.bytes);
    this.usage.clear();
  }

  private openGap(source: string, reason: string): void {
    if (this.openGaps.has(source)) return;
    const id = this.d.db.prepare("INSERT INTO collector_gaps (source, started_at, reason) VALUES (?, ?, ?)").run(source, this.now(), reason).lastInsertRowid;
    this.openGaps.set(source, Number(id));
  }

  private closeGap(source: string): void {
    const id = this.openGaps.get(source);
    if (id === undefined) return;
    this.d.db.prepare("UPDATE collector_gaps SET ended_at = ? WHERE id = ?").run(this.now(), id);
    this.openGaps.delete(source);
  }

  /** The time between our last heartbeat and now (crash/reboot) is a gap in every stream. */
  private recordRestartGap(): void {
    const db = this.d.db;
    const now = this.now();
    db.prepare("UPDATE collector_gaps SET ended_at = ? WHERE ended_at IS NULL").run(now);
    const last = db.prepare("SELECT ts FROM service_heartbeats WHERE service = ?").get(SERVICE) as { ts: number } | undefined;
    if (last) db.prepare("INSERT INTO collector_gaps (source, started_at, ended_at, reason) VALUES ('all', ?, ?, 'collector restart')").run(last.ts, now);
  }

  private beat(): void {
    this.persistUsage();
    heartbeat(this.d.db, SERVICE, {
      ...this.stats, streams: this.streams, liveTokens: this.bars.size, heliusMbToday: +(this.heliusBytesToday / 1e6).toFixed(1),
      holderChecks: this.holders?.stats ?? null, rss_mb: Math.round(process.memoryUsage().rss / 1e6),
    });
  }

  /** Drop old raw data in small chunks so the writer never holds the lock for long. */
  private prune(): void {
    const { db, cfg } = this.d;
    const tradeCutoff = this.now() - cfg.retention.raw_trades_days * 86_400_000;
    const holderCutoff = this.now() - cfg.retention.holders_days * 86_400_000;
    const delTrades = db.prepare(`DELETE FROM trades WHERE id IN (SELECT id FROM trades WHERE received_at < ?
      AND wallet NOT IN (SELECT wallet FROM tracked_wallets) LIMIT 20000)`);
    const delHolders = db.prepare(`DELETE FROM token_holders WHERE rowid IN (SELECT rowid FROM token_holders WHERE updated_at < ? LIMIT 20000)`);
    const drain = (run: () => number) => {
      let total = 0;
      for (let n = run(); n > 0; n = run()) total += n;
      return total;
    };
    const trades = drain(() => delTrades.run(tradeCutoff).changes);
    const holders = drain(() => delHolders.run(holderCutoff).changes);
    if (trades || holders) log.info({ trades, holders }, "pruned old rows");
  }
}
