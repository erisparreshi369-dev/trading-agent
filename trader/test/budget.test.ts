import { describe, expect, it } from "vitest";
import { CAP_OVERRIDE_KEY, capEta, dailyCap, firehoseAllowed, followsWallets, keepWatch, modeFor, stepReached, UsageRate } from "../src/collector/budget.js";
import { testConfig } from "./helpers.js";

const STEPS = [70, 85, 95] as const;
const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0);

describe("data budget", () => {
  it("ships with 70/85/95% steps and a 1500 MB daily cap", () => {
    expect(testConfig().collector.helius).toEqual({ daily_mb_cap: 1500, monthly_credits: 1_000_000, credits_per_mb: 20, stream_share: 0.9, steps_pct: [70, 85, 95] });
  });

  it("steps down through lighter modes before the cap", () => {
    expect(modeFor(1000, 1500, STEPS, 0)).toBe("normal");
    expect(modeFor(1050, 1500, STEPS, 0)).toBe("light");
    expect(modeFor(1275, 1500, STEPS, 0)).toBe("essential");
    expect(modeFor(1425, 1500, STEPS, 0)).toBe("positions_only");
    expect(modeFor(1500, 1500, STEPS, 0)).toBe("off");
    expect(modeFor(1600, 1500, STEPS, 2)).toBe("positions_only"); // open trades are never left blind
  });

  it("warning steps", () => {
    expect([1000, 1050, 1300, 1430, 1500].map((mb) => stepReached(mb, 1500, STEPS))).toEqual([0, 70, 85, 95, 100]);
  });

  it("what each mode keeps watching", () => {
    const tokenMs = 60 * 60_000;
    const position = { reason: "paper position", until: NOW + 86_400_000 };
    const pool = { reason: "migrated with tracked holders", until: NOW + 40 * H };
    const freshToken = { reason: "tracked wallet trade", until: NOW + tokenMs - 5 * 60_000 }; // traded 5 min ago
    const oldToken = { reason: "tracked wallet trade", until: NOW + tokenMs - 45 * 60_000 }; // 45 min ago
    const keep = (m: Parameters<typeof keepWatch>[0]) => [position, pool, freshToken, oldToken].map((r) => keepWatch(m, r, NOW, tokenMs));
    expect(keep("normal")).toEqual([true, true, true, true]);
    expect(keep("light")).toEqual([true, false, true, true]);
    expect(keep("essential")).toEqual([true, false, true, false]);
    expect(keep("positions_only")).toEqual([true, false, false, false]);
    expect(keep("off")).toEqual([false, false, false, false]);
    expect(["normal", "light", "essential", "positions_only", "off"].map((m) => [firehoseAllowed(m as never), followsWallets(m as never)])).toEqual([
      [true, true], [false, true], [false, true], [false, false], [false, false],
    ]);
  });

  it("MB per hour and when we hit the cap at that speed", () => {
    const r = new UsageRate(NOW - 2 * H);
    for (let m = 0; m < 60; m++) r.add(NOW - m * 60_000, 2e6); // 2 MB a minute for the last hour
    r.add(NOW - 2 * H, 999e6); // older than an hour: not counted
    expect(r.mbLastHour(NOW)).toBeCloseTo(120, 6);
    expect(r.mbPerHour(NOW)).toBeCloseTo(120, 6);
    expect(capEta(1260, 1500, 120, NOW)).toBe(NOW + 2 * H); // 240 MB left at 120 MB/h
    expect(capEta(100, 1500, 120, NOW)).toBe(NOW + (1400 / 120) * H); // 23:40
    expect(capEta(40, 1500, 120, NOW)).toBeNull(); // 1460 MB left lasts past midnight
    expect(capEta(1500, 1500, 0, NOW)).toBe(NOW);
    expect(capEta(100, 1500, 0, NOW)).toBeNull();
  });

  it("right after a restart the speed is extrapolated from what we have (at least 10 minutes)", () => {
    const r = new UsageRate(NOW - 20 * 60_000);
    r.add(NOW - 60_000, 10e6);
    expect(r.mbPerHour(NOW)).toBeCloseTo(30, 6); // 10 MB in 20 minutes
  });
});

describe("the trader respects the data budget", () => {
  it("opens no new trades once the collector only watches open trades; normal again when the mode is back", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { PaperEngine } = await import("../src/paper/engine.js");
    const { RiskManager } = await import("../src/risk/risk-manager.js");
    const { clock, Curve, key, memDb } = await import("./helpers.js");
    const db = memDb();
    const c = clock();
    const e = new PaperEngine(db, testConfig().paper, new RiskManager(db, join(mkdtempSync(join(tmpdir(), "kill-")), "KILL"), c.now), c.now);
    e.init();
    const curve = new Curve(db, key(), key(), c.t - 60_000).insertToken();
    const leader = key();
    curve.buy(leader, 1, c.t);
    const mode = (m: string) => db.prepare("INSERT INTO kv (key, value) VALUES ('collector.data_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(m);
    const enter = () => e.enter(1, { mint: curve.mint, wallet: leader, venue: "curve", received_at: c.t, price_sol: curve.price });
    db.prepare("INSERT INTO signals (id, ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (1, 0, 'w', ?, 0, 'curve', 'enter', '[]', '{}')").run(curve.mint);
    for (const m of ["positions_only", "off"]) {
      mode(m);
      expect(enter()).toEqual({ ok: false, reason: "data budget nearly used: no new trades until 00:00 UTC" });
    }
    mode("essential");
    expect(enter().ok).toBe(true);
  });
});

describe("raising the daily cap (dashboard) never uses up the month", () => {
  const h = testConfig().collector.helius; // 1M credits * 90% / 20 = 45,000 MB per 31 days
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it("config cap by default; the dashboard override when set; a bad override is ignored", async () => {
    const { memDb } = await import("./helpers.js");
    const db = memDb();
    expect(dailyCap(db, h, NOW)).toEqual({ capMb: 1500, chosenMb: 1500, overridden: false, monthlyGuardMb: 45_000 });
    db.prepare("INSERT INTO kv (key, value) VALUES (?, '4000')").run(CAP_OVERRIDE_KEY);
    expect(dailyCap(db, h, NOW)).toMatchObject({ capMb: 4000, chosenMb: 4000, overridden: true });
    db.prepare("UPDATE kv SET value = 'lots' WHERE key = ?").run(CAP_OVERRIDE_KEY);
    expect(dailyCap(db, h, NOW)).toMatchObject({ capMb: 1500, overridden: false });
  });

  it("today may use at most the monthly budget minus the previous 30 days, however high the cap", async () => {
    const { memDb } = await import("./helpers.js");
    const db = memDb();
    db.prepare("INSERT INTO kv (key, value) VALUES (?, '1000000')").run(CAP_OVERRIDE_KEY);
    const use = db.prepare("INSERT INTO stream_usage (day, source, messages, bytes) VALUES (?, ?, 1, ?)");
    use.run(day(NOW - 86_400_000), "firehose", 30_000e6); // yesterday: 30 GB
    use.run(day(NOW - 10 * 86_400_000), "targeted", 10_000e6); // 10 days ago: 10 GB
    use.run(day(NOW - 31 * 86_400_000), "firehose", 40_000e6); // older than the window: not counted
    use.run(day(NOW - 86_400_000), "pumpportal", 99_000e6); // free, not Helius: not counted
    use.run(day(NOW), "firehose", 2_000e6); // today's own use is checked against the cap, not here
    expect(dailyCap(db, h, NOW)).toEqual({ capMb: 5_000, chosenMb: 1_000_000, overridden: true, monthlyGuardMb: 5_000 });
    use.run(day(NOW - 2 * 86_400_000), "firehose", 9_000e6);
    expect(dailyCap(db, h, NOW).capMb).toBe(0); // the month's budget is spent: nothing until older days roll out
  });
});
