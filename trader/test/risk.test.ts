import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { ConfigSchema, ROOT } from "../src/lib/config.js";
import { limitsFor, PAPER_NO_LIMITS, PAPER_TEST_RISK, RISK } from "../src/risk/limits.js";
import { RiskManager, type AccountSnapshot } from "../src/risk/risk-manager.js";
import { MIN_WEEK_TRADES, nextSizeBase, WEEK_MS, type Results } from "../src/risk/size-base.js";
import { clock, memDb } from "./helpers.js";

const killFile = () => join(mkdtempSync(join(tmpdir(), "kill-")), "KILL");
const acct = (over: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  equity: 1, freeBalance: 1, startBalance: 1, openPositions: 0, entriesToday: 0, leaderRecentEntries: 0, ...over,
});

describe("risk limits are not changeable at runtime", () => {
  it("are frozen", () => {
    expect(Object.isFrozen(RISK)).toBe(true);
    expect(() => {
      (RISK as { MAX_POSITION_PCT: number }).MAX_POSITION_PCT = 0.5;
    }).toThrow(TypeError);
    expect(RISK.MAX_POSITION_PCT).toBe(0.02);
  });

  it("cannot be supplied through the config file", () => {
    const raw = YAML.parse(readFileSync(resolve(ROOT, "config/config.yaml"), "utf8"));
    expect(() => ConfigSchema.parse({ ...raw, risk: { MAX_POSITION_PCT: 0.5 } })).toThrow();
    expect(() => ConfigSchema.parse({ ...raw, paper: { ...raw.paper, stop_loss_pct: 0.9 } })).toThrow();
  });

  it("the risk module reads no config, env, model or network input", () => {
    const dir = resolve(ROOT, "trader/src/risk");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/from "\.\.\/lib\/config|process\.env|signals\/|learner|fetch\(/);
      expect(src, f).not.toMatch(/^\s*(set|update)\w*\s*\(/m); // no setters
    }
  });

  it("the only way to clear the kill switch is the operator tool", () => {
    const srcDir = resolve(ROOT, "trader/src");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/SET\s(?:(?!WHERE)[^;`])*kill_switch\s*=\s*0/i.test(readFileSync(p, "utf8"))) offenders.push(p.slice(srcDir.length));
      }
    };
    walk(srcDir);
    expect(offenders).toEqual(["/tools/kill.ts"]);
  });
});

describe("RiskManager entries", () => {
  it("sizes at 2% of equity, capped absolutely, and skips sizes too small to be worth fees", () => {
    const fresh = () => new RiskManager(memDb(), killFile()); // each starts its own day at the given equity
    expect(fresh().checkEntry(acct())).toEqual({ ok: true, sizeSol: 0.02 });
    expect(fresh().checkEntry(acct({ equity: 10, freeBalance: 10, startBalance: 10 }))).toEqual({ ok: true, sizeSol: RISK.MAX_POSITION_SOL });
    const small = fresh().checkEntry(acct({ equity: 0.45, freeBalance: 0.45, startBalance: 0.45 }));
    expect(small).toMatchObject({ ok: false, reason: expect.stringMatching(/below minimum/) });
  });

  it("caps open positions and entries per day", () => {
    const r = new RiskManager(memDb(), killFile());
    expect(r.checkEntry(acct({ openPositions: RISK.MAX_OPEN_POSITIONS }))).toMatchObject({ ok: false, reason: expect.stringMatching(/max open/) });
    expect(r.checkEntry(acct({ entriesToday: RISK.MAX_ENTRIES_PER_DAY }))).toMatchObject({ ok: false, reason: expect.stringMatching(/per day/) });
  });

  it("caps any one leader at 25% of our last 20 entries (5), also while there are fewer", () => {
    const r = new RiskManager(memDb(), killFile());
    expect(r.checkEntry(acct({ leaderRecentEntries: 4 }))).toMatchObject({ ok: true });
    expect(r.checkEntry(acct({ leaderRecentEntries: 5 }))).toMatchObject({ ok: false, reason: "leader has 5 of our last 20 entries (max 5)" });
  });

  it("keeps a free-balance reserve for exit fees", () => {
    const r = new RiskManager(memDb(), killFile());
    expect(r.checkEntry(acct({ freeBalance: 0.06 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/reserve/) });
  });

  it("halts entries for the rest of the UTC day after the daily loss cap, then resumes", () => {
    const c = clock();
    const r = new RiskManager(memDb(), killFile(), c.now);
    r.tick({ equity: 1, startBalance: 1 }); // day starts at equity 1.0
    r.tick({ equity: 0.96, startBalance: 1 });
    expect(r.haltedToday()).toBe(false);
    r.tick({ equity: 0.94, startBalance: 1 }); // -6% > 5% cap
    expect(r.haltedToday()).toBe(true);
    // recovering intraday does not un-halt
    expect(r.checkEntry(acct({ equity: 1.0 }))).toMatchObject({ ok: false, reason: "daily loss cap reached" });
    c.advance(24 * 3_600_000);
    expect(r.checkEntry(acct({ equity: 0.94, freeBalance: 0.94 }))).toMatchObject({ ok: true });
  });

  it("trips the kill switch on max drawdown, and it stays tripped", () => {
    const db = memDb();
    const r = new RiskManager(db, killFile());
    r.tick({ equity: 0.69, startBalance: 1 });
    expect(r.isKilled()).toMatchObject({ killed: true, reason: expect.stringMatching(/max drawdown/) });
    expect(r.checkEntry(acct())).toMatchObject({ ok: false, reason: expect.stringMatching(/kill switch/) });
    // a fresh instance (restart) still sees it
    expect(new RiskManager(db, killFile()).isKilled().killed).toBe(true);
  });

  it("honours a kill file dropped by a human", () => {
    const f = killFile();
    const r = new RiskManager(memDb(), f);
    expect(r.isKilled().killed).toBe(false);
    writeFileSync(f, "");
    expect(r.checkEntry(acct())).toMatchObject({ ok: false, reason: expect.stringMatching(/kill switch: kill file/) });
  });
});

describe("RiskManager exits", () => {
  it("stop loss at -25% and time exit at 30 minutes", () => {
    const c = clock();
    const r = new RiskManager(memDb(), killFile(), c.now);
    const p = { entryPrice: 1, openedAt: c.t };
    expect(r.checkExit(p, 0.76)).toBeNull();
    expect(r.checkExit(p, 0.75)).toBe("stop_loss");
    c.advance(RISK.TIME_EXIT_MS - 1);
    expect(r.checkExit(p, 2)).toBeNull();
    c.advance(1);
    expect(r.checkExit(p, 2)).toBe("time_exit");
  });
});

describe("practice trading without portfolio limits (limits.ts PAPER_NO_LIMITS)", () => {
  const paper = (c = clock()) => new RiskManager(memDb(), killFile(), c.now, limitsFor("paper"));

  it("is the owner's current choice, a frozen constant, and only for paper: live always gets the real limits", () => {
    expect(PAPER_NO_LIMITS).toBe(true);
    expect(Object.isFrozen(PAPER_TEST_RISK)).toBe(true);
    expect(limitsFor("live")).toBe(RISK);
    expect(limitsFor("paper")).toBe(PAPER_TEST_RISK);
  });

  it("no cap on open positions, entries per day, one leader's share or position size", () => {
    const r = paper();
    expect(r.checkEntry(acct({ openPositions: 500, entriesToday: 5000, leaderRecentEntries: 20 }))).toEqual({ ok: true, sizeSol: 0.02 });
    expect(paper().checkEntry(acct({ equity: 100, freeBalance: 100, startBalance: 100 }))).toEqual({ ok: true, sizeSol: 2 }); // 2% of equity, no 0.05 cap
    expect(r.checkEntry(acct({ equity: 0.2, freeBalance: 0.2 }))).toEqual({ ok: true, sizeSol: 0.004 }); // no minimum size
  });

  it("still can't spend SOL it doesn't have", () => {
    expect(paper().checkEntry(acct({ freeBalance: 0.01 }))).toMatchObject({ ok: false });
  });

  it("no daily loss halt and no automatic kill switch on drawdown", () => {
    const c = clock();
    const r = paper(c);
    r.tick({ equity: 1, startBalance: 1 });
    r.tick({ equity: 0.2, startBalance: 1 }); // -80%
    expect(r.haltedToday()).toBe(false);
    expect(r.isKilled().killed).toBe(false);
    expect(r.checkEntry(acct({ equity: 0.2, freeBalance: 0.2 })).ok).toBe(true);
  });

  it("keeps the exits and the manual kill switch", () => {
    const c = clock();
    const r = paper(c);
    expect(r.checkExit({ entryPrice: 1, openedAt: c.t }, 0.74)).toBe("stop_loss");
    expect(r.checkExit({ entryPrice: 1, openedAt: c.t - RISK.TIME_EXIT_MS }, 1)).toBe("time_exit");
    r.kill("make kill");
    expect(r.checkEntry(acct())).toEqual({ ok: false, reason: "kill switch: make kill" });
  });
});

describe("size up after consistency, not after profit (size-base.ts)", () => {
  const DAY = 86_400_000;
  /** Results from a list of [closedAt, pnl] trades. */
  const book = (trades: [number, number][]): Results => (from, to) => {
    const t = trades.filter(([at]) => at >= from && at < to);
    return { pnl: t.reduce((a, [, p]) => a + p, 0), trades: t.length };
  };
  /** `perWeek` trades of `pnl` each, every week for `weeks` weeks before `end`. */
  const weeksOf = (end: number, weeks: number, pnl: number, perWeek = MIN_WEEK_TRADES): [number, number][] =>
    Array.from({ length: weeks * perWeek }, (_, i) => [end - Math.floor(i / perWeek) * WEEK_MS - 1 - (i % perWeek) * 1000, pnl]);

  it("a winning day doesn't make the next trade bigger: size follows the starting balance", () => {
    const c = clock();
    const r = new RiskManager(memDb(), killFile(), c.now, PAPER_TEST_RISK, book([])); // no daily loss halt in the way
    expect(r.checkEntry(acct())).toEqual({ ok: true, sizeSol: 0.02 });
    expect(r.checkEntry(acct({ equity: 2, freeBalance: 2 }))).toEqual({ ok: true, sizeSol: 0.02 }); // doubled the account: same size
    expect(r.checkEntry(acct({ equity: 0.8, freeBalance: 0.8 }))).toEqual({ ok: true, sizeSol: 0.016 }); // losing still shrinks it
  });

  it("steps up only after 4 profitable weeks in a row, by at most 25%, never above the real balance", () => {
    const start = { base: 1, prev: null, stepAt: 0 };
    const now = 4 * WEEK_MS;
    expect(nextSizeBase(start, 2, now, book(weeksOf(now, 4, 0.01)), 4, 0.25)).toEqual({ state: { base: 1.25, prev: 1, stepAt: now }, event: "up" });
    expect(nextSizeBase(start, 1.1, now, book(weeksOf(now, 4, 0.01)), 4, 0.25)?.state.base).toBe(1.1);
    expect(nextSizeBase(start, 2, now - 1, book(weeksOf(now, 4, 0.01)), 4, 0.25)).toBeNull(); // not 4 weeks since the last step yet
    expect(nextSizeBase(start, 0.9, now, book(weeksOf(now, 4, 0.01)), 4, 0.25)).toBeNull(); // not up overall
    const oneBadWeek = weeksOf(now, 4, 0.01).concat([[now - 2 * WEEK_MS + DAY, -1]]);
    expect(nextSizeBase(start, 2, now, book(oneBadWeek), 4, 0.25)).toBeNull();
    expect(nextSizeBase(start, 2, now, book(weeksOf(now, 4, 0.01, MIN_WEEK_TRADES - 1)), 4, 0.25)).toBeNull(); // too few trades to prove anything
  });

  it("goes back down if the week after a step-up loses; a good week ends the trial", () => {
    const s = { base: 1.25, prev: 1, stepAt: 0 };
    expect(nextSizeBase(s, 1.3, WEEK_MS - 1, book([[DAY, -0.1]]), 4, 0.25)).toBeNull();
    expect(nextSizeBase(s, 1.3, WEEK_MS, book([[DAY, -0.1]]), 4, 0.25)).toEqual({ state: { base: 1, prev: null, stepAt: WEEK_MS }, event: "down" });
    expect(nextSizeBase(s, 1.3, WEEK_MS, book([[DAY, 0.1]]), 4, 0.25)).toEqual({ state: { base: 1.25, prev: null, stepAt: 0 }, event: "kept" });
  });

  it("the risk manager steps the proven balance it sizes from, and remembers it across restarts", () => {
    const c = clock();
    const db = memDb();
    const t0 = c.t;
    const r = new RiskManager(db, killFile(), c.now, RISK, book(weeksOf(t0 + 4 * WEEK_MS, 4, 0.01)));
    r.tick({ equity: 1, startBalance: 1 });
    expect(r.sizeBase()).toEqual({ base: 1, prev: null, stepAt: t0 });
    c.advance(4 * WEEK_MS);
    expect(r.checkEntry(acct({ equity: 2, freeBalance: 2 }))).toEqual({ ok: true, sizeSol: 0.025 }); // 2% of 1.25
    expect(new RiskManager(db, killFile(), c.now).sizeBase()).toEqual({ base: 1.25, prev: 1, stepAt: c.t });
  });
});
