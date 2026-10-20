import type { Config } from "../lib/config.js";
import type { DB } from "../lib/db.js";
import { RISK } from "../risk/limits.js";
import { M } from "./voice.js";
import {
  type ActivityFacts, type BuyFacts, type Counted, type Health, type MissedFacts, type PeriodResult, type PnlFacts,
  type ReportFacts, type SellFacts, type StatusFacts, type TokenRef, type WhyEvent,
} from "./messages.js";

/** Database reads that turn into the facts messages.ts words. No wording here. */

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const utcDayStart = (ms: number) => Date.parse(new Date(ms).toISOString().slice(0, 10));
const json = <T>(s: string | null | undefined, fallback: T): T => (s ? (JSON.parse(s) as T) : fallback);

// ---- account ----

export interface Account {
  equity: number;
  start: number;
  balance: number;
  open: number;
}

export function account(db: DB): Account {
  const hb = db.prepare("SELECT info FROM service_heartbeats WHERE service = 'trader'").get() as { info: string } | undefined;
  const acct = db.prepare("SELECT balance_sol, start_balance FROM paper_account WHERE id = 1").get() as { balance_sol: number; start_balance: number } | undefined;
  const balance = acct?.balance_sol ?? 0, start = acct?.start_balance ?? 1;
  const open = (db.prepare("SELECT count(*) n FROM paper_positions WHERE status IN ('pending', 'open')").get() as { n: number }).n;
  return { equity: json<{ equity?: number }>(hb?.info, {}).equity ?? balance, start, balance, open };
}

// ---- service health ----

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface PartHealth {
  health: Health;
  /** when it went down/off/silent, if known exactly */
  since: number | null;
  detail: string | null;
}

/**
 * Is a service up? Combines its run state (written at start, clean stop and crash), whether its
 * process still exists, and its heartbeat.
 */
export function partHealth(db: DB, service: string, now: number, staleMs: number): PartHealth {
  const run = db.prepare("SELECT state, pid, changed_at, detail FROM service_runs WHERE service = ?").get(service) as
    { state: string; pid: number | null; changed_at: number; detail: string | null } | undefined;
  const hb = db.prepare("SELECT ts, pid FROM service_heartbeats WHERE service = ?").get(service) as { ts: number; pid: number | null } | undefined;
  if (!run) {
    if (!hb) return { health: "unknown", since: null, detail: null };
    return now - hb.ts < staleMs ? { health: "up", since: null, detail: null } : { health: "frozen", since: hb.ts, detail: null };
  }
  if (run.state === "stopped") return { health: "off", since: run.changed_at, detail: null };
  if (run.state === "crashed") return { health: "down", since: run.changed_at, detail: run.detail };
  if (run.pid && !pidAlive(run.pid)) return { health: "down", since: null, detail: null }; // killed: no exact time
  const mine = hb && hb.pid === run.pid;
  const last = mine ? Math.max(hb.ts, run.changed_at) : run.changed_at;
  if (now - last > staleMs) return { health: "frozen", since: last, detail: null };
  return { health: mine ? "up" : "starting", since: null, detail: null };
}

export function statusFacts(db: DB, cfg: Config, now: number, quietUntil: number | null): StatusFacts {
  const staleMs = cfg.notifier.stale_after_s * 1000;
  const parts = [...cfg.notifier.watch_services, "notifier"].map((service) => {
    const h = service === "notifier" ? { health: "up" as Health, since: null } : partHealth(db, service, now, staleMs);
    return { service, health: h.health, since: h.since };
  });
  const col = db.prepare("SELECT ts, info FROM service_heartbeats WHERE service = 'collector'").get() as { ts: number; info: string } | undefined;
  let streams: StatusFacts["streams"] = null;
  if (col && now - col.ts < staleMs) {
    const i = json<{ streams?: Record<string, unknown>; heliusMbToday?: number; heliusCapMb?: number }>(col.info, {});
    const st = i.streams ?? {};
    const c = cfg.collector;
    const [h0] = c.firehose.hours_utc;
    const resume = utcDayStart(now) + h0 * HOUR;
    streams = {
      watching: !c.targeted.enabled ? "disabled" : st.targeted === true ? "on" : st.targeted === null ? "capped" : "reconnecting",
      discovery: !c.firehose.enabled ? "disabled" : st.firehose === true ? "on" : st.firehoseOff === "off-hours" ? "resting"
        : st.firehoseOff === "daily budget used" ? "budget_used" : "reconnecting",
      discoveryResumesAt: resume > now ? resume : resume + DAY,
      mbToday: i.heliusMbToday ?? 0,
      capMb: i.heliusCapMb ?? c.helius.daily_mb_cap,
    };
  }
  const tr = db.prepare("SELECT info FROM service_heartbeats WHERE service = 'trader'").get() as { info: string } | undefined;
  const risk = db.prepare("SELECT kill_switch, kill_reason, kill_at, halted_day FROM risk_state WHERE id = 1").get() as
    { kill_switch: number; kill_reason: string | null; kill_at: number | null; halted_day: string | null } | undefined;
  const trackedNow = (db.prepare("SELECT count(*) n FROM tracked_wallets WHERE active = 1").get() as { n: number }).n;
  const last = db.prepare("SELECT max(received_at) t FROM trades").get() as { t: number | null };
  return {
    parts,
    lastTradeAt: last.t,
    streams,
    tracked: tr ? trackedNow : null,
    open: account(db).open,
    killed: risk?.kill_switch ? { reason: risk.kill_reason, at: risk.kill_at } : null,
    halted: risk?.halted_day === new Date(now).toISOString().slice(0, 10),
    quietUntil,
  };
}

// ---- trades ----

export interface FillRow {
  id: number;
  side: string;
  ok: number;
  sol: number | null;
  slippage_bps: number | null;
  reason: string | null;
  mint: string;
  symbol: string | null;
  leader_wallet: string;
  cost_sol: number | null;
  proceeds_sol: number | null;
  pnl_sol: number | null;
  opened_at: number | null;
  closed_at: number | null;
  exit_reason: string | null;
  features: string | null;
}

export function fillsSince(db: DB, cursor: number): FillRow[] {
  return db.prepare(`SELECT f.id, f.side, f.ok, f.sol, f.slippage_bps, f.reason, p.mint, t.symbol, p.leader_wallet, p.cost_sol, p.proceeds_sol,
    p.pnl_sol, p.opened_at, p.closed_at, p.exit_reason, s.features
    FROM paper_fills f JOIN paper_positions p ON p.id = f.position_id LEFT JOIN tokens t ON t.mint = p.mint
    LEFT JOIN signals s ON s.id = p.signal_id WHERE f.id > ? ORDER BY f.id`).all(cursor) as FillRow[];
}

const tokenOf = (f: { mint: string; symbol: string | null }): TokenRef => ({ mint: f.mint, symbol: f.symbol });

export function buyFacts(db: DB, cfg: Config, f: FillRow): BuyFacts {
  const feat = json<Record<string, number | null>>(f.features, {});
  const ws = db.prepare("SELECT copy_roi, copy_trades FROM wallet_scores WHERE wallet = ? ORDER BY run_at DESC LIMIT 1").get(f.leader_wallet) as
    { copy_roi: number | null; copy_trades: number } | undefined;
  return {
    token: tokenOf(f),
    sizeSol: f.sol ?? 0,
    equity: account(db).equity,
    slippage: (f.slippage_bps ?? 0) / 10_000,
    trackedCount: (db.prepare("SELECT count(*) n FROM tracked_wallets WHERE active = 1").get() as { n: number }).n,
    walletRoi: ws?.copy_roi ?? null,
    walletTrades: ws?.copy_trades ?? null,
    confirmations: feat.confirmations ?? 1,
    windowS: cfg.signals.confirmation_window_s,
    tokenAgeS: feat.token_age_s ?? null,
    top10Pct: feat.top10_pct ?? null,
    devSoldFrac: feat.dev_sold_frac ?? null,
    maxTop10Pct: cfg.signals.max_top10_pct,
  };
}

export function sellFacts(db: DB, f: FillRow): SellFacts {
  const a = account(db);
  return {
    token: tokenOf(f), costSol: f.cost_sol ?? 0, proceedsSol: f.proceeds_sol ?? f.sol ?? 0, pnlSol: f.pnl_sol ?? 0,
    heldMs: (f.closed_at ?? 0) - (f.opened_at ?? 0), reason: f.exit_reason ?? f.reason, equity: a.equity, start: a.start,
    stopLossPct: RISK.STOP_LOSS_PCT, maxHoldMs: RISK.TIME_EXIT_MS,
  };
}

export function missedFacts(cfg: Config, f: FillRow): MissedFacts {
  return { token: tokenOf(f), reason: f.reason, feeSol: f.sol ?? 0, maxSlippage: cfg.paper.max_slippage_bps / 10_000 };
}

// ---- periods ----

export function period(db: DB, from: number, to: number): PeriodResult & { missed: number } {
  const r = db.prepare(`SELECT SUM(status = 'closed') closed, SUM(status = 'failed') missed, SUM(status = 'closed' AND pnl_sol > 0) wins,
    COALESCE(SUM(pnl_sol), 0) pnl FROM paper_positions WHERE status IN ('closed', 'failed') AND closed_at >= ? AND closed_at < ?`).get(from, to) as
    { closed: number | null; missed: number | null; wins: number | null; pnl: number };
  return { closed: r.closed ?? 0, missed: r.missed ?? 0, wins: r.wins ?? 0, pnl: r.pnl };
}

export function pnlFacts(db: DB, now: number): PnlFacts {
  const a = account(db);
  return { equity: a.equity, start: a.start, open: a.open, today: period(db, utcDayStart(now), now + 1), week: period(db, now - 7 * DAY, now + 1), all: period(db, 0, now + 1) };
}

function top(counts: Map<string, number>, n: number): Counted[] {
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([text, k]) => ({ text, n: k }));
}

/** What the signal engine did with tracked-wallet buys in [from, to). */
export function signalFacts(db: DB, from: number, to: number, topN = 3): Omit<ActivityFacts, "from" | "to"> {
  const rows = db.prepare("SELECT decision, reasons FROM signals WHERE ts >= ? AND ts < ?").all(from, to) as { decision: string; reasons: string }[];
  const skipped = new Map<string, number>(), blocked = new Map<string, number>();
  let copied = 0, skippedTotal = 0, blockedTotal = 0;
  for (const r of rows) {
    const reasons = json<string[]>(r.reasons, []);
    if (r.decision === "enter") copied++;
    else if (r.decision === "risk_block") {
      blockedTotal++;
      const t = M.explainSkip(reasons.find((x) => x.startsWith("risk:")) ?? "").short;
      blocked.set(t, (blocked.get(t) ?? 0) + 1);
    } else {
      skippedTotal++;
      const t = M.explainSkip(reasons[0] ?? "").short; // the first check it failed
      skipped.set(t, (skipped.get(t) ?? 0) + 1);
    }
  }
  return { buys: rows.length, copied, skipped: top(skipped, topN), skippedTotal, blocked: top(blocked, 2), blockedTotal };
}

export function reportFacts(db: DB, cfg: Config, from: number, to: number, opts: { dataDay: string | null }): ReportFacts {
  const a = account(db);
  const p = period(db, from, to);
  const extreme = (dir: "DESC" | "ASC") => db.prepare(`SELECT p.mint, t.symbol, p.pnl_sol pnl FROM paper_positions p LEFT JOIN tokens t ON t.mint = p.mint
    WHERE p.status = 'closed' AND p.closed_at >= ? AND p.closed_at < ? ORDER BY p.pnl_sol ${dir} LIMIT 1`).get(from, to) as
    { mint: string; symbol: string | null; pnl: number } | undefined;
  const slip = db.prepare(`SELECT AVG(f.slippage_bps) s FROM paper_fills f WHERE f.side = 'buy' AND f.ok = 1 AND f.ts >= ? AND f.ts < ?`).get(from, to) as { s: number | null };
  const exits = db.prepare(`SELECT exit_reason text, count(*) n FROM paper_positions WHERE status = 'closed' AND closed_at >= ? AND closed_at < ?
    GROUP BY exit_reason ORDER BY n DESC`).all(from, to) as Counted[];
  const scoring = db.prepare(`SELECT
      (SELECT count(*) FROM tracked_wallets WHERE active = 1) tracked,
      (SELECT count(*) FROM tracked_wallets WHERE added_at >= ? AND added_at < ?) added,
      (SELECT count(*) FROM tracked_wallets WHERE deactivated_at >= ? AND deactivated_at < ?) removed`).get(from, to, from, to) as
    { tracked: number; added: number; removed: number };
  let data: ReportFacts["data"] = null;
  if (opts.dataDay) {
    const u = db.prepare("SELECT COALESCE(SUM(bytes), 0) b FROM stream_usage WHERE day = ? AND source != 'pumpportal'").get(opts.dataDay) as { b: number };
    data = { mb: u.b / 1e6, capMb: cfg.collector.helius.daily_mb_cap };
  }
  const trouble = db.prepare(`SELECT source service, SUM(kind = 'restart') restarts, SUM(kind = 'error') errors FROM alerts
    WHERE kind IN ('restart', 'error') AND ts >= ? AND ts < ? GROUP BY source ORDER BY source`).all(from, to) as
    { service: string; restarts: number; errors: number }[];
  const all = period(db, 0, to);
  const risk = db.prepare("SELECT kill_switch FROM risk_state WHERE id = 1").get() as { kill_switch: number } | undefined;
  const best = extreme("DESC"), worst = extreme("ASC");
  return {
    from, to, equity: a.equity, start: a.start,
    period: { ...p, best: best ?? null, worst: worst ?? null, avgSlippage: slip.s === null ? null : slip.s / 10_000 },
    exits,
    ...signalFacts(db, from, to),
    wallets: scoring.tracked || scoring.added || scoring.removed ? scoring : null,
    data,
    trouble,
    verdict: { closedAllTime: all.closed, pnlAllTime: all.pnl, start: a.start, pnlLast7d: period(db, to - 7 * DAY, to).pnl },
    killed: !!risk?.kill_switch,
    stopLossPct: RISK.STOP_LOSS_PCT,
  };
}

// ---- /why ----

export type WhyResult =
  | { found: false }
  | { found: true; token: TokenRef; events: WhyEvent[]; total: number; sameName: number };

export function whyFacts(db: DB, query: string, limit = 8): WhyResult {
  const q = query.trim().replace(/^\$/, "");
  const candidates = db.prepare(`SELECT t.mint, t.symbol, (SELECT max(ts) FROM signals s WHERE s.mint = t.mint) last FROM tokens t
    WHERE t.mint = ? OR upper(t.symbol) = upper(?) ORDER BY last IS NULL, last DESC, t.created_at DESC`).all(q, q) as { mint: string; symbol: string | null }[];
  let tok: TokenRef | undefined = candidates[0];
  if (!tok && (db.prepare("SELECT 1 FROM signals WHERE mint = ? LIMIT 1").get(q))) tok = { mint: q, symbol: null };
  if (!tok) return { found: false };
  const total = (db.prepare("SELECT count(*) n FROM signals WHERE mint = ?").get(tok.mint) as { n: number }).n;
  const rows = db.prepare(`SELECT s.ts, s.decision, s.reasons, s.features, p.status, p.size_sol, p.closed_at, p.exit_reason, p.pnl_sol, p.cost_sol
    FROM signals s LEFT JOIN paper_positions p ON p.signal_id = s.id WHERE s.mint = ? ORDER BY s.ts DESC, s.id DESC LIMIT ?`).all(tok.mint, limit) as {
    ts: number; decision: WhyEvent["decision"]; reasons: string; features: string; status: string | null; size_sol: number | null;
    closed_at: number | null; exit_reason: string | null; pnl_sol: number | null; cost_sol: number | null;
  }[];
  const events: WhyEvent[] = rows.reverse().map((r) => ({
    at: r.ts,
    decision: r.decision,
    reasons: json<string[]>(r.reasons, []),
    confirmations: json<{ confirmations?: number }>(r.features, {}).confirmations ?? 1,
    position: r.status ? {
      status: r.status as NonNullable<WhyEvent["position"]>["status"], sizeSol: r.size_sol ?? 0, closedAt: r.closed_at,
      exitReason: r.exit_reason, pnlSol: r.pnl_sol, costSol: r.cost_sol,
    } : null,
  }));
  return { found: true, token: tok, events, total, sameName: candidates.length };
}
