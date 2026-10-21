/**
 * SIZE UP AFTER CONSISTENCY, NOT AFTER PROFIT.
 *
 * Trades are sized from a "proven balance" instead of today's balance: winning days don't make the
 * next trade bigger. The proven balance starts at the starting balance and only steps up after
 * `weeks` profitable weeks in a row (each with at least MIN_WEEK_TRADES closed trades), by at most
 * `stepPct`, never above the balance we really have. If the first week after a step-up loses, it
 * steps back down. Losing never needs a step: size is a share of min(balance, proven balance), so it
 * shrinks with the balance anyway.
 */

export const WEEK_MS = 7 * 86_400_000;
/** A week with fewer closed trades than this proves nothing, so it doesn't count as profitable. */
export const MIN_WEEK_TRADES = 10;

export interface SizeBase {
  base: number; // proven balance
  prev: number | null; // the level before the last step-up, while its first week is on trial
  stepAt: number; // when it was set or last stepped (ms)
}

/** Realized result of the trades that closed in [from, to). */
export type Results = (from: number, to: number) => { pnl: number; trades: number };

export type SizeStep = { state: SizeBase; event: "up" | "down" | "kept" } | null;

/** What the proven balance should become now, or null if nothing changes. Pure: all inputs are arguments. */
export function nextSizeBase(s: SizeBase, equity: number, now: number, results: Results, weeks: number, stepPct: number): SizeStep {
  if (s.prev !== null) {
    if (now - s.stepAt < WEEK_MS) return null; // the step-up's trial week isn't over
    const first = results(s.stepAt, s.stepAt + WEEK_MS);
    return first.pnl < 0
      ? { state: { base: s.prev, prev: null, stepAt: now }, event: "down" }
      : { state: { ...s, prev: null }, event: "kept" };
  }
  if (now - s.stepAt < weeks * WEEK_MS || equity <= s.base) return null;
  for (let i = 0; i < weeks; i++) {
    const w = results(now - (i + 1) * WEEK_MS, now - i * WEEK_MS);
    if (w.trades < MIN_WEEK_TRADES || w.pnl <= 0) return null;
  }
  return { state: { base: Math.min(equity, s.base * (1 + stepPct)), prev: s.base, stepAt: now }, event: "up" };
}
