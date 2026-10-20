import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { keepWatch, WATCH_CANDIDATE } from "../src/collector/budget.js";
import { coinsWeDecidedOn, runIntel } from "../src/intel/jobs.js";
import { MadeOnSol, type Fetch } from "../src/intel/madeonsol.js";
import { ROOT } from "../src/lib/config.js";
import type { DB } from "../src/lib/db.js";
import { scrubSecrets } from "../src/lib/log.js";
import { SignalEngine } from "../src/signals/engine.js";
import { cheapReasons, type Features } from "../src/signals/filters.js";
import { key, memDb, testConfig } from "./helpers.js";

const KEY = "msk_test_0123456789abcdefSECRET";
const NOW = Date.UTC(2026, 9, 21, 0, 2);
const cfg = testConfig();
const mcfg = cfg.madeonsol;

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; hang?: boolean; throws?: string };

/** A stand-in for MadeOnSol: records every request, answers from `route`. */
function fakeApi(route: (path: string, body: any) => Reply) {
  const calls: { url: string; auth: string; body: any }[] = [];
  const fetchFn: Fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, auth: init.headers.Authorization!, body });
    const r = route(url.replace(mcfg.base_url + "/", ""), body);
    if (r.throws) throw new Error(r.throws);
    if (r.hang) {
      await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, json: async () => r.body ?? {} };
  };
  return { calls, fetchFn };
}

function client(db: DB, route: (path: string, body: any) => Reply, over: Partial<typeof mcfg> = {}, now = () => NOW) {
  const f = fakeApi(route);
  return { api: new MadeOnSol(db, { ...mcfg, ...over }, KEY, now, f.fetchFn, async () => {}), calls: f.calls };
}

const alerts = (db: DB) => db.prepare("SELECT kind, data FROM alerts ORDER BY id").all().map((r: any) => ({ kind: r.kind, ...JSON.parse(r.data) }));

describe("MadeOnSol client: budget, timeout, never in the way", () => {
  it("ships optional, 200 a day, stopping at 90%, 10s timeout", () => {
    expect(mcfg).toMatchObject({ enabled: true, key_env: "MADEONSOL_API_KEY", daily_requests: 200, warn_pct: 70, stop_pct: 90, timeout_s: 10 });
  });

  it("counts every request and stops at 90% without sending more; one message at 70% and at 90%", async () => {
    const db = memDb();
    const { api, calls } = client(db, () => ({ body: { ok: 1 } }), { daily_requests: 10 });
    for (let i = 0; i < 12; i++) await api.request("me");
    expect(calls).toHaveLength(9); // 90% of 10
    expect(api.usedToday()).toBe(9);
    expect(await api.request("me")).toBeNull();
    expect(alerts(db)).toMatchObject([{ kind: "madeonsol_budget", pct: 70, used: 7 }, { kind: "madeonsol_budget", pct: 90, used: 9 }]);
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
  });

  it("the dashboard can move the stop point (up to all of MadeOnSol's requests); a bad value is ignored", async () => {
    const db = memDb();
    const { api, calls } = client(db, () => ({ body: {} }), { daily_requests: 10 });
    db.prepare("INSERT INTO kv (key, value) VALUES ('override.madeonsol_stop_pct', '100')").run();
    for (let i = 0; i < 12; i++) await api.request("me");
    expect(calls).toHaveLength(10);
    db.prepare("UPDATE kv SET value = '250' WHERE key = 'override.madeonsol_stop_pct'").run();
    expect(api.stopAt).toBe(9); // back to config's 90%
  });

  it("trusts MadeOnSol's own count when it's higher (e.g. requests you made by hand today)", async () => {
    const db = memDb();
    const { api, calls } = client(db, () => ({ body: {}, headers: { "x-ratelimit-used": "185" } }));
    await api.request("me");
    expect(api.usedToday()).toBe(185);
    expect(api.canRequest()).toBe(false);
    expect(await api.request("me")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("'out of requests' (429) stops everything for the day and sends one message", async () => {
    const db = memDb();
    const { api, calls } = client(db, () => ({ status: 429 }));
    expect(await api.request("me")).toBeNull();
    expect(await api.request("me")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(alerts(db)).toMatchObject([{ kind: "madeonsol_budget", pct: 100 }]);
  });

  it("a hung request gives up after the timeout; errors never throw", async () => {
    const db = memDb();
    const { api } = client(db, (p) => (p === "slow" ? { hang: true } : { throws: "ECONNREFUSED" }), { timeout_s: 0.05 });
    await expect(api.request("slow")).resolves.toBeNull();
    await expect(api.request("down")).resolves.toBeNull();
    const rows = db.prepare("SELECT ok, status, error FROM intel_requests ORDER BY id").all();
    expect(rows).toEqual([{ ok: 0, status: null, error: "timeout after 0.05s" }, { ok: 0, status: null, error: "Error: ECONNREFUSED" }]);
  });

  it("the key never reaches the database, alerts or logs", async () => {
    const db = memDb();
    const { api } = client(db, () => ({ throws: `bad request with key ${KEY} in it` }));
    await api.request("me");
    const everything = JSON.stringify([db.prepare("SELECT * FROM intel_requests").all(), db.prepare("SELECT * FROM alerts").all(), db.prepare("SELECT * FROM kv").all()]);
    expect(everything).not.toContain(KEY);
    expect(scrubSecrets(`Authorization: Bearer ${KEY}`)).not.toContain(KEY); // registered with the log scrubber
  });

  it("nothing in the trading path can call it: no code outside the intel job imports it or talks to madeonsol.com", () => {
    const src = resolve(ROOT, "trader/src");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "intel") walk(p);
        } else if (/from "\.\.\/intel\/|madeonsol\.com/i.test(readFileSync(p, "utf8"))) offenders.push(p.slice(src.length + 1));
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

/** The coin + creator data seen on 2026-10-20 (shapes as MadeOnSol returns them). */
function seedMarket(db: DB) {
  const following = key(), coinA = key(), coinB = key(), devA = key(), devB = key();
  db.prepare("INSERT INTO tracked_wallets (wallet, added_at, active, source) VALUES (?, 0, 1, 'scoring')").run(following);
  for (const [mint, dev] of [[coinA, devA], [coinB, devB]]) {
    db.prepare("INSERT INTO tokens (mint, creator, created_at, first_seen_at, source) VALUES (?, ?, ?, ?, 'pumpportal')").run(mint, dev, NOW - 3_600_000, NOW - 3_600_000);
  }
  db.prepare("INSERT INTO signals (ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (?, ?, ?, 0, 'curve', 'reject', '[]', '{}')").run(NOW - 600_000, following, coinA);
  return { following, coinA, coinB, devA, devB };
}

function intelRoute(m: ReturnType<typeof seedMarket>, ranked: { following: string; fast: string; good: string[] }) {
  return (path: string, body: any): Reply => {
    if (path === "token/batch") {
      return { body: { tokens: body.mints.map((mint: string) => ({ mint, launch_cohort_size: 20, is_blacklisted: false,
        deployer: mint === m.coinA ? { wallet: m.devA, tier: "cold", total_deployed: 558, total_bonded: 0, recent_bond_rate: 0, history_status: "established" }
          : { wallet: m.devB, tier: "unranked", total_deployed: 1, total_bonded: 0, history_status: "new_in_our_index" } })) } };
    }
    if (path === "tokens/batch/buyer-quality") return { body: { tokens: body.mints.map((mint: string) => ({ mint, score: 12, confidence: "low", signal: "negative", breakdown: { bundle_buyer_count: 6 } })) } };
    if (path.startsWith("alpha/leaderboard")) {
      return { body: { leaderboard: [ranked.following, ...ranked.good].map((wallet, i) => ({ rank: i + 1, wallet, net_pnl_sol: 100 - i, tokens_traded: 9 })) } };
    }
    if (path.startsWith("kol/leaderboard")) return { body: { leaderboard: [{ wallet: ranked.fast, name: "Fast", pnl: 999, median_hold_minutes_30d: 0.5 }] } };
    return { status: 404 };
  };
}

describe("daily intel job", () => {
  it("stores creator records and early-buyer scores with source and fetch time, for the coins we decided on", async () => {
    const db = memDb();
    const m = seedMarket(db);
    expect(coinsWeDecidedOn(db, NOW)).toEqual([m.coinA]);
    const { api, calls } = client(db, intelRoute(m, { following: m.following, fast: key(), good: [] }), { creator_batches: 0 });
    const s = await runIntel(db, mcfg, api, NOW);
    expect(s).toMatchObject({ coins: 1, creators: 1, earlyBuyerScores: 1 });
    expect(calls.map((c) => c.url.split("/v1/")[1]!.split("?")[0])).toEqual(["token/batch", "tokens/batch/buyer-quality", "alpha/leaderboard", "kol/leaderboard"]);
    expect(db.prepare("SELECT creator, fetched_at, tier, total_deployed, total_bonded, source FROM creator_reputation").all())
      .toEqual([{ creator: m.devA, fetched_at: NOW, tier: "cold", total_deployed: 558, total_bonded: 0, source: "madeonsol" }]);
    expect(db.prepare("SELECT mint, creator, early_buyer_score, bundle_buyers, source FROM token_intel").all())
      .toEqual([{ mint: m.coinA, creator: m.devA, early_buyer_score: 12, bundle_buyers: 6, source: "madeonsol" }]);
    expect(coinsWeDecidedOn(db, NOW + 1)).toEqual([]); // not fetched twice in a day
  });

  it("frequent creators: one coin each, batched 50 to a request, no early-buyer requests for them", async () => {
    const db = memDb();
    const m = seedMarket(db);
    db.prepare("DELETE FROM signals").run();
    db.prepare("DELETE FROM tracked_wallets").run();
    db.prepare("INSERT INTO tokens (mint, creator, created_at, first_seen_at, source) VALUES (?, ?, ?, ?, 'pumpportal')").run(key(), m.devA, NOW - 1000, NOW - 1000);
    const { api, calls } = client(db, intelRoute(m, { following: key(), fast: key(), good: [] }));
    await runIntel(db, mcfg, api, NOW);
    const batches = calls.filter((c) => c.url.endsWith("token/batch"));
    expect(batches).toHaveLength(1);
    expect(batches[0]!.body.mints).toHaveLength(1); // devA launched twice: one of its coins; devB once: skipped
    expect(calls.some((c) => c.url.endsWith("buyer-quality"))).toBe(false);
  });

  it("ranked wallets are candidates only: trial watch for the best ones we don't follow, at the lowest priority, one trial each", async () => {
    const db = memDb();
    const m = seedMarket(db);
    const fast = key();
    const good = Array.from({ length: 25 }, () => key());
    const route = intelRoute(m, { following: m.following, fast, good });
    const { api } = client(db, route, { creator_batches: 0 });
    const s = await runIntel(db, mcfg, api, NOW);
    expect(s.candidatesWatched).toBe(20);
    const watched = (db.prepare("SELECT wallet FROM candidate_watch").all() as { wallet: string }[]).map((r) => r.wallet);
    expect(watched).toEqual(expect.arrayContaining(good.slice(0, 20)));
    expect(watched).not.toContain(m.following); // already followed
    expect(watched).not.toContain(fast); // too fast to copy
    expect(db.prepare("SELECT kind, priority, reason, until FROM watchlist WHERE address = ?").get(good[0]))
      .toEqual({ kind: "wallet", priority: 9, reason: WATCH_CANDIDATE, until: NOW + 7 * 86_400_000 });
    expect(db.prepare("SELECT count(*) n, MIN(source) s FROM candidate_wallets").get()).toEqual({ n: 27, s: "madeonsol" });
    expect(db.prepare("SELECT count(*) n FROM tracked_wallets WHERE active = 1").get()).toEqual({ n: 1 }); // listing never means following
    // next day: all 20 slots still busy, nobody new; after the trials end the next ones get their turn
    const next = client(db, route, { creator_batches: 0 }, () => NOW + 86_400_000);
    expect((await runIntel(db, mcfg, next.api, NOW + 86_400_000)).candidatesWatched).toBe(0);
    const later = client(db, route, { creator_batches: 0 }, () => NOW + 8 * 86_400_000);
    expect((await runIntel(db, mcfg, later.api, NOW + 8 * 86_400_000)).candidatesWatched).toBe(5);
  });

  it("MadeOnSol down: the job finishes with nothing stored and the bot's data is untouched", async () => {
    const db = memDb();
    const m = seedMarket(db);
    const { api } = client(db, () => ({ throws: "ECONNRESET" }));
    const s = await runIntel(db, mcfg, api, NOW);
    expect(s).toMatchObject({ coins: 0, creators: 0, candidatesWatched: 0 });
    expect(db.prepare("SELECT count(*) n FROM tokens").get()).toEqual({ n: 2 });
    expect(m.coinA).toBeTruthy();
  });

  it("candidates are the first thing the collector drops when the data budget gets tight", () => {
    const row = { reason: WATCH_CANDIDATE, until: NOW + 86_400_000 };
    expect(["normal", "light", "essential", "positions_only"].map((mode) => keepWatch(mode as never, row, NOW, 3_600_000))).toEqual([true, false, false, false]);
  });
});

describe("creator check: decisions read only our database, only data fetched before the decision", () => {
  function engineAt(db: DB, at: number) {
    const info = { top10Pct: async () => 10, walletBalance: async () => 0 };
    return new SignalEngine(db, cfg.signals, info as never, {} as never, () => at) as unknown as { storedIntel(m: string, c: string | null): Features };
  }

  it("uses a creator record fetched before the decision, never one fetched after", () => {
    const db = memDb();
    const dev = key(), mint = key();
    db.prepare("INSERT INTO creator_reputation (creator, fetched_at, total_deployed, total_bonded) VALUES (?, ?, 558, 0), (?, ?, 600, 3)").run(dev, NOW, dev, NOW + 3_600_000);
    db.prepare("INSERT INTO token_intel (mint, fetched_at, early_buyer_score) VALUES (?, ?, 12)").run(mint, NOW + 60_000); // known only after the decision
    expect(engineAt(db, NOW - 1).storedIntel(mint, dev)).toEqual({ creator_launches: null, creator_success_rate: null, creator_record_age_h: null, early_buyer_score: null, intel_source: null });
    expect(engineAt(db, NOW + 1_800_000).storedIntel(mint, dev))
      .toEqual({ creator_launches: 558, creator_success_rate: 0, creator_record_age_h: 0.5, early_buyer_score: 12, intel_source: "madeonsol" });
  });

  it("is off for practice trades; the creator_check shadow variant turns it on", () => {
    const f: Features = { venue: "curve", leader_buy_sol: 1, token_known: true, token_age_s: 30, liquidity_sol: 5, confirmations: 1, creator_launches: 558, creator_success_rate: 0 };
    expect(cfg.signals.exclude_bad_creators).toBe(false);
    expect(cheapReasons(f, cfg.signals, false)).toEqual([]);
    const variant = { ...cfg.signals, ...cfg.shadow.variants.creator_check!.filters as object };
    expect(cheapReasons(f, variant, false)).toEqual(["bad creator: 558 launches, 0% filled their curve"]);
    expect(cheapReasons({ ...f, creator_launches: 3 }, variant, false)).toEqual([]); // too few launches to judge
    expect(cheapReasons({ ...f, creator_launches: null, creator_success_rate: null }, variant, false)).toEqual([]); // unknown creator passes
  });
});
