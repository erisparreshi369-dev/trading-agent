/**
 * Trade-cost model shared by the paper engine and wallet scoring, so "what we'd have made
 * following this wallet" and "what paper trading reports" use identical math.
 *
 * Pricing is constant-product on the reserves of the trade that last touched the token
 * (virtual reserves on the curve, pool reserves on PumpSwap), which is exactly how both
 * venues price swaps. Our sizes are tiny relative to the reserves, but impact is still included.
 */

export interface MarketState {
  venue: "curve" | "amm";
  vSol: number; // lamports
  vToken: number; // raw token units
  realToken: number | null; // curve only: tokens left to sell before the curve completes
  feeRate: number; // venue fees (protocol + creator [+ lp]) as a fraction of the SOL amount
  price: number; // SOL per whole token
  ts: number; // received_at of the trade this state comes from
}

export interface CostModel {
  priorityFeeSol: number; // per tx
  executorFeeBps: number; // PumpPortal fee, both ways
  extraSlippageBps: number;
  tokenAccountRentSol: number;
}

/** Where the money went on one fill, in SOL. Slippage = price impact + extra slippage vs the spot price we traded at. */
export interface CostBreakdown {
  platformSol: number; // pump.fun / PumpSwap protocol + creator (+ LP) fees
  executorSol: number; // PumpPortal fee
  prioritySol: number; // fixed per transaction
  slippageSol: number;
  rentSol: number; // token account rent: paid on the buy, refunded on the sell (negative)
}

export interface BuyResult {
  tokens: number; // raw units
  curveSol: number; // SOL that went into the curve/pool, before fees
  feesSol: number; // venue + executor + priority
  rentSol: number;
  price: number; // effective SOL per whole token, venue fees excluded (comparable to spot)
  costs: CostBreakdown;
}

export interface SellResult {
  netSol: number; // SOL received after every cost, rent refund NOT included
  grossSol: number;
  feesSol: number;
  price: number;
  costs: CostBreakdown; // rentSol is 0 here: the refund is the caller's to add
}

export const zeroCosts = (): CostBreakdown => ({ platformSol: 0, executorSol: 0, prioritySol: 0, slippageSol: 0, rentSol: 0 });

export function addCosts(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    platformSol: a.platformSol + b.platformSol, executorSol: a.executorSol + b.executorSol, prioritySol: a.prioritySol + b.prioritySol,
    slippageSol: a.slippageSol + b.slippageSol, rentSol: a.rentSol + b.rentSol,
  };
}

export const totalCost = (c: CostBreakdown) => c.platformSol + c.executorSol + c.prioritySol + c.slippageSol + c.rentSol;

const DEFAULT_FEE_RATE = 0.0125;

/** Fee rate implied by a stored trade row (both fee columns relative to the pre-fee SOL amount). */
export function feeRateOf(row: { sol_lamports: number; fee_lamports: number | null; creator_fee_lamports: number | null }): number {
  if (!row.sol_lamports || row.fee_lamports === null) return DEFAULT_FEE_RATE;
  const r = (row.fee_lamports + (row.creator_fee_lamports ?? 0)) / row.sol_lamports;
  return r > 0 && r < 0.1 ? r : DEFAULT_FEE_RATE;
}

/** Spend exactly `budgetSol` (everything included) buying at `m`. */
export function simulateBuy(m: MarketState, budgetSol: number, c: CostModel, payRent = true): BuyResult | null {
  const rent = payRent ? c.tokenAccountRentSol : 0;
  const exec = c.executorFeeBps / 10_000;
  const curveSol = (budgetSol - c.priorityFeeSol - rent) / (1 + m.feeRate + exec);
  if (curveSol <= 0) return null;
  const inLamports = curveSol * 1e9;
  let tokens = (m.vToken * inLamports) / (m.vSol + inLamports);
  tokens *= 1 - c.extraSlippageBps / 10_000;
  if (m.realToken !== null) tokens = Math.min(tokens, m.realToken);
  if (!(tokens > 0)) return null;
  return {
    tokens: Math.floor(tokens),
    curveSol,
    feesSol: curveSol * (m.feeRate + exec) + c.priorityFeeSol,
    rentSol: rent,
    price: curveSol / (tokens / 1e6),
    costs: {
      platformSol: curveSol * m.feeRate, executorSol: curveSol * exec, prioritySol: c.priorityFeeSol,
      slippageSol: curveSol - (Math.floor(tokens) / 1e6) * m.price, rentSol: rent,
    },
  };
}

/** Sell `tokens` (raw units) at `m`. */
export function simulateSell(m: MarketState, tokens: number, c: CostModel): SellResult {
  let gross = (m.vSol * tokens) / (m.vToken + tokens) / 1e9;
  gross *= 1 - c.extraSlippageBps / 10_000;
  const fees = gross * (m.feeRate + c.executorFeeBps / 10_000) + c.priorityFeeSol;
  return {
    grossSol: gross, feesSol: fees, netSol: Math.max(0, gross - fees), price: tokens > 0 ? gross / (tokens / 1e6) : 0,
    costs: {
      platformSol: gross * m.feeRate, executorSol: (gross * c.executorFeeBps) / 10_000, prioritySol: c.priorityFeeSol,
      slippageSol: (tokens / 1e6) * m.price - gross, rentSol: 0,
    },
  };
}

/** Slippage of our effective price against a reference (leader's) price, in bps. Positive = worse. */
export function slippageBps(effective: number, reference: number): number {
  return reference > 0 ? (effective / reference - 1) * 10_000 : 0;
}

export interface TradeRowLike {
  venue: string;
  v_sol_reserves: number | null;
  v_token_reserves: number | null;
  real_token_reserves: number | null;
  sol_lamports: number;
  fee_lamports: number | null;
  creator_fee_lamports: number | null;
  price_sol: number | null;
  received_at: number;
}

export function stateFromTrade(t: TradeRowLike): MarketState | null {
  if (!t.v_sol_reserves || !t.v_token_reserves) return null;
  return {
    venue: t.venue === "amm" ? "amm" : "curve",
    vSol: t.v_sol_reserves,
    vToken: t.v_token_reserves,
    realToken: t.venue === "amm" ? null : t.real_token_reserves,
    feeRate: feeRateOf(t),
    price: t.price_sol ?? t.v_sol_reserves / 1e9 / (t.v_token_reserves / 1e6),
    ts: t.received_at,
  };
}
