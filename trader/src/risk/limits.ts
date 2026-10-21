/**
 * RISK LIMITS.
 *
 * RISK holds the normal values. Since 2026-10-21 the owner may change each one on the dashboard
 * (Limits tab, stored in kv `override.risk.<NAME>`), for practice and real money alike, but only
 * inside RISK_WALLS below: those walls are constants, and a stored value outside them (or garbage)
 * is ignored, so the normal value applies. Nothing else writes these: not config, env, Telegram or
 * the learning brain. Changing a wall means editing this file, committing and restarting.
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
export type RiskName = keyof typeof RISK;

/**
 * THE WALLS: [lowest, highest] the dashboard may set each limit to. The stop loss, time exit, loss
 * stops and fee reserve can't be switched off; a trade can't exceed 0.5 SOL. shared/editable-settings.json
 * (what the dashboard offers) must use exactly these ranges; a test checks.
 */
export const RISK_WALLS: { readonly [K in RiskName]: readonly [number, number] } = Object.freeze({
  MAX_POSITION_PCT: [0.001, 0.2],
  MAX_POSITION_SOL: [0.01, 0.5],
  MIN_POSITION_SOL: [0.001, 0.1],
  MAX_OPEN_POSITIONS: [1, 20],
  MAX_ENTRIES_PER_DAY: [1, 200],
  MAX_WALLET_SHARE: [0.05, 1],
  WALLET_SHARE_WINDOW: [5, 100],
  STOP_LOSS_PCT: [0.02, 0.5],
  TIME_EXIT_MS: [60_000, 30 * 60_000], // the shadow book and the collector's watch windows assume <= 30 min
  DAILY_LOSS_CAP_PCT: [0.01, 0.5],
  MAX_DRAWDOWN_PCT: [0.05, 0.6],
  MIN_FREE_BALANCE_SOL: [0.01, 1],
});
const WHOLE: ReadonlySet<RiskName> = new Set(["MAX_OPEN_POSITIONS", "MAX_ENTRIES_PER_DAY", "WALLET_SHARE_WINDOW", "TIME_EXIT_MS"]);

export const OVERRIDE_PREFIX = "override.risk.";

/**
 * PRACTICE WITHOUT PORTFOLIO LIMITS (owner's decision, 2026-10-20): paper trading collects more
 * data with the portfolio limits lifted. It applies ONLY to paper trading: live trading always gets
 * the limits, whatever this says. The exits (stop loss, time exit) and the manual kill switch stay.
 * This is the normal value; the dashboard can switch it (kv override.risk.PAPER_NO_LIMITS, "1"/"0").
 */
export const PAPER_NO_LIMITS = true;

const NONE = Number.POSITIVE_INFINITY;

/** `limits` with every portfolio limit lifted (sizing stays a share of equity; you still can't spend SOL you don't have). */
const lifted = (limits: RiskLimits): RiskLimits => Object.freeze({
  ...limits,
  MAX_POSITION_SOL: NONE,
  MIN_POSITION_SOL: 0,
  MAX_OPEN_POSITIONS: NONE,
  MAX_ENTRIES_PER_DAY: NONE,
  MAX_WALLET_SHARE: NONE,
  DAILY_LOSS_CAP_PCT: NONE,
  MAX_DRAWDOWN_PCT: NONE,
  MIN_FREE_BALANCE_SOL: 0,
});

/** RISK with every portfolio limit lifted. */
export const PAPER_TEST_RISK: RiskLimits = lifted(RISK);

/** Only what's needed to read kv (better-sqlite3 or a test double). */
interface KvReader {
  prepare(sql: string): { all(...a: unknown[]): unknown[] };
}

export interface OwnerLimits {
  limits: RiskLimits; // RISK with the owner's dashboard values, each inside its wall
  paperNoLimits: boolean;
  changed: RiskName[]; // which ones differ from RISK because of the dashboard
}

/** One stored value, or undefined if it's missing, garbage or outside its wall. */
function wallChecked(name: RiskName, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = Number(raw);
  const [lo, hi] = RISK_WALLS[name];
  if (!Number.isFinite(v) || v < lo || v > hi || (WHOLE.has(name) && !Number.isInteger(v))) return undefined;
  return v;
}

/** The limits as the owner set them on the dashboard (RISK where they didn't, or where a value is outside its wall). */
export function ownerLimits(db: KvReader): OwnerLimits {
  const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE ?").all(`${OVERRIDE_PREFIX}%`) as { key: string; value: string }[];
  const raw = new Map(rows.map((r) => [r.key.slice(OVERRIDE_PREFIX.length), r.value]));
  const out: Record<string, number> = { ...RISK };
  const changed: RiskName[] = [];
  for (const name of Object.keys(RISK) as RiskName[]) {
    const v = wallChecked(name, raw.get(name));
    if (v !== undefined && v !== RISK[name]) {
      out[name] = v;
      changed.push(name);
    }
  }
  if (out.MIN_POSITION_SOL! > out.MAX_POSITION_SOL!) { // a pair that contradicts itself: both back to normal
    out.MIN_POSITION_SOL = RISK.MIN_POSITION_SOL;
    out.MAX_POSITION_SOL = RISK.MAX_POSITION_SOL;
    changed.splice(0, changed.length, ...changed.filter((n) => n !== "MIN_POSITION_SOL" && n !== "MAX_POSITION_SOL"));
  }
  const sw = raw.get("PAPER_NO_LIMITS");
  return {
    limits: changed.length ? Object.freeze(out as RiskLimits) : RISK,
    paperNoLimits: sw === "1" ? true : sw === "0" ? false : PAPER_NO_LIMITS,
    changed,
  };
}

/**
 * The limits for a trading mode. Live always gets the limits (the owner's, inside the walls).
 * Without a database: the normal values.
 */
export function limitsFor(mode: "paper" | "live", db?: KvReader): RiskLimits {
  const o = db ? ownerLimits(db) : { limits: RISK, paperNoLimits: PAPER_NO_LIMITS };
  if (mode === "paper" && o.paperNoLimits) return o.limits === RISK ? PAPER_TEST_RISK : lifted(o.limits);
  return o.limits;
}
