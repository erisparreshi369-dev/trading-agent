import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { raiseAlert } from "../src/lib/alerts.js";
import { heartbeat } from "../src/lib/db.js";
import { log } from "../src/lib/log.js";
import { attachAlerts } from "../src/lib/service.js";
import { Notifier } from "../src/notifier/notifier.js";
import { Telegram } from "../src/notifier/telegram.js";
import { RiskManager } from "../src/risk/risk-manager.js";
import { clock, key, memDb, testConfig } from "./helpers.js";

const CHAT = "424242";
const TOKEN = "123456789:AAFakeTokenForTestsOnly_xxxxxxxxxxxxx";

/** Fake Bot API: records sendMessage/sendDocument, serves queued updates to getUpdates. */
async function fakeTelegram() {
  const sent: { method: string; body: any }[] = [];
  const updates: any[] = [];
  let failNext = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const method = req.url!.split("/").pop()!;
      const raw = Buffer.concat(chunks).toString();
      const body = req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : raw;
      res.setHeader("content-type", "application/json");
      if (method === "getUpdates") {
        const batch = updates.splice(0);
        if (batch.length) return res.end(JSON.stringify({ ok: true, result: batch }));
        return setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 50);
      }
      if (failNext > 0) {
        failNext--;
        return res.end(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } }));
      }
      sent.push({ method, body });
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  let uid = 1;
  return {
    base: `http://127.0.0.1:${port}`,
    sent,
    texts: () => sent.filter((s) => s.method === "sendMessage").map((s) => s.body.text as string),
    docs: () => sent.filter((s) => s.method === "sendDocument"),
    command: (text: string, chat = CHAT) => updates.push({ update_id: uid++, message: { chat: { id: Number(chat) }, text, from: { username: "owner" } } }),
    rateLimitNext: (n: number) => (failNext = n),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const tg = await fakeTelegram();
  const db = memDb();
  const c = clock(Date.UTC(2026, 9, 20, 12, 0));
  const dir = mkdtempSync(join(tmpdir(), "notif-"));
  const reports = join(dir, "reports");
  mkdirSync(reports);
  const telegram = new Telegram(TOKEN, CHAT, tg.base, 0);
  const n = new Notifier({ db, cfg: testConfig().notifier, telegram, killFile: join(dir, "KILL"), reportsDir: reports, now: c.now });
  db.prepare("INSERT INTO paper_account (id, balance_sol, start_balance, created_at) VALUES (1, 0.98, 1, 0)").run();
  heartbeat(db, "collector", { streams: {} });
  heartbeat(db, "trader", { equity: 0.99 });
  db.prepare("UPDATE service_heartbeats SET ts = ?").run(c.t); // on the test clock
  db.prepare("INSERT INTO kv (key, value) VALUES ('notifier.last_daily', '2026-10-20')").run(); // today's summary already sent
  cleanups.push(tg.close, () => n.stop());
  return { tg, db, c, n, reports, dir };
}

function insertTrade(db: ReturnType<typeof memDb>, opts: { pnl?: number; failed?: boolean } = {}) {
  const mint = key();
  db.prepare("INSERT INTO tokens (mint, symbol, created_at, first_seen_at, source) VALUES (?, 'MOON', 0, 0, 't')").run(mint);
  const sig = Number(db.prepare("INSERT INTO signals (ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (0,'w',?,0,'curve','enter','[]','{}')").run(mint).lastInsertRowid);
  const pos = Number(db.prepare(`INSERT INTO paper_positions (signal_id, mint, leader_wallet, status, size_sol, leader_price, entry_due_at, cost_sol, opened_at, closed_at, pnl_sol)
    VALUES (?, ?, 'Leader1111111111111111111111111111111111111', ?, 0.02, 1, 0, 0.02, 1000, 61000, ?)`)
    .run(sig, mint, opts.failed ? "failed" : opts.pnl !== undefined ? "closed" : "open", opts.pnl ?? null).lastInsertRowid);
  const fill = db.prepare("INSERT INTO paper_fills (position_id, ts, side, venue, ok, sol, slippage_bps, reason) VALUES (?, 0, ?, 'curve', ?, ?, ?, ?)");
  if (opts.failed) fill.run(pos, "buy", 0, 0.0003, null, "slippage 1800bps over limit");
  else fill.run(pos, "buy", 1, 0.02, 107, null);
  if (opts.pnl !== undefined) fill.run(pos, "sell", 1, 0.02 + opts.pnl, 50, "leader_exit");
  return mint;
}

describe("Notifier trade and error alerts", () => {
  it("announces every paper buy, sell and missed fill exactly once, but not history from before it started", async () => {
    const s = await setup();
    insertTrade(s.db, { pnl: 0.004 }); // happened before the notifier ever ran
    s.n.start();
    insertTrade(s.db, { pnl: -0.0025 });
    insertTrade(s.db, { failed: true });
    await s.n.tick();
    await s.n.tick();
    const t = s.tg.texts().filter((x) => !x.startsWith("🤖"));
    expect(t).toHaveLength(3);
    expect(t[0]).toMatch(/^🟢 BUY \$MOON 0\.0200 SOL \[paper\]\nleader Lead…1111 · slippage \+107bps/);
    expect(t[1]).toMatch(/^🔴 SELL \$MOON -0\.0025 SOL \(-12\.5%\) \[paper\]\nleader_exit · held 60s/);
    expect(t[2]).toMatch(/^⚪ MISSED \$MOON: slippage 1800bps over limit/);
  });

  it("delivers queued alerts once, retries through rate limits, and never leaks secrets", async () => {
    const s = await setup();
    raiseAlert(s.db, "error", "collector", `boom at https://x/?api-key=abc123 with ${TOKEN}`, s.c.t);
    expect(raiseAlert(s.db, "error", "collector", `boom at https://x/?api-key=abc123 with ${TOKEN}`, s.c.t + 1000)).toBe(false); // deduped
    s.tg.rateLimitNext(2);
    await s.n.tick();
    expect(s.tg.texts()).toEqual(["🚨 [collector] boom at https://x/?api-key=*** with ***"]);
    expect(s.tg.texts()[0]).not.toContain("abc123");
    expect(s.tg.texts()[0]).not.toContain("AAFakeToken");
    await s.n.tick();
    expect(s.tg.texts()).toHaveLength(1);
  });

  it("routes error logs from any service into the outbox", async () => {
    const s = await setup();
    attachAlerts(s.db, "trader");
    try {
      log.error({ err: "db locked" }, "trader loop failed");
      log.warn("just a warning"); // not alerted
      log.warn({ alert: true }, "daily loss cap hit");
    } finally {
      attachAlerts(s.db, "x");
      (await import("../src/lib/log.js")).setAlertSink(null);
    }
    expect(s.db.prepare("SELECT level, source, text FROM alerts ORDER BY id").all()).toEqual([
      { level: "error", source: "trader", text: "trader loop failed: db locked" },
      { level: "warn", source: "trader", text: "daily loss cap hit" },
    ]);
  });
});

describe("Notifier watchdog", () => {
  it("alerts once when a service goes silent for 5 minutes and once when it recovers", async () => {
    const s = await setup();
    s.c.advance(4 * 60_000);
    await s.n.tick();
    expect(s.tg.texts()).toEqual([]);
    s.c.advance(61_000);
    s.db.prepare("UPDATE service_heartbeats SET ts = ? WHERE service = 'collector'").run(s.c.t); // collector alive, trader silent
    await s.n.tick();
    await s.n.tick();
    expect(s.tg.texts()).toEqual([expect.stringMatching(/^🚨 \[watchdog\] trader has not reported for 5 min/)]);
    s.db.prepare("UPDATE service_heartbeats SET ts = ? WHERE service = 'trader'").run(s.c.t);
    await s.n.tick();
    expect(s.tg.texts()[1]).toMatch(/^ℹ️ \[watchdog\] trader is reporting again/);
  });
});

describe("Notifier commands", () => {
  it("/stop trips the kill switch; only from the owner's chat", async () => {
    const s = await setup();
    const risk = new RiskManager(s.db, join(s.dir, "KILL"));
    s.n.start();
    s.tg.command("/stop", "999"); // a stranger
    await waitFor(() => s.n["d"].telegram.stats.ignoredChats === 1);
    expect(risk.isKilled().killed).toBe(false);
    s.tg.command("/stop@ser1sbot rugs everywhere");
    await waitFor(() => s.tg.texts().some((t) => t.startsWith("🛑")));
    expect(risk.isKilled()).toEqual({ killed: true, reason: "telegram /stop by owner: rugs everywhere" });
    expect(s.tg.texts().find((t) => t.startsWith("🛑"))).toMatch(/make unkill/);
  });

  it("/status and /pnl answer from the database", async () => {
    const s = await setup();
    insertTrade(s.db, { pnl: 0.006 });
    s.db.prepare("UPDATE paper_positions SET closed_at = ?").run(s.c.t - 1000);
    expect(await s.n.onCommand({ name: "status", args: "", from: "o" })).toMatch(/📊 Status\n🟢 collector \(0s ago\)\n.*\n🟢 trader/);
    const pnl = await s.n.onCommand({ name: "pnl", args: "", from: "o" });
    expect(pnl).toMatch(/equity 0\.9900 SOL \(-0\.0100 SOL, -1\.0% since start\)/);
    expect(pnl).toMatch(/today: 1 trades, 100% win, \+0\.0060 SOL/);
    expect(await s.n.onCommand({ name: "unkill", args: "", from: "o" })).toMatch(/unknown command/);
  });
});

describe("Notifier scheduled messages", () => {
  it("sends yesterday's summary once after the configured time", async () => {
    const s = await setup();
    s.c.t = Date.UTC(2026, 9, 21, 0, 4);
    s.db.prepare("UPDATE service_heartbeats SET ts = ?").run(Date.UTC(2026, 9, 21, 0, 3));
    await s.n.tick();
    expect(s.tg.texts()).toEqual([]);
    s.c.t = Date.UTC(2026, 9, 21, 0, 5);
    await s.n.tick();
    await s.n.tick();
    expect(s.tg.texts()).toEqual([expect.stringMatching(/^📅 Daily summary 2026-10-20 \[paper\]/)]);
  });

  it("sends new reports as documents, once", async () => {
    const s = await setup();
    writeFileSync(join(s.reports, "old.md"), "# old");
    s.n.start(); // existing reports at first start are not re-sent
    writeFileSync(join(s.reports, "weekly-2026-10-26.md"), "# week");
    await s.n.tick();
    await s.n.tick();
    expect(s.tg.docs()).toHaveLength(1);
    expect(s.tg.docs()[0]!.body).toContain("weekly-2026-10-26.md");
  });
});

async function waitFor(cond: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("secret scrubbing", () => {
  it("removes API keys and Telegram tokens wherever they appear", async () => {
    const { scrubSecrets } = await import("../src/lib/log.js");
    const helius = "0123abcd-0000-4000-8000-0123456789ab";
    const out = scrubSecrets(`GET https://mainnet.helius-rpc.com/?api-key=${helius} failed; token ${TOKEN}; url https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(out).not.toContain(helius);
    expect(out).not.toContain("AAFakeToken");
    expect(out).toBe("GET https://mainnet.helius-rpc.com/?api-key=*** failed; token ***; url https://api.telegram.org/***/sendMessage");
  });
});


describe("crash detection (markStarted)", () => {
  it("alerts when the previous run died hard, not after a clean stop or an already-reported crash", async () => {
    const { markStarted } = await import("../src/lib/service.js");
    const db = memDb();
    const texts = () => (db.prepare("SELECT level, text FROM alerts ORDER BY id").all() as { level: string; text: string }[]);
    markStarted(db, "trader"); // first ever start
    expect(texts()).toEqual([]);
    markStarted(db, "trader"); // previous run never stopped cleanly: kill -9 / OOM / power loss
    expect(texts()).toEqual([{ level: "error", text: "trader restarted after dying without a clean shutdown (killed, out of memory, or power loss), 1st time today" }]);
    markStarted(db, "trader"); // again within minutes: must NOT be swallowed by the outbox dedupe
    expect(texts()[1]!.text).toMatch(/2nd time today$/);
    db.prepare("UPDATE kv SET value = 'stopped' WHERE key = 'run_state.trader'").run();
    markStarted(db, "trader"); // clean stop: silent
    db.prepare("UPDATE kv SET value = 'crashed' WHERE key = 'run_state.trader'").run();
    markStarted(db, "trader"); // the crash itself was alerted when it happened; just say it's back
    expect(texts().map((t) => t.level)).toEqual(["error", "error", "info"]);
    expect(texts()[2]!.text).toBe("trader is back up after the crash (3rd today)");
  });
});
