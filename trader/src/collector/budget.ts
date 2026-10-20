/**
 * The daily Helius data budget, in steps. Every Helius websocket byte costs credits (~20 per MB)
 * and the Free plan has 1M credits a month; once they're gone Helius refuses everything until the
 * month resets. collector.helius.daily_mb_cap spreads that over the month, and these modes make
 * a day's budget last instead of hitting a wall:
 *
 *   normal          everything (firehose in its hours, tracked wallets, their tokens, pools)
 *   light           70%: firehose off (no new wallet discovery), no post-migration pool watching,
 *                   no candidate wallets on trial
 *   essential       85%: only tracked wallets, tokens they traded in the last 30 min, open trades
 *   positions_only  95%: only open trades; the trader opens no new ones until 00:00 UTC
 *   off             100% and nothing open: Helius streams stopped until 00:00 UTC
 *
 * Open trades are watched in every mode, past 100% if needed, until they close (at most
 * RISK.TIME_EXIT_MS): we never go blind in the middle of a trade. That overshoot is small, and the
 * daily cap leaves the monthly credits some slack.
 */
export type DataMode = "normal" | "light" | "essential" | "positions_only" | "off";

/** stream_usage sources that are metered Helius traffic. */
export const HELIUS_SOURCES = ["helius", "firehose", "targeted"];
/** The dashboard's daily-cap override (kv), set until changed back. */
export const CAP_OVERRIDE_KEY = "override.helius_daily_mb_cap";

export interface DailyCap {
  capMb: number; // what today may use: the chosen cap, never above the monthly guard
  chosenMb: number; // config, or the dashboard override
  overridden: boolean;
  monthlyGuardMb: number; // most today may use without the last 31 days exceeding the monthly budget
}

/**
 * Today's cap. Helius's monthly credits reset on a date we don't know; if every 31 days in a row
 * stay under the monthly budget, every billing month does. So today may use the monthly budget
 * minus what the previous 30 days used, and never more than the chosen daily cap.
 */
export function dailyCap(db: { prepare(sql: string): { get(...a: unknown[]): unknown } },
  h: { daily_mb_cap: number; monthly_credits: number; credits_per_mb: number; stream_share: number }, now: number): DailyCap {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(CAP_OVERRIDE_KEY) as { value: string } | undefined;
  const override = row ? Number(row.value) : NaN;
  const overridden = Number.isFinite(override) && override > 0;
  const chosenMb = overridden ? override : h.daily_mb_cap;
  const today = new Date(now).toISOString().slice(0, 10);
  const from = new Date(now - 30 * 86_400_000).toISOString().slice(0, 10);
  const used = (db.prepare(`SELECT COALESCE(SUM(bytes), 0) b FROM stream_usage WHERE day >= ? AND day < ? AND source IN (${HELIUS_SOURCES.map(() => "?").join(",")})`)
    .get(from, today, ...HELIUS_SOURCES) as { b: number }).b / 1e6;
  const monthlyGuardMb = Math.max(0, (h.monthly_credits * h.stream_share) / h.credits_per_mb - used);
  return { capMb: Math.min(chosenMb, monthlyGuardMb), chosenMb, overridden, monthlyGuardMb };
}

/** Watch reasons written to the watchlist table. */
export const WATCH_POSITION = "paper position";
export const WATCH_TOKEN = "tracked wallet trade";
export const WATCH_POOL = "migrated with tracked holders";
/** Ranked wallets on a trial watch (intel job), so scoring can judge them on full data. */
export const WATCH_CANDIDATE = "candidate wallet";
/** In essential mode, keep watching a tracked wallet's token only this long after its trade. */
export const ESSENTIAL_TOKEN_MS = 30 * 60_000;

export function modeFor(mb: number, capMb: number, stepsPct: readonly number[], openPositions: number): DataMode {
  const pct = (mb / capMb) * 100;
  if (pct >= 100) return openPositions > 0 ? "positions_only" : "off";
  if (pct >= stepsPct[2]!) return "positions_only";
  if (pct >= stepsPct[1]!) return "essential";
  if (pct >= stepsPct[0]!) return "light";
  return "normal";
}

/** Highest warning step reached (0 = none, else one of stepsPct, or 100). */
export function stepReached(mb: number, capMb: number, stepsPct: readonly number[]): number {
  const pct = (mb / capMb) * 100;
  if (pct >= 100) return 100;
  return [...stepsPct].reverse().find((s) => pct >= s) ?? 0;
}

export const firehoseAllowed = (m: DataMode) => m === "normal";
export const followsWallets = (m: DataMode) => m === "normal" || m === "light" || m === "essential";

/** Should this watchlist row keep its subscription in this mode? */
export function keepWatch(m: DataMode, row: { reason: string | null; until: number }, now: number, tokenWatchMs: number): boolean {
  if (row.reason === WATCH_POSITION) return m !== "off";
  switch (m) {
    case "normal":
      return true;
    case "light":
      return row.reason !== WATCH_POOL && row.reason !== WATCH_CANDIDATE;
    case "essential":
      return row.reason === WATCH_TOKEN && now - (row.until - tokenWatchMs) < ESSENTIAL_TOKEN_MS;
    default:
      return false;
  }
}

/** Helius bytes per minute over the last hour, for "MB per hour" and "when do we hit the cap". */
export class UsageRate {
  private minutes = new Map<number, number>();

  constructor(private startedAt: number) {}

  add(now: number, bytes: number): void {
    const m = Math.floor(now / 60_000);
    this.minutes.set(m, (this.minutes.get(m) ?? 0) + bytes);
    if (this.minutes.size > 90) for (const k of this.minutes.keys()) if (k < m - 60) this.minutes.delete(k);
  }

  /** MB received in the last 60 minutes. */
  mbLastHour(now: number): number {
    const m = Math.floor(now / 60_000);
    let b = 0;
    for (const [k, v] of this.minutes) if (k > m - 60) b += v;
    return b / 1e6;
  }

  /** Current speed in MB/h: the last hour, or since start when we've run less than that (min 10 min). */
  mbPerHour(now: number): number {
    const ran = Math.max(10 * 60_000, Math.min(3_600_000, now - this.startedAt));
    return this.mbLastHour(now) * (3_600_000 / ran);
  }
}

/** When the cap is reached at this speed; null if never today (or no usage). */
export function capEta(mbToday: number, capMb: number, mbPerHour: number, now: number): number | null {
  if (mbToday >= capMb) return now;
  if (mbPerHour <= 0) return null;
  const at = now + ((capMb - mbToday) / mbPerHour) * 3_600_000;
  const midnight = Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000;
  return at < midnight ? Math.round(at) : null;
}
