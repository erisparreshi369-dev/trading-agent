import { describe, expect, it } from "vitest";
import type { DB } from "../src/lib/db.js";
import { outOfSample } from "../src/scoring/oos.js";
import { applyScores, scoreWallets } from "../src/scoring/score.js";
import { Curve, key, memDb, testConfig } from "./helpers.js";

const T0 = Date.UTC(2026, 9, 20, 0, 0, 0);
const cfg = testConfig({ scoring: { min_positions: 5, min_copy_trades: 3, max_tokens_per_day: 30, min_median_hold_s: 20 } });

/**
 * 40 launches, 10 minutes apart. On each:
 *  - SNIPER (every 3rd) buys in the launch slot, sells 1.8s later into the first pump (uncopyable),
 *  - DEV buys and sells their own token,
 *  - BOT flips every token within seconds,
 *  - GOOD (every 4th token) buys at +20s, rides two follow-on pumps, sells at +3min.
 */
function market(db: DB) {
  const w = { good: key(), sniper: key(), bot: key() };
  for (let i = 0; i < 40; i++) {
    const created = T0 + i * 600_000;
    const c = new Curve(db, key(), key(), created, 1000 + i * 1000).insertToken();
    if (i % 3 === 0) {
      const s = c.buy(w.sniper, 2, created + 400, c.createdSlot); // same slot as the launch
      c.movePrice(1.5, created + 1_000);
      c.sell(w.sniper, s.tokens, created + 1_800);
    }
    const d = c.buy(c.creator, 1, created + 2_500);
    const b = c.buy(w.bot, 0.5, created + 5_000);
    c.sell(w.bot, b.tokens, created + 9_000);
    c.sell(c.creator, d.tokens, created + 12_000);
    if (i % 4 === 0) {
      const g = c.buy(w.good, 1, created + 20_000);
      c.movePrice(1.3, created + 25_000);
      c.movePrice(1.3, created + 40_000);
      c.movePrice(1.1, created + 120_000);
      c.sell(w.good, g.tokens, created + 180_000);
      c.movePrice(1.0, created + 200_000); // keep the tape going after the exit
    }
  }
  return { ...w, now: T0 + 40 * 600_000 + 3_600_000 };
}

describe("wallet scoring", () => {
  it("ranks the copyable trader and rejects sniper, bot and dev for the right reasons", () => {
    const db = memDb();
    const m = market(db);
    const scores = scoreWallets(db, cfg.scoring, cfg.paper, m.now);
    const by = (w: string) => scores.find((s) => s.wallet === w)!;

    const good = by(m.good);
    expect(good).toMatchObject({ eligible: true, closed_positions: 10, copy_trades: 10, snipe_frac: 0 });
    expect(good.copy_roi!).toBeGreaterThan(0.2); // follower still makes >20%/trade after all costs
    expect(good.copy_roi!).toBeLessThan(good.realized_pnl_sol); // but less than the leader's own result
    expect(good.median_hold_s).toBe(160);
    expect(good.score!).toBeCloseTo((good.copy_roi! * 10) / 20, 10); // shrunk by k=10

    const sniper = by(m.sniper);
    expect(sniper.realized_pnl_sol).toBeGreaterThan(5); // looks brilliant on its own PnL...
    expect(sniper.snipe_frac).toBe(1);
    expect(sniper).toMatchObject({ eligible: false, reject_reason: "100% of profit from snipes" });
    // ...and can't be followed: 1.5s later the price has already run, every order hits the slippage limit
    expect(sniper).toMatchObject({ copy_trades: 0, copy_missed: 14, copy_roi: null });

    expect(by(m.bot)).toMatchObject({ eligible: false, reject_reason: expect.stringMatching(/tokens\/day looks like a bot/) });
    // devs trading their own launch are never scored
    const creators = new Set((db.prepare("SELECT creator FROM tokens").all() as { creator: string }[]).map((r) => r.creator));
    expect(scores.some((s) => creators.has(s.wallet))).toBe(false);
    expect(scores[0]!.wallet).toBe(m.good);
  });

  it("caps each trade's ROI so one moonshot can't carry a losing wallet", () => {
    const db = memDb();
    const lucky = key();
    for (let i = 0; i < 10; i++) {
      const created = T0 + i * 600_000;
      const c = new Curve(db, key(), key(), created, 1000 + i * 1000).insertToken();
      const g = c.buy(lucky, 0.5, created + 20_000);
      c.movePrice(i === 0 ? 30 : 0.9, created + 25_000); // after our delayed entry: one 30x, nine small losers
      c.sell(lucky, g.tokens, created + 60_000);
      c.movePrice(1.0, created + 70_000);
    }
    const now = T0 + 10 * 600_000 + 3_600_000;
    const s = scoreWallets(db, cfg.scoring, cfg.paper, now).find((x) => x.wallet === lucky)!;
    expect(s.copy_pnl_sol).toBeGreaterThan(0); // uncapped, the moonshot pays for everything...
    expect(s).toMatchObject({ eligible: false, reject_reason: expect.stringMatching(/follower ROI -/) }); // ...capped, it doesn't
  });

  it("drops positions that overlap a firehose gap (not fully observed)", () => {
    const db = memDb();
    const m = market(db);
    // the stream was off during the first hour: launches 0..5, GOOD traded #0 and #4
    db.prepare("INSERT INTO collector_gaps (source, started_at, ended_at, reason) VALUES ('firehose', ?, ?, 'test')").run(T0, T0 + 3_600_000);
    const good = scoreWallets(db, cfg.scoring, cfg.paper, m.now).find((s) => s.wallet === m.good)!;
    expect(good.closed_positions).toBe(8);
  });

  it("a ranked candidate on a trial watch is judged on full data (targeted streams cover it), only inside its trial", () => {
    const full = (() => {
      const db = memDb();
      const m = market(db);
      return scoreWallets(db, cfg.scoring, cfg.paper, m.now).find((s) => s.wallet === m.good)!.closed_positions;
    })();
    const db = memDb();
    const m = market(db);
    db.prepare("INSERT INTO collector_gaps (source, started_at, ended_at, reason) VALUES ('firehose', ?, ?, 'test')").run(T0, T0 + 3_600_000);
    db.prepare("INSERT INTO candidate_watch (wallet, since, until) VALUES (?, ?, ?)").run(m.good, T0 - 3_600_000, T0 + 30 * 86_400_000);
    expect(scoreWallets(db, cfg.scoring, cfg.paper, m.now).find((s) => s.wallet === m.good)!.closed_positions).toBe(full);
    // a trial that started after the gap doesn't cover it
    db.prepare("UPDATE candidate_watch SET since = ?").run(T0 + 3_600_000);
    expect(scoreWallets(db, cfg.scoring, cfg.paper, m.now).find((s) => s.wallet === m.good)!.closed_positions).toBe(8);
    // being listed is not being followed: only scoring adds wallets
    expect(db.prepare("SELECT count(*) n FROM tracked_wallets").get()).toEqual({ n: 0 });
  });

  it("updates the tracked set: adds the best, drops cold and rejected wallets, never touches manual ones", () => {
    const db = memDb();
    const m = market(db);
    const cold = key(), manual = key();
    db.prepare("INSERT INTO tracked_wallets (wallet, added_at, active, source) VALUES (?, 0, 1, 'scoring'), (?, 0, 1, 'manual'), (?, 0, 1, 'scoring')")
      .run(cold, manual, m.sniper);
    const res = applyScores(db, scoreWallets(db, cfg.scoring, cfg.paper, m.now), cfg.scoring, m.now);
    expect(res.added).toEqual([m.good]);
    expect(res.removed).toEqual(expect.arrayContaining([
      { wallet: cold, reason: "went cold" },
      { wallet: m.sniper, reason: "100% of profit from snipes" },
    ]));
    const active = (db.prepare("SELECT wallet FROM tracked_wallets WHERE active = 1 ORDER BY wallet").all() as { wallet: string }[]).map((r) => r.wallet);
    expect(active.sort()).toEqual([m.good, manual].sort());
    expect(db.prepare("SELECT count(*) n FROM wallet_scores WHERE eligible = 1").get()).toEqual({ n: 1 });
  });

  it("needs scoring.min_copy_trades simulated follower trades before a wallet can be followed", () => {
    const db = memDb();
    const m = market(db);
    const strict = { ...cfg.scoring, min_copy_trades: 30 };
    const good = scoreWallets(db, strict, cfg.paper, m.now).find((s) => s.wallet === m.good)!;
    expect(good).toMatchObject({ copy_trades: 10, eligible: false, reject_reason: "only 10 copyable trades < 30 (0 missed on slippage)" });
  });
});

describe("out-of-sample check", () => {
  it("scores on the older days and measures the same wallet on the newest ones, without double counting", () => {
    const db = memDb();
    const fader = key();
    // 20 launches 2h apart; FADER's first 10 entries run +50% after our delayed fill, the last 10 drop 20%
    for (let i = 0; i < 20; i++) {
      const created = T0 + i * 7_200_000;
      const c = new Curve(db, key(), key(), created, 1000 + i * 1000).insertToken();
      const g = c.buy(fader, 0.5, created + 20_000);
      c.movePrice(i < 10 ? 1.5 : 0.8, created + 25_000);
      c.sell(fader, g.tokens, created + 60_000);
      c.movePrice(1.0, created + 70_000);
    }
    const now = T0 + 40 * 3_600_000; // split at T0+20h: launches 0-9 in-sample, 10-19 out-of-sample
    const sc = { ...cfg.scoring, lookback_days: 2, oos_days: 20 / 24 };
    const { splitAt, rows } = outOfSample(db, sc, cfg.paper, now);
    expect(splitAt).toBe(T0 + 20 * 3_600_000);
    const r = rows.find((x) => x.wallet === fader)!;
    expect(r).toMatchObject({ is_trades: 10, oos_trades: 10, is_eligible: true, is_rank: 1 });
    expect(r.is_roi!).toBeGreaterThan(0.2);
    expect(r.oos_roi!).toBeLessThan(-0.15); // looked great in-sample, lost money after
  });
});
