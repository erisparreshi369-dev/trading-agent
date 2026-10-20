/** pump.fun tokens always have 1B supply with 6 decimals. */
export const TOTAL_SUPPLY_RAW = 1_000_000_000n * 1_000_000n;

export interface BarConfig {
  fine_bucket_ms: number;
  fine_window_ms: number;
  coarse_bucket_ms: number;
  coarse_window_ms: number;
}

export interface Bar {
  mint: string;
  bucket_ms: number;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_lamports: number;
  buys: number;
  sells: number;
  unique_traders: number;
  v_sol_reserves: number;
  holders: number | null;
  top10_pct: number | null;
  dev_pct: number | null;
}

export interface BarTrade {
  mint: string;
  wallet: string;
  isBuy: boolean;
  solLamports: bigint;
  tokenAmount: bigint;
  vSol: bigint;
  price: number;
  ts: number; // ms
}

interface TokenState {
  createdAt: number;
  creator: string | null;
  /** Trade-derived balances; kept only during the fine window to bound memory. */
  balances: Map<string, bigint> | null;
  bar: (Omit<Bar, "unique_traders" | "holders" | "top10_pct" | "dev_pct"> & { traders: Set<string> }) | null;
  trades: number;
}

/**
 * Builds OHLCV bars per token: fine buckets for the first window after creation, coarse after,
 * nothing past the coarse window. Bars are emitted when a later bucket starts or on flush().
 */
export class BarAggregator {
  private tokens = new Map<string, TokenState>();

  constructor(private cfg: BarConfig) {}

  addToken(mint: string, createdAt: number, creator: string | null): void {
    if (this.tokens.has(mint)) return;
    this.tokens.set(mint, { createdAt, creator, balances: new Map(), bar: null, trades: 0 });
  }

  has(mint: string): boolean {
    return this.tokens.has(mint);
  }

  tradeCount(mint: string): number {
    return this.tokens.get(mint)?.trades ?? 0;
  }

  get size(): number {
    return this.tokens.size;
  }

  /** Returns any bar closed by this trade. Trades for unknown tokens are ignored. */
  onTrade(t: BarTrade): Bar[] {
    const s = this.tokens.get(t.mint);
    if (!s) return [];
    s.trades++;
    if (s.balances) {
      const next = (s.balances.get(t.wallet) ?? 0n) + (t.isBuy ? t.tokenAmount : -t.tokenAmount);
      if (next > 0n) s.balances.set(t.wallet, next);
      else s.balances.delete(t.wallet);
    }
    const width = this.widthFor(s, t.ts);
    if (width === null) return [];
    const start = t.ts - (t.ts % width);
    const out: Bar[] = [];
    if (s.bar && (s.bar.ts !== start || s.bar.bucket_ms !== width)) {
      // late trade for an already-closed bucket: fold it into the current bar rather than reopen
      if (start < s.bar.ts) {
        this.fold(s, t);
        return out;
      }
      out.push(this.close(s));
    }
    if (!s.bar) {
      s.bar = {
        mint: t.mint, bucket_ms: width, ts: start,
        open: t.price, high: t.price, low: t.price, close: t.price,
        volume_lamports: 0, buys: 0, sells: 0, v_sol_reserves: 0, traders: new Set(),
      };
    }
    this.fold(s, t);
    return out;
  }

  /** Close bars whose bucket has ended and evict tokens past the coarse window. */
  flush(now: number, graceMs = 1000): Bar[] {
    const out: Bar[] = [];
    for (const [mint, s] of this.tokens) {
      if (s.bar && now >= s.bar.ts + s.bar.bucket_ms + graceMs) out.push(this.close(s));
      const age = now - s.createdAt;
      if (s.balances && age > this.cfg.fine_window_ms) s.balances = null;
      if (age > this.cfg.coarse_window_ms && !s.bar) this.tokens.delete(mint);
    }
    return out;
  }

  private widthFor(s: TokenState, ts: number): number | null {
    const age = ts - s.createdAt;
    if (age < this.cfg.fine_window_ms) return this.cfg.fine_bucket_ms;
    if (age < this.cfg.coarse_window_ms) return this.cfg.coarse_bucket_ms;
    return null;
  }

  private fold(s: TokenState, t: BarTrade): void {
    const b = s.bar!;
    b.high = Math.max(b.high, t.price);
    b.low = Math.min(b.low, t.price);
    b.close = t.price;
    b.volume_lamports += Number(t.solLamports);
    if (t.isBuy) b.buys++;
    else b.sells++;
    b.traders.add(t.wallet);
    b.v_sol_reserves = Number(t.vSol);
  }

  private close(s: TokenState): Bar {
    const { traders, ...b } = s.bar!;
    s.bar = null;
    let holders: number | null = null;
    let top10: number | null = null;
    let dev: number | null = null;
    // holder stats only for fine bars: balances are dropped once the fine window ends
    if (s.balances && b.bucket_ms === this.cfg.fine_bucket_ms) {
      holders = s.balances.size;
      const top = [...s.balances.values()].sort((x, y) => (y > x ? 1 : y < x ? -1 : 0)).slice(0, 10);
      top10 = pct(top.reduce((a, v) => a + v, 0n));
      dev = s.creator ? pct(s.balances.get(s.creator) ?? 0n) : null;
    }
    return { ...b, unique_traders: traders.size, holders, top10_pct: top10, dev_pct: dev };
  }
}

function pct(raw: bigint): number {
  return Number((raw * 1_000_000n) / TOTAL_SUPPLY_RAW) / 10_000;
}
