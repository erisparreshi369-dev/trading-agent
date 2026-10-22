import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SignalsConfig } from "../src/lib/config.js";
import { INGEST_MARGIN_MS } from "../src/paper/engine.js";
import { SignalEngine, type LeaderTrade } from "../src/signals/engine.js";
import { coolingOff, curveSolPerMin, inTradingHours } from "../src/signals/filters.js";
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

function setup(over: Partial<SignalsConfig> = {}, info = new FakeInfo(), shadow = false) {
  const db = memDb();
  const c = clock();
  // shadow variants off unless a test is about them: looser variants legitimately spend RPC credits
  const cfg = testConfig({ signals: over, shadow: { enabled: shadow }, paper: { follow_leader_exit: true, trailing_stop_pct: null } }); // exits via the leader selling
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

/** `n` closed losing paper trades, the newest closed at `at`. */
function lostTrades(s: ReturnType<typeof setup>, n: number, at: number, pnl = -0.005): void {
  const sig = Number(s.db.prepare(`INSERT INTO signals (ts, wallet, mint, leader_trade_id, venue, score, decision, reasons, features)
    VALUES (?, ?, ?, (SELECT min(id) FROM trades), 'curve', 0, 'enter', '[]', '{}')`).run(at, s.leader, s.curve.mint).lastInsertRowid);
  for (let i = 0; i < n; i++) {
    s.db.prepare(`INSERT INTO paper_positions (signal_id, mint, leader_wallet, status, size_sol, leader_price, entry_due_at, closed_at, pnl_sol)
      VALUES (?, ?, ?, 'closed', 0.02, 1, ?, ?, ?)`).run(sig, key(), s.leader, at - 120_000, at - i * 1000, pnl);
  }
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
    ["chasing a coin that went vertical", { max_curve_sol_per_min: 1 }, (s: ReturnType<typeof setup>) => leaderBuy(s), /chasing: curve filled [\d.]+ SOL\/min > 1/],
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

describe("veteran habits (filters)", () => {
  const c = { pause_after_losses: 3, pause_minutes: 30 } as SignalsConfig;
  const at = 10_000_000;
  const lost = (minsAgo: number) => ({ won: false, closedAt: at - minsAgo * 60_000 });

  it("cools off only after N losses in a row, and only for pause_minutes after the last one", () => {
    expect(coolingOff([lost(1), lost(2), lost(3)], c, at)).toBe(true);
    expect(coolingOff([lost(31), lost(32), lost(33)], c, at)).toBe(false); // the pause is over
    expect(coolingOff([lost(1), { won: true, closedAt: at - 120_000 }, lost(3)], c, at)).toBe(false); // a win breaks the streak
    expect(coolingOff([lost(1), lost(2)], c, at)).toBe(false); // too few trades yet
    expect(coolingOff([lost(1), lost(2), lost(3)], { ...c, pause_after_losses: 0 }, at)).toBe(false); // off
  });

  it("curve fill speed: SOL in the curve per minute since launch, curve only", () => {
    expect(curveSolPerMin({ venue: "curve", liquidity_sol: 30, token_age_s: 60 })).toBe(30);
    expect(curveSolPerMin({ venue: "amm", liquidity_sol: 30, token_age_s: 60 })).toBeNull();
    expect(curveSolPerMin({ venue: "curve", liquidity_sol: 30 })).toBeNull(); // launch not seen
  });

  it("sits out after our own losing streak, without spending RPC credits; an old streak lets it trade again", async () => {
    const s = setup({ pause_after_losses: 2, pause_minutes: 30 });
    lostTrades(s, 2, s.c.t - 60_000);
    const r = await s.signals.evaluate(leaderBuy(s));
    expect(r).toMatchObject({ decision: "reject", reasons: ["cooling off after 2 losses in a row"] });
    expect(s.info.calls).toBe(0);
    const later = setup({ pause_after_losses: 2, pause_minutes: 30 });
    lostTrades(later, 2, later.c.t - 31 * 60_000);
    expect((await later.signals.evaluate(leaderBuy(later))).decision).toBe("enter");
  });
});

describe("TJR habits (filters)", () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 21, h, m);
  const hours = (trade_hours_utc: [number, number] | null) => ({ trade_hours_utc }) as SignalsConfig;

  it("trading hours: [from, to) in UTC, wrapping past midnight; null trades around the clock", () => {
    expect(inTradingHours(hours([13, 21]), at(12, 59))).toBe(false);
    expect(inTradingHours(hours([13, 21]), at(13))).toBe(true);
    expect(inTradingHours(hours([13, 21]), at(20, 59))).toBe(true);
    expect(inTradingHours(hours([13, 21]), at(21))).toBe(false);
    expect(inTradingHours(hours([22, 4]), at(23))).toBe(true);
    expect(inTradingHours(hours([22, 4]), at(3, 59))).toBe(true);
    expect(inTradingHours(hours([22, 4]), at(4))).toBe(false);
    expect(inTradingHours(hours([0, 24]), at(23, 59))).toBe(true);
    expect(inTradingHours(hours(null), at(5))).toBe(true);
  });

  it("outside trading hours the signal is skipped without spending RPC credits", async () => {
    const h = new Date(setup().c.t).getUTCHours();
    const s = setup({ trade_hours_utc: [(h + 1) % 24, (h + 2) % 24] });
    const r = await s.signals.evaluate(leaderBuy(s));
    expect(r).toMatchObject({ decision: "reject", reasons: [`outside trading hours ${(h + 1) % 24}-${(h + 2) % 24} UTC`] });
    expect(s.info.calls).toBe(0);
    const open = setup({ trade_hours_utc: [h, h + 1] });
    expect((await open.signals.evaluate(leaderBuy(open))).decision).toBe("enter");
  });
});
