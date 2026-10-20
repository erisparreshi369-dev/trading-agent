import { createHash } from "node:crypto";
import bs58 from "bs58";

/** pump.fun bonding-curve program. Layouts follow pump-fun/pump-public-docs idl/pump.json. */
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const DEFAULT_PUBKEY = "11111111111111111111111111111111";

const disc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const TRADE = disc("TradeEvent");
const CREATE = disc("CreateEvent");
const COMPLETE = disc("CompleteEvent");
const MIGRATION = disc("CompletePumpAmmMigrationEvent");

export interface TradeEvent {
  kind: "trade";
  mint: string;
  solLamports: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  timestamp: number; // unix seconds
  vSol: bigint;
  vToken: bigint;
  realSol: bigint;
  realToken: bigint;
  fee: bigint | null;
  creator: string | null;
  creatorFee: bigint | null;
  ixName: string | null;
  quoteMint: string | null;
}

export interface CreateEvent {
  kind: "create";
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string | null;
  timestamp: number | null;
  tokenProgram: string | null;
  isMayhemMode: boolean | null;
  quoteMint: string | null;
}

export interface CompleteEvent {
  kind: "complete";
  user: string;
  mint: string;
  bondingCurve: string;
  timestamp: number;
}

/** Emitted by the pump program when a finished curve moves into a PumpSwap pool. */
export interface MigrationEvent {
  kind: "migration";
  user: string;
  mint: string;
  mintAmount: bigint;
  solAmount: bigint;
  bondingCurve: string;
  timestamp: number;
  pool: string;
  quoteMint: string | null;
}

export type PumpEvent = TradeEvent | CreateEvent | CompleteEvent | MigrationEvent;

/** Borsh reader that returns null instead of throwing once the buffer runs out, so older
 * (shorter) event versions still decode their leading fields. */
export class Reader {
  private o = 0;
  constructor(private b: Buffer) {}
  private has(n: number) {
    return this.o + n <= this.b.length;
  }
  u8(): number | null {
    if (!this.has(1)) return null;
    return this.b.readUInt8(this.o++);
  }
  bool(): boolean | null {
    const v = this.u8();
    return v === null ? null : v !== 0;
  }
  u16(): number | null {
    if (!this.has(2)) return null;
    const v = this.b.readUInt16LE(this.o);
    this.o += 2;
    return v;
  }
  u32(): number | null {
    if (!this.has(4)) return null;
    const v = this.b.readUInt32LE(this.o);
    this.o += 4;
    return v;
  }
  u64(): bigint | null {
    if (!this.has(8)) return null;
    const v = this.b.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  i64(): bigint | null {
    if (!this.has(8)) return null;
    const v = this.b.readBigInt64LE(this.o);
    this.o += 8;
    return v;
  }
  pubkey(): string | null {
    if (!this.has(32)) return null;
    const v = bs58.encode(this.b.subarray(this.o, this.o + 32));
    this.o += 32;
    return v;
  }
  string(): string | null {
    const len = this.u32();
    if (len === null || !this.has(len)) return null;
    const v = this.b.toString("utf8", this.o, this.o + len);
    this.o += len;
    return v;
  }
  skip(n: number): boolean {
    if (!this.has(n)) return false;
    this.o += n;
    return true;
  }
}

export function req<T>(v: T | null, field: string): T {
  if (v === null) throw new Error(`truncated event at ${field}`);
  return v;
}

export function decodeEvent(data: Buffer): PumpEvent | null {
  if (data.length < 8) return null;
  const d = data.subarray(0, 8);
  const r = new Reader(data.subarray(8));
  if (d.equals(TRADE)) {
    const ev: TradeEvent = {
      kind: "trade",
      mint: req(r.pubkey(), "mint"),
      solLamports: req(r.u64(), "sol_amount"),
      tokenAmount: req(r.u64(), "token_amount"),
      isBuy: req(r.bool(), "is_buy"),
      user: req(r.pubkey(), "user"),
      timestamp: Number(req(r.i64(), "timestamp")),
      vSol: req(r.u64(), "virtual_sol_reserves"),
      vToken: req(r.u64(), "virtual_token_reserves"),
      realSol: req(r.u64(), "real_sol_reserves"),
      realToken: req(r.u64(), "real_token_reserves"),
      fee: null,
      creator: null,
      creatorFee: null,
      ixName: null,
      quoteMint: null,
    };
    r.pubkey(); // fee_recipient
    r.u64(); // fee_basis_points
    ev.fee = r.u64();
    ev.creator = r.pubkey();
    r.u64(); // creator_fee_basis_points
    ev.creatorFee = r.u64();
    r.bool(); // track_volume
    r.u64(); // total_unclaimed_tokens
    r.u64(); // total_claimed_tokens
    r.u64(); // current_sol_volume
    r.i64(); // last_update_timestamp
    ev.ixName = r.string();
    r.bool(); // mayhem_mode
    for (let i = 0; i < 4; i++) r.u64(); // cashback bps, cashback, buyback bps, buyback fee
    const n = r.u32(); // shareholders: Vec<{pubkey, u16}>
    if (n !== null && r.skip(n * 34)) ev.quoteMint = r.pubkey();
    return ev;
  }
  if (d.equals(CREATE)) {
    const ev: CreateEvent = {
      kind: "create",
      name: req(r.string(), "name"),
      symbol: req(r.string(), "symbol"),
      uri: req(r.string(), "uri"),
      mint: req(r.pubkey(), "mint"),
      bondingCurve: req(r.pubkey(), "bonding_curve"),
      user: req(r.pubkey(), "user"),
      creator: r.pubkey(),
      timestamp: null,
      tokenProgram: null,
      isMayhemMode: null,
      quoteMint: null,
    };
    const ts = r.i64();
    ev.timestamp = ts === null ? null : Number(ts);
    for (let i = 0; i < 4; i++) r.u64(); // virtual/real reserves, total supply
    ev.tokenProgram = r.pubkey();
    ev.isMayhemMode = r.bool();
    r.bool(); // is_cashback_enabled
    ev.quoteMint = r.pubkey();
    return ev;
  }
  if (d.equals(COMPLETE)) {
    return {
      kind: "complete",
      user: req(r.pubkey(), "user"),
      mint: req(r.pubkey(), "mint"),
      bondingCurve: req(r.pubkey(), "bonding_curve"),
      timestamp: Number(req(r.i64(), "timestamp")),
    };
  }
  if (d.equals(MIGRATION)) {
    const user = req(r.pubkey(), "user");
    const mint = req(r.pubkey(), "mint");
    const mintAmount = req(r.u64(), "mint_amount");
    const solAmount = req(r.u64(), "sol_amount");
    r.u64(); // pool_migration_fee
    return {
      kind: "migration", user, mint, mintAmount, solAmount,
      bondingCurve: req(r.pubkey(), "bonding_curve"),
      timestamp: Number(req(r.i64(), "timestamp")),
      pool: req(r.pubkey(), "pool"),
      quoteMint: r.pubkey(),
    };
  }
  return null;
}

/**
 * Extract a program's Anchor events from a transaction's log lines. Tracks the invoke stack so
 * "Program data:" lines emitted by other programs in the same tx are ignored.
 */
export function eventsFromLogs(logs: string[]): PumpEvent[];
export function eventsFromLogs<E>(logs: string[], program: string, decode: (b: Buffer) => E | null): E[];
export function eventsFromLogs(logs: string[], program = PUMP_PROGRAM, decode: (b: Buffer) => unknown = decodeEvent): unknown[] {
  const stack: string[] = [];
  const out: unknown[] = [];
  for (const line of logs) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Program (\w+) invoke \[\d+\]$/))) {
      stack.push(m[1]!);
    } else if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
    } else if (line.startsWith("Program data: ") && stack.at(-1) === program) {
      try {
        const ev = decode(Buffer.from(line.slice(14), "base64"));
        if (ev) out.push(ev);
      } catch {
        // malformed/unknown layout: skip this event, keep the rest of the tx
      }
    }
  }
  return out;
}

export function isSolQuoted(quoteMint: string | null): boolean {
  return quoteMint === null || quoteMint === WSOL_MINT || quoteMint === DEFAULT_PUBKEY;
}

/** SOL per whole token from virtual reserves (SOL 9 decimals, pump tokens 6 decimals). */
export function priceSol(vSol: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return Number(vSol) / 1e9 / (Number(vToken) / 1e6);
}

// --- encoders, used by tests and the replay tool ---

export function encodeTrade(e: Omit<TradeEvent, "kind">): Buffer {
  const parts: Buffer[] = [TRADE];
  const pk = (s: string) => Buffer.from(bs58.decode(s));
  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  };
  const i64 = (v: number) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v));
    return b;
  };
  const str = (s: string) => {
    const b = Buffer.from(s, "utf8");
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    return Buffer.concat([l, b]);
  };
  parts.push(pk(e.mint), u64(e.solLamports), u64(e.tokenAmount), Buffer.from([e.isBuy ? 1 : 0]), pk(e.user));
  parts.push(i64(e.timestamp), u64(e.vSol), u64(e.vToken), u64(e.realSol), u64(e.realToken));
  parts.push(pk(DEFAULT_PUBKEY), u64(95n), u64(e.fee ?? 0n), pk(e.creator ?? DEFAULT_PUBKEY), u64(5n), u64(e.creatorFee ?? 0n));
  parts.push(Buffer.from([0]), u64(0n), u64(0n), u64(0n), i64(0), str(e.ixName ?? "buy"), Buffer.from([0]));
  parts.push(u64(0n), u64(0n), u64(0n), u64(0n), Buffer.from([0, 0, 0, 0]), pk(e.quoteMint ?? WSOL_MINT));
  return Buffer.concat(parts);
}

export function encodeCreate(e: { name: string; symbol: string; uri: string; mint: string; bondingCurve: string; user: string; creator: string; timestamp: number }): Buffer {
  const pk = (s: string) => Buffer.from(bs58.decode(s));
  const str = (s: string) => {
    const b = Buffer.from(s, "utf8");
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    return Buffer.concat([l, b]);
  };
  const ts = Buffer.alloc(8);
  ts.writeBigInt64LE(BigInt(e.timestamp));
  return Buffer.concat([CREATE, str(e.name), str(e.symbol), str(e.uri), pk(e.mint), pk(e.bondingCurve), pk(e.user), pk(e.creator), ts]);
}

export function encodeMigration(e: Omit<MigrationEvent, "kind">): Buffer {
  const pk = (v: string) => Buffer.from(bs58.decode(v));
  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  };
  const ts = Buffer.alloc(8);
  ts.writeBigInt64LE(BigInt(e.timestamp));
  return Buffer.concat([MIGRATION, pk(e.user), pk(e.mint), u64(e.mintAmount), u64(e.solAmount), u64(0n), pk(e.bondingCurve), ts, pk(e.pool), pk(e.quoteMint ?? WSOL_MINT)]);
}
