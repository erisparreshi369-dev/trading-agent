import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { ConfigSchema, ROOT } from "../src/lib/config.js";
import { RISK } from "../src/risk/limits.js";
import { RiskManager, type AccountSnapshot } from "../src/risk/risk-manager.js";
import { clock, memDb } from "./helpers.js";

const killFile = () => join(mkdtempSync(join(tmpdir(), "kill-")), "KILL");
const acct = (over: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  equity: 1, freeBalance: 1, startBalance: 1, openPositions: 0, entriesToday: 0, ...over,
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
