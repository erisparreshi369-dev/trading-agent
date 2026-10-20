import { Keypair } from "@solana/web3.js";
import { encodeTrade, WSOL_MINT } from "../src/collector/pump-events.js";
import { loadConfig, type Config } from "../src/lib/config.js";
import { openDb, type DB } from "../src/lib/db.js";

export const key = () => Keypair.generate().publicKey.toBase58();

export function sampleTrade(over: Partial<Parameters<typeof encodeTrade>[0]> = {}) {
  return {
    mint: key(), solLamports: 500_000_000n, tokenAmount: 17_000_000_000_000n, isBuy: true, user: key(),
    timestamp: 1_760_000_000, vSol: 30_500_000_000n, vToken: 1_055_000_000_000_000n, realSol: 500_000_000n,
    realToken: 776_000_000_000_000n, fee: 4_750_000n, creator: key(), creatorFee: 250_000n, ixName: "buy", quoteMint: WSOL_MINT,
    ...over,
  };
}

/** The real config file, with per-test overrides: tests break if the shipped config stops parsing. */
export function testConfig(over: { [K in keyof Config]?: Partial<Config[K]> } = {}): Config {
  const c = loadConfig();
  return {
    collector: { ...c.collector, ...over.collector },
    scoring: { ...c.scoring, ...over.scoring },
    signals: { ...c.signals, ...over.signals },
    paper: { ...c.paper, ...over.paper },
    notifier: { ...c.notifier, ...over.notifier },
  };
}

export function memDb(): DB {
  return openDb(":memory:");
}

/** Mutable clock for deterministic tests. */
export function clock(start = Date.UTC(2026, 9, 20, 15, 0, 0)) {
  const c = { t: start, now: () => c.t, advance: (ms: number) => (c.t += ms) };
  return c;
}

export const FEE_RATE = 0.0125; // 0.95% protocol + 0.30% creator, roughly what the live data shows

/**
 * A pump.fun bonding curve that writes internally consistent trades (constant product on virtual
 * reserves) into the trades table, so tests see the same shapes the collector produces.
 */
export class Curve {
  vSol = 30_000_000_000;
  vToken = 1_073_000_000_000_000;
  realToken = 793_100_000_000_000;
  private seq = 0;

  constructor(private db: DB, readonly mint = key(), readonly creator = key(), readonly createdAt = Date.UTC(2026, 9, 20, 15, 0, 0), readonly createdSlot = 1000) {}

  insertToken(over: Record<string, unknown> = {}): this {
    const row = {
      mint: this.mint, creator: this.creator, created_at: this.createdAt, first_seen_at: this.createdAt, created_slot: this.createdSlot,
      source: "test", initial_buy_tokens: null, is_mayhem_mode: 0, token_program: null, ...over,
    };
    const cols = Object.keys(row);
    this.db.prepare(`INSERT INTO tokens (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`).run(row);
    return this;
  }

  get price(): number {
    return this.vSol / 1e9 / (this.vToken / 1e6);
  }

  buy(wallet: string, sol: number, at: number, slot = this.createdSlot + 50): { id: number; tokens: number } {
    const lamports = Math.round(sol * 1e9);
    const tokens = Math.floor((this.vToken * lamports) / (this.vSol + lamports));
    this.vSol += lamports;
    this.vToken -= tokens;
    this.realToken -= tokens;
    return { id: this.write(wallet, true, lamports, tokens, at, slot), tokens };
  }

  sell(wallet: string, tokens: number, at: number, slot = this.createdSlot + 50): { id: number; sol: number } {
    const lamports = Math.floor((this.vSol * tokens) / (this.vToken + tokens));
    this.vSol -= lamports;
    this.vToken += tokens;
    this.realToken += tokens;
    return { id: this.write(wallet, false, lamports, tokens, at, slot), sol: lamports / 1e9 };
  }

  /** Move price by a factor with one trade from a throwaway wallet. */
  movePrice(factor: number, at: number, wallet = key()): void {
    // constant product: price ∝ vSol², so scale vSol by sqrt(factor)
    const target = this.vSol * Math.sqrt(factor);
    if (target > this.vSol) this.buy(wallet, (target - this.vSol) / 1e9, at);
    else {
      const k = this.vSol * this.vToken;
      this.sell(wallet, Math.floor(k / target - this.vToken), at);
    }
  }

  private write(wallet: string, isBuy: boolean, lamports: number, tokens: number, at: number, slot: number): number {
    const fee = Math.round(lamports * 0.0095), cfee = Math.round(lamports * 0.003);
    return Number(this.db.prepare(`INSERT INTO trades (signature, ev_index, slot, block_time, received_at, mint, wallet, is_buy, sol_lamports,
      token_amount, v_sol_reserves, v_token_reserves, real_sol_reserves, real_token_reserves, fee_lamports, creator_fee_lamports, price_sol,
      is_dev, ix_name, source, venue) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'buy', 'test', 'curve')`)
      .run(`sig${this.mint.slice(0, 6)}${this.seq++}`, slot, at, at, this.mint, wallet, isBuy ? 1 : 0, lamports, tokens, this.vSol, this.vToken,
        this.vSol - 30_000_000_000, this.realToken, fee, cfee, this.price, wallet === this.creator ? 1 : 0).lastInsertRowid);
  }
}
