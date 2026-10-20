import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DB } from "../src/lib/db.js";
import { INGEST_MARGIN_MS, PaperEngine, type Position } from "../src/paper/engine.js";
import { RiskManager } from "../src/risk/risk-manager.js";
import { maxSlippageBps, stricterOnly } from "../src/lib/safe-settings.js";
import { clock, Curve, key, memDb, testConfig } from "./helpers.js";

const cfg = testConfig().paper;
const pos = (db: DB) => db.prepare("SELECT * FROM paper_positions ORDER BY id DESC LIMIT 1").get() as Position;
const lastFill = (db: DB) => db.prepare("SELECT * FROM paper_fills ORDER BY id DESC LIMIT 1").get() as { side: string; ok: number; slippage_bps: number; reason: string; price: number };

function engine(db: DB, c: ReturnType<typeof clock>, paper = cfg) {
  const risk = new RiskManager(db, join(mkdtempSync(join(tmpdir(), "kill-")), "KILL"), c.now);
  const e = new PaperEngine(db, paper, risk, c.now);
  e.init();
  return e;
}

/**
 * The BBC trade of 2026-10-20, exactly as recorded: the copied wallet bought at 4.866e-8 SOL per
 * token; three more buys landed inside our 1.5s delay and we paid 5.200e-8, 6.86% more.
 */
const BBC = {
  mint: "2syvxH8VKzDgUA56yCEzeWCaU76TuYTc5XfUZK6Lpump",
  leader: "4nDJMtnz35oWDF4EZJ8bxEeuQAFsAit8kTMKsi9BtZ4s",
  trades: [
    // id, received_at, wallet, sol_lamports, v_sol, v_token, real_token, fee, creator_fee, price
    [146280, 1792472718595, "4nDJMtnz35oWDF4EZJ8bxEeuQAFsAit8kTMKsi9BtZ4s", 222179069, 39577865264, 813333408990013, 533433408990013, 2110702, 666538, 4.8661305224320354e-8],
    [146304, 1792472719179, "ES7V1iZyUrUJft3HwX5CrbsUY1ieAqF8qHsXNscBCgsL", 93754656, 40209641013, 800554276714798, 520654276714798, 890670, 281264, 5.022725152129181e-8],
    [146305, 1792472719332, "72NWWbchKdRJKvhG6U4f9363psUttkeEkE4yk15imy8u", 296296296, 40505937309, 794698313814018, 514798313814018, 2814815, 888889, 5.097020668711213e-8],
    [146307, 1792472719345, "EZbw9MrMwGKE3PCYDos7Y7cQsaqoRAby9i18MjGjzxMk", 296296296, 40802233605, 788927400184360, 509027400184360, 2814815, 888889, 5.1718616434750716e-8],
  ] as const,
};

// the real position was 2% of 0.98200691 SOL equity; same size here, so price impact matches too
const BBC_EQUITY = 0.019640138294891068 / 0.02;

function bbc(paper = { ...cfg, start_balance_sol: BBC_EQUITY }) {
  const db = memDb();
  const leaderAt = BBC.trades[0][1];
  const c = clock(leaderAt);
  db.prepare("INSERT INTO tokens (mint, symbol, created_at, first_seen_at, source) VALUES (?, 'BBC', ?, ?, 'pumpportal')").run(BBC.mint, leaderAt - 84_644, leaderAt - 84_644);
  const ins = db.prepare(`INSERT INTO trades (id, signature, ev_index, received_at, mint, wallet, is_buy, sol_lamports, token_amount, v_sol_reserves, v_token_reserves,
    real_token_reserves, fee_lamports, creator_fee_lamports, price_sol, source, venue) VALUES (?, ?, 0, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?, ?, 'helius', 'curve')`);
  for (const [id, at, wallet, sol, vs, vt, rt, fee, cfee, price] of BBC.trades) ins.run(id, `sig${id}`, at, BBC.mint, wallet, sol, vs, vt, rt, fee, cfee, price);
  const e = engine(db, c, paper);
  const sig = Number(db.prepare("INSERT INTO signals (ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (?, ?, ?, 146280, 'curve', 'enter', '[]', '{}')")
    .run(leaderAt + 686, BBC.leader, BBC.mint).lastInsertRowid);
  expect(e.enter(sig, { mint: BBC.mint, wallet: BBC.leader, venue: "curve", received_at: leaderAt, price_sol: BBC.trades[0][9] }).ok).toBe(true);
  c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
  e.tick();
  return { db, e };
}

describe("max slippage rule", () => {
  it("ships at 3%", () => {
    expect(cfg.max_slippage_bps).toBe(300);
  });

  it("BBC (6.86% slippage) is now skipped: 'skipped: price moved too much', only the network fee is paid", () => {
    const { db, e } = bbc();
    expect(pos(db)).toMatchObject({ status: "failed", exit_reason: expect.stringMatching(/^skipped: price moved too much \(slippage 686bps > 300bps limit\)$/) });
    expect(pos(db).pnl_sol).toBeCloseTo(-cfg.priority_fee_sol, 12);
    expect(lastFill(db)).toMatchObject({ side: "buy", ok: 0 });
    expect(lastFill(db).slippage_bps).toBeCloseTo(686.14, 1);
    expect(e.account().balance).toBeCloseTo(BBC_EQUITY - cfg.priority_fee_sol, 12);
  });

  it("BBC replays exactly as it happened under the old 15% limit (the fixture is faithful)", () => {
    const { db } = bbc({ ...cfg, start_balance_sol: BBC_EQUITY, max_slippage_bps: 1500 });
    expect(pos(db).status).toBe("open");
    expect(pos(db).entry_price!).toBeCloseTo(5.200016971070713e-8, 18);
    expect(lastFill(db).slippage_bps).toBeCloseTo(686.14, 1);
  });

  it("never blocks a sell: the exit fills and the slippage vs the decision price is recorded", () => {
    const db = memDb();
    const c = clock();
    const e = engine(db, c);
    const curve = new Curve(db, key(), key(), c.t - 60_000).insertToken();
    const leader = key();
    curve.buy(leader, 1, c.t);
    const sig = Number(db.prepare("INSERT INTO signals (ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (0, 'w', ?, 0, 'curve', 'enter', '[]', '{}')")
      .run(curve.mint).lastInsertRowid);
    e.enter(sig, { mint: curve.mint, wallet: leader, venue: "curve", received_at: c.t, price_sol: curve.price });
    c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    e.tick();
    expect(pos(db).status).toBe("open");
    // the leader sells; the price then drops 15% while our sell is on its way
    const sold = curve.sell(leader, 1e12, c.t);
    e.onTrade(db.prepare("SELECT * FROM trades WHERE id = ?").get(sold.id) as never);
    const decided = curve.price;
    curve.movePrice(0.85, c.t + 500);
    c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    e.tick();
    expect(pos(db)).toMatchObject({ status: "closed", exit_reason: "leader_exit" });
    const f = lastFill(db);
    expect(f).toMatchObject({ side: "sell", ok: 1, reason: "leader_exit" });
    expect(f.slippage_bps).toBeGreaterThan(cfg.max_slippage_bps); // over the limit, sold anyway
    expect(f.slippage_bps).toBeCloseTo((decided / f.price - 1) * 10_000, 6);
  });
});

describe("safe settings: the learner can only make max slippage stricter", () => {
  it("takes a lower value, ignores a higher, missing or garbage one", () => {
    expect(stricterOnly("max_slippage_bps", 300, 200)).toBe(200);
    expect(stricterOnly("max_slippage_bps", 300, "150")).toBe(150);
    expect(stricterOnly("max_slippage_bps", 300, 500)).toBe(300);
    for (const bad of [undefined, null, "", "abc", Number.NaN, -5, 0, Infinity]) expect(stricterOnly("max_slippage_bps", 300, bad)).toBe(300);
  });

  it("reads the learner's proposal from the database; a looser one never loosens the live rule", () => {
    const db = memDb();
    const set = (v: string) => db.prepare("INSERT INTO kv (key, value) VALUES ('learner.max_slippage_bps', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(v);
    expect(maxSlippageBps(db, cfg)).toBe(300);
    set("1000");
    expect(maxSlippageBps(db, cfg)).toBe(300);
    set("250");
    expect(maxSlippageBps(db, cfg)).toBe(250);
  });

  it("a stricter learner value applies to live entries", () => {
    const db = memDb();
    db.prepare("INSERT INTO kv (key, value) VALUES ('learner.max_slippage_bps', '100')").run();
    const c = clock();
    const e = engine(db, c);
    const curve = new Curve(db, key(), key(), c.t - 60_000).insertToken();
    const leader = key();
    curve.buy(leader, 1, c.t);
    const sig = Number(db.prepare("INSERT INTO signals (ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (0, 'w', ?, 0, 'curve', 'enter', '[]', '{}')")
      .run(curve.mint).lastInsertRowid);
    e.enter(sig, { mint: curve.mint, wallet: leader, venue: "curve", received_at: c.t, price_sol: curve.price });
    curve.movePrice(1.02, c.t + 500); // +2%: inside 3%, over the learner's 1%
    c.advance(cfg.execution_delay_ms + INGEST_MARGIN_MS);
    e.tick();
    expect(pos(db).exit_reason).toMatch(/> 100bps limit/);
  });
});
