import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SignalsConfig } from "../src/lib/config.js";
import { INGEST_MARGIN_MS } from "../src/paper/engine.js";
import { SignalEngine, type LeaderTrade } from "../src/signals/engine.js";
import type { TokenInfoSource } from "../src/signals/token-info.js";
import { Trader } from "../src/trader/trader.js";
import { clock, Curve, key, memDb, testConfig } from "./helpers.js";

class FakeInfo implements TokenInfoSource {
  calls = 0;
  // default: dev still holds the 30M-token launch buy (3% of supply)
  constructor(public top10 = 20, public devBalance = 30_000_000_000_000, public fail = false) {}
  async top10Pct() {
    this.calls++;
    if (this.fail) throw new Error("rpc down");
    return this.top10;
  }
  async walletBalance() {
    this.calls++;
    if (this.fail) throw new Error("rpc down");
    return this.devBalance;
  }
}

function setup(over: Partial<SignalsConfig> = {}, info = new FakeInfo()) {
  const db = memDb();
  const c = clock();
  const cfg = testConfig({ signals: over });
  const trader = new Trader(db, cfg, info, join(mkdtempSync(join(tmpdir(), "k-")), "KILL"), c.now);
  trader.paper.init();
  const curve = new Curve(db, key(), key(), c.t - 60_000).insertToken({ initial_buy_tokens: 30_000_000_000_000 });
  const leader = key();
  db.prepare("INSERT INTO tracked_wallets (wallet, added_at, active, source, score) VALUES (?, 0, 1, 'scoring', 0.15)").run(leader);
  curve.movePrice(4, c.t - 30_000); // ~6 SOL in the curve: inside the liquidity window
  return { db, c, cfg, trader, curve, leader, info, signals: trader.signals as SignalEngine };
}

function leaderBuy(s: ReturnType<typeof setup>, sol = 0.5, wallet = s.leader): LeaderTrade {
  const { id } = s.curve.buy(wallet, sol, s.c.t);
  return s.db.prepare("SELECT * FROM trades WHERE id = ?").get(id) as LeaderTrade;
}

describe("SignalEngine filters", () => {
  it("accepts a clean signal, records features, and schedules a paper entry", async () => {
    const s = setup();
    const r = await s.signals.evaluate(leaderBuy(s));
    expect(r).toMatchObject({ decision: "enter", reasons: [] });
    const row = s.db.prepare("SELECT decision, features FROM signals WHERE id = ?").get(r.signalId) as { decision: string; features: string };
    expect(JSON.parse(row.features)).toMatchObject({ token_age_s: 60, confirmations: 1, top10_pct: 20, dev_hold_pct: 3, dev_sold_frac: 0, wallet_score: 0.15 });
    expect(s.db.prepare("SELECT status, size_sol FROM paper_positions").get()).toEqual({ status: "pending", size_sol: 0.02 });
  });

  it.each([
    ["leader buy too small", {}, (s: ReturnType<typeof setup>) => leaderBuy(s, 0.05), /leader buy 0\.050 < 0\.1/],
    ["token too old", { token_age_s: [3, 30] as [number, number] }, (s: ReturnType<typeof setup>) => leaderBuy(s), /token age 60s outside/],
    ["mayhem token", {}, (s: ReturnType<typeof setup>) => {
      s.db.prepare("UPDATE tokens SET is_mayhem_mode = 1").run();
      return leaderBuy(s);
    }, /mayhem/],
    ["serial launcher", { max_dev_tokens_24h: 1 }, (s: ReturnType<typeof setup>) => {
      new Curve(s.db, key(), s.curve.creator, s.c.t - 1000).insertToken();
      return leaderBuy(s);
    }, /dev launched 2 tokens/],
    ["not enough tracked buyers", { min_confirmations: 2 }, (s: ReturnType<typeof setup>) => leaderBuy(s), /1 tracked buyers < 2/],
    ["curve nearly complete", { max_real_sol: 3 }, (s: ReturnType<typeof setup>) => leaderBuy(s), /curve SOL .* outside/],
    ["unknown launch", {}, (s: ReturnType<typeof setup>) => {
      s.db.prepare("DELETE FROM tokens").run();
      return leaderBuy(s);
    }, /launch not seen/],
  ])("rejects: %s, without spending RPC credits", async (_n, over, make, reason) => {
    const s = setup(over);
    const r = await s.signals.evaluate(make(s));
    expect(r.decision).toBe("reject");
    expect(r.reasons.join("; ")).toMatch(reason);
    expect(s.info.calls).toBe(0);
    expect(s.db.prepare("SELECT count(*) n FROM paper_positions").get()).toEqual({ n: 0 });
  });

  it("counts other tracked wallets buying the same token as confirmations", async () => {
    const s = setup({ min_confirmations: 2 });
    const other = key();
    s.db.prepare("INSERT INTO tracked_wallets (wallet, added_at, active, source, score) VALUES (?, 0, 1, 'scoring', 0.1)").run(other);
    s.curve.buy(other, 0.3, s.c.t - 30_000);
    const r = await s.signals.evaluate(leaderBuy(s));
    expect(r).toMatchObject({ decision: "enter" });
    expect(r.score).toBeCloseTo(0.15 + 0.05, 10);
  });

  it.each([
    ["concentrated holders", new FakeInfo(55), /top10 holders 55\.0% > 40%/],
    ["dev still holds a lot", new FakeInfo(20, 150_000_000_000_000), /dev holds 15% > 10%/],
    ["dev dumped the launch buy", new FakeInfo(20, 10_000_000_000_000), /dev sold 67% of launch buy/],
    ["RPC failure fails closed", new FakeInfo(20, 0, true), /on-chain check failed: Error: rpc down/],
  ])("rejects on-chain: %s", async (_n, info, reason) => {
    const s = setup({}, info);
    const r = await s.signals.evaluate(leaderBuy(s));
    expect(r.decision).toBe("reject");
    expect(r.reasons.join("; ")).toMatch(reason);
  });

  it("records risk blocks separately from filter rejects", async () => {
    const s = setup();
    s.trader.risk.kill("test");
    const r = await s.signals.evaluate(leaderBuy(s));
    expect(r).toMatchObject({ decision: "risk_block", reasons: [expect.stringMatching(/risk: kill switch: test/)] });
  });

  it("a model score adjuster can veto via score but cannot size or bypass risk", async () => {
    const s = setup();
    s.signals.setScoreAdjuster(() => 100); // wildly optimistic model
    s.trader.risk.kill("test");
    expect((await s.signals.evaluate(leaderBuy(s))).decision).toBe("risk_block");
    const s2 = setup();
    s2.signals.setScoreAdjuster(() => 100);
    await s2.signals.evaluate(leaderBuy(s2));
    expect(s2.db.prepare("SELECT size_sol FROM paper_positions").get()).toEqual({ size_sol: 0.02 }); // risk's size, not the model's
    const s3 = setup();
    s3.signals.setScoreAdjuster(() => -1);
    expect((await s3.signals.evaluate(leaderBuy(s3))).reasons).toEqual([expect.stringMatching(/score -0\.150 < 0/)]);
  });
});

describe("Trader end to end", () => {
  it("tracked buy -> signal -> delayed paper fill -> leader sells -> closed with PnL", async () => {
    const s = setup();
    s.trader.start();
    try {
      s.trader.poll(); // initial cursor already at head; nothing to do
      const { tokens } = s.curve.buy(s.leader, 1, s.c.t);
      s.trader.poll();
      await s.trader.idle();
      expect(s.db.prepare("SELECT decision FROM signals").get()).toEqual({ decision: "enter" });

      s.curve.movePrice(1.5, s.c.t + 10_000);
      s.c.advance(cfgDelay(s) + INGEST_MARGIN_MS);
      s.trader.poll();
      s.trader.paper.tick();
      expect(s.db.prepare("SELECT status FROM paper_positions").get()).toEqual({ status: "open" });

      s.c.advance(20_000);
      s.curve.sell(s.leader, tokens, s.c.t);
      s.trader.poll();
      s.c.advance(cfgDelay(s) + INGEST_MARGIN_MS);
      s.trader.paper.tick();
      const p = s.db.prepare("SELECT status, exit_reason, pnl_sol FROM paper_positions").get() as { status: string; exit_reason: string; pnl_sol: number };
      expect(p).toMatchObject({ status: "closed", exit_reason: "leader_exit" });
      expect(p.pnl_sol).toBeGreaterThan(0); // +50% move minus costs and the leader's own dump
      expect(s.trader.summary()).toMatchObject({ mode: "paper", live: 0, todayClosed: 1, todayWins: 1 });
    } finally {
      await s.trader.stop();
    }
  });

  it("ignores stale tracked buys after a restart instead of acting on old news", async () => {
    const s = setup();
    s.trader.start();
    try {
      s.curve.buy(s.leader, 1, s.c.t - 10_000); // landed 10s ago
      s.trader.poll();
      await s.trader.idle();
      expect(s.trader.stats).toMatchObject({ leaderBuys: 1, staleSkipped: 1, signals: 0 });
    } finally {
      await s.trader.stop();
    }
  });
});

const cfgDelay = (s: ReturnType<typeof setup>) => s.cfg.paper.execution_delay_ms;
