import { addCosts, simulateBuy, simulateSell, slippageBps, stateFromTrade, type CostBreakdown, type CostModel, type MarketState, type TradeRowLike } from "./market.js";

/**
 * Replay "follow this buy" over a token's recorded tape. Wallet scoring, shadow variants and
 * signal outcomes all go through here, so they share the paper engine's execution model:
 * our order lands `delayMs` after the leader's, exits fire on the first trade that crosses a
 * rule and land `delayMs` later, every fee/slippage/rent of the cost model applies.
 */

export interface FollowTrade extends TradeRowLike {
  wallet: string;
  is_buy: number;
}

export interface ExitRule {
  leaderExit: boolean; // sell when the leader sells
  stopLossPct: number; // below our entry price
  takeProfitPct: number | null; // above our entry price
  trailingStopPct: number | null; // below the highest price since entry
  maxHoldMs: number;
}

export interface FollowParams {
  leaderWallet: string;
  leaderAt: number; // received_at of the leader's buy
  leaderPrice: number | null; // spot right after the leader's buy (slippage reference)
  sizeSol: number;
  delayMs: number;
  maxSlippageBps: number;
  cost: CostModel;
  exit: ExitRule;
  /** Data is complete up to here; anything needing later trades is 'unknown'. */
  dataUntil: number;
}

export type FollowResult =
  | { status: "missed"; reason: string; slippageBps: number | null }
  | { status: "unknown" }
  | {
      status: "closed";
      entryAt: number;
      exitAt: number;
      exitReason: string;
      entryPrice: number; // effective, ours
      exitPrice: number;
      entrySpot: number; // market price when our buy landed
      slippageBps: number; // our effective entry vs the leader's price
      tokens: number;
      costSol: number; // = size
      proceedsSol: number; // after every cost, rent refunded
      pnlSol: number;
      roi: number;
      costs: CostBreakdown;
      /** What the delay cost: (our entry spot / leader's price - 1) of the SOL that went in. Not a fee, can be negative. */
      delaySol: number;
    };

/** Latest market state at or before `t` in a tape sorted by received_at. */
export function stateAt(tape: TradeRowLike[], t: number): MarketState | null {
  let lo = 0, hi = tape.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tape[mid]!.received_at <= t) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return idx >= 0 ? stateFromTrade(tape[idx]!) : null;
}

export function simulateFollow(tape: FollowTrade[], p: FollowParams): FollowResult {
  const entryAt = p.leaderAt + p.delayMs;
  if (entryAt > p.dataUntil) return { status: "unknown" };
  const entry = stateAt(tape, entryAt);
  if (!entry) return { status: "unknown" };
  const buy = simulateBuy(entry, p.sizeSol, p.cost);
  if (!buy) return { status: "missed", reason: "size too small after fixed costs", slippageBps: null };
  const slip = slippageBps(buy.price, p.leaderPrice ?? entry.price);
  if (slip > p.maxSlippageBps) return { status: "missed", reason: "slippage over limit", slippageBps: slip };

  const x = p.exit;
  let trigger = entryAt + x.maxHoldMs;
  let why = "time_exit";
  const stop = buy.price * (1 - x.stopLossPct);
  const tp = x.takeProfitPct === null ? Infinity : buy.price * (1 + x.takeProfitPct);
  let peak = entry.price;
  for (const t of tape) {
    if (t.received_at < p.leaderAt) continue;
    if (t.received_at >= trigger) break;
    // the leader selling while our buy is in flight takes us straight out once it lands
    if (x.leaderExit && t.wallet === p.leaderWallet && !t.is_buy && t.received_at > p.leaderAt) {
      trigger = Math.max(t.received_at, entryAt);
      why = "leader_exit";
      break;
    }
    if (t.received_at <= entryAt || t.price_sol === null) continue;
    const px = t.price_sol;
    if (px <= stop) {
      trigger = t.received_at;
      why = "stop_loss";
      break;
    }
    if (px >= tp) {
      trigger = t.received_at;
      why = "take_profit";
      break;
    }
    peak = Math.max(peak, px);
    if (x.trailingStopPct !== null && px <= peak * (1 - x.trailingStopPct)) {
      trigger = t.received_at;
      why = "trailing_stop";
      break;
    }
  }
  const exitAt = trigger + p.delayMs;
  if (exitAt > p.dataUntil) return { status: "unknown" };
  // a token that went quiet before exitAt: its last observed state is the market
  const exit = stateAt(tape, exitAt);
  if (!exit) return { status: "unknown" };
  const sell = simulateSell(exit, buy.tokens, p.cost);
  const proceeds = sell.netSol + p.cost.tokenAccountRentSol;
  const costs = addCosts(buy.costs, { ...sell.costs, rentSol: -p.cost.tokenAccountRentSol });
  const pnl = proceeds - p.sizeSol;
  return {
    status: "closed", entryAt, exitAt, exitReason: why, entryPrice: buy.price, exitPrice: sell.price, entrySpot: entry.price, slippageBps: slip,
    tokens: buy.tokens, costSol: p.sizeSol, proceedsSol: proceeds, pnlSol: pnl, roi: pnl / p.sizeSol, costs,
    delaySol: p.leaderPrice ? buy.curveSol * (1 - p.leaderPrice / entry.price) : 0,
  };
}
