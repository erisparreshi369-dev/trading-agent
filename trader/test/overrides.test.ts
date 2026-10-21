import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { CAP_OVERRIDE_KEY } from "../src/collector/budget.js";
import { STOP_OVERRIDE_KEY } from "../src/intel/madeonsol.js";
import { loadConfig, ROOT } from "../src/lib/config.js";
import { CONFIG_SETTINGS, EDITABLE, followOverrides, parseStored, resolveOverrides } from "../src/lib/overrides.js";
import { limitsFor, ownerLimits, PAPER_TEST_RISK, RISK, RISK_WALLS, type RiskName } from "../src/risk/limits.js";
import { RiskManager } from "../src/risk/risk-manager.js";
import { memDb } from "./helpers.js";

const put = (db: ReturnType<typeof memDb>, key: string, value: string) =>
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
const at = (obj: unknown, path: string) => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj);

describe("the list of limits the dashboard may change (shared/editable-settings.json)", () => {
  const raw = YAML.parse(readFileSync(resolve(ROOT, "config/config.yaml"), "utf8"));

  it("names real settings, each once, with a range that holds today's value", () => {
    const keys = EDITABLE.settings.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of CONFIG_SETTINGS) {
      const v = at(raw, s.path);
      expect(typeof v, s.path).toBe(s.type === "bool" ? "boolean" : "number");
      if (s.type !== "bool") expect(v as number, s.path).toBeGreaterThanOrEqual(s.min!), expect(v as number, s.path).toBeLessThanOrEqual(s.max!);
    }
    for (const [a, b] of EDITABLE.rules) for (const p of [a, b]) expect(EDITABLE.settings.some((s) => s.path === p), p).toBe(true);
  });

  it("the two older dashboard limits keep their database keys", () => {
    expect(EDITABLE.settings.find((s) => s.path === "collector.helius.daily_mb_cap")!.key).toBe(CAP_OVERRIDE_KEY);
    expect(EDITABLE.settings.find((s) => s.path === "madeonsol.stop_pct")!.key).toBe(STOP_OVERRIDE_KEY);
  });

  it("offers every trading safety limit, with exactly the walls in limits.ts", () => {
    for (const name of Object.keys(RISK) as RiskName[]) {
      const s = EDITABLE.settings.find((x) => x.path === `risk.${name}`);
      expect(s, name).toBeDefined();
      expect([s!.min, s!.max], name).toEqual([...RISK_WALLS[name]]);
      expect(RISK[name], name).toBeGreaterThanOrEqual(RISK_WALLS[name][0]);
      expect(RISK[name], name).toBeLessThanOrEqual(RISK_WALLS[name][1]);
    }
    expect(EDITABLE.settings.some((s) => s.path === "risk.PAPER_NO_LIMITS" && s.type === "bool")).toBe(true);
  });
});

describe("the walls (risk/limits.ts)", () => {
  it("the stop loss, time exit, loss stops and fee reserve can't be switched off; a trade can't pass 0.5 SOL", () => {
    expect(RISK_WALLS.STOP_LOSS_PCT[1]).toBeLessThan(1);
    expect(RISK_WALLS.TIME_EXIT_MS[1]).toBeLessThanOrEqual(30 * 60_000);
    expect(RISK_WALLS.DAILY_LOSS_CAP_PCT[1]).toBeLessThan(1);
    expect(RISK_WALLS.MAX_DRAWDOWN_PCT[1]).toBeLessThan(1);
    expect(RISK_WALLS.MIN_FREE_BALANCE_SOL[0]).toBeGreaterThan(0);
    expect(RISK_WALLS.MAX_POSITION_SOL[1]).toBe(0.5);
    expect(Object.isFrozen(RISK_WALLS)).toBe(true);
  });

  it("uses the owner's values inside the walls, for practice and real money", () => {
    const db = memDb();
    expect(limitsFor("live", db)).toBe(RISK);
    put(db, "override.risk.STOP_LOSS_PCT", "0.15");
    put(db, "override.risk.MAX_POSITION_SOL", "0.2");
    put(db, "override.risk.MAX_OPEN_POSITIONS", "8");
    expect(limitsFor("live", db)).toMatchObject({ STOP_LOSS_PCT: 0.15, MAX_POSITION_SOL: 0.2, MAX_OPEN_POSITIONS: 8, MAX_ENTRIES_PER_DAY: RISK.MAX_ENTRIES_PER_DAY });
    expect(ownerLimits(db).changed.sort()).toEqual(["MAX_OPEN_POSITIONS", "MAX_POSITION_SOL", "STOP_LOSS_PCT"]);
    // practice without limits (the normal choice) still lifts the portfolio limits, keeping the owner's stop loss
    expect(limitsFor("paper", db)).toMatchObject({ STOP_LOSS_PCT: 0.15, MAX_OPEN_POSITIONS: Infinity, MAX_POSITION_SOL: Infinity });
  });

  it("ignores anything past a wall, garbage, a fraction where a count is needed, or min above max", () => {
    const db = memDb();
    put(db, "override.risk.STOP_LOSS_PCT", "0.99"); // past the wall: no stop loss at all
    put(db, "override.risk.MAX_POSITION_SOL", "50");
    put(db, "override.risk.MAX_DRAWDOWN_PCT", "lots");
    put(db, "override.risk.MAX_OPEN_POSITIONS", "2.5");
    put(db, "override.risk.TIME_EXIT_MS", "");
    expect(limitsFor("live", db)).toBe(RISK);
    put(db, "override.risk.MIN_POSITION_SOL", "0.08");
    put(db, "override.risk.MAX_POSITION_SOL", "0.06");
    expect(limitsFor("live", db)).toMatchObject({ MIN_POSITION_SOL: RISK.MIN_POSITION_SOL, MAX_POSITION_SOL: RISK.MAX_POSITION_SOL });
  });

  it("the practice switch: off = practice uses the limits too", () => {
    const db = memDb();
    expect(limitsFor("paper", db)).toBe(PAPER_TEST_RISK);
    put(db, "override.risk.PAPER_NO_LIMITS", "0");
    expect(limitsFor("paper", db)).toBe(RISK);
    put(db, "override.risk.PAPER_NO_LIMITS", "maybe"); // not on/off: the normal choice
    expect(limitsFor("paper", db)).toBe(PAPER_TEST_RISK);
  });

  it("a risk manager reading them live sees a change at its next check", () => {
    const db = memDb();
    put(db, "override.risk.PAPER_NO_LIMITS", "0");
    const r = new RiskManager(db, "/nonexistent/KILL", () => Date.UTC(2026, 9, 21, 12), () => limitsFor("paper", db));
    const acct = { equity: 1, freeBalance: 1, startBalance: 1, openPositions: 5, entriesToday: 0, leaderRecentEntries: 0 };
    expect(r.checkEntry(acct)).toMatchObject({ ok: false, reason: "max open positions (5)" });
    put(db, "override.risk.MAX_OPEN_POSITIONS", "6");
    expect(r.checkEntry(acct)).toEqual({ ok: true, sizeSol: 0.02 });
    put(db, "override.risk.STOP_LOSS_PCT", "0.1");
    expect(r.checkExit({ entryPrice: 1, openedAt: Date.UTC(2026, 9, 21, 12) }, 0.89)).toBe("stop_loss");
  });
});

describe("the config limits (lib/overrides.ts)", () => {
  it("reads a stored value only if it's the right type and in range", () => {
    const s = (path: string) => CONFIG_SETTINGS.find((x) => x.path === path)!;
    expect(parseStored(s("signals.min_confirmations"), "2")).toBe(2);
    expect(parseStored(s("signals.min_confirmations"), "2.5")).toBeUndefined();
    expect(parseStored(s("signals.min_confirmations"), "99")).toBeUndefined();
    expect(parseStored(s("signals.min_leader_buy_sol"), "0")).toBe(0);
    expect(parseStored(s("signals.min_leader_buy_sol"), "")).toBeUndefined();
    expect(parseStored(s("signals.use_brain"), "0")).toBe(false);
    expect(parseStored(s("signals.use_brain"), "yes")).toBeUndefined();
  });

  it("applies valid values; a broken pair or a config the checks refuse falls back to config.yaml", () => {
    const base = loadConfig();
    const db = memDb();
    put(db, "override.signals.min_leader_buy_sol", "0.5");
    put(db, "override.scoring.min_copy_trades", "12");
    put(db, "override.signals.token_age_s.0", "600"); // above the max age below: the pair is ignored
    put(db, "override.signals.token_age_s.1", "300");
    put(db, "override.signals.max_top10_pct", "1000"); // out of range
    const r = resolveOverrides(db, base);
    expect(r.values.get("signals.min_leader_buy_sol")).toBe(0.5);
    expect(r.values.get("scoring.min_copy_trades")).toBe(12);
    expect(r.values.get("signals.token_age_s.0")).toBe(base.signals.token_age_s[0]);
    expect(r.values.get("signals.token_age_s.1")).toBe(base.signals.token_age_s[1]);
    expect(r.applied.sort()).toEqual(["scoring.min_copy_trades", "signals.min_leader_buy_sol"]);
    expect(r.ignored.sort()).toEqual(["signals.max_top10_pct", "signals.token_age_s.0", "signals.token_age_s.1"]);
    // MadeOnSol's warning must stay below its stop point (also a config check)
    put(db, "override.madeonsol.warn_pct", "95");
    expect(resolveOverrides(db, base).values.get("madeonsol.warn_pct")).toBe(base.madeonsol.warn_pct);
  });

  it("keeps the service's config object in step, in place, and says when something changed", () => {
    const cfg = loadConfig();
    const signals = cfg.signals, ages = cfg.signals.token_age_s;
    const before = { buy: cfg.signals.min_leader_buy_sol, steps: [...cfg.collector.helius.steps_pct] };
    const db = memDb();
    const onChange = vi.fn();
    const f = followOverrides(cfg, db, { everyMs: 0, onChange });
    expect(onChange).not.toHaveBeenCalled();
    put(db, "override.signals.min_leader_buy_sol", "0.3");
    put(db, "override.signals.token_age_s.1", "600");
    put(db, "override.collector.helius.steps_pct.0", "60");
    put(db, "override.signals.use_brain", "0");
    expect(f.refresh()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(cfg.signals).toBe(signals); // the same objects the engine holds
    expect(cfg.signals.token_age_s).toBe(ages);
    expect(cfg.signals.min_leader_buy_sol).toBe(0.3);
    expect(cfg.signals.token_age_s[1]).toBe(600);
    expect(cfg.collector.helius.steps_pct[0]).toBe(60);
    expect(cfg.signals.use_brain).toBe(false);
    expect(f.refresh()).toBe(false); // nothing new
    db.prepare("DELETE FROM kv WHERE key LIKE 'override.%'").run();
    expect(f.refresh()).toBe(true);
    expect(cfg.signals.min_leader_buy_sol).toBe(before.buy);
    expect(cfg.collector.helius.steps_pct).toEqual(before.steps);
    expect(cfg.signals.use_brain).toBe(true);
    f.stop();
  });
});
