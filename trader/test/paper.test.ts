import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DB } from "../src/lib/db.js";
import { INGEST_MARGIN_MS, PaperEngine, type Position } from "../src/paper/engine.js";
import { RISK } from "../src/risk/limits.js";
import { RiskManager } from "../src/risk/risk-manager.js";
import { simulateBuy, simulateSell, stateFromTrade, type CostModel } from "../src/sim/market.js";
import { clock, Curve, key, memDb, testConfig } from "./helpers.js";

const cfg = testConfig().paper; // 1 SOL, 1500ms delay, the shipped cost model
const costs: CostModel = {
  priorityFeeSol: cfg.priority_fee_sol, executorFeeBps: cfg.executor_fee_bps,
  extraSlippageBps: cfg.extra_slippage_bps, tokenAccountRentSol: cfg.token_account_rent_sol,
};

function setup() {
  const db = memDb();
  const c = clock();
  const killFile = join(mkdtempSync(join(tmpdir(), "kill-")), "KILL");
  const risk = new RiskManager(db, killFile, c.now);
  const engine = new PaperEngine(db, cfg, risk, c.now);
  engine.init();
  const curve = new Curve(db, key(), key(), c.t - 60_000).insertToken();
  const leader = key();
  const events: string[] = [];
  engine.on((e) => events.push(e.type));
  return { db, c, risk, engine, curve, leader, killFile, events };
}

function signal(db: DB, mint: string): number {
  return Number(db.prepare("INSERT INTO signals (ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (0,'w',?,0,'curve','enter','[]','{}')")
    .run(mint).lastInsertRowid);
}

/** Leader buys now; we accept the signal. */
function leaderBuys(s: ReturnType<typeof setup>, sol = 1) {
  const at = s.c.t;
  s.curve.buy(s.leader, sol, at);
  const t = s.db.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT 1").get() as never;
  for (const row of [t]) s.engine.onTrade(row);
  const d = s.engine.enter(signal(s.db, s.curve.mint), { mint: s.curve.mint, wallet: s.leader, venue: "curve", received_at: at, price_sol: s.curve.price });
  return { at, decision: d };
}

/** Insert a trade and feed it to the engine, like the trader loop does. */
function feed(s: ReturnType<typeof setup>, fn: () => unknown) {
  const before = (s.db.prepare("SELECT COALESCE(MAX(id),0) m FROM trades").get() as { m: number }).m;
  fn();
  for (const t of s.db.prepare("SELECT * FROM trades WHERE id > ? ORDER BY id").all(before) as never[]) s.engine.onTrade(t);
}

const pos = (db: DB) => db.prepare("SELECT * FROM paper_positions ORDER BY id DESC LIMIT 1").get() as Position;
const balance = (e: PaperEngine) => e.account().balance;
const stateNow = (db: DB, mint: string, at: number) =>
  stateFromTrade(db.prepare("SELECT * FROM trades WHERE mint = ? AND received_at <= ? ORDER BY received_at DESC, id DESC LIMIT 1").get(mint, at) as never)!;

describe("PaperEngine entries", () => {
  it("fills at the market as it was after the execution delay, not at the leader's price", () => {
    const s = setup();
    const { at } = leaderBuys(s);
    expect(pos(s.db).status).toBe("pending");
    expect(balance(s.engine)).toBeCloseTo(1 - 0.02, 12); // reserved immediately

    s.curve.movePrice(1.05, at + 1_000); // other buyers land inside our delay window
    s.curve.movePrice(1.05, at + 2_000); // ...and after it (must NOT affect our fill)
    const expected = simulateBuy(stateNow(s.db, s.curve.mint, at + cfg.execution_delay_ms), 0.02, costs)!;

    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS - 1);
    s.engine.tick();
    expect(pos(s.db).status).toBe("pending"); // waits for late-arriving trades
    s.c.advance(1);
    s.engine.tick();
    const p = pos(s.db);
    expect(p).toMatchObject({ status: "open", tokens: expected.tokens, cost_sol: 0.02, opened_at: at + cfg.execution_delay_ms });
    expect(p.entry_price).toBeCloseTo(expected.price, 15);
    const fill = s.db.prepare("SELECT * FROM paper_fills").get() as { slippage_bps: number; delay_ms: number; ok: number };
    expect(fill).toMatchObject({ ok: 1, delay_ms: 1500 });
    expect(fill.slippage_bps).toBeGreaterThan(400); // the 5% move happened before we landed
    expect(s.events).toEqual(["entry"]);
  });

  it("fails the order when price ran past the slippage limit, and charges only the network fee", () => {
    const s = setup();
    const { at } = leaderBuys(s);
    s.curve.movePrice(1.2, at + 500); // +20% > 15% limit
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    s.engine.tick();
    expect(pos(s.db)).toMatchObject({ status: "failed", exit_reason: expect.stringMatching(/slippage/) });
    expect(pos(s.db).pnl_sol).toBeCloseTo(-cfg.priority_fee_sol, 12);
    expect(balance(s.engine)).toBeCloseTo(1 - cfg.priority_fee_sol, 12);
    expect(s.events).toEqual(["entry_failed"]);
  });

  it("does not enter the same token twice", () => {
    const s = setup();
    leaderBuys(s);
    const again = s.engine.enter(signal(s.db, s.curve.mint), { mint: s.curve.mint, wallet: key(), venue: "curve", received_at: s.c.t, price_sol: 1 });
    expect(again).toEqual({ ok: false, reason: "already in this token" });
  });

  it("puts the token on the collector's watchlist", () => {
    const s = setup();
    leaderBuys(s);
    expect(s.db.prepare("SELECT kind, mint, priority FROM watchlist").get()).toEqual({ kind: "curve", mint: s.curve.mint, priority: 1 });
  });
});

describe("PaperEngine accounting", () => {
  it("round trip at an unchanged price loses exactly the modelled costs, rent comes back", () => {
    const s = setup();
    const { at } = leaderBuys(s);
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    s.engine.tick();
    const open = pos(s.db);
    const entryState = stateNow(s.db, s.curve.mint, at + cfg.execution_delay_ms);
    // leader sells a tiny amount: we follow
    feed(s, () => s.curve.sell(s.leader, 1_000_000, s.c.t));
    const exitState = stateNow(s.db, s.curve.mint, s.c.t + cfg.execution_delay_ms);
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    s.engine.tick();
    const closed = pos(s.db);
    const sell = simulateSell(exitState, open.tokens!, costs);
    expect(closed).toMatchObject({ status: "closed", exit_reason: "leader_exit" });
    expect(closed.proceeds_sol).toBeCloseTo(sell.netSol + cfg.token_account_rent_sol, 12);
    expect(closed.pnl_sol).toBeCloseTo(closed.proceeds_sol! - 0.02, 12);
    expect(balance(s.engine)).toBeCloseTo(1 - 0.02 + closed.proceeds_sol!, 12);
    // sanity on magnitude: ~2x(1.25% venue + 0.5% executor + 0.0003 priority) + impact on 0.02 SOL
    expect(closed.pnl_sol!).toBeLessThan(0);
    expect(closed.pnl_sol! / 0.02).toBeGreaterThan(-0.08);
    expect(entryState.price).toBeGreaterThan(0);
    expect(s.engine.live()).toEqual([]);
  });

  it("equity counts reserved, open and free SOL", () => {
    const s = setup();
    leaderBuys(s);
    expect(s.engine.equity()).toBeCloseTo(1, 12); // pending: reserved counts at face value
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    s.engine.tick();
    const eq = s.engine.equity();
    expect(eq).toBeLessThan(1); // marked at what it would sell for, after costs
    expect(eq).toBeGreaterThan(0.99);
  });
});

describe("PaperEngine exits", () => {
  function opened() {
    const s = setup();
    leaderBuys(s);
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    s.engine.tick();
    return s;
  }

  it("stop loss triggers on the trade that crosses it and fills after the delay", () => {
    const s = opened();
    const entry = pos(s.db).entry_price!;
    feed(s, () => s.curve.movePrice(0.8, s.c.t)); // -20%: hold
    expect(pos(s.db).exit_trigger).toBeNull();
    const crossAt = s.c.t + 100;
    feed(s, () => s.curve.movePrice(0.85, crossAt)); // now ~-32% from entry
    expect(s.curve.price).toBeLessThan(entry * (1 - RISK.STOP_LOSS_PCT));
    expect(pos(s.db)).toMatchObject({ exit_trigger: "stop_loss", exit_due_at: crossAt + cfg.execution_delay_ms });
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS + 100);
    s.engine.tick();
    expect(pos(s.db)).toMatchObject({ status: "closed", exit_reason: "stop_loss" });
    expect(pos(s.db).pnl_sol!).toBeLessThan(-0.005);
  });

  it("time exit after 30 minutes", () => {
    const s = opened();
    const openedAt = pos(s.db).opened_at!;
    s.c.t = openedAt + RISK.TIME_EXIT_MS - 1;
    s.engine.tick();
    expect(pos(s.db).exit_trigger).toBeNull();
    s.c.t = openedAt + RISK.TIME_EXIT_MS;
    s.engine.tick();
    expect(pos(s.db)).toMatchObject({ exit_trigger: "time_exit", exit_due_at: openedAt + RISK.TIME_EXIT_MS + cfg.execution_delay_ms });
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    s.engine.tick();
    expect(pos(s.db).status).toBe("closed");
  });

  it("follows a leader who sold while our buy was still in flight", () => {
    const s = setup();
    const { at } = leaderBuys(s);
    feed(s, () => s.curve.sell(s.leader, 1_000_000, at + 300));
    expect(pos(s.db).leader_exited_at).toBe(at + 300);
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    s.engine.tick();
    expect(pos(s.db)).toMatchObject({ status: "open", exit_trigger: "leader_exit" });
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    s.engine.tick();
    expect(pos(s.db).status).toBe("closed");
  });

  it("ignores other wallets selling", () => {
    const s = opened();
    feed(s, () => s.curve.sell(key(), 1_000_000, s.c.t));
    expect(pos(s.db).exit_trigger).toBeNull();
  });
});

describe("PaperEngine kill switch and restarts", () => {
  it("kill switch flattens open positions, refunds pending ones, and blocks entries", () => {
    const s = setup();
    leaderBuys(s); // will be open
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    s.engine.tick();
    const other = new Curve(s.db, key(), key(), s.c.t - 60_000).insertToken();
    other.buy(s.leader, 1, s.c.t);
    s.engine.enter(signal(s.db, other.mint), { mint: other.mint, wallet: s.leader, venue: "curve", received_at: s.c.t, price_sol: other.price });
    const balBefore = balance(s.engine);
    const reserved = (s.db.prepare("SELECT size_sol FROM paper_positions WHERE status = 'pending'").get() as { size_sol: number }).size_sol;
    expect(reserved).toBeLessThan(0.02); // 2% of equity, and equity is marked after exit costs

    writeFileSync(s.killFile, "");
    s.engine.tick();
    const rows = s.db.prepare("SELECT mint, status, exit_trigger, exit_reason FROM paper_positions ORDER BY id").all() as Position[];
    expect(rows[0]).toMatchObject({ status: "open", exit_trigger: "kill_switch" });
    expect(rows[1]).toMatchObject({ status: "failed", exit_reason: "kill switch" });
    expect(balance(s.engine)).toBeCloseTo(balBefore + reserved, 12); // pending refunded in full
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    s.engine.tick();
    expect(s.engine.live()).toEqual([]);
    const third = new Curve(s.db).insertToken();
    expect(s.engine.enter(signal(s.db, third.mint), { mint: third.mint, wallet: s.leader, venue: "curve", received_at: s.c.t, price_sol: 1 }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/kill switch/) });
  });

  it("a restarted engine picks up a pending fill from the database", () => {
    const s = setup();
    leaderBuys(s);
    const fresh = new PaperEngine(s.db, cfg, s.risk, s.c.now); // process restarted
    fresh.init(); // must not reset the balance
    expect(fresh.account().balance).toBeCloseTo(0.98, 12);
    s.c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    fresh.tick();
    expect(pos(s.db).status).toBe("open");
  });

  it("daily loss cap blocks new entries but leaves exits running", () => {
    const s = setup();
    s.db.prepare("UPDATE paper_account SET balance_sol = 0.9 WHERE id = 1").run(); // lost 10% "today"
    s.risk.tick({ equity: 1, startBalance: 1 }); // the day had started at 1.0
    s.engine.tick();
    expect(s.risk.haltedToday()).toBe(true);
    expect(leaderBuys(s).decision).toEqual({ ok: false, reason: "daily loss cap reached" });
  });
});
