import type { DB } from "../lib/db.js";
import type { Bar } from "./bars.js";

export interface TradeRow {
  signature: string;
  ev_index: number;
  slot: number | null;
  block_time: number | null;
  received_at: number;
  mint: string;
  wallet: string;
  is_buy: number;
  sol_lamports: bigint;
  token_amount: bigint;
  v_sol_reserves: bigint | null;
  v_token_reserves: bigint | null;
  real_sol_reserves: bigint | null;
  real_token_reserves: bigint | null;
  fee_lamports: bigint | null;
  creator_fee_lamports: bigint | null;
  price_sol: number | null;
  is_dev: number;
  ix_name: string | null;
  source: string;
  venue: "curve" | "amm";
  /** provider that delivered it first (helius | drpc | ankr) */
  data_source?: string | null;
}

export interface TokenRow {
  mint: string;
  name?: string | null;
  symbol?: string | null;
  uri?: string | null;
  creator?: string | null;
  bonding_curve?: string | null;
  token_program?: string | null;
  quote_mint?: string | null;
  created_slot?: number | null;
  created_at: number;
  first_seen_at: number;
  create_signature?: string | null;
  initial_buy_lamports?: bigint | null;
  initial_buy_tokens?: bigint | null;
  is_mayhem_mode?: number | null;
  source: string;
}

const TOKEN_COLS = [
  "mint", "name", "symbol", "uri", "creator", "bonding_curve", "token_program", "quote_mint", "created_slot",
  "created_at", "first_seen_at", "create_signature", "initial_buy_lamports", "initial_buy_tokens", "is_mayhem_mode", "source",
] as const;

/**
 * Buffers writes and commits them in one transaction per flush: SQLite handles thousands of
 * rows/s this way, versus a few hundred with one commit per row.
 */
export class Store {
  private trades: TradeRow[] = [];
  private tokens: TokenRow[] = [];
  private bars: Bar[] = [];
  private stmts;

  constructor(private db: DB) {
    this.stmts = {
      trade: db.prepare(`INSERT OR IGNORE INTO trades (signature, ev_index, slot, block_time, received_at, mint, wallet,
        is_buy, sol_lamports, token_amount, v_sol_reserves, v_token_reserves, real_sol_reserves, real_token_reserves,
        fee_lamports, creator_fee_lamports, price_sol, is_dev, ix_name, source, venue, data_source)
        VALUES (@signature, @ev_index, @slot, @block_time, @received_at, @mint, @wallet, @is_buy, @sol_lamports,
        @token_amount, @v_sol_reserves, @v_token_reserves, @real_sol_reserves, @real_token_reserves, @fee_lamports,
        @creator_fee_lamports, @price_sol, @is_dev, @ix_name, @source, @venue, @data_source)`),
      holder: db.prepare(`INSERT INTO token_holders (mint, wallet, balance, updated_at) VALUES (?, ?, MAX(0, ?), ?)
        ON CONFLICT(mint, wallet) DO UPDATE SET balance = MAX(0, balance + ?), updated_at = excluded.updated_at`),
      // Two sources report the same token; keep the first non-null value for each field.
      token: db.prepare(`INSERT INTO tokens (${TOKEN_COLS.join(", ")}) VALUES (${TOKEN_COLS.map((c) => "@" + c).join(", ")})
        ON CONFLICT(mint) DO UPDATE SET ${TOKEN_COLS.filter((c) => !["mint", "source", "first_seen_at"].includes(c))
          .map((c) => `${c} = COALESCE(tokens.${c}, excluded.${c})`).join(", ")},
          created_at = MIN(tokens.created_at, excluded.created_at),
          first_seen_at = MIN(tokens.first_seen_at, excluded.first_seen_at)`),
      bar: db.prepare(`INSERT OR REPLACE INTO token_bars (mint, bucket_ms, ts, open, high, low, close, volume_lamports,
        buys, sells, unique_traders, v_sol_reserves, holders, top10_pct, dev_pct)
        VALUES (@mint, @bucket_ms, @ts, @open, @high, @low, @close, @volume_lamports, @buys, @sells, @unique_traders,
        @v_sol_reserves, @holders, @top10_pct, @dev_pct)`),
      completed: db.prepare("UPDATE tokens SET completed_at = COALESCE(completed_at, ?) WHERE mint = ?"),
      migrated: db.prepare("UPDATE tokens SET migrated_at = COALESCE(migrated_at, ?), migration_pool = COALESCE(migration_pool, ?) WHERE mint = ?"),
      pool: db.prepare("INSERT OR IGNORE INTO pools (pool, mint, quote_mint, created_at, source) VALUES (?, ?, ?, ?, ?)"),
      watch: db.prepare(`INSERT INTO watchlist (address, kind, mint, until, priority, reason) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(address) DO UPDATE SET until = MAX(until, excluded.until), priority = MIN(priority, excluded.priority)`),
    };
  }

  addTrade(t: TradeRow): void {
    this.trades.push(t);
  }

  addToken(t: TokenRow): void {
    this.tokens.push(t);
  }

  addBars(bars: Bar[]): void {
    this.bars.push(...bars);
  }

  markCompleted(mint: string, ts: number): void {
    this.stmts.completed.run(ts, mint);
  }

  markMigrated(mint: string, ts: number, pool: string | null): void {
    this.stmts.migrated.run(ts, pool, mint);
  }

  addPool(pool: string, mint: string, quoteMint: string | null, ts: number, source: string): void {
    this.stmts.pool.run(pool, mint, quoteMint, ts, source);
  }

  /** Ask for an address to be followed by targeted subscriptions until `until`. */
  watch(address: string, kind: "curve" | "pool" | "wallet", mint: string | null, until: number, priority: number, reason: string): void {
    this.stmts.watch.run(address, kind, mint, until, priority, reason);
  }

  get pending(): number {
    return this.trades.length + this.tokens.length + this.bars.length;
  }

  /** Commit everything buffered. Returns rows written. */
  flush(): number {
    if (this.pending === 0) return 0;
    const tokens = this.tokens, trades = this.trades, bars = this.bars;
    this.tokens = [];
    this.trades = [];
    this.bars = [];
    const s = this.stmts;
    this.db.transaction(() => {
      for (const k of tokens) s.token.run(fillToken(k));
      for (const t of trades) {
        // only count a trade towards holder balances the first time we see it
        if (s.trade.run({ ...t, data_source: t.data_source ?? null }).changes === 1) {
          const delta = t.is_buy ? t.token_amount : -t.token_amount;
          s.holder.run(t.mint, t.wallet, delta, t.received_at, delta);
        }
      }
      for (const b of bars) s.bar.run(b);
    }).immediate();
    return tokens.length + trades.length + bars.length;
  }
}

function fillToken(t: TokenRow): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const c of TOKEN_COLS) row[c] = (t as unknown as Record<string, unknown>)[c] ?? null;
  return row;
}
