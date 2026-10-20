import type { MadeOnSolConfig } from "../lib/config.js";
import type { DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import { WATCH_CANDIDATE } from "../collector/budget.js";
import type { MadeOnSol } from "./madeonsol.js";

const BATCH = 50; // coins per request (the API's maximum; a batch counts as one request)
const DAY = 86_400_000;
/** A coin fetched this recently isn't fetched again. */
const REFETCH_MS = 20 * 3_600_000;
/** A creator's record fetched this recently isn't refreshed through the frequent-creators job. */
const CREATOR_REFRESH_MS = 7 * DAY;
/** Candidates are watched at the lowest priority: first dropped when subscriptions or the data budget run short. */
const CANDIDATE_PRIORITY = 9;

export interface IntelSummary {
  coins: number;
  creators: number;
  earlyBuyerScores: number;
  candidatesListed: number;
  candidatesWatched: number;
  requests: number;
  stoppedForBudget: boolean;
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * The daily MadeOnSol job. Order matters for the budget: the coins we actually decided on come
 * first, then the ranked wallets, then reputation for creators who launch often (so it's stored
 * before their next launch). Each part stops quietly when the budget does.
 */
export async function runIntel(db: DB, cfg: MadeOnSolConfig, api: MadeOnSol, now = Date.now()): Promise<IntelSummary> {
  const before = api.usedToday();
  const s: IntelSummary = { coins: 0, creators: 0, earlyBuyerScores: 0, candidatesListed: 0, candidatesWatched: 0, requests: 0, stoppedForBudget: false };
  const priority = coinsWeDecidedOn(db, now);
  await fetchCoins(db, api, priority, true, now, s);
  await fetchCandidates(db, cfg, api, now, s);
  const frequent = frequentCreatorCoins(db, now, cfg.creator_batches * BATCH);
  await fetchCoins(db, api, frequent, false, now, s);
  s.requests = api.usedToday() - before;
  s.stoppedForBudget = !api.canRequest();
  return s;
}

/** Coins we evaluated, held, or saw our wallets trade in the last day, not fetched recently. */
export function coinsWeDecidedOn(db: DB, now: number): string[] {
  return (db.prepare(`
    SELECT mint FROM (
      SELECT mint FROM signals WHERE ts > :since
      UNION SELECT mint FROM paper_positions WHERE entry_due_at > :since
      UNION SELECT t.mint FROM trades t JOIN tracked_wallets w ON w.wallet = t.wallet AND w.active = 1 WHERE t.received_at > :since
    ) m WHERE NOT EXISTS (SELECT 1 FROM token_intel i WHERE i.mint = m.mint AND i.fetched_at > :recent)`)
    .all({ since: now - DAY, recent: now - REFETCH_MS }) as { mint: string }[]).map((r) => r.mint);
}

/** One recent coin per creator who launched at least twice in the last day and has no fresh record. */
export function frequentCreatorCoins(db: DB, now: number, max: number): string[] {
  return (db.prepare(`
    SELECT MAX(mint) mint FROM tokens k
    WHERE k.first_seen_at > ? AND k.creator IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM creator_reputation r WHERE r.creator = k.creator AND r.fetched_at > ?)
    GROUP BY k.creator HAVING count(*) >= 2 ORDER BY count(*) DESC LIMIT ?`)
    .all(now - DAY, now - CREATOR_REFRESH_MS, max) as { mint: string }[]).map((r) => r.mint);
}

async function fetchCoins(db: DB, api: MadeOnSol, mints: string[], withEarlyBuyers: boolean, now: number, s: IntelSummary): Promise<void> {
  const rep = db.prepare(`INSERT OR IGNORE INTO creator_reputation (creator, fetched_at, tier, total_deployed, total_bonded, recent_bond_rate, history_status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const tok = db.prepare(`INSERT INTO token_intel (mint, fetched_at, creator, launch_cohort_size, is_blacklisted) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(mint, fetched_at) DO UPDATE SET creator = excluded.creator, launch_cohort_size = excluded.launch_cohort_size, is_blacklisted = excluded.is_blacklisted`);
  const ebs = db.prepare(`INSERT INTO token_intel (mint, fetched_at, early_buyer_score, early_buyer_confidence, early_buyer_signal, bundle_buyers) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint, fetched_at) DO UPDATE SET early_buyer_score = excluded.early_buyer_score, early_buyer_confidence = excluded.early_buyer_confidence,
      early_buyer_signal = excluded.early_buyer_signal, bundle_buyers = excluded.bundle_buyers`);
  for (const batch of chunks(mints, BATCH)) {
    const info = await api.request("token/batch", { mints: batch }, batch.length);
    if (!info) {
      if (!api.canRequest()) return;
      continue; // a failed batch is skipped; tomorrow's run picks the coins up again
    }
    const fetchedAt = now;
    db.transaction(() => {
      for (const t of (info.tokens ?? []) as any[]) {
        if (typeof t?.mint !== "string") continue;
        const d = t.deployer;
        const creator = typeof d?.wallet === "string" ? d.wallet : null;
        tok.run(t.mint, fetchedAt, creator, num(t.launch_cohort_size), t.is_blacklisted ? 1 : 0);
        s.coins++;
        if (creator && rep.run(creator, fetchedAt, str(d.tier), num(d.total_deployed), num(d.total_bonded), num(d.recent_bond_rate), str(d.history_status)).changes) s.creators++;
      }
    })();
    if (!withEarlyBuyers) continue;
    const q = await api.request("tokens/batch/buyer-quality", { mints: batch }, batch.length);
    if (!q) {
      if (!api.canRequest()) return;
      continue;
    }
    db.transaction(() => {
      for (const t of (q.tokens ?? []) as any[]) {
        if (typeof t?.mint !== "string" || typeof t.score !== "number") continue;
        ebs.run(t.mint, fetchedAt, t.score, str(t.confidence), str(t.signal), num(t.breakdown?.bundle_buyer_count));
        s.earlyBuyerScores++;
      }
    })();
  }
}

interface Listed {
  wallet: string;
  list: "alpha" | "kol";
  rank: number;
  pnl: number;
  holdMinutes: number | null;
  stats: unknown;
}

/**
 * Ranked wallets become candidates for OUR scorer, nothing more. The best `watch_top` that we
 * don't already follow get one `watch_days` trial of having their trades watched, so scoring
 * sees them fully; whether we ever follow one is decided by scoring on our own data.
 */
async function fetchCandidates(db: DB, cfg: MadeOnSolConfig, api: MadeOnSol, now: number, s: IntelSummary): Promise<void> {
  const listed: Listed[] = [];
  const alpha = await api.request("alpha/leaderboard?period=7d&sort=pnl&limit=100&exclude_bots=true");
  for (const r of (alpha?.leaderboard ?? []) as any[]) {
    if (typeof r?.wallet === "string") listed.push({ wallet: r.wallet, list: "alpha", rank: num(r.rank) ?? 0, pnl: num(r.net_pnl_sol) ?? 0, holdMinutes: null, stats: r });
  }
  const kol = await api.request("kol/leaderboard?period=7d&limit=100");
  for (const r of (kol?.leaderboard ?? []) as any[]) {
    if (typeof r?.wallet === "string") listed.push({ wallet: r.wallet, list: "kol", rank: listed.filter((x) => x.list === "kol").length + 1, pnl: num(r.pnl) ?? 0, holdMinutes: num(r.median_hold_minutes_30d), stats: r });
  }
  if (!listed.length) return;
  const ins = db.prepare("INSERT OR IGNORE INTO candidate_wallets (wallet, list, fetched_at, rank, stats) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const c of listed) ins.run(c.wallet, c.list, now, c.rank, JSON.stringify(c.stats));
  })();
  s.candidatesListed = new Set(listed.map((c) => c.wallet)).size;

  const following = new Set((db.prepare("SELECT wallet FROM tracked_wallets WHERE active = 1").all() as { wallet: string }[]).map((r) => r.wallet));
  const tried = new Set((db.prepare("SELECT wallet FROM candidate_watch").all() as { wallet: string }[]).map((r) => r.wallet));
  const active = (db.prepare("SELECT count(*) n FROM candidate_watch WHERE until > ?").get(now) as { n: number }).n;
  const picks = [...new Map(listed.map((c) => [c.wallet, c])).values()]
    .filter((c) => !following.has(c.wallet) && !tried.has(c.wallet) && (c.holdMinutes === null || c.holdMinutes >= cfg.candidates.min_hold_minutes))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, Math.max(0, cfg.candidates.watch_top - active));
  const until = now + cfg.candidates.watch_days * DAY;
  const watchRow = db.prepare("INSERT INTO candidate_watch (wallet, since, until) VALUES (?, ?, ?)");
  const watch = db.prepare(`INSERT INTO watchlist (address, kind, mint, until, priority, reason) VALUES (?, 'wallet', NULL, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET until = MAX(until, excluded.until)`);
  db.transaction(() => {
    for (const c of picks) {
      watchRow.run(c.wallet, now, until);
      watch.run(c.wallet, until, CANDIDATE_PRIORITY, WATCH_CANDIDATE);
    }
  })();
  s.candidatesWatched = picks.length;
  if (picks.length) log.info({ added: picks.length, active: active + picks.length }, "candidate wallets: trial watch started");
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === "string" ? x.slice(0, 100) : null);
