import type { PaperConfig, SignalsConfig } from "../lib/config.js";
import type { DB } from "../lib/db.js";
import { COLLECTOR_SILENT_MS } from "../paper/engine.js";
import type { RiskLimits } from "../risk/limits.js";
import { rejectReasons, type Features } from "../signals/filters.js";

/**
 * THE MISTAKE CHECKER: did the paper trader break its own rules? Each check replays a rule on what
 * the database recorded (the same filter code, the same stop loss, the same time limit) and flags a
 * trade only when the rule was clearly broken. A losing trade is not a mistake; a rule not followed is.
 *
 * Rules change (dashboard limits, config.yaml): a check is skipped for a trade when the setting it
 * uses changed after that trade started, so the bot is never blamed for a rule it didn't have yet.
 */
export const KINDS = {
  bad_entry: "bought a coin its filters say no to",
  over_slippage: "bought although the price had moved more than the limit",
  missed_stop: "didn't sell at the stop loss",
  missed_leader_exit: "didn't sell when the copied trader sold",
  missed_trailing: "didn't sell when the price fell from its best",
  held_too_long: "held a trade past the time limit",
  stuck_buy: "never finished a buy",
  stuck_sell: "never finished a sell",
  money_trade: "got a trade's profit math wrong",
  money_account: "got its balance math wrong",
  negative_balance: "spent more than it had",
  blind: "bought while it couldn't see the market",
} as const;
export type MistakeKind = keyof typeof KINDS;

export interface Mistake {
  key: string; // "<kind>:<position id>": the same problem is found once
  positionId: number | null;
  kind: MistakeKind;
  text: string;
  data: Record<string, unknown>;
}

export interface CheckContext {
  signals: SignalsConfig;
  paper: PaperConfig;
  limits: RiskLimits;
  now: number;
  /** When the running trader started (service_runs), null if unknown: entry rules are only rechecked after it. */
  traderStartedAt: number | null;
  /** config.yaml's last change (ms). Newer than the trader's start = the trader runs older rules than the file. */
  configChangedAt: number;
}

/** How long the trader may take to react to a trade that landed (it polls; restarts take a few seconds). */
export const REACT_MS = 10_000;
/** Slack on the time limit: the tick runs every ~250 ms, the fill waits for the data. */
export const HOLD_GRACE_MS = 60_000;
/** A buy due this long ago and still pending is stuck. */
export const PENDING_GRACE_MS = 60_000;
/** A sell may wait up to 10 min for a migrated coin's pool (engine MIGRATION_WAIT_MS); stuck after this. */
export const SELL_STUCK_MS = 12 * 60_000;
/** A dashboard change takes up to ~5 s to reach the trader (overrides.ts); treat changes this close as "before". */
const SETTING_LAG_MS = 10_000;
const SOL_EPS = 1e-6;

interface PositionRow {
  id: number;
  signal_id: number;
  mint: string;
  leader_wallet: string;
  status: "pending" | "open" | "closed" | "failed";
  size_sol: number;
  entry_due_at: number;
  exit_due_at: number | null;
  exit_trigger: string | null;
  opened_at: number | null;
  cost_sol: number | null;
  entry_price: number | null;
  closed_at: number | null;
  proceeds_sol: number | null;
  pnl_sol: number | null;
  features: string | null;
  leader_at: number | null; // when the copied buy landed
  symbol: string | null;
}

export function findMistakes(db: DB, x: CheckContext): Mistake[] {
  const positions = db.prepare(`SELECT p.*, s.features, t.received_at leader_at, k.symbol FROM paper_positions p
    LEFT JOIN signals s ON s.id = p.signal_id LEFT JOIN trades t ON t.id = s.leader_trade_id LEFT JOIN tokens k ON k.mint = p.mint
    ORDER BY p.id`).all() as PositionRow[];
  const out: Mistake[] = [];
  const add = (p: PositionRow | null, kind: MistakeKind, why: string, data: Record<string, unknown> = {}) =>
    out.push({ key: `${kind}:${p?.id ?? "account"}`, positionId: p?.id ?? null, kind, text: `${p ? `${coin(p)}: ` : ""}${KINDS[kind]} (${why})`, data });
  const changed = settingChangedSince(db);
  const rulesKnown = (at: number) => x.traderStartedAt !== null && x.configChangedAt <= x.traderStartedAt && at >= x.traderStartedAt;

  for (const p of positions) {
    const at = p.leader_at ?? p.entry_due_at - x.paper.execution_delay_ms;
    // the moment the trader decided to sell (triggerExit: due = max(at, opened_at) + delay)
    const trigger = p.exit_due_at === null ? null : p.exit_due_at - x.paper.execution_delay_ms;

    // ---- entry: the filters, replayed on the features stored with the signal ----
    if (p.features && rulesKnown(at) && !changed(["signals."], at)) {
      const f = JSON.parse(p.features) as Features;
      const reasons = rejectReasons(f, x.signals, inCooldown(db, p, at, x.signals.reentry_cooldown_s), [], at);
      if (reasons.length) add(p, "bad_entry", reasons.join("; "), { reasons });
    }
    if (p.status !== "pending" && p.leader_at !== null && wasBlind(db, at)) add(p, "blind", "the data feed was down when it bought", { at });

    if (p.status === "pending") {
      if (x.now > p.entry_due_at + PENDING_GRACE_MS) add(p, "stuck_buy", `pending ${mins(x.now - p.entry_due_at)} past its time`, { entry_due_at: p.entry_due_at });
      continue;
    }
    if (p.status === "failed" || p.opened_at === null || p.entry_price === null) continue;

    const buy = db.prepare("SELECT ts, slippage_bps FROM paper_fills WHERE position_id = ? AND side = 'buy' AND ok = 1 ORDER BY id LIMIT 1")
      .get(p.id) as { ts: number; slippage_bps: number | null } | undefined;
    if (buy?.slippage_bps != null && buy.slippage_bps > x.paper.max_slippage_bps + 0.5 && rulesKnown(buy.ts) && !changed(["paper.max_slippage_bps"], buy.ts)) {
      add(p, "over_slippage", `${Math.round(buy.slippage_bps)} bps, limit ${x.paper.max_slippage_bps}`, { slippage_bps: buy.slippage_bps, limit: x.paper.max_slippage_bps });
    }

    // ---- exits: the first moment a rule said "sell" vs when it did ----
    const end = trigger ?? x.now;
    if (!changed(["risk.STOP_LOSS_PCT", "risk.PAPER_NO_LIMITS"], p.opened_at)) {
      const stopPrice = p.entry_price * (1 - x.limits.STOP_LOSS_PCT);
      const hit = db.prepare(`SELECT received_at, price_sol FROM trades WHERE mint = ? AND received_at >= ? AND received_at < ? AND price_sol IS NOT NULL
        AND price_sol <= ? ORDER BY received_at LIMIT 1`).get(p.mint, p.opened_at, end, stopPrice) as { received_at: number; price_sol: number } | undefined;
      if (hit && late(hit.received_at, trigger, x.now)) {
        add(p, "missed_stop", `price fell ${pct(1 - hit.price_sol / p.entry_price)}, stop is ${pct(x.limits.STOP_LOSS_PCT)}; ${reaction(hit.received_at, trigger)}`,
          { hit_at: hit.received_at, trigger_at: trigger, stop: x.limits.STOP_LOSS_PCT });
      }
    }
    const trail = x.paper.trailing_stop_pct;
    if (trail !== null && rulesKnown(p.opened_at)) {
      // the engine's rule: peak = max(entry, every price since we bought); sell once a price is trail% below it
      let peak = p.entry_price;
      const tape = db.prepare(`SELECT received_at, price_sol FROM trades WHERE mint = ? AND received_at >= ? AND received_at < ? AND price_sol IS NOT NULL
        ORDER BY received_at, id`).all(p.mint, p.opened_at, end) as { received_at: number; price_sol: number }[];
      for (const t of tape) {
        peak = Math.max(peak, t.price_sol);
        if (t.price_sol > peak * (1 - trail / 100)) continue;
        if (late(t.received_at, trigger, x.now)) {
          add(p, "missed_trailing", `price fell ${pct(1 - t.price_sol / peak)} from its best, limit ${trail}%; ${reaction(t.received_at, trigger)}`,
            { hit_at: t.received_at, trigger_at: trigger, peak, trail });
        }
        break;
      }
    }
    if (x.paper.follow_leader_exit && p.leader_at !== null) {
      const sell = db.prepare(`SELECT received_at FROM trades WHERE mint = ? AND wallet = ? AND is_buy = 0 AND received_at > ? AND received_at < ?
        ORDER BY received_at LIMIT 1`).get(p.mint, p.leader_wallet, p.leader_at, end) as { received_at: number } | undefined;
      const due = sell && Math.max(sell.received_at, p.opened_at);
      if (due && late(due, trigger, x.now)) add(p, "missed_leader_exit", reaction(due, trigger), { sell_at: sell!.received_at, trigger_at: trigger });
    }
    if (!changed(["risk.TIME_EXIT_MS", "risk.PAPER_NO_LIMITS"], p.opened_at)) {
      const limit = p.opened_at + x.limits.TIME_EXIT_MS;
      if (end > limit + HOLD_GRACE_MS) {
        add(p, "held_too_long", `${trigger === null ? "still holding after" : "held"} ${mins(end - p.opened_at)}, limit ${mins(x.limits.TIME_EXIT_MS)}`,
          { opened_at: p.opened_at, trigger_at: trigger, limit_ms: x.limits.TIME_EXIT_MS });
      }
    }
    if (p.status === "open" && p.exit_due_at !== null && x.now > p.exit_due_at + SELL_STUCK_MS) {
      add(p, "stuck_sell", `decided to sell ${mins(x.now - p.exit_due_at)} ago`, { exit_due_at: p.exit_due_at, trigger: p.exit_trigger });
    }
    if (p.status === "closed" && p.pnl_sol !== null && p.proceeds_sol !== null && p.cost_sol !== null && Math.abs(p.pnl_sol - (p.proceeds_sol - p.cost_sol)) > 1e-9) {
      add(p, "money_trade", `result ${p.pnl_sol} SOL, but sold for ${p.proceeds_sol} after paying ${p.cost_sol}`, { pnl: p.pnl_sol, proceeds: p.proceeds_sol, cost: p.cost_sol });
    }
  }

  // ---- the account: start + every result - money in open trades = balance ----
  const acct = db.prepare("SELECT balance_sol, start_balance FROM paper_account WHERE id = 1").get() as { balance_sol: number; start_balance: number } | undefined;
  if (acct) {
    let expected = acct.start_balance;
    for (const p of positions) {
      if (p.status === "closed" || p.status === "failed") expected += p.pnl_sol ?? 0;
      else if (p.status === "open") expected -= p.cost_sol ?? p.size_sol;
      else expected -= p.size_sol;
    }
    const diff = acct.balance_sol - expected;
    if (Math.abs(diff) > SOL_EPS) {
      out.push({ key: `money_account:${diff.toFixed(6)}`, positionId: null, kind: "money_account",
        text: `${KINDS.money_account} (balance ${acct.balance_sol.toFixed(6)} SOL, trades say ${expected.toFixed(6)})`, data: { balance: acct.balance_sol, expected, diff } });
    }
    if (acct.balance_sol < -SOL_EPS) {
      out.push({ key: `negative_balance:${new Date(x.now).toISOString().slice(0, 10)}`, positionId: null, kind: "negative_balance",
        text: `${KINDS.negative_balance} (balance ${acct.balance_sol.toFixed(4)} SOL)`, data: { balance: acct.balance_sol } });
    }
  }
  return out;
}

/** Store new findings; returns the ones not seen before. `alert` = queue them for Telegram (false on the first run: history). */
export function saveMistakes(db: DB, found: Mistake[], now: number, alert: boolean): Mistake[] {
  const ins = db.prepare(`INSERT INTO mistakes (key, found_at, position_id, kind, text, data, alerted) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO NOTHING`);
  const fresh: Mistake[] = [];
  db.transaction(() => {
    for (const m of found) if (ins.run(m.key, now, m.positionId, m.kind, m.text, JSON.stringify(m.data), alert ? 1 : 0).changes) fresh.push(m);
  })();
  return fresh;
}

/** Was the re-entry cooldown on for this signal? Same rule as signals/engine.ts, from what was in the book at that moment. */
function inCooldown(db: DB, p: PositionRow, at: number, cooldownS: number): boolean {
  const rows = db.prepare("SELECT closed_at, entry_due_at FROM paper_positions WHERE mint = ? AND id < ?").all(p.mint, p.id) as { closed_at: number | null; entry_due_at: number }[];
  let last: number | null = null;
  for (const r of rows) {
    const ts = r.closed_at !== null && r.closed_at <= at ? r.closed_at : r.entry_due_at;
    if (last === null || ts > last) last = ts;
  }
  return last !== null && at - last < cooldownS * 1000;
}

/** Did a dashboard setting starting with one of `prefixes` change at or after `at` (or just before it)? */
function settingChangedSince(db: DB): (prefixes: string[], at: number) => boolean {
  const rows = db.prepare("SELECT ts, json_extract(data, '$.setting') setting FROM alerts WHERE kind = 'setting_changed'").all() as { ts: number; setting: string | null }[];
  return (prefixes, at) => rows.some((r) => r.ts >= at - SETTING_LAG_MS && !!r.setting && prefixes.some((pre) => r.setting!.startsWith(pre)));
}

/**
 * Blind = what paper/engine.ts blindReason() refuses to trade on: the collector down, or neither
 * the targeted stream nor the firehose watching. Counted only once the trader could have noticed.
 */
function wasBlind(db: DB, at: number): boolean {
  const covering = (source: string, notice: number) => db.prepare(`SELECT started_at FROM collector_gaps WHERE source = ? AND started_at + ? <= ?
    AND COALESCE(ended_at, ?) >= ? LIMIT 1`).get(source, notice, at, at, at) as { started_at: number } | undefined;
  if (covering("all", COLLECTOR_SILENT_MS + 30_000)) return true;
  return !!covering("targeted", 60_000) && !!covering("firehose", 60_000);
}

/** A rule said "sell" at `due`: was the sell decided more than REACT_MS later (or not at all, and it's been that long)? */
function late(due: number, trigger: number | null, now: number): boolean {
  return trigger === null ? now - due > REACT_MS : trigger - due > REACT_MS;
}

function reaction(due: number, trigger: number | null): string {
  return trigger === null ? "it never sold" : `sold ${secs(trigger - due)} later`;
}

const coin = (p: PositionRow) => (p.symbol ? `$${p.symbol}` : `coin ${p.mint.slice(0, 4)}…`) + ` (trade #${p.id})`;
const pct = (f: number) => `${Math.round(f * 100)}%`;
const secs = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)}s` : mins(ms));
const mins = (ms: number) => (ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
