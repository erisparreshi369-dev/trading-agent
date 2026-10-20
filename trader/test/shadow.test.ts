import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/lib/config.js";
import { INGEST_MARGIN_MS } from "../src/paper/engine.js";
import { resolveVariants } from "../src/paper/shadow.js";
import { RISK } from "../src/risk/limits.js";
import type { TokenInfoSource } from "../src/signals/token-info.js";
import { totalCost } from "../src/sim/market.js";
import { Trader } from "../src/trader/trader.js";
import { clock, Curve, key, memDb, testConfig } from "./helpers.js";

class FakeInfo implements TokenInfoSource {
  calls = 0;
  async top10Pct() {
    this.calls++;
    return 20;
  }
  async walletBalance() {
    this.calls++;
    return 30_000_000_000_000;
  }
}

type Variants = Config["shadow"]["variants"];

function setup(variants: Variants) {
  const db = memDb();
  const c = clock();
  const cfg = testConfig({ shadow: { enabled: true, size_sol: 0.02, variants } });
  const info = new FakeInfo();
  const trader = new Trader(db, cfg, info, join(mkdtempSync(join(tmpdir(), "k-")), "KILL"), c.now);
  trader.paper.init();
  const curve = new Curve(db, key(), key(), c.t - 60_000).insertToken({ initial_buy_tokens: 30_000_000_000_000 });
  const leader = key();
  db.prepare("INSERT INTO tracked_wallets (wallet, added_at, active, source, score) VALUES (?, 0, 1, 'scoring', 0.15)").run(leader);
  curve.movePrice(4, c.t - 30_000);
  trader.start();
  const delay = cfg.paper.execution_delay_ms;
  /** The trader loop: read new trades, evaluate, run paper fills. */
  const step = async () => {
    trader.poll();
    await trader.idle();
    trader.paper.tick();
  };
  const shadow = (variant: string) => db.prepare("SELECT * FROM shadow_trades WHERE variant = ? ORDER BY signal_id DESC").get(variant) as Record<string, any>;
  return { db, c, cfg, trader, curve, leader, info, delay, step, shadow };
}

type At = (offsetMs: number, fn: () => void) => void;

/**
 * Leader buys at t0; `plan` schedules what happens next with at(offset, fn). Each event is written
 * only when the clock reaches it, like the collector would, while the trader loop runs (100ms
 * steps for 2 minutes, then 1s). Settles everything 32 minutes later.
 */
async function scenario(s: ReturnType<typeof setup>, plan: (at: At, t0: number, tokens: number) => void, sol = 1) {
  const t0 = s.c.t;
  const { tokens } = s.curve.buy(s.leader, sol, t0);
  const events: [number, () => void][] = [];
  plan((ms, fn) => events.push([t0 + ms, fn]), t0, tokens);
  events.sort((a, b) => a[0] - b[0]);
  await s.step();
  while (s.c.t < t0 + 32 * 60_000) {
    s.c.advance(s.c.t < t0 + 120_000 ? 100 : 1_000);
    while (events.length && events[0]![0] <= s.c.t) events.shift()![1]();
    await s.step();
  }
  s.trader.shadow.settle();
}

describe("shadow variants", () => {
  it("the 'live' variant reproduces the real paper trade exactly", async () => {
    const s = setup({ live: {} });
    try {
      await scenario(s, (at, t0, tokens) => {
        at(800, () => s.curve.movePrice(1.015, t0 + 800)); // inside the 3% slippage limit
        at(20_000, () => s.curve.movePrice(1.1, t0 + 20_000));
        at(45_000, () => s.curve.sell(s.leader, tokens, t0 + 45_000));
        at(46_000, () => s.curve.movePrice(0.9, t0 + 46_000));
      });
      const paper = s.db.prepare("SELECT pnl_sol, opened_at, closed_at, exit_reason FROM paper_positions").get() as Record<string, number | string>;
      const sh = s.shadow("live");
      expect(sh).toMatchObject({ status: "closed", exit_reason: "leader_exit", entry_at: paper.opened_at, exit_at: paper.closed_at });
      expect(sh.pnl_sol).toBeCloseTo(paper.pnl_sol as number, 12);
      // and the per-fill cost columns of the real trade add up to the same costs
      const fills = s.db.prepare(`SELECT SUM(platform_fee_sol) p, SUM(executor_fee_sol) e, SUM(priority_fee_sol) pr, SUM(slippage_sol) sl, SUM(rent_sol) r
        FROM paper_fills`).get() as Record<string, number>;
      expect(fills.p).toBeCloseTo(sh.platform_fee_sol, 12);
      expect(fills.pr).toBeCloseTo(2 * s.cfg.paper.priority_fee_sol, 12);
      expect(fills.r).toBeCloseTo(0, 12); // rent comes back
      expect(fills.sl).toBeCloseTo(sh.slippage_sol, 12);
    } finally {
      await s.trader.stop();
    }
  });

  it("exit rules: take profit, trailing stop, max hold, and the hard stop loss always applies", async () => {
    const s = setup({
      live: {},
      tp_30: { exit: { take_profit_pct: 30 } },
      trail_20: { exit: { leader_exit: false, trailing_stop_pct: 20 } },
      hold_1m: { exit: { leader_exit: false, max_hold_s: 60 } },
      ride: { exit: { leader_exit: false } },
    });
    try {
      await scenario(s, (at, t0, tokens) => {
        at(10_000, () => s.curve.movePrice(1.5, t0 + 10_000)); // +50%: take profit
        at(30_000, () => s.curve.movePrice(0.75, t0 + 30_000)); // -25% from the peak: trailing stop
        at(40_000, () => s.curve.sell(s.leader, tokens, t0 + 40_000)); // leader out
        at(90_000, () => s.curve.movePrice(1.0, t0 + 90_000));
        at(120_000, () => s.curve.movePrice(0.5, t0 + 120_000)); // well below entry: hard stop for whoever is still in
      });
      expect(s.shadow("live")).toMatchObject({ status: "closed", exit_reason: "leader_exit" });
      expect(s.shadow("tp_30")).toMatchObject({ status: "closed", exit_reason: "take_profit" });
      expect(s.shadow("trail_20")).toMatchObject({ status: "closed", exit_reason: "trailing_stop" });
      expect(s.shadow("hold_1m")).toMatchObject({ status: "closed", exit_reason: "time_exit" });
      expect(s.shadow("hold_1m").exit_at - s.shadow("hold_1m").entry_at).toBe(60_000 + s.delay);
      expect(s.shadow("ride")).toMatchObject({ status: "closed", exit_reason: "stop_loss" });
      expect(s.shadow("tp_30").roi).toBeGreaterThan(0.2);
    } finally {
      await s.trader.stop();
    }
  });

  it("filter variants: 'none' takes rejected signals, a looser one pays for its on-chain checks", async () => {
    const s = setup({ live: {}, all_signals: { filters: "none" }, "buy_0.05": { filters: { min_leader_buy_sol: 0.05 } } });
    try {
      await scenario(s, (at, t0) => at(5_000, () => s.curve.movePrice(1.2, t0 + 5_000)), 0.07); // below the live 0.1 SOL minimum
      expect(s.db.prepare("SELECT decision FROM signals").get()).toEqual({ decision: "reject" });
      expect(s.shadow("live")).toMatchObject({ status: "filtered", reasons: JSON.stringify(["leader buy 0.070 < 0.1 SOL"]) });
      expect(s.shadow("all_signals")).toMatchObject({ status: "closed", exit_reason: "time_exit" });
      expect(s.shadow("buy_0.05")).toMatchObject({ status: "closed" });
      expect(s.info.calls).toBe(2); // top10 + dev balance, only because buy_0.05 could take it
    } finally {
      await s.trader.stop();
    }
  });

  it("each variant has its own re-entry cooldown", async () => {
    const s = setup({ live: {}, all_signals: { filters: "none" } });
    try {
      await scenario(s, (at, t0) => {
        at(3_000, () => s.curve.buy(s.leader, 0.5, t0 + 3_000)); // the leader adds while we're in
      });
      const rows = s.db.prepare("SELECT variant, status, reasons FROM shadow_trades ORDER BY signal_id, variant").all();
      expect(rows).toEqual([
        { variant: "all_signals", status: "closed", reasons: null },
        { variant: "live", status: "closed", reasons: null },
        { variant: "all_signals", status: "closed", reasons: null }, // 'none' takes every signal
        { variant: "live", status: "filtered", reasons: JSON.stringify(["re-entry cooldown"]) },
      ]);
    } finally {
      await s.trader.stop();
    }
  });

  it("a collector outage during the trade leaves it out instead of guessing", async () => {
    const s = setup({ live: {} });
    try {
      await scenario(s, (at, t0) => {
        at(60_000, () => s.db.prepare("INSERT INTO collector_gaps (source, started_at, ended_at, reason) VALUES ('targeted', ?, ?, 'test')").run(t0 + 60_000, t0 + 90_000)); // 30s: long enough to count
      });
      expect(s.shadow("live")).toMatchObject({ status: "gap" });
      expect(s.db.prepare("SELECT status FROM signal_outcomes").get()).toEqual({ status: "gap" });
    } finally {
      await s.trader.stop();
    }
  });

  it("tolerates a short reconnect: the next trade carries the market state again", async () => {
    const s = setup({ live: {} });
    try {
      await scenario(s, (at, t0) => {
        at(60_000, () => s.db.prepare("INSERT INTO collector_gaps (source, started_at, ended_at, reason) VALUES ('targeted', ?, ?, 'close 1006')").run(t0 + 60_000, t0 + 61_000));
      });
      expect(s.shadow("live")).toMatchObject({ status: "closed" });
      expect(s.db.prepare("SELECT status FROM signal_outcomes").get()).toEqual({ status: "ok" });
    } finally {
      await s.trader.stop();
    }
  });

  it("round trip at an unchanged price: the cost breakdown is exactly the loss", async () => {
    const hold = { leader_exit: false, max_hold_s: 120 };
    const s = setup({ hold: { filters: "none", exit: hold }, big: { filters: "none", exit: hold, size_sol: 0.25 } });
    try {
      // a tiny buy (no meaningful move), nothing else trades
      await scenario(s, () => undefined, 0.000001);
      for (const v of ["hold", "big"]) {
        const r = s.shadow(v);
        expect(r).toMatchObject({ status: "closed", exit_reason: "time_exit" });
        const costs = { platformSol: r.platform_fee_sol, executorSol: r.executor_fee_sol, prioritySol: r.priority_fee_sol, slippageSol: r.slippage_sol, rentSol: r.rent_sol };
        expect(-r.pnl_sol).toBeCloseTo(totalCost(costs), 10);
        expect(r.rent_sol).toBeCloseTo(0, 12);
      }
      // fixed costs weigh less on a bigger position; impact weighs more
      const share = (v: string) => -s.shadow(v).pnl_sol / s.shadow(v).size_sol;
      expect(share("big")).toBeLessThan(share("hold"));
      expect(s.shadow("big").slippage_sol / 0.25).toBeGreaterThan(s.shadow("hold").slippage_sol / 0.02);
    } finally {
      await s.trader.stop();
    }
  });

  it("records the market 1, 5 and 30 minutes after every signal, rejected ones too", async () => {
    const s = setup({ live: {} });
    try {
      let p1 = 0, p5 = 0;
      await scenario(s, (at, t0) => {
        at(30_000, () => s.curve.movePrice(1.2, t0 + 30_000));
        at(30_001, () => (p1 = s.curve.price));
        at(200_000, () => s.curve.movePrice(0.5, t0 + 200_000));
        at(200_001, () => (p5 = s.curve.price));
      }, 0.05); // rejected: leader buy too small
      const o = s.db.prepare("SELECT * FROM signal_outcomes").get() as Record<string, number | string>;
      expect(o).toMatchObject({ status: "ok" });
      expect(o.price_1m).toBeCloseTo(p1, 15);
      expect(o.price_5m).toBeCloseTo(p5, 15);
      expect(o.price_30m).toBeCloseTo(p5, 15);
      expect(o.max_30m).toBeCloseTo(p1, 15);
      expect(o.min_30m).toBeCloseTo(p5, 15);
    } finally {
      await s.trader.stop();
    }
  });

  it("backfills signals recorded before the variants existed, once", async () => {
    const s = setup({ live: {} });
    try {
      s.curve.buy(s.leader, 1, s.c.t);
      await s.step();
      s.db.prepare("DELETE FROM shadow_trades").run();
      expect(s.trader.shadow.backfill()).toBe(1);
      expect(s.trader.shadow.backfill()).toBe(0);
      expect(s.shadow("live")).toMatchObject({ status: "pending" });
    } finally {
      await s.trader.stop();
    }
  });
});

describe("shadow config", () => {
  it("variants are the live settings plus overrides; max hold can't exceed the hard time exit", () => {
    const cfg = testConfig();
    const vs = resolveVariants(cfg);
    const live = vs.find((v) => v.name === "live")!;
    expect(live.filters).toEqual(cfg.signals);
    expect(live.exit).toEqual({ leaderExit: true, stopLossPct: RISK.STOP_LOSS_PCT, takeProfitPct: null, trailingStopPct: null, maxHoldMs: RISK.TIME_EXIT_MS });
    expect(vs.find((v) => v.name === "all_signals")!.filters).toBeNull();
    expect(vs.find((v) => v.name === "tp_50")!.exit.takeProfitPct).toBe(0.5);
    expect(vs.find((v) => v.name === "size_0.1")!.sizeSol).toBe(0.1);
    const bad = { ...cfg, shadow: { ...cfg.shadow, variants: { x: { exit: { max_hold_s: 3600 } } } } };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...cfg, shadow: { ...cfg.shadow, variants: { x: { filters: { typo: 1 } } } } }).success).toBe(false);
  });
});
