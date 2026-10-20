import { createHash } from "node:crypto";
import bs58 from "bs58";
import { req, Reader } from "./pump-events.js";

/** PumpSwap AMM, where pump.fun tokens trade after migration. Layout: pump-public-docs idl/pump_amm.json. */
export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const disc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const BUY = disc("BuyEvent");
const SELL = disc("SellEvent");

/**
 * Normalised to the same convention as curve trades:
 * buy cost = quoteAmount + fee + creatorFee; sell proceeds = quoteAmount - fee - creatorFee.
 */
export interface AmmTradeEvent {
  kind: "amm_trade";
  isBuy: boolean;
  timestamp: number; // unix seconds
  baseAmount: bigint; // tokens bought/sold (raw)
  quoteAmount: bigint; // lamports excluding fees (normalised, see decodeAmmEvent)
  poolBase: bigint; // pool reserves after the trade
  poolQuote: bigint;
  fee: bigint; // lp + protocol
  creatorFee: bigint;
  pool: string;
  user: string;
}

export function decodeAmmEvent(data: Buffer): AmmTradeEvent | null {
  if (data.length < 8) return null;
  const d = data.subarray(0, 8);
  const isBuy = d.equals(BUY);
  if (!isBuy && !d.equals(SELL)) return null;
  const r = new Reader(data.subarray(8));
  const timestamp = Number(req(r.i64(), "timestamp"));
  const baseAmount = req(r.u64(), "base_amount");
  r.u64(); // max_quote_amount_in | min_quote_amount_out
  r.u64(); // user_base_token_reserves
  r.u64(); // user_quote_token_reserves
  const poolBase = req(r.u64(), "pool_base_token_reserves");
  const poolQuote = req(r.u64(), "pool_quote_token_reserves");
  const quoteAmount = req(r.u64(), "quote_amount");
  r.u64(); // lp_fee_basis_points
  const lpFee = req(r.u64(), "lp_fee");
  r.u64(); // protocol_fee_basis_points
  const protocolFee = req(r.u64(), "protocol_fee");
  r.u64(); // quote_amount_in_with_lp_fee | quote_amount_out_without_lp_fee
  const userQuote = req(r.u64(), "user_quote_amount");
  const pool = req(r.pubkey(), "pool");
  const user = req(r.pubkey(), "user");
  for (let i = 0; i < 4; i++) r.pubkey(); // user token accounts, protocol fee recipient + its account
  r.pubkey(); // coin_creator
  r.u64(); // coin_creator_fee_basis_points
  const creatorFee = r.u64() ?? 0n;
  const fee = lpFee + protocolFee;
  // What the user actually paid/received. Plain buys pay user_quote_amount_in (= quote + fees);
  // buy_exact_quote_in-style instructions pay quote_amount_in with fees inside it, so on buys
  // the larger of the two is the gross (verified against on-chain balances). Sells receive
  // user_quote_amount_out. Extra fee types (buyback, holder rewards) are folded into quoteAmount
  // so that cost = quoteAmount + fee + creatorFee and proceeds = quoteAmount - fee - creatorFee hold exactly.
  const paid = isBuy ? (quoteAmount > userQuote ? quoteAmount : userQuote) : userQuote;
  const normQuote = isBuy ? paid - fee - creatorFee : paid + fee + creatorFee;
  return { kind: "amm_trade", isBuy, timestamp, baseAmount, quoteAmount: normQuote, poolBase, poolQuote, fee, creatorFee, pool, user };
}

/** Encodes a plain buy/sell (user quote = quote ± fees). */
export function encodeAmmTrade(e: Omit<AmmTradeEvent, "kind">): Buffer {
  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  };
  const pk = (s: string) => Buffer.from(bs58.decode(s));
  const zeroKey = Buffer.alloc(32);
  const ts = Buffer.alloc(8);
  ts.writeBigInt64LE(BigInt(e.timestamp));
  return Buffer.concat([
    e.isBuy ? BUY : SELL, ts, u64(e.baseAmount), u64(0n), u64(0n), u64(0n), u64(e.poolBase), u64(e.poolQuote), u64(e.quoteAmount),
    u64(20n), u64(e.fee), u64(5n), u64(0n), u64(0n),
    u64(e.isBuy ? e.quoteAmount + e.fee + e.creatorFee : e.quoteAmount - e.fee - e.creatorFee), pk(e.pool), pk(e.user), zeroKey, zeroKey, zeroKey, zeroKey, zeroKey,
    u64(5n), u64(e.creatorFee),
  ]);
}
