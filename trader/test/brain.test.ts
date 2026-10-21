import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Brain, predict, type BrainModel } from "../src/brain/model.js";
import type { SignalsConfig } from "../src/lib/config.js";
import { brainReasons } from "../src/signals/filters.js";
import type { LeaderTrade } from "../src/signals/engine.js";
import type { TokenInfoSource } from "../src/signals/token-info.js";
import { Trader } from "../src/trader/trader.js";
import { clock, Curve, key, memDb, testConfig } from "./helpers.js";

// The expected numbers come from learner/brain.py predict() on the same model and features:
// the trader must do the exact same math as the brain that trained it.
const MODEL: BrainModel = {
  version: "brain-test", active: true, threshold: 0, intercept: -0.05,
  features: [
    { name: "leader_buy_sol", kind: "log", mean: 0.3, std: 0.2 },
    { name: "top10_pct", kind: "num", mean: 25, std: 10 },
    { name: "top10_pct_missing", kind: "missing", of: "top10_pct", mean: 0.2, std: 0.4 },
    { name: "venue", kind: "eq", value: "amm", mean: 0.1, std: 0.3 },
    { name: "mayhem", kind: "bool", mean: 0.05, std: 0.2 },
    { name: "dev_sold_frac", kind: "num", mean: 0.1, std: 0 }, // constant in training: ignored
  ],
  weights: [0.04, -0.03, -0.02, 0.01, -0.1, -5],
};

describe("learning brain: model math", () => {
  it("predicts exactly like learner/brain.py", () => {
    expect(predict(MODEL, { leader_buy_sol: 0.5, top10_pct: 40, venue: "curve", mayhem: false, dev_sold_frac: 1 })).toBeCloseTo(-0.04224031171170046, 12);
    expect(predict(MODEL, { leader_buy_sol: null, venue: "amm", mayhem: true })).toBeCloseTo(-0.535, 12);
  });

  it("reads the newest model from the database, and ignores a broken one", () => {
    const db = memDb();
    const c = clock();
    const brain = new Brain(db, c.now);
    expect(brain.features({})).toEqual({ brain_version: null });
    const ins = db.prepare("INSERT INTO brain_models (trained_at, version, active, threshold, studied, model, exam) VALUES (0, ?, 1, 0, 300, ?, '{}')");
    ins.run("old", JSON.stringify({ ...MODEL, version: "old" }));
    ins.run("brain-test", JSON.stringify(MODEL));
    c.advance(61_000);
    expect(brain.features({ venue: "amm", mayhem: true })).toEqual({ brain_version: "brain-test", brain_active: true, brain_pred: -0.535, brain_threshold: 0 });
    ins.run("broken", "{\"weights\": [1]}");
    c.advance(61_000);
    expect(brain.features({})).toEqual({ brain_version: null });
  });
});

describe("learning brain: it can only add a skip", () => {
  const cfg = (use_brain: boolean) => ({ use_brain }) as SignalsConfig;
  const f = (pred: number, active = true) => ({ brain_active: active, brain_pred: pred, brain_threshold: 0 });

  it("skips a signal it predicts will lose, only once it passed its exam and only if config allows", () => {
    expect(brainReasons(f(-0.08), cfg(true))).toEqual(["model expects -8.0% follower ROI < 0.0% threshold"]);
    expect(brainReasons(f(0.03), cfg(true))).toEqual([]);
    expect(brainReasons(f(-0.08, false), cfg(true))).toEqual([]); // still studying
    expect(brainReasons(f(-0.08), cfg(false))).toEqual([]); // switched off in config
    expect(brainReasons({}, cfg(true))).toEqual([]); // no model yet
  });

  class Info implements TokenInfoSource {
    async top10Pct() { return 20; }
    async walletBalance() { return 30_000_000_000_000; }
  }

  function setup(model: BrainModel | null) {
    const db = memDb();
    const c = clock();
    if (model) {
      db.prepare("INSERT INTO brain_models (trained_at, version, active, threshold, studied, model, exam) VALUES (0, ?, ?, ?, 300, ?, '{}')")
        .run(model.version, model.active ? 1 : 0, model.threshold, JSON.stringify(model));
    }
    const trader = new Trader(db, testConfig({ shadow: { enabled: false } }), new Info(), join(mkdtempSync(join(tmpdir(), "k-")), "KILL"), c.now);
    trader.paper.init();
    const curve = new Curve(db, key(), key(), c.t - 60_000).insertToken({ initial_buy_tokens: 30_000_000_000_000 });
    const leader = key();
    db.prepare("INSERT INTO tracked_wallets (wallet, added_at, active, source, score) VALUES (?, 0, 1, 'scoring', 0.15)").run(leader);
    curve.movePrice(4, c.t - 30_000);
    const { id } = curve.buy(leader, 0.5, c.t);
    return { db, trader, trade: db.prepare("SELECT * FROM trades WHERE id = ?").get(id) as LeaderTrade };
  }

  // a model that hates everything: predicts -40% for any signal
  const gloomy = (active: boolean): BrainModel => ({ version: "gloomy", active, threshold: 0, intercept: -0.4, features: [], weights: [] });

  it("an exam-passed model makes the engine skip; a studying one only records its guess", async () => {
    const on = setup(gloomy(true));
    const r = await on.trader.signals.evaluate(on.trade);
    expect(r.decision).toBe("reject");
    expect(r.reasons).toEqual(["model expects -40.0% follower ROI < 0.0% threshold"]);
    expect(on.db.prepare("SELECT count(*) n FROM paper_positions").get()).toEqual({ n: 0 });

    const studying = setup(gloomy(false));
    const r2 = await studying.trader.signals.evaluate(studying.trade);
    expect(r2.decision).toBe("enter");
    const f = JSON.parse((studying.db.prepare("SELECT features FROM signals").get() as { features: string }).features);
    expect(f).toMatchObject({ brain_version: "gloomy", brain_active: false, brain_pred: -0.4 });

    const none = setup(null);
    expect((await none.trader.signals.evaluate(none.trade)).decision).toBe("enter");
  });

  it("a cheerful model can't rescue a signal the rules reject", async () => {
    const s = setup({ version: "cheerful", active: true, threshold: 0, intercept: 0.9, features: [], weights: [] });
    s.db.prepare("UPDATE tokens SET is_mayhem_mode = 1").run();
    const r = await s.trader.signals.evaluate(s.trade);
    expect(r.decision).toBe("reject");
    expect(r.reasons.join()).toMatch(/mayhem/);
  });
});
