import type { PaperConfig } from "./config.js";
import type { DB } from "./db.js";

/**
 * SAFE SETTINGS: rules a human sets in config/config.yaml that the learner (Phase 4) may only
 * make STRICTER, never looser. The learner proposes a value by writing kv `learner.<name>`; the
 * value used is the stricter of the config value and the proposal. A looser, missing or garbage
 * proposal is ignored, so nothing the learner writes can ever loosen a rule.
 *
 * The hard risk limits (limits.ts) are stricter still: nothing can change those at runtime.
 */
export const SAFE_SETTINGS = {
  /** Max price move between the copied wallet's buy and ours, in bps. Lower = stricter. */
  max_slippage_bps: "lower",
} as const;

export type SafeSetting = keyof typeof SAFE_SETTINGS;

/** The stricter of `base` and `proposed` for this setting; `proposed` is ignored unless it's a valid, stricter number. */
export function stricterOnly(name: SafeSetting, base: number, proposed: unknown): number {
  const p = typeof proposed === "string" && proposed.trim() !== "" ? Number(proposed) : proposed;
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) return base;
  return SAFE_SETTINGS[name] === "lower" ? Math.min(base, p) : Math.max(base, p);
}

/** The slippage limit in force right now: config, tightened by the learner if it asked for that. */
export function maxSlippageBps(db: DB, cfg: Pick<PaperConfig, "max_slippage_bps">): number {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'learner.max_slippage_bps'").get() as { value: string } | undefined;
  return stricterOnly("max_slippage_bps", cfg.max_slippage_bps, row?.value);
}
