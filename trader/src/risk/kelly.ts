/**
 * DYNAMIC KELLY FRACTION SIZING.
 *
 * Calculates optimal position size based on recent trading statistics.
 * Kelly formula: f* = (p * b - q) / b
 *   where p = win probability, q = 1-p, b = avg win / avg loss
 *
 * We cap it conservatively and blend with the proven balance approach.
 * This is advisory only: the actual size comes from risk/limits.ts.
 */

import type { DB } from "../lib/db.js";

export interface KellyInput {
  /** Recent closed trades (last N or rolling window) */
  trades: { pnl_sol: number; entry_sol: number }[];
  /** Current equity */
  equity: number;
  /** Max fraction of equity per trade (from limits) */
  maxPositionPct: number;
  /** Min fraction of equity per trade (from limits) */
  minPositionPct: number;
}

export interface KellyOutput {
  /** Kelly fraction (0 to 1) */
  fraction: number;
  /** Recommended position size in SOL */
  sizeSol: number;
  /** Win rate (0-1) */
  winRate: number;
  /** Profit factor (avg win / avg loss) */
  profitFactor: number;
  /** Sharpe-like metric */
  sharpe: number;
  /** Number of trades analyzed */
  n: number;
}

/**
 * Calculate Kelly fraction from recent trades.
 * Conservative: uses half-Kelly, capped at maxPositionPct, floored at minPositionPct.
 */
export function calcKelly(input: KellyInput): KellyOutput {
  const { trades, equity, maxPositionPct, minPositionPct } = input;

  if (trades.length < 10) {
    // Not enough data: use conservative default
    return {
      fraction: minPositionPct,
      sizeSol: equity * minPositionPct,
      winRate: 0,
      profitFactor: 0,
      sharpe: 0,
      n: trades.length,
    };
  }

  const wins = trades.filter((t) => t.pnl_sol > 0);
  const losses = trades.filter((t) => t.pnl_sol < 0);

  const winRate = wins.length / trades.length;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl_sol, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl_sol, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : 0;

  // Kelly: f* = p - q/b where b = avgWin/avgLoss
  // Equivalent: f* = (p * b - q) / b
  let kelly = 0;
  if (avgLoss > 0) {
    const b = avgWin / avgLoss;
    kelly = (winRate * b - (1 - winRate)) / b;
  }

  // Half-Kelly for safety
  kelly = Math.max(0, kelly * 0.5);

  // Cap at limits
  const fraction = Math.min(maxPositionPct, Math.max(minPositionPct, kelly));

  // Sharpe-like: mean return / std dev of returns
  const returns = trades.map((t) => t.pnl_sol / t.entry_sol);
  const meanRet = returns.reduce((s, r) => s + r, 0) / returns.length;
  const varRet = returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / returns.length;
  const sharpe = varRet > 0 ? meanRet / Math.sqrt(varRet) : 0;

  return {
    fraction,
    sizeSol: equity * fraction,
    winRate,
    profitFactor,
    sharpe,
    n: trades.length,
  };
}

/**
 * Fetch recent closed paper trades for Kelly calculation.
 * Returns last N closed trades with pnl and entry size.
 */
export async function fetchKellyTrades(db: DB, limit = 100): Promise<{ pnl_sol: number; entry_sol: number }[]> {
  const rows = db.prepare(`
    SELECT pnl_sol, size_sol
    FROM paper_positions
    WHERE status = 'closed' AND pnl_sol IS NOT NULL AND size_sol IS NOT NULL
    ORDER BY closed_at DESC
    LIMIT ?
  `).all(limit) as { pnl_sol: number; size_sol: number }[];
  return rows.map((r) => ({ pnl_sol: r.pnl_sol, entry_sol: r.size_sol }));
}

/**
 * Get Kelly-advised size, blended with proven balance.
 * This is the main entry point for the trader to call.
 */
export async function getKellySize(
  db: DB,
  equity: number,
  limits: { maxPositionPct: number; minPositionPct: number },
  windowSize = 50
): Promise<KellyOutput> {
  const trades = await fetchKellyTrades(db, windowSize);
  return calcKelly({ trades, equity, maxPositionPct: limits.maxPositionPct, minPositionPct: limits.minPositionPct });
}