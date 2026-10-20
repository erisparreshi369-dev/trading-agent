/**
 * HARD RISK LIMITS.
 *
 * These are constants on purpose. They are not read from config, env, the database, Telegram or
 * the model, and nothing exposes a setter. Changing one means editing this file, committing,
 * and restarting: a deliberate act, never a runtime one. Tests assert all of this.
 */
export const RISK = Object.freeze({
  /** Position size as a share of current equity. */
  MAX_POSITION_PCT: 0.02,
  /** Absolute cap per position, whatever the equity. */
  MAX_POSITION_SOL: 0.05,
  /** Below this, fixed costs (priority fees, rent) eat the trade: skip instead. */
  MIN_POSITION_SOL: 0.01,
  MAX_OPEN_POSITIONS: 5,
  MAX_ENTRIES_PER_DAY: 40,
  /** No leader may account for more than this share of our entries... */
  MAX_WALLET_SHARE: 0.25,
  /** ...counted over our last this-many entries (so at most 5 of the last 20, also while there are fewer). */
  WALLET_SHARE_WINDOW: 20,
  /** Exit when price is this far below our entry price. */
  STOP_LOSS_PCT: 0.25,
  /** Exit any position held this long. */
  TIME_EXIT_MS: 30 * 60_000,
  /** Equity drop from the UTC day's start that halts new entries until the next UTC day. */
  DAILY_LOSS_CAP_PCT: 0.05,
  /** Equity drop from the starting balance that trips the kill switch (needs a human to clear). */
  MAX_DRAWDOWN_PCT: 0.3,
  /** Never let free SOL fall below this: exits need fees. */
  MIN_FREE_BALANCE_SOL: 0.05,
});

export type RiskLimits = { readonly [K in keyof typeof RISK]: number };

/**
 * PRACTICE WITHOUT PORTFOLIO LIMITS (owner's decision, 2026-10-20): paper trading collects more
 * data with the portfolio limits lifted. It applies ONLY to paper trading: live trading always gets
 * RISK, whatever this says. The exits (stop loss, time exit) and the manual kill switch stay.
 * Like every limit here it is a constant: switching back to practising with the real limits means
 * setting this to false, committing and restarting.
 */
export const PAPER_NO_LIMITS = true;

const NONE = Number.POSITIVE_INFINITY;

/** RISK with every portfolio limit lifted (sizing stays 2% of equity; you still can't spend SOL you don't have). */
export const PAPER_TEST_RISK: RiskLimits = Object.freeze({
  ...RISK,
  MAX_POSITION_SOL: NONE,
  MIN_POSITION_SOL: 0,
  MAX_OPEN_POSITIONS: NONE,
  MAX_ENTRIES_PER_DAY: NONE,
  MAX_WALLET_SHARE: NONE,
  DAILY_LOSS_CAP_PCT: NONE,
  MAX_DRAWDOWN_PCT: NONE,
  MIN_FREE_BALANCE_SOL: 0,
});

/** The limits for a trading mode. Live always gets the real ones. */
export function limitsFor(mode: "paper" | "live"): RiskLimits {
  return mode === "paper" && PAPER_NO_LIMITS ? PAPER_TEST_RISK : RISK;
}
