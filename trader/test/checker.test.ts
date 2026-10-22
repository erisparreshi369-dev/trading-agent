import { describe, expect, it } from "vitest";
import { findMistakes, saveMistakes, type CheckContext } from "../src/checker/checks.js";
import type { DB } from "../src/lib/db.js";
import { RISK } from "../src/risk/limits.js";
import { key, memDb, testConfig } from "./helpers.js";

const T = Date.UTC(2026, 9, 22, 12, 0, 0);
const min = 60_000;
const cfg = testConfig({ paper: { follow_leader_exit: true, trailing_stop_pct: null } }); // the exit rules the checks below test
const DELAY = cfg.paper.execution_delay_ms;

/** Features of a real signal that passes the shipped filters. */
const GOOD = {
  venue: "curve", leader_buy_sol: 0.25, price: 5e-8, wallet_score: 0.04, token_known: true, token_age_s: 5, mayhem: false, dev_tokens_24h: 1,
  leader_is_dev: false, liquidity_sol: 9, confirmations: 1, onchain_checked: true, top10_pct: 20, dev_hold_pct: 3, dev_sold_frac: 0, score: 0.05,
  brain_active: false,
};

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return { signals: cfg.signals, paper: cfg.paper, limits: RISK, now: T, traderStartedAt: T - 3 * 60 * min, configChangedAt: T - 4 * 60 * min, ...over };
}

let sig = 0;
function trade(db: DB, o: { mint: string; wallet?: string; at: number; buy?: boolean; price?: number }): number {
  return Number(db.prepare(`INSERT INTO trades (signature, ev_index, received_at, mint, wallet, is_buy, sol_lamports, token_amount, price_sol, source, venue)
    VALUES (?, 0, ?, ?, ?, ?, 0, 0, ?, 'test', 'curve')`).run(`sig${++sig}`, o.at, o.mint, o.wallet ?? key(), o.buy === false ? 0 : 1, o.price ?? 1e-7).lastInsertRowid);
}

interface Pos {
  at?: number; // the copied buy
  status?: "pending" | "open" | "closed" | "failed";
  features?: Record<string, unknown>;
  exitAt?: number | null; // when it decided to sell
  trigger?: string;
  entryPrice?: number;
}

/** A leader buy, the signal, and our position opened DELAY later at 1e-7. Returns ids and names. */
function position(db: DB, o: Pos = {}) {
  const at = o.at ?? T - 20 * min;
  const mint = key();
  const leader = key();
  const tid = trade(db, { mint, wallet: leader, at });
  const signalId = Number(db.prepare(`INSERT INTO signals (ts, wallet, mint, leader_trade_id, venue, score, decision, reasons, features)
    VALUES (?, ?, ?, ?, 'curve', 0.05, 'enter', '[]', ?)`).run(at, leader, mint, tid, JSON.stringify(o.features ?? GOOD)).lastInsertRowid);
  const status = o.status ?? "closed";
  const opened = status === "pending" ? null : at + DELAY;
  const exitDue = o.exitAt === undefined ? (status === "closed" ? at + 5 * min + DELAY : null) : o.exitAt === null ? null : o.exitAt + DELAY;
  const closed = status === "closed";
  const id = Number(db.prepare(`INSERT INTO paper_positions (signal_id, mint, leader_wallet, status, size_sol, leader_price, entry_due_at, exit_due_at, exit_trigger,
    opened_at, cost_sol, entry_price, closed_at, proceeds_sol, pnl_sol) VALUES (?, ?, ?, ?, 0.02, 1e-7, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    signalId, mint, leader, status, at + DELAY, exitDue, exitDue ? o.trigger ?? "leader_exit" : null, opened, opened ? 0.02 : null,
    opened ? o.entryPrice ?? 1e-7 : null, closed ? exitDue : null, closed ? 0.019 : null, closed ? -0.001 : null).lastInsertRowid);
  if (opened) db.prepare("INSERT INTO paper_fills (position_id, ts, side, venue, ok, slippage_bps) VALUES (?, ?, 'buy', 'curve', 1, 10)").run(id, opened);
  return { id, mint, leader, at, opened };
}

const kinds = (db: DB, x = ctx()) => findMistakes(db, x).map((m) => m.kind).sort();

describe("mistake checker", () => {
  it("finds nothing wrong in a trade that followed every rule", () => {
    const db = memDb();
    const p = position(db);
    trade(db, { mint: p.mint, wallet: p.leader, at: p.at + 5 * min, buy: false }); // the leader sold, we followed at once
    expect(kinds(db)).toEqual([]);
  });

  it("flags a buy the filters reject, with the reason", () => {
    const db = memDb();
    position(db, { features: { ...GOOD, leader_buy_sol: 0.05 } });
    const [m] = findMistakes(db, ctx());
    expect(m!.kind).toBe("bad_entry");
    expect(m!.text).toContain("leader buy 0.050 < 0.1 SOL");
  });

  it("doesn't blame a buy on a filter that changed afterwards, or on rules from before the trader started", () => {
    const db = memDb();
    const p = position(db, { features: { ...GOOD, leader_buy_sol: 0.05 } });
    db.prepare("INSERT INTO alerts (ts, level, kind, source, text, data) VALUES (?, 'info', 'setting_changed', 'dashboard', 'x', ?)")
      .run(p.at + min, JSON.stringify({ setting: "signals.min_leader_buy_sol" }));
    expect(kinds(db)).toEqual([]);
    const db2 = memDb();
    const q = position(db2, { features: { ...GOOD, leader_buy_sol: 0.05 } });
    expect(kinds(db2, ctx({ traderStartedAt: q.at + 1 }))).toEqual([]);
    expect(kinds(db2, ctx({ configChangedAt: T }))).toEqual([]); // config.yaml edited since the trader started
  });

  it("flags a stop loss that fired late, not one that fired on time", () => {
    const db = memDb();
    const late = position(db, { exitAt: T - 10 * min, trigger: "stop_loss" });
    trade(db, { mint: late.mint, at: late.opened! + min, price: 0.7e-7 }); // -30% four minutes before it sold
    const onTime = position(db, { exitAt: T - 10 * min, trigger: "stop_loss" });
    trade(db, { mint: onTime.mint, at: T - 10 * min - 2_000, price: 0.7e-7 });
    const found = findMistakes(db, ctx());
    expect(found.map((m) => [m.kind, m.positionId])).toEqual([["missed_stop", late.id]]);
    expect(found[0]!.text).toContain("price fell 30%, stop is 25%");
  });

  it("flags the copied trader selling before our buy filled, and the trade then held to the time limit", () => {
    const db = memDb();
    const at = T - 60 * min;
    const p = position(db, { at, exitAt: at + DELAY + RISK.TIME_EXIT_MS, trigger: "time_exit" });
    trade(db, { mint: p.mint, wallet: p.leader, at: p.at + 300, buy: false }); // sold 0.3 s after buying
    const [m] = findMistakes(db, ctx());
    expect(m!.kind).toBe("missed_leader_exit");
    expect(m!.text).toContain("sold 30 min later");
  });

  it("with the trailing stop on: flags a sell that came late after the price fell from its best", () => {
    const db = memDb();
    const x = ctx({ paper: { ...cfg.paper, follow_leader_exit: false, trailing_stop_pct: 20 } });
    const late = position(db, { exitAt: T - 10 * min, trigger: "trailing_stop" });
    trade(db, { mint: late.mint, at: late.opened! + 10_000, price: 3e-7 }); // 3x
    trade(db, { mint: late.mint, at: late.opened! + 20_000, price: 2.2e-7 }); // -27% from the top, minutes before it sold
    const onTime = position(db, { exitAt: T - 10 * min, trigger: "trailing_stop" });
    trade(db, { mint: onTime.mint, at: T - 10 * min - 1_000, price: 0.75e-7 });
    expect(findMistakes(db, x).map((m) => [m.kind, m.positionId])).toEqual([["missed_trailing", late.id]]);
  });

  it("flags an open trade past the time limit, and a buy stuck pending", () => {
    const db = memDb();
    position(db, { status: "open", at: T - RISK.TIME_EXIT_MS - 3 * min });
    position(db, { status: "pending", at: T - 5 * min });
    expect(kinds(db)).toEqual(["held_too_long", "stuck_buy"]);
  });

  it("flags a buy above the slippage limit", () => {
    const db = memDb();
    const p = position(db);
    db.prepare("UPDATE paper_fills SET slippage_bps = ? WHERE position_id = ?").run(cfg.paper.max_slippage_bps + 200, p.id);
    expect(kinds(db)).toEqual(["over_slippage"]);
  });

  it("checks the money: each trade, and the balance against all trades", () => {
    const db = memDb();
    const p = position(db);
    db.prepare("INSERT OR REPLACE INTO paper_account (id, balance_sol, start_balance, created_at) VALUES (1, ?, 1, 0)").run(1 - 0.001);
    expect(kinds(db)).toEqual([]);
    db.prepare("UPDATE paper_positions SET pnl_sol = 0.005 WHERE id = ?").run(p.id);
    expect(kinds(db)).toEqual(["money_account", "money_trade"]);
  });

  it("flags a buy while both streams that watch our traders were down", () => {
    const db = memDb();
    const p = position(db);
    db.prepare("INSERT INTO collector_gaps (source, started_at, ended_at, reason) VALUES ('targeted', ?, ?, 'daily cap reached')").run(p.at - 10 * min, p.at + min);
    expect(kinds(db)).toEqual([]); // the firehose was still on
    db.prepare("INSERT INTO collector_gaps (source, started_at, ended_at, reason) VALUES ('firehose', ?, NULL, 'off-hours')").run(p.at - 60 * min);
    expect(kinds(db)).toEqual(["blind"]);
  });

  it("stores each problem once", () => {
    const db = memDb();
    position(db, { features: { ...GOOD, leader_buy_sol: 0.05 } });
    expect(saveMistakes(db, findMistakes(db, ctx()), T, true)).toHaveLength(1);
    expect(saveMistakes(db, findMistakes(db, ctx()), T + min, true)).toHaveLength(0);
    expect(db.prepare("SELECT alerted FROM mistakes").get()).toEqual({ alerted: 1 });
  });
});
