import type { CollectorConfig } from "../lib/config.js";
import { heartbeat, type DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import { ReconnectingWs } from "../lib/reconnecting-ws.js";
import { decodeAmmEvent, PUMPSWAP_PROGRAM, type AmmTradeEvent } from "./amm-events.js";
import { BarAggregator } from "./bars.js";
import { HolderChecker } from "./holder-checks.js";
import { bondingCurve, canonicalPool } from "./pools.js";
import { DEFAULT_PUBKEY, eventsFromLogs, isSolQuoted, priceSol, PUMP_PROGRAM, WSOL_MINT, type PumpEvent } from "./pump-events.js";
import { Store } from "./store.js";
import { TargetedSubscriptions, type WatchTarget } from "./targeted.js";

export const SERVICE = "collector";
const PUMPPORTAL_URL = "wss://pumpportal.fun/api/data";
const HELIUS_SOURCES = ["helius", "firehose", "targeted"];

export interface CollectorDeps {
  db: DB;
  cfg: CollectorConfig;
  heliusApiKey?: string;
  /** Overridable for tests. */
  firehoseUrl?: string;
  targetedUrl?: string;
  pumpportalUrl?: string;
  now?: () => number;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class Collector {
  private store: Store;
  private bars: BarAggregator;
  private holders?: HolderChecker;
  private firehose?: ReconnectingWs;
  private targetedWs?: ReconnectingWs;
  private targeted?: TargetedSubscriptions;
  private pumpportal?: ReconnectingWs;
  private firehoseRunning = false;
  private firehoseOffReason: string | null = null;
  private targetedRunning = false;
  private timers: NodeJS.Timeout[] = [];
  private openGaps = new Map<string, number>();
  private usage = new Map<string, { messages: number; bytes: number }>();
  private heliusBytesToday = 0;
  private usageDay: string;
  private trackedWallets = new Set<string>();
  private poolToMint = new Map<string, string>();
  private creatorCache = new Map<string, string | null>();
  private lastWatched = new Map<string, number>();
  private seen = [new Set<string>(), new Set<string>()];
  readonly stats = {
    notifications: 0, duplicates: 0, trades: 0, ammTrades: 0, ammUnknownPool: 0, creates: 0, completes: 0, migrations: 0,
    ppCreates: 0, ppMigrations: 0, nonSolSkipped: 0, decodeErrors: 0, rowsWritten: 0,
  };
  private now: () => number;

  constructor(private d: CollectorDeps) {
    this.now = d.now ?? Date.now;
    this.store = new Store(d.db);
    this.bars = new BarAggregator(d.cfg.bars);
    this.usageDay = utcDay(this.now());
  }

  private get hasHelius(): boolean {
    return !!(this.d.heliusApiKey || this.d.firehoseUrl || this.d.targetedUrl);
  }

  start(): void {
    const { db, cfg } = this.d;
    this.recordRestartGap();
    this.loadTrackedWallets();
    this.loadPools();
    this.heliusBytesToday = (db.prepare(
      `SELECT COALESCE(SUM(bytes), 0) b FROM stream_usage WHERE day = ? AND source IN (${HELIUS_SOURCES.map(() => "?").join(",")})`,
    ).get(this.usageDay, ...HELIUS_SOURCES) as { b: number }).b;

    const key = this.d.heliusApiKey ?? "";
    const heliusWs = `wss://mainnet.helius-rpc.com/?api-key=${key}`;
    if (!this.hasHelius) {
      log.warn("HELIUS_API_KEY not set: only new tokens and migrations (PumpPortal) will be collected");
    } else {
      if (cfg.firehose.enabled) {
        this.firehose = this.makeStream("firehose", this.d.firehoseUrl ?? heliusWs, cfg.stale_stream_s * 1000, () => [
          { jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "confirmed" }] },
        ]);
        this.firehose.on("message", (raw: string) => this.onHelius(raw, "firehose"));
      }
      if (cfg.targeted.enabled) {
        // Targeted subscriptions can be quiet for a long time; only reconnect on real silence.
        this.targetedWs = this.makeStream("targeted", this.d.targetedUrl ?? heliusWs, 15 * 60_000, () => this.targeted!.openMessages());
        this.targeted = new TargetedSubscriptions(this.targetedWs, cfg.targeted.max_subscriptions);
        this.targetedWs.on("message", (raw: string) => this.onHelius(raw, "targeted"));
      }
      if (this.d.heliusApiKey && cfg.holder_checks.enabled) {
        this.holders = new HolderChecker(db, `https://mainnet.helius-rpc.com/?api-key=${key}`, cfg.holder_checks, (m) => this.bars.tradeCount(m));
        this.holders.start();
      }
    }
    if (cfg.pumpportal_streams) {
      this.pumpportal = this.makeStream("pumpportal", this.d.pumpportalUrl ?? PUMPPORTAL_URL, cfg.stale_stream_s * 1000, () => [
        { method: "subscribeNewToken" },
        { method: "subscribeMigration" },
      ]);
      this.pumpportal.on("message", (raw: string) => this.onPumpPortal(raw));
      this.pumpportal.start();
    }

    this.schedule();
    this.timers.push(
      setInterval(() => this.flush(), 250),
      setInterval(() => this.store.addBars(this.bars.flush(this.now())), 1_000),
      setInterval(() => this.reconcileTargets(), 2_000),
      setInterval(() => this.schedule(), 5_000),
      setInterval(() => this.loadTrackedWallets(), 30_000),
      setInterval(() => this.rotateSeen(), 60_000),
      setInterval(() => this.beat(), cfg.heartbeat_s * 1000),
      setInterval(() => this.prune(), 3_600_000),
    );
    this.beat();
    log.info({ firehose: !!this.firehose, targeted: !!this.targeted, pumpportal: !!this.pumpportal, holderChecks: !!this.holders }, "collector started");
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.firehose?.stop();
    this.targetedWs?.stop();
    this.pumpportal?.stop();
    this.holders?.stop();
    this.store.addBars(this.bars.flush(Number.MAX_SAFE_INTEGER));
    this.flush();
    this.persistUsage();
    log.info(this.stats, "collector stopped");
  }

  /** Exposed for health checks/tests. */
  get streams() {
    return {
      firehose: this.firehose ? (this.firehoseRunning ? this.firehose.up : null) : null,
      firehoseOff: this.firehoseOffReason,
      targeted: this.targetedWs ? (this.targetedRunning ? this.targetedWs.up : null) : null,
      targetedSubs: this.targeted?.size ?? 0,
      pumpportal: this.pumpportal?.up ?? null,
    };
  }

  private makeStream(name: string, url: string, staleMs: number, subs: () => unknown[]): ReconnectingWs {
    const ws = new ReconnectingWs({ name, url, onOpenMessages: subs, staleMs });
    ws.on("message", (_raw: string, bytes: number) => this.meter(name, bytes));
    ws.on("up", () => this.closeGap(name));
    ws.on("down", (reason: string) => this.openGap(name, reason));
    return ws;
  }

  // ---- budget + schedule ----

  /** Decide which Helius streams should run, given the hour and today's spend. */
  private schedule(): void {
    const { cfg } = this.d;
    const mb = this.heliusBytesToday / 1e6;
    const hour = new Date(this.now()).getUTCHours();
    const [h0, h1] = cfg.firehose.hours_utc;
    const inHours = h0 <= h1 ? hour >= h0 && hour < h1 : hour >= h0 || hour < h1;

    if (this.firehose) {
      const off = !inHours ? "off-hours" : mb >= cfg.helius.daily_mb_cap - cfg.helius.targeted_reserve_mb ? "daily budget used" : null;
      if (!off && !this.firehoseRunning) {
        this.firehoseRunning = true;
        this.firehoseOffReason = null;
        log.info({ mbToday: Math.round(mb) }, "firehose on");
        this.firehose.start();
      } else if (off && (this.firehoseRunning || this.firehoseOffReason === null)) {
        if (this.firehoseRunning) log.info({ reason: off, mbToday: Math.round(mb) }, "firehose off");
        this.openGap("firehose", off); // before stop(): its 'down' would record a generic reason
        this.firehoseRunning = false;
        this.firehoseOffReason = off;
        this.firehose.stop();
      }
    }
    if (this.targetedWs) {
      const capped = mb >= cfg.helius.daily_mb_cap;
      if (!capped && !this.targetedRunning) {
        this.targetedRunning = true;
        this.targetedWs.start();
      } else if (capped && this.targetedRunning) {
        log.error({ mbToday: Math.round(mb) }, "Helius daily cap reached: targeted streams paused, following is OFF until 00:00 UTC");
        this.openGap("targeted", "daily cap reached");
        this.targetedRunning = false;
        this.targetedWs.stop();
      }
    }
  }

  /** Reload tracked wallets and resync targeted subscriptions now (normally on timers). */
  syncTargets(): void {
    this.loadTrackedWallets();
    this.reconcileTargets();
  }

  private reconcileTargets(): void {
    if (!this.targeted) return;
    const rows = this.d.db.prepare("SELECT address, priority FROM watchlist WHERE until > ?").all(this.now()) as WatchTarget[];
    const wallets = [...this.trackedWallets].map((address) => ({ address, priority: 0 }));
    this.targeted.reconcile([...wallets, ...rows]);
  }

  // ---- helius (firehose + targeted) ----

  private onHelius(raw: string, source: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.method !== "logsNotification") {
      if (source === "targeted" && this.targeted?.onReply(msg)) return;
      if (msg.error) log.error({ source, error: msg.error }, "helius error");
      else if (msg.id === 1) log.info({ source, sub: msg.result }, "logsSubscribe ok");
      return;
    }
    const v = msg.params?.result?.value;
    const slot: number | null = msg.params?.result?.context?.slot ?? null;
    if (!v || v.err || !Array.isArray(v.logs)) return;
    this.stats.notifications++;
    // the same tx arrives via the firehose and any targeted subscription that mentions it
    if (this.seen[0]!.has(v.signature) || this.seen[1]!.has(v.signature)) {
      this.stats.duplicates++;
      return;
    }
    this.seen[0]!.add(v.signature);
    const receivedAt = this.now();
    let pump: PumpEvent[];
    let amm: AmmTradeEvent[];
    try {
      pump = eventsFromLogs(v.logs);
      amm = eventsFromLogs(v.logs, PUMPSWAP_PROGRAM, decodeAmmEvent);
    } catch {
      this.stats.decodeErrors++;
      return;
    }
    // ev_index must be stable for a tx regardless of which stream delivered it: pump first, then amm
    pump.forEach((ev, i) => this.onPumpEvent(ev, v.signature, i, slot, receivedAt));
    amm.forEach((ev, i) => this.onAmmEvent(ev, v.signature, pump.length + i, slot, receivedAt));
  }

  private onPumpEvent(ev: PumpEvent, signature: string, evIndex: number, slot: number | null, receivedAt: number): void {
    if (ev.kind === "create") {
      this.stats.creates++;
      const createdAt = ev.timestamp ? ev.timestamp * 1000 : receivedAt;
      const creator = ev.creator ?? ev.user;
      this.creatorCache.set(ev.mint, creator);
      this.store.addToken({
        mint: ev.mint, name: ev.name, symbol: ev.symbol, uri: ev.uri, creator,
        bonding_curve: ev.bondingCurve, token_program: ev.tokenProgram, quote_mint: ev.quoteMint, created_slot: slot,
        created_at: createdAt, first_seen_at: receivedAt, create_signature: signature,
        is_mayhem_mode: ev.isMayhemMode === null ? null : Number(ev.isMayhemMode), source: "helius",
      });
      if (isSolQuoted(ev.quoteMint)) {
        this.bars.addToken(ev.mint, createdAt, creator);
        this.holders?.track(ev.mint, ev.bondingCurve, ev.tokenProgram, createdAt);
      }
    } else if (ev.kind === "trade") {
      if (!isSolQuoted(ev.quoteMint)) {
        this.stats.nonSolSkipped++;
        return;
      }
      this.stats.trades++;
      const price = priceSol(ev.vSol, ev.vToken);
      this.store.addTrade({
        signature, ev_index: evIndex, slot, block_time: ev.timestamp * 1000, received_at: receivedAt, mint: ev.mint, wallet: ev.user,
        is_buy: ev.isBuy ? 1 : 0, sol_lamports: ev.solLamports, token_amount: ev.tokenAmount, v_sol_reserves: ev.vSol,
        v_token_reserves: ev.vToken, real_sol_reserves: ev.realSol, real_token_reserves: ev.realToken, fee_lamports: ev.fee,
        creator_fee_lamports: ev.creatorFee, price_sol: price, is_dev: ev.creator !== null && ev.creator === ev.user ? 1 : 0,
        ix_name: ev.ixName, source: "helius", venue: "curve",
      });
      // Bars use receive time: on-chain timestamps are whole seconds, too coarse for 5s buckets.
      this.store.addBars(this.bars.onTrade({
        mint: ev.mint, wallet: ev.user, isBuy: ev.isBuy, solLamports: ev.solLamports, tokenAmount: ev.tokenAmount,
        vSol: ev.vSol, price, ts: receivedAt,
      }));
      if (this.trackedWallets.has(ev.user)) this.watchToken(ev.mint, bondingCurve(ev.mint), "curve");
    } else if (ev.kind === "complete") {
      this.stats.completes++;
      this.store.markCompleted(ev.mint, ev.timestamp * 1000);
    } else {
      this.stats.migrations++;
      const quote = !ev.quoteMint || ev.quoteMint === DEFAULT_PUBKEY ? WSOL_MINT : ev.quoteMint;
      this.onMigration(ev.mint, ev.pool, quote, ev.timestamp * 1000, "helius");
    }
  }

  private onAmmEvent(ev: AmmTradeEvent, signature: string, evIndex: number, slot: number | null, receivedAt: number): void {
    const mint = this.poolToMint.get(ev.pool);
    if (!mint) {
      this.stats.ammUnknownPool++; // a pool we never saw being created: not a token we track
      return;
    }
    this.stats.ammTrades++;
    const price = priceSol(ev.poolQuote, ev.poolBase);
    const creator = this.creatorOf(mint);
    this.store.addTrade({
      signature, ev_index: evIndex, slot, block_time: ev.timestamp * 1000, received_at: receivedAt, mint, wallet: ev.user,
      is_buy: ev.isBuy ? 1 : 0, sol_lamports: ev.quoteAmount, token_amount: ev.baseAmount, v_sol_reserves: ev.poolQuote,
      v_token_reserves: ev.poolBase, real_sol_reserves: null, real_token_reserves: null, fee_lamports: ev.fee,
      creator_fee_lamports: ev.creatorFee, price_sol: price, is_dev: creator === ev.user ? 1 : 0, ix_name: null,
      source: "helius", venue: "amm",
    });
    this.store.addBars(this.bars.onTrade({
      mint, wallet: ev.user, isBuy: ev.isBuy, solLamports: ev.quoteAmount, tokenAmount: ev.baseAmount, vSol: ev.poolQuote, price, ts: receivedAt,
    }));
    if (this.trackedWallets.has(ev.user)) this.watchToken(mint, ev.pool, "pool");
  }

  private onMigration(mint: string, pool: string, quoteMint: string, ts: number, source: string): void {
    this.store.markMigrated(mint, ts, "pump-amm");
    if (quoteMint !== WSOL_MINT) return;
    this.store.addPool(pool, mint, quoteMint, ts, source);
    this.poolToMint.set(pool, mint);
    this.flush(); // the holder/watch lookup below needs every pending trade written
    const interested = this.d.db.prepare(`
      SELECT 1 FROM watchlist WHERE mint = ? AND until > ?
      UNION ALL
      SELECT 1 FROM token_holders h JOIN tracked_wallets w ON w.wallet = h.wallet AND w.active = 1
      WHERE h.mint = ? AND h.balance > 0
      LIMIT 1`).get(mint, this.now(), mint);
    if (interested) {
      this.store.watch(pool, "pool", mint, this.now() + this.d.cfg.targeted.pool_watch_hours * 3_600_000, 2, "migrated with tracked holders");
    }
  }

  /** A tracked wallet traded this token: follow its curve/pool so we see exits and price. */
  private watchToken(mint: string, address: string, kind: "curve" | "pool"): void {
    const now = this.now();
    if (now - (this.lastWatched.get(address) ?? 0) < 60_000) return;
    this.lastWatched.set(address, now);
    this.store.watch(address, kind, mint, now + this.d.cfg.targeted.token_watch_minutes * 60_000, 2, "tracked wallet trade");
  }

  private creatorOf(mint: string): string | null {
    if (!this.creatorCache.has(mint)) {
      if (this.creatorCache.size > 50_000) this.creatorCache.clear();
      const row = this.d.db.prepare("SELECT creator FROM tokens WHERE mint = ?").get(mint) as { creator: string | null } | undefined;
      this.creatorCache.set(mint, row?.creator ?? null);
    }
    return this.creatorCache.get(mint) ?? null;
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
      if (typeof m.traderPublicKey === "string") this.creatorCache.set(m.mint, m.traderPublicKey);
      this.store.addToken({
        mint: m.mint, name: m.name, symbol: m.symbol, uri: m.uri, creator: m.traderPublicKey,
        bonding_curve: m.bondingCurveKey, created_at: now, first_seen_at: now, create_signature: m.signature,
        initial_buy_lamports: typeof m.solAmount === "number" ? BigInt(Math.round(m.solAmount * 1e9)) : null,
        initial_buy_tokens: typeof m.initialBuy === "number" ? BigInt(Math.round(m.initialBuy * 1e6)) : null,
        is_mayhem_mode: typeof m.is_mayhem_mode === "boolean" ? Number(m.is_mayhem_mode) : null,
        source: "pumpportal",
      });
      // Without the firehose this is our only token source; build bars if a watched token trades.
      this.bars.addToken(m.mint, now, m.traderPublicKey ?? null);
    } else if (m.txType === "migrate" && typeof m.mint === "string") {
      // The stream also reports other launchpads (e.g. raydium-cpmm); only pump-amm pools are ours.
      if (m.pool !== "pump-amm") return;
      this.stats.ppMigrations++;
      this.flush(); // make sure the token row exists before updating it
      this.onMigration(m.mint, canonicalPool(m.mint), WSOL_MINT, now, "pumpportal");
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

  private rotateSeen(): void {
    this.seen = [new Set(), this.seen[0]!];
  }

  private meter(source: string, bytes: number): void {
    const day = utcDay(this.now());
    if (day !== this.usageDay) {
      this.persistUsage();
      this.usageDay = day;
      this.heliusBytesToday = 0;
      this.schedule();
    }
    const u = this.usage.get(source) ?? { messages: 0, bytes: 0 };
    u.messages++;
    u.bytes += bytes;
    this.usage.set(source, u);
    if (HELIUS_SOURCES.includes(source)) {
      this.heliusBytesToday += bytes;
      // check the budget promptly: at full firehose speed 5s is ~2 MB
      if (u.messages % 200 === 0) this.schedule();
    }
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

  private loadTrackedWallets(): void {
    const rows = this.d.db.prepare("SELECT wallet FROM tracked_wallets WHERE active = 1").all() as { wallet: string }[];
    this.trackedWallets = new Set(rows.map((r) => r.wallet));
  }

  private loadPools(): void {
    const rows = this.d.db.prepare("SELECT pool, mint FROM pools WHERE created_at > ?").all(this.now() - 30 * 86_400_000) as { pool: string; mint: string }[];
    for (const r of rows) this.poolToMint.set(r.pool, r.mint);
  }

  private beat(): void {
    this.persistUsage();
    heartbeat(this.d.db, SERVICE, {
      ...this.stats, streams: this.streams, liveTokens: this.bars.size, heliusMbToday: +(this.heliusBytesToday / 1e6).toFixed(1),
      heliusCapMb: this.d.cfg.helius.daily_mb_cap, targetedStats: this.targeted?.stats ?? null, trackedWallets: this.trackedWallets.size,
      holderChecks: this.holders?.stats ?? null, rss_mb: Math.round(process.memoryUsage().rss / 1e6),
    });
  }

  /** Drop old raw data in small chunks so the writer never holds the lock for long. */
  prune(): void {
    const { db, cfg } = this.d;
    const tradeCutoff = this.now() - cfg.retention.raw_trades_days * 86_400_000;
    const holderCutoff = this.now() - cfg.retention.holders_days * 86_400_000;
    const delTrades = db.prepare(`DELETE FROM trades WHERE id IN (SELECT id FROM trades WHERE received_at < ?
      AND wallet NOT IN (SELECT wallet FROM tracked_wallets) LIMIT 20000)`);
    // token_holders is WITHOUT ROWID: delete by primary key
    const delHolders = db.prepare(`DELETE FROM token_holders WHERE (mint, wallet) IN
      (SELECT mint, wallet FROM token_holders WHERE updated_at < ? LIMIT 20000)`);
    const drain = (run: () => number) => {
      let total = 0;
      for (let n = run(); n > 0; n = run()) total += n;
      return total;
    };
    const trades = drain(() => delTrades.run(tradeCutoff).changes);
    const holders = drain(() => delHolders.run(holderCutoff).changes);
    const watch = db.prepare("DELETE FROM watchlist WHERE until < ?").run(this.now() - 86_400_000).changes;
    if (trades || holders || watch) log.info({ trades, holders, watch }, "pruned old rows");
  }
}
