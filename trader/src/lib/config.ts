import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import YAML from "yaml";
import { z } from "zod";
import { RISK } from "../risk/limits.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

dotenv.config({ path: resolve(ROOT, ".env"), quiet: true });

// .strict() everywhere: a typo or an unexpected section (e.g. someone adding `risk:`) fails loudly.
const CollectorSchema = z
  .object({
    helius: z
      .object({
        daily_mb_cap: z.number().positive(),
        monthly_credits: z.number().int().positive(),
        credits_per_mb: z.number().positive(),
        stream_share: z.number().gt(0).max(1),
        steps_pct: z.tuple([z.number(), z.number(), z.number()]).refine(([a, b, c]) => 0 < a && a < b && b < c && c < 100, "three rising percentages below 100"),
      })
      .strict(),
    firehose: z
      .object({
        enabled: z.boolean(),
        hours_utc: z.tuple([z.number().min(0).max(24), z.number().min(0).max(24)]),
      })
      .strict(),
    targeted: z
      .object({
        enabled: z.boolean(),
        token_watch_minutes: z.number().positive(),
        pool_watch_hours: z.number().positive(),
        max_subscriptions: z.number().int().positive(),
      })
      .strict(),
    pumpportal_streams: z.boolean(),
    bars: z
      .object({
        fine_bucket_ms: z.number().int().positive(),
        fine_window_ms: z.number().int().positive(),
        coarse_bucket_ms: z.number().int().positive(),
        coarse_window_ms: z.number().int().positive(),
      })
      .strict(),
    holder_checks: z
      .object({
        enabled: z.boolean(),
        min_trades: z.number().int().nonnegative(),
        ages_s: z.array(z.number().int().positive()),
        max_per_minute: z.number().int().positive(),
      })
      .strict(),
    retention: z.object({ raw_trades_days: z.number().nonnegative(), holders_days: z.number().nonnegative() }).strict(), // 0 = keep forever
    heartbeat_s: z.number().positive(),
    stale_stream_s: z.number().positive(),
  })
  .strict();

const ScoringSchema = z
  .object({
    lookback_days: z.number().positive(),
    min_positions: z.number().int().positive(),
    min_copy_trades: z.number().int().positive(),
    max_tokens_per_day: z.number().positive(),
    snipe_window_slots: z.number().int().nonnegative(),
    max_snipe_pnl_frac: z.number().min(0).max(1),
    min_median_hold_s: z.number().nonnegative(),
    copy_size_sol: z.number().positive(),
    min_copy_roi: z.number(),
    copy_roi_cap: z.number().positive(),
    track_top_n: z.number().int().positive(),
    cold_after_hours: z.number().positive(),
    oos_days: z.number().positive(),
  })
  .strict();

const SignalsSchema = z
  .object({
    venues: z.array(z.enum(["curve", "amm"])).min(1),
    min_leader_buy_sol: z.number().nonnegative(),
    token_age_s: z.tuple([z.number().nonnegative(), z.number().positive()]),
    min_real_sol: z.number().nonnegative(),
    max_real_sol: z.number().positive(),
    max_top10_pct: z.number().positive(),
    max_dev_hold_pct: z.number().nonnegative(),
    max_dev_sold_frac: z.number().min(0).max(1),
    max_dev_tokens_24h: z.number().int().positive(),
    exclude_mayhem: z.boolean(),
    min_confirmations: z.number().int().positive(),
    confirmation_window_s: z.number().positive(),
    reentry_cooldown_s: z.number().nonnegative(),
    min_score: z.number(),
    exclude_bad_creators: z.boolean(),
    bad_creator_min_launches: z.number().int().positive(),
    bad_creator_max_success: z.number().min(0).max(1),
    use_brain: z.boolean(), // skip what the learning brain predicts will lose, once it passed its exam (it can only skip, never add trades)
    // veteran habits (null / 0 = off)
    max_curve_sol_per_min: z.number().positive().nullable(), // don't chase: skip a curve that filled faster than this since launch
    pause_after_losses: z.number().int().nonnegative(), // cool off: after this many losses in a row...
    pause_minutes: z.number().nonnegative(), // ...take no new trades for this long after the last one
    // trading hours [from, to) in UTC; from > to wraps past midnight (e.g. [22, 4]); null = around the clock
    trade_hours_utc: z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(24)]).nullable(),
  })
  .strict();

// The learning brain (learner/brain.py studies every night; the trader reads its newest model from the database).
const BrainSchema = z
  .object({
    min_signals: z.number().int().positive(),
    min_test_trades: z.number().int().positive(),
    test_share: z.number().gt(0).lt(1),
    min_gain: z.number().nonnegative(),
    min_kept: z.number().int().positive(),
    skip_below_roi: z.number().max(0.5),
    ridge: z.number().positive(),
    lesson_min_n: z.number().int().positive(),
    lesson_min_diff: z.number().nonnegative(),
    own_skips_min: z.number().int().positive(),
  })
  .strict();

const PaperSchema = z
  .object({
    start_balance_sol: z.number().positive(),
    execution_delay_ms: z.number().int().nonnegative(),
    priority_fee_sol: z.number().nonnegative(),
    executor_fee_bps: z.number().nonnegative(),
    extra_slippage_bps: z.number().nonnegative(),
    max_slippage_bps: z.number().positive(),
    token_account_rent_sol: z.number().nonnegative(),
    follow_leader_exit: z.boolean(),
  })
  .strict();

// Exits a shadow variant may use. The hard stop loss and time exit (RISK) apply on top, always.
const ExitSchema = z
  .object({
    leader_exit: z.boolean(),
    take_profit_pct: z.number().positive().nullable(),
    trailing_stop_pct: z.number().positive().max(100).nullable(),
    max_hold_s: z.number().positive().max(RISK.TIME_EXIT_MS / 1000),
    stop_loss_pct: z.number().positive().max(RISK.STOP_LOSS_PCT * 100), // a tighter stop than the hard one, never looser
    breakeven_after_pct: z.number().positive().nullable(), // once up this much, the stop moves up to our entry price
    cut_if_flat_s: z.number().positive().max(RISK.TIME_EXIT_MS / 1000).nullable(), // still not above our entry price after this long: get out
    partial_take_pct: z.number().positive().nullable(), // once up this much, sell part (partial_sell_frac) and move the stop to our entry price
    partial_sell_frac: z.number().gt(0).lt(1),
  })
  .strict()
  .partial();

// When a shadow variant buys. Default: right away (our order lands execution_delay_ms after the leader's).
const EntrySchema = z
  .object({
    wait_dip_pct: z.number().positive().max(90), // wait for the price to pull back this far from its high since the leader's buy...
    wait_s: z.number().positive().max(600), // ...for at most this long; no pullback, or the leader sold first: no trade
  })
  .strict();

const ShadowSchema = z
  .object({
    enabled: z.boolean(),
    size_sol: z.number().positive(),
    variants: z.record(
      z.string().regex(/^[\w.-]+$/),
      z
        .object({
          filters: z.union([z.literal("none"), SignalsSchema.partial()]).optional(),
          entry: EntrySchema.optional(),
          exit: ExitSchema.optional(),
          size_sol: z.number().positive().optional(),
          max_slippage_bps: z.number().positive().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const NotifierSchema = z
  .object({
    watch_services: z.array(z.string()).min(1),
    stale_after_s: z.number().positive(),
    daily_summary_utc: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    trade_alerts: z.boolean(),
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "unknown time zone (use a name like UTC or Europe/London)"),
    usd_prices: z.boolean(),
    voice: z.enum(["plain", "genz", "plain-short", "genz-short"]),
  })
  .strict();

const ProviderName = z.enum(["helius", "drpc", "ankr"]);
const ProvidersSchema = z
  .object({
    list: z.record(ProviderName, z.object({ key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/), ws: z.string().url(), http: z.string().url() }).strict()),
    jobs: z
      .object(Object.fromEntries((["following", "discovery", "lookups", "history"] as const).map((j) => [j,
        z.object({ use: z.array(ProviderName).min(1), mode: z.enum(["failover"]) }).strict()])) as Record<"following" | "discovery" | "lookups" | "history", z.ZodObject<{ use: z.ZodArray<typeof ProviderName>; mode: z.ZodEnum<["failover"]> }>>)
      .strict(),
    health: z
      .object({
        errors_in_a_row: z.number().int().positive(),
        timeout_s: z.number().positive(),
        silent_s: z.number().positive(),
        budget_pct: z.number().positive().max(100),
        switch_back_after_healthy_s: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .refine((p) => Object.values(p.jobs).every((j) => j.use.every((n) => n in p.list)), "every provider a job uses must be in providers.list");

// MadeOnSol: an optional helper for the daily intel job only (never called while deciding a trade).
const MadeOnSolSchema = z
  .object({
    enabled: z.boolean(),
    key_env: z.string().regex(/^[A-Z_]+$/),
    base_url: z.string().url(),
    daily_requests: z.number().int().positive(),
    warn_pct: z.number().min(1).max(99),
    stop_pct: z.number().min(1).max(100),
    timeout_s: z.number().positive().max(30),
    per_minute: z.number().int().positive(),
    creator_batches: z.number().int().nonnegative(),
    candidates: z.object({ watch_top: z.number().int().nonnegative(), watch_days: z.number().positive(), min_hold_minutes: z.number().nonnegative() }).strict(),
  })
  .strict()
  .refine((m) => m.warn_pct < m.stop_pct, "warn_pct must be below stop_pct");

export const ConfigSchema = z
  .object({
    collector: CollectorSchema, scoring: ScoringSchema, signals: SignalsSchema, paper: PaperSchema, shadow: ShadowSchema, notifier: NotifierSchema,
    providers: ProvidersSchema, madeonsol: MadeOnSolSchema, brain: BrainSchema,
    // Read only by learner/youtube.py (the brain's nightly YouTube study); nothing in the trader uses it,
    // so only its on/off switch is checked here and new keys there can't stop the bot from starting.
    youtube: z.object({ enabled: z.boolean() }).passthrough().optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type CollectorConfig = z.infer<typeof CollectorSchema>;
export type ScoringConfig = z.infer<typeof ScoringSchema>;
export type SignalsConfig = z.infer<typeof SignalsSchema>;
export type PaperConfig = z.infer<typeof PaperSchema>;
export type ShadowConfig = z.infer<typeof ShadowSchema>;
export type ShadowExitConfig = z.infer<typeof ExitSchema>;
export type NotifierConfig = z.infer<typeof NotifierSchema>;
export type BrainConfig = z.infer<typeof BrainSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersSchema>;
export type MadeOnSolConfig = z.infer<typeof MadeOnSolSchema>;
export type ProviderName = z.infer<typeof ProviderName>;
export type JobName = keyof ProvidersConfig["jobs"];

export function loadConfig(path = resolve(ROOT, "config/config.yaml")): Config {
  return ConfigSchema.parse(YAML.parse(readFileSync(path, "utf8")));
}

/** Environment, read once. Secrets are exposed only through these getters, never logged. */
export const env = {
  dbPath: resolve(ROOT, process.env.DB_PATH ?? "./data/trading.db"),
  logLevel: process.env.LOG_LEVEL ?? "info",
  heliusApiKey: () => process.env.HELIUS_API_KEY?.trim() || undefined,
  // Exact string match: anything other than "true" means paper mode.
  liveTrading: process.env.LIVE_TRADING === "true",
  telegramToken: () => process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
  telegramChatId: () => process.env.TELEGRAM_CHAT_ID?.trim() || undefined,
};

export function heliusRpcUrl(): string | undefined {
  const k = env.heliusApiKey();
  return k ? `https://mainnet.helius-rpc.com/?api-key=${k}` : undefined;
}
