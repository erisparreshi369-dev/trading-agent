import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import YAML from "yaml";
import { z } from "zod";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

dotenv.config({ path: resolve(ROOT, ".env"), quiet: true });

const CollectorSchema = z.object({
  helius_firehose: z.boolean().default(true),
  helius_daily_mb_cap: z.number().positive().default(1500),
  pumpportal_streams: z.boolean().default(true),
  bars: z.object({
    fine_bucket_ms: z.number().int().positive(),
    fine_window_ms: z.number().int().positive(),
    coarse_bucket_ms: z.number().int().positive(),
    coarse_window_ms: z.number().int().positive(),
  }),
  holder_checks: z.object({
    enabled: z.boolean(),
    min_trades: z.number().int().nonnegative(),
    ages_s: z.array(z.number().int().positive()),
    max_per_minute: z.number().int().positive(),
  }),
  retention: z.object({
    raw_trades_days: z.number().positive(),
    holders_days: z.number().positive(),
  }),
  heartbeat_s: z.number().positive().default(30),
  stale_stream_s: z.number().positive().default(60),
});

const ConfigSchema = z.object({ collector: CollectorSchema });

export type Config = z.infer<typeof ConfigSchema>;
export type CollectorConfig = z.infer<typeof CollectorSchema>;

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
};
