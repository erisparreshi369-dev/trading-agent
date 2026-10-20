import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import YAML from "yaml";
import { z } from "zod";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

dotenv.config({ path: resolve(ROOT, ".env"), quiet: true });

// .strict() everywhere: a typo or an unexpected section (e.g. someone adding `risk:`) fails loudly.
const CollectorSchema = z
  .object({
    helius: z.object({ daily_mb_cap: z.number().positive(), targeted_reserve_mb: z.number().nonnegative() }).strict(),
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
    retention: z.object({ raw_trades_days: z.number().positive(), holders_days: z.number().positive() }).strict(),
    heartbeat_s: z.number().positive(),
    stale_stream_s: z.number().positive(),
  })
  .strict();

const ScoringSchema = z
  .object({
    lookback_days: z.number().positive(),
    min_positions: z.number().int().positive(),
    max_tokens_per_day: z.number().positive(),
    snipe_window_slots: z.number().int().nonnegative(),
    max_snipe_pnl_frac: z.number().min(0).max(1),
    min_median_hold_s: z.number().nonnegative(),
    copy_size_sol: z.number().positive(),
    min_copy_roi: z.number(),
    copy_roi_cap: z.number().positive(),
    track_top_n: z.number().int().positive(),
    cold_after_hours: z.number().positive(),
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

const NotifierSchema = z
  .object({
    watch_services: z.array(z.string()).min(1),
    stale_after_s: z.number().positive(),
    daily_summary_utc: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    trade_alerts: z.boolean(),
  })
  .strict();

export const ConfigSchema = z
  .object({ collector: CollectorSchema, scoring: ScoringSchema, signals: SignalsSchema, paper: PaperSchema, notifier: NotifierSchema })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type CollectorConfig = z.infer<typeof CollectorSchema>;
export type ScoringConfig = z.infer<typeof ScoringSchema>;
export type SignalsConfig = z.infer<typeof SignalsSchema>;
export type PaperConfig = z.infer<typeof PaperSchema>;
export type NotifierConfig = z.infer<typeof NotifierSchema>;

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
