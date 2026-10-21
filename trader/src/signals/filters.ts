import type { SignalsConfig } from "../lib/config.js";

export type Features = Record<string, number | string | boolean | null>;

/** One closed trade of the book deciding (our paper trades, or a shadow variant's own), newest first. */
export interface RecentResult {
  won: boolean;
  closedAt: number;
}

/** How fast the curve filled since launch, SOL per minute: a coin that went vertical. Null when unknown. */
export function curveSolPerMin(f: Features): number | null {
  const age = f.token_age_s;
  if (f.venue !== "curve" || typeof age !== "number" || age <= 0 || typeof f.liquidity_sol !== "number") return null;
  return f.liquidity_sol / (age / 60);
}

/** Cool off: the last `pause_after_losses` trades all lost and the newest closed less than `pause_minutes` ago. */
export function coolingOff(recent: RecentResult[], c: SignalsConfig, at: number): boolean {
  const n = c.pause_after_losses;
  if (n <= 0 || recent.length < n) return false;
  const last = recent.slice(0, n);
  return last.every((r) => !r.won) && at - last[0]!.closedAt < c.pause_minutes * 60_000;
}

/**
 * The signal filters as a pure function of the feature snapshot stored with every signal, so the
 * live engine and every shadow variant decide from identical inputs, and the decision can be
 * recomputed later for any other settings. Reason texts are what reports group on: keep them stable.
 */
export function cheapReasons(f: Features, c: SignalsConfig, inCooldown: boolean, recent: RecentResult[] = [], at = 0): string[] {
  const reasons: string[] = [];
  if (!c.venues.includes(f.venue as "curve" | "amm")) reasons.push(`venue ${f.venue} not enabled`);
  const buy = f.leader_buy_sol as number;
  if (buy < c.min_leader_buy_sol) reasons.push(`leader buy ${buy.toFixed(3)} < ${c.min_leader_buy_sol} SOL`);
  if (!f.token_known) {
    reasons.push("token launch not seen (no creator/age data)");
  } else {
    const age = f.token_age_s as number;
    if (age < c.token_age_s[0] || age > c.token_age_s[1]) reasons.push(`token age ${Math.round(age)}s outside [${c.token_age_s.join(", ")}]`);
    if (c.exclude_mayhem && f.mayhem) reasons.push("mayhem mode token");
    if (typeof f.dev_tokens_24h === "number" && f.dev_tokens_24h > c.max_dev_tokens_24h) reasons.push(`dev launched ${f.dev_tokens_24h} tokens in 24h`);
    if (f.leader_is_dev) reasons.push("leader is the token's dev");
  }
  const liq = f.liquidity_sol as number;
  if (f.venue === "curve" && (liq < c.min_real_sol || liq > c.max_real_sol)) reasons.push(`curve SOL ${liq.toFixed(2)} outside [${c.min_real_sol}, ${c.max_real_sol}]`);
  if ((f.confirmations as number) < c.min_confirmations) reasons.push(`${f.confirmations} tracked buyers < ${c.min_confirmations}`);
  if (inCooldown) reasons.push("re-entry cooldown");
  const speed = curveSolPerMin(f);
  if (c.max_curve_sol_per_min !== null && speed !== null && speed > c.max_curve_sol_per_min) {
    reasons.push(`chasing: curve filled ${speed.toFixed(1)} SOL/min > ${c.max_curve_sol_per_min}`);
  }
  if (coolingOff(recent, c, at)) reasons.push(`cooling off after ${c.pause_after_losses} loss${c.pause_after_losses === 1 ? "" : "es"} in a row`);
  // creator record stored before the decision (daily MadeOnSol job); unknown creators pass
  const launches = f.creator_launches;
  if (c.exclude_bad_creators && typeof launches === "number" && launches >= c.bad_creator_min_launches
    && (f.creator_success_rate as number) <= c.bad_creator_max_success) {
    reasons.push(`bad creator: ${launches} launches, ${Math.round((f.creator_success_rate as number) * 100)}% filled their curve`);
  }
  return reasons;
}

/** Checks on the on-chain features; call only once those were fetched (onchain_checked). */
export function onChainReasons(f: Features, c: SignalsConfig): string[] {
  if (f.onchain_error) return [`on-chain check failed: ${f.onchain_error}`]; // fail closed
  if (!f.onchain_checked) return ["on-chain checks not run"];
  const reasons: string[] = [];
  const top10 = f.top10_pct as number;
  if (top10 > c.max_top10_pct) reasons.push(`top10 holders ${top10.toFixed(1)}% > ${c.max_top10_pct}%`);
  if ((f.dev_hold_pct as number) > c.max_dev_hold_pct) reasons.push(`dev holds ${f.dev_hold_pct}% > ${c.max_dev_hold_pct}%`);
  if (f.dev_sold_frac !== null && f.dev_sold_frac !== undefined && (f.dev_sold_frac as number) > c.max_dev_sold_frac) {
    reasons.push(`dev sold ${Math.round((f.dev_sold_frac as number) * 100)}% of launch buy`);
  }
  return reasons;
}

/** Every reason to reject, in the order the engine checks them (on-chain only if the cheap checks pass). */
export function rejectReasons(f: Features, c: SignalsConfig, inCooldown: boolean, recent: RecentResult[] = [], at = 0): string[] {
  const reasons = cheapReasons(f, c, inCooldown, recent, at);
  if (reasons.length) return reasons;
  reasons.push(...onChainReasons(f, c));
  if (reasons.length === 0 && (f.score as number) < c.min_score) reasons.push(`score ${(f.score as number).toFixed(3)} < ${c.min_score}`);
  if (reasons.length === 0) reasons.push(...brainReasons(f, c));
  return reasons;
}

/**
 * The learning brain's vote, from what it predicted when the signal came in (stored in the
 * features). Only a model that passed its nightly exam may vote, and its only vote is "skip".
 */
export function brainReasons(f: Features, c: SignalsConfig): string[] {
  if (!c.use_brain || f.brain_active !== true || typeof f.brain_pred !== "number" || typeof f.brain_threshold !== "number") return [];
  return f.brain_pred < f.brain_threshold
    ? [`model expects ${(f.brain_pred * 100).toFixed(1)}% follower ROI < ${(f.brain_threshold * 100).toFixed(1)}% threshold`]
    : [];
}
