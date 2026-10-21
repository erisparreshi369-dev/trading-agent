import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { raiseAlert } from "../src/lib/alerts.js";
import { heartbeat } from "../src/lib/db.js";
import { log, setAlertSink } from "../src/lib/log.js";
import { attachAlerts, markStarted } from "../src/lib/service.js";
import * as M from "../src/notifier/messages.js";
import { DOWN_GRACE_MS, Notifier } from "../src/notifier/notifier.js";
import { Telegram } from "../src/notifier/telegram.js";
import { RiskManager } from "../src/risk/risk-manager.js";
import { clock, key, memDb, testConfig } from "./helpers.js";
import { samples } from "./message-samples.js";

const CHAT = "424242";
const TOKEN = "123456789:AAFakeTokenForTestsOnly_xxxxxxxxxxxxx";
const DEAD_PID = 4_194_304 + 777; // above Linux's pid_max: never a live process
const HOUR = 3_600_000;

/** Fake Bot API: records what we send, serves queued updates (commands, button presses) to getUpdates. */
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
      if (failNext > 0 && method === "sendMessage") {
        failNext--;
        return res.end(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } }));
      }
      sent.push({ method, body });
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  let uid = 1;
  return {
    base: `http://127.0.0.1:${port}`,
    sent,
    texts: () => sent.filter((s) => s.method === "sendMessage").map((s) => s.body.text as string),
    edits: () => sent.filter((s) => s.method === "editMessageText").map((s) => s.body.text as string),
    docs: () => sent.filter((s) => s.method === "sendDocument"),
    command: (text: string, chat = CHAT) => updates.push({ update_id: uid++, message: { chat: { id: Number(chat) }, text, from: { username: "owner" } } }),
    tap: (data: string, chat = CHAT) =>
      updates.push({ update_id: uid++, callback_query: { id: `cb${uid}`, data, from: { username: "owner" }, message: { message_id: 1, chat: { id: Number(chat) } } } }),
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
  const c = clock(Date.UTC(2026, 9, 20, 12, 0, 30));
  const dir = mkdtempSync(join(tmpdir(), "notif-"));
  const reports = join(dir, "reports");
  mkdirSync(reports);
  const telegram = new Telegram(TOKEN, CHAT, tg.base, 0);
  const n = new Notifier({ db, cfg: testConfig({ notifier: { watch_services: ["collector", "trader"] } }), telegram, killFile: join(dir, "KILL"), reportsDir: reports, now: c.now });
  db.prepare("INSERT INTO paper_account (id, balance_sol, start_balance, created_at) VALUES (1, 0.98, 1, 0)").run();
  for (const s of ["collector", "trader"]) {
    db.prepare("INSERT INTO service_runs (service, state, pid, changed_at) VALUES (?, 'running', ?, ?)").run(s, process.pid, c.t - 60_000);
    heartbeat(db, s, s === "trader" ? { equity: 0.99 } : { streams: { targeted: true, firehose: true }, heliusMbToday: 420, heliusCapMb: 1500 });
  }
  db.prepare("UPDATE service_heartbeats SET ts = ?").run(c.t); // on the test clock
  for (const [k, v] of [["notifier.last_daily", "2026-10-20"], ["notifier.last_hour", String(Date.UTC(2026, 9, 20, 12))], ["notifier.fill_cursor", "0"], ["notifier.reports_sent", "[]"], ["notifier.guide_sent", "1"]]) {
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(k, v);
  }
  cleanups.push(tg.close, () => n.stop());
  /** advance the clock, keeping the given services' heartbeats fresh */
  const advance = (ms: number, alive = ["collector", "trader"]) => {
    c.advance(ms);
    for (const s of alive) db.prepare("UPDATE service_heartbeats SET ts = ? WHERE service = ?").run(c.t, s);
  };
  return { tg, db, c, n, reports, dir, advance };
}

function insertTrade(db: ReturnType<typeof memDb>, opts: { pnl?: number; failed?: boolean; exit?: string; at?: number } = {}) {
  const mint = key();
  db.prepare("INSERT INTO tokens (mint, symbol, created_at, first_seen_at, source) VALUES (?, 'MOON', 0, 0, 't')").run(mint);
  const sig = Number(db.prepare(`INSERT INTO signals (ts, wallet, mint, leader_trade_id, venue, decision, reasons, features)
    VALUES (?, 'w', ?, 0, 'curve', 'enter', '[]', '{"confirmations":2,"token_age_s":95,"top10_pct":22.5,"dev_sold_frac":0}')`).run(opts.at ?? 0, mint).lastInsertRowid);
  const closedAt = opts.at ?? 61_000;
  const pos = Number(db.prepare(`INSERT INTO paper_positions (signal_id, mint, leader_wallet, status, size_sol, leader_price, entry_due_at, cost_sol, opened_at, closed_at, pnl_sol, proceeds_sol, exit_reason)
    VALUES (?, ?, 'Leader1111111111111111111111111111111111111', ?, 0.02, 1, 0, 0.02, ?, ?, ?, ?, ?)`)
    .run(sig, mint, opts.failed ? "failed" : opts.pnl !== undefined ? "closed" : "open", closedAt - 60_000, closedAt, opts.pnl ?? null,
      opts.pnl !== undefined ? 0.02 + opts.pnl : null, opts.failed ? "slippage 1800bps over limit" : opts.pnl !== undefined ? opts.exit ?? "leader_exit" : null).lastInsertRowid);
  const fill = db.prepare("INSERT INTO paper_fills (position_id, ts, side, venue, ok, sol, slippage_bps, reason) VALUES (?, 0, ?, 'curve', ?, ?, ?, ?)");
  if (opts.failed) fill.run(pos, "buy", 0, 0.0003, 1800, "slippage 1800bps > limit");
  else fill.run(pos, "buy", 1, 0.02, 107, null);
  if (opts.pnl !== undefined) fill.run(pos, "sell", 1, 0.02 + opts.pnl, 50, opts.exit ?? "leader_exit");
  return mint;
}

function insertSignal(db: ReturnType<typeof memDb>, at: number, decision: string, reasons: string[], mint = key()) {
  db.prepare("INSERT INTO signals (ts, wallet, mint, leader_trade_id, venue, decision, reasons, features) VALUES (?, 'w', ?, 0, 'curve', ?, ?, '{}')")
    .run(at, mint, decision, JSON.stringify(reasons));
}

const crash = (db: ReturnType<typeof memDb>, svc: string, at: number, detail = `${svc} crashed: Error: boom`) =>
  db.prepare("UPDATE service_runs SET state = 'crashed', detail = ?, changed_at = ? WHERE service = ?").run(detail, at, svc);

/** What systemd does after a crash: the new process starts (markStarted) and reports in. */
function restart(db: ReturnType<typeof memDb>, svc: string, at: number) {
  markStarted(db, svc, at);
  db.prepare("UPDATE service_heartbeats SET ts = ?, pid = ? WHERE service = ?").run(at, process.pid, svc);
}

// ------------------------------------------------------------------------------------------------

describe("every message follows the house rules", () => {
  const all = samples();
  /** Jargon the owner asked us never to use (plain replacements live in messages.ts). */
  const JARGON = /\b(leader|tracked|wallets?|slippage|stop[- ]?loss|paper trade|pnl|drawdown|rugs?|signals?|rejected|notifier|services?|tokens?|mint|bps|equity|positions?|holders?|devs?|developer|roi|kill switch|exit|pump\.fun|helius|pid|null|undefined|nan)\b/i;

  it.each(all.map((s) => [s.name, s.text]))("%s", (_name, text) => {
    const lines = text.split("\n");
    const detailsAt = lines.indexOf("More details:");
    const head = detailsAt === -1 ? lines : lines.slice(0, detailsAt);
    // 1. same shape every time: title, what happened, good/bad/normal, (≤2 more), what to do
    expect(lines[0]).toMatch(/^(\[(PAPER|LIVE)\] )?[A-Z][A-Z ']+( · .+)?$/);
    expect(lines[1]).toMatch(/^What happened: \S/);
    expect(lines[2]).toMatch(/^(✅ Good|⚠️ Be careful|🚨 Bad|😐 Normal): \S/u);
    expect(head[head.length - 1]).toMatch(/^What to do: \S.*[.!)]$/);
    expect(text.match(/^What to do:/gm)).toHaveLength(1);
    // 2. short: at most 6 lines before the details
    expect(head.length).toBeLessThanOrEqual(6);
    // 3. no jargon ("data collector" is the part's agreed name)
    expect(text.replace(/data collector/g, "").replace(/\/\w+/g, "")).not.toMatch(JARGON); // command names like /pnl are the owner's choice
    // 4. SOL explained in brackets the first time it appears
    if (/\bSOL\b/.test(text) && !/^(WORDS I USE|EXPLAINED)/.test(lines[0]!)) expect(text.match(/\bSOL\b.*/)![0]).toMatch(/^SOL \(the coin we trade with\)/);
    expect(text).not.toMatch(/\) \(|\([^()]*\([^()]*\)[^()]*\)/); // no doubled or nested brackets
    expect(text).not.toMatch(/×/); // "5 times", not "5×"
    // 5. no addresses, ids, long decimals or raw log text
    expect(text).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{25,}|\d\.\d{4,}|"level"|\{"|SIG[A-Z]+|trading-\w+/);
    // 6. the verdict emoji only in the verdict line (and status/guide detail lists)
    expect(lines[0]).not.toMatch(/[✅⚠️🚨😐]/u);
  });

  it("money always comes with plain words for its size", () => {
    for (const name of ["paper win", "paper loss"]) expect(all.find((s) => s.name === name)!.text).toMatch(/We (gained|lost) [\d.]+ SOL \(the coin we trade with\)\. That is a (small|medium|big) (gain|loss)\./);
  });

  it("every reason the trading part writes has a plain explanation", () => {
    const reasons = [
      "venue amm not enabled", "leader buy 0.040 < 0.1 SOL", "token launch not seen (no creator/age data)", "token age 2s outside [3, 1800]",
      "token age 2400s outside [3, 1800]", "mayhem mode token", "dev launched 9 tokens in 24h", "leader is the token's dev",
      "curve SOL 0.40 outside [1, 75]", "curve SOL 80.12 outside [1, 75]", "1 tracked buyers < 2", "re-entry cooldown", "top10 holders 61.2% > 40%",
      "dev holds 12.5% > 10%", "dev sold 80% of launch buy", "on-chain check failed: Error: 429", "score -0.012 < 0", "model expects -8.0% follower ROI < 2.0% threshold",
      "risk: kill switch: make kill", "risk: daily loss cap reached", "risk: max open positions (5)", "risk: max entries per day (40)",
      "risk: leader has 5 of our last 20 entries (max 5)", "risk: position size 0.0080 below minimum 0.01", "risk: free balance would drop below reserve",
      "risk: already in this token",
    ];
    for (const r of reasons) {
      const e = M.explainSkip(r);
      expect(e.key, r).not.toBe("other");
      expect(`${e.short} ${e.long}`, r).not.toMatch(JARGON_WORDS);
    }
    expect(M.explainSkip("dev sold 80% of launch buy").long).toBe("the person who made it already sold, which is often a scam");
  });

  it("/explain recognises every kind of message by its title, and lists the words in it", () => {
    for (const s of all.filter((x) => !/^EXPLAINED/.test(x.text))) {
      const e = M.explain(s.text);
      expect(e, s.name).not.toMatch(/This is one of my messages about the bot/);
      expect(e, s.name).toMatch(/Example: /);
    }
    const ex = M.explain(all.find((s) => s.name === "paper loss")!.text);
    expect(ex).toMatch(/Words in that message:\n  - SOL: /);
    expect(ex).toMatch(/automatic sell to stop a big loss: /);
  });

  it("/words explains every special word in one line", () => {
    const w = M.words();
    for (const [word] of M.WORDS) expect(w).toContain(`• ${word}: `);
  });
});

const JARGON_WORDS = /\b(leader|tracked|wallets?|slippage|stop[- ]?loss|pnl|drawdown|rugs?|signals?|tokens?|devs?|developer|roi|kill switch)\b/i;

describe("trade messages", () => {
  it("one message per followed trade (buy, sell, missed buy), once, not history from before the first start", async () => {
    const s = await setup();
    s.db.prepare("DELETE FROM kv WHERE key = 'notifier.fill_cursor'").run();
    insertTrade(s.db, { pnl: 0.004 }); // happened before the notifier ever ran
    s.n.start("stopped");
    insertTrade(s.db, { pnl: -0.0025 });
    insertTrade(s.db, { failed: true });
    await s.n.tick();
    await s.n.tick();
    const t = s.tg.texts().filter((x) => !/^(BOT STARTED|HOW TO READ)/.test(x));
    expect(t).toHaveLength(3);
    expect(t[0]).toMatch(/^\[PAPER\] TRADE OPENED · MOON\nWhat happened: We copied a trade\. We bought MOON for 0\.020 SOL \(the coin we trade with\) as a practice trade \(no real money\)\./);
    expect(t[0]).toMatch(/• 2 of the traders we copy bought it\./);
    expect(t[0]).toMatch(/• The price moved against us before our trade went through\. We paid 1\.1% more than the trader we copy\./);
    expect(t[1]).toMatch(/^\[PAPER\] TRADE CLOSED · MOON\nWhat happened: We sold MOON\. We got back less than we paid\.\n😐 Normal: We lost 0\.00\d SOL \(the coin we trade with\)\. That is a small loss\./);
    expect(t[1]).toMatch(/• Why we sold: the trader we copy sold\./);
    expect(t[2]).toMatch(/^\[PAPER\] TRADE NOT DONE · MOON\n[\s\S]*It went up 18%, and we only allow \d+%\./);
  });

  it("skipped chances: one message each only when a scam check caught it; the rest in the hourly summary", async () => {
    const s = await setup();
    const h = Date.UTC(2026, 9, 20, 12);
    for (let i = 0; i < 5; i++) insertSignal(s.db, h + i * 1000, "reject", ["token age 2400s outside [3, 1800]"]);
    for (let i = 0; i < 3; i++) insertSignal(s.db, h + i * 1000, "reject", ["dev sold 90% of launch buy", "top10 holders 70.0% > 40%"]);
    insertSignal(s.db, h + 5000, "risk_block", ["risk: max open positions (5)"]);
    insertSignal(s.db, h + 6000, "enter", []);
    await s.n.tick();
    expect(s.tg.texts()).toHaveLength(3); // the 3 scam-check skips, nothing for "too old" or the safety limit
    for (const t of s.tg.texts()) expect(t).toMatch(/^SKIPPED CHANCE · \S+\n[\s\S]*✅ Good: Our safety check found a danger: the person who made it already sold/);
    s.advance(HOUR);
    await s.n.tick();
    await s.n.tick();
    expect(s.tg.texts()).toHaveLength(4);
    const a = s.tg.texts()[3]!;
    expect(a).toMatch(/^HOURLY SUMMARY\nWhat happened: In the last hour, the traders we copy made 10 buys\. We copied 1 and skipped 9\.\n/);
    expect(a).toMatch(/• Skipped 5 times: the coin was too old.*\n• Skipped 3 times: the person who made it already sold, which is often a scam/);
    expect(a).toMatch(/• Skipped once by a safety limit: we already had 5 trades open, our limit\./);
  });

  it("no summary for an hour where nothing happened", async () => {
    const s = await setup();
    s.advance(HOUR);
    await s.n.tick();
    expect(s.tg.texts()).toEqual([]);
  });
});

describe("parts of the bot stopping", () => {
  it("a crash that systemd fixes within 20s: no alarm, one short 🔧 message", async () => {
    const s = await setup();
    crash(s.db, "trader", s.c.t);
    s.advance(2_000, ["collector"]);
    await s.n.tick();
    s.advance(4_000, ["collector"]);
    restart(s.db, "trader", s.c.t);
    s.advance(DOWN_GRACE_MS - 6_000);
    await s.n.tick();
    expect(s.tg.texts()).toEqual([]); // back, but not yet up for 20s
    s.advance(6_000);
    await s.n.tick();
    await s.n.tick();
    expect(s.tg.texts()).toEqual([expect.stringMatching(/^BOT HEALTH · The trading part restarted by itself\nWhat happened: The trading part stopped suddenly and started again by itself a few seconds later\.\n😐 Normal: [\s\S]*Probable reason: it hit an unexpected problem\./)]);
    expect(s.tg.texts()[0]).not.toMatch(/not restarted/);
  });

  it("restarts are grouped: at most one 🔧 message per part per hour", async () => {
    const s = await setup();
    restart(s.db, "collector", s.c.t); // killed: previous run never shut down cleanly
    s.advance(30_000);
    await s.n.tick();
    expect(s.tg.texts()).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      s.advance(10 * 60_000);
      crash(s.db, "collector", s.c.t);
      s.advance(5_000);
      restart(s.db, "collector", s.c.t);
      s.advance(30_000);
      await s.n.tick();
    }
    expect(s.tg.texts()).toHaveLength(1);
    s.advance(HOUR - 3 * (10 * 60_000 + 35_000));
    await s.n.tick();
    expect(s.tg.texts()).toHaveLength(2);
    expect(s.tg.texts()[1]).toMatch(/^BOT HEALTH · The data collector restarted by itself\n[\s\S]*It happened 3 times in the last hour\./);
  });

  it("still down after 20s: 🚨 once, then ✅ when it's back (not a 🔧 as well)", async () => {
    const s = await setup();
    crash(s.db, "trader", s.c.t, "db write failed: SqliteError: database or disk is full");
    s.advance(DOWN_GRACE_MS - 1_000, ["collector"]);
    await s.n.tick();
    expect(s.tg.texts()).toEqual([]);
    s.advance(1_000, ["collector"]);
    await s.n.tick();
    s.advance(60_000, ["collector"]);
    await s.n.tick();
    expect(s.tg.texts()).toEqual([expect.stringMatching(/^BOT HEALTH · The trading part is down\n[\s\S]*🚨 Bad: [\s\S]*What to do: On the bot's computer, type: df -h[\s\S]*Probable reason: it could not save data, maybe the disk is full\./)]);
    restart(s.db, "trader", s.c.t);
    await s.n.tick();
    s.advance(HOUR);
    await s.n.tick();
    expect(s.tg.texts()).toHaveLength(2);
    expect(s.tg.texts()[1]).toMatch(/^BOT HEALTH · The trading part is working again\nWhat happened: The trading part is working again\. It was down for 1 minute\.\n✅ Good/);
  });

  it("killed (process gone, no crash recorded): counted from when it was noticed", async () => {
    const s = await setup();
    s.db.prepare("UPDATE service_runs SET pid = ? WHERE service = 'collector'").run(DEAD_PID);
    await s.n.tick(); // noticed now
    s.advance(DOWN_GRACE_MS - 2_000, ["trader"]);
    await s.n.tick();
    expect(s.tg.texts()).toEqual([]);
    s.advance(2_000, ["trader"]);
    await s.n.tick();
    expect(s.tg.texts()).toEqual([expect.stringMatching(/^BOT HEALTH · The data collector is down/)]);
  });

  it("frozen (alive but silent for 5 minutes) is urgent; switched off on purpose is a ⚠️ after 5 minutes", async () => {
    const s = await setup();
    s.db.prepare("UPDATE service_runs SET state = 'stopped', changed_at = ? WHERE service = 'collector'").run(s.c.t);
    s.advance(4 * 60_000, ["collector"]);
    await s.n.tick();
    expect(s.tg.texts()).toEqual([]);
    s.advance(61_000, ["collector"]);
    await s.n.tick();
    await s.n.tick();
    expect(s.tg.texts()).toEqual([
      expect.stringMatching(/^BOT HEALTH · The data collector is switched off\n[\s\S]*⚠️ Be careful/),
      expect.stringMatching(/^BOT HEALTH · The trading part is not answering\nWhat happened: The trading part is switched on, but it has not answered for 5 minutes\.\n🚨 Bad/),
    ]);
  });

  it("a part that refuses to start says why once, and its retries stay quiet", async () => {
    const s = await setup();
    attachAlerts(s.db, "trader");
    try {
      for (let i = 0; i < 4; i++) {
        restart(s.db, "trader", s.c.t);
        log.fatal({ alert: "startup_blocked", why: "helius_key_missing" }, "HELIUS_API_KEY is required");
        s.advance(6_000, ["collector"]);
        await s.n.tick();
      }
      s.advance(HOUR, ["collector"]);
      await s.n.tick();
    } finally {
      setAlertSink(null);
    }
    expect(s.tg.texts()).toEqual([expect.stringMatching(/^BOT HEALTH · The trading part cannot start\n[\s\S]*What to do: Add HELIUS_API_KEY to the \.env settings file/)]);
  });

  it("lots of errors from a part that keeps running: one ⚠️ per hour; a few: only the daily report", async () => {
    const s = await setup();
    for (let i = 0; i < 12; i++) raiseAlert(s.db, { kind: "error", source: "collector", text: `helius error ${i}` }, s.c.t);
    for (let i = 0; i < 3; i++) raiseAlert(s.db, { kind: "error", source: "trader", text: `signal evaluation failed ${i}` }, s.c.t);
    s.advance(HOUR);
    await s.n.tick();
    await s.n.tick();
    expect(s.tg.texts()).toEqual([expect.stringMatching(/^BOT HEALTH · The data collector has many errors\nWhat happened: The data collector had 12 errors in the last hour\./)]);
  });
});

describe("alerts from the services", () => {
  it("error logs land in the outbox with a kind; the raw text is never sent", async () => {
    const s = await setup();
    attachAlerts(s.db, "trader");
    try {
      log.error({ err: "db locked" }, "trader loop failed");
      log.warn("just a warning"); // not alerted
      log.warn({ alert: "daily_loss_cap", equity: 0.95, dayStart: 1 }, "daily loss cap hit");
    } finally {
      setAlertSink(null);
    }
    expect(s.db.prepare("SELECT kind, source, text FROM alerts ORDER BY id").all()).toEqual([
      { kind: "error", source: "trader", text: "trader loop failed: db locked" },
      { kind: "daily_loss_cap", source: "trader", text: "daily loss cap hit" },
    ]);
    await s.n.tick();
    expect(s.tg.texts()).toEqual([expect.stringMatching(/^SAFETY LIMIT · Trading paused for today\n/)]);
  });

  it("a fatal log records the crash cause on the run instead of messaging straight away", () => {
    const db = memDb();
    markStarted(db, "collector");
    attachAlerts(db, "collector");
    try {
      log.fatal({ err: "SQLITE_FULL" }, "db write failed");
    } finally {
      setAlertSink(null);
    }
    expect(db.prepare("SELECT state, detail FROM service_runs").get()).toEqual({ state: "crashed", detail: "db write failed: SQLITE_FULL" });
    expect(db.prepare("SELECT count(*) n FROM alerts").get()).toEqual({ n: 0 });
  });

  it("delivers through rate limits, and never leaks secrets", async () => {
    const s = await setup();
    raiseAlert(s.db, { kind: "kill_switch", source: "trader", text: "KILL SWITCH TRIPPED", data: { reason: `make kill https://x/?api-key=abc123 ${TOKEN}` } }, s.c.t);
    expect(raiseAlert(s.db, { kind: "kill_switch", source: "trader", text: "KILL SWITCH TRIPPED" }, s.c.t + 1000)).toBe(false); // deduped
    s.tg.rateLimitNext(2);
    await s.n.tick();
    await s.n.tick();
    expect(s.tg.texts()).toEqual([expect.stringMatching(/^EMERGENCY STOP · Trading stopped\nWhat happened: Someone used the emergency stop on the bot's computer\./)]);
    expect(s.tg.texts()[0]).not.toMatch(/abc123|AAFakeToken/);
  });

  it("restart events are never deduped (each one counts)", () => {
    const db = memDb();
    markStarted(db, "trader");
    markStarted(db, "trader"); // previous run never stopped cleanly
    markStarted(db, "trader");
    db.prepare("UPDATE service_runs SET state = 'stopped'").run();
    markStarted(db, "trader"); // clean stop: nothing
    expect(db.prepare("SELECT kind, data FROM alerts ORDER BY id").all()).toEqual([
      { kind: "restart", data: JSON.stringify({ cause: "killed", detail: null }) },
      { kind: "restart", data: JSON.stringify({ cause: "killed", detail: null }) },
    ]);
  });
});

describe("quiet mode", () => {
  it("/quiet holds back everything but 🚨 for 8 hours, then sums up what happened", async () => {
    const s = await setup();
    expect(await s.n.onCommand({ name: "quiet", args: "", from: "o" })).toMatch(/^QUIET MODE · On\nWhat happened: I will be quiet until 20:00 UTC/);
    insertTrade(s.db, { pnl: 0.003, at: s.c.t + 1000 });
    raiseAlert(s.db, { kind: "helius_cap", source: "collector", text: "cap", data: { capMb: 1500 } }, s.c.t);
    raiseAlert(s.db, { kind: "startup_blocked", source: "trader", text: "no key", data: { why: "helius_key_missing" } }, s.c.t);
    s.advance(2_000);
    await s.n.tick();
    expect(s.tg.texts()).toEqual([expect.stringMatching(/^BOT HEALTH · The trading part cannot start/)]);
    s.advance(8 * HOUR);
    await s.n.tick();
    const over = s.tg.texts().find((t) => t.startsWith("QUIET MODE · Over"));
    expect(over).toMatch(/^QUIET MODE · Over\nWhat happened: Quiet mode is over\. 1 trade closed while I was quiet\.\n😐 Normal: Together: We gained 0\.003 SOL \(the coin we trade with\)\. That is a small gain\.[\s\S]*• I did not send 1 message\./);
  });

  it("/quiet off ends it early", async () => {
    const s = await setup();
    expect(await s.n.onCommand({ name: "quiet", args: "off", from: "o" })).toMatch(/^QUIET MODE · Was not on/);
    await s.n.onCommand({ name: "quiet", args: "", from: "o" });
    expect(await s.n.onCommand({ name: "quiet", args: "off", from: "o" })).toMatch(/^QUIET MODE · Over/);
  });
});

describe("learning brain", () => {
  it("tells the owner when the brain starts skipping trades, with what its test showed", async () => {
    const s = await setup();
    raiseAlert(s.db, { kind: "brain", source: "brain", text: "learning brain ON", data: {
      active: true, studied: 412, test_taken: 41, taken_avg: -0.062, kept_avg: 0.018, skipped: 17, skipped_avg: -0.15, use_brain: true } }, s.c.t);
    s.advance(2_000);
    await s.n.tick();
    expect(s.tg.texts()).toEqual([expect.stringMatching(
      /^LEARNING BRAIN · It now skips trades it expects to lose\n[\s\S]*our rules took 41 trades, which lost 6\.2% on average\. It would have skipped 17, and the rest made 1\.8%/)]);
  });
});

describe("/brain", () => {
  it("shows what the learning brain remembers, from its long-term memory", async () => {
    const s = await setup();
    expect(await s.n.onCommand({ name: "brain", args: "", from: "o" })).toMatch(/^LEARNING BRAIN · What it remembers\nWhat happened: The learning brain has not studied yet\./);
    s.db.prepare("INSERT INTO brain_models (trained_at, version, active, threshold, studied, model, exam) VALUES (1, 'b', 0, 0, 106, '{}', ?)")
      .run(JSON.stringify({ checks: [{ key: "enough_signals", ok: false, have: 106, need: 200 }, { key: "skips_losers", ok: true, have: -0.07, need: "< 0" }] }));
    const mem = s.db.prepare(`INSERT INTO brain_memory (key, kind, words, first_seen_at, last_seen_at, nights_seen, nights_same, direction, status, diff, with_n, with_avg, data)
      VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)`);
    mem.run("small_buy", "lesson", "our trader bought under 0.1 SOL", 4, 4, -1, "confirmed", -0.085, 34, -0.21, null);
    mem.run("very_new", "lesson", "the coin was under 1 minute old", 4, 4, 0, "no_difference", 0.001, 52, -0.17, null);
    mem.run("own_skips", "own_skips", "the trades it skipped", 2, 2, -1, "new", -0.1, 12, -0.1, JSON.stringify({ losers: 9 }));
    const text = await s.n.onCommand({ name: "brain", args: "", from: "o" }) as string;
    expect(text).toMatch(/studied 106 chances to copy a trade over 1 day and remembers 1 lesson\./);
    expect(text).toMatch(/needs 200 studied chances to copy a trade \(it has 106\)\./);
    expect(text).toMatch(/📌 Sure, 4 days in a row: when our trader bought under 0\.1 SOL \(the coin we trade with\), copying does worse \(8\.5 points\)\./);
    expect(text).not.toMatch(/under 1 minute old/); // no real difference: not a lesson
    expect(text).toMatch(/Its own skips: 12 so far, 9 of them would have lost money, lost 10% on average\./);
  });
});

describe("commands", () => {
  it("/stop asks first; Yes halts trading, Cancel doesn't; old buttons expire; strangers are ignored", async () => {
    const s = await setup();
    const risk = new RiskManager(s.db, join(s.dir, "KILL"));
    s.n.start("running");
    s.tg.command("/stop", "999"); // a stranger
    await waitFor(() => s.n["d"].telegram.stats.ignoredChats === 1);
    s.tg.command("/stop@ser1sbot rugs everywhere");
    await waitFor(() => s.tg.sent.some((m) => m.body?.reply_markup));
    const ask = s.tg.sent.find((m) => m.body?.reply_markup)!.body;
    expect(ask.text).toMatch(/^EMERGENCY STOP · Are you sure\?\n/);
    const [yes, no] = ask.reply_markup.inline_keyboard[0];
    expect([yes.text, no.text]).toEqual([M.STOP_YES, M.STOP_NO]);
    expect(risk.isKilled().killed).toBe(false);

    s.tg.tap(no.callback_data);
    await waitFor(() => s.tg.edits().length === 1);
    expect(s.tg.edits()[0]).toMatch(/^EMERGENCY STOP · Cancelled/);
    s.tg.tap(yes.callback_data); // the same (now used) button
    await waitFor(() => s.tg.edits().length === 2);
    expect(s.tg.edits()[1]).toMatch(/^EMERGENCY STOP · Too late/);
    expect(risk.isKilled().killed).toBe(false);

    s.tg.command("/stop rugs everywhere");
    await waitFor(() => s.tg.sent.filter((m) => m.body?.reply_markup).length === 2);
    s.tg.tap(s.tg.sent.filter((m) => m.body?.reply_markup)[1]!.body.reply_markup.inline_keyboard[0][0].callback_data);
    await waitFor(() => s.tg.edits().length === 3);
    expect(s.tg.edits()[2]).toMatch(/^EMERGENCY STOP · Trading stopped\n[\s\S]*type: make unkill/);
    expect(risk.isKilled()).toEqual({ killed: true, reason: "telegram /stop by owner: rugs everywhere" });
    expect(s.tg.sent.filter((m) => m.method === "answerCallbackQuery")).toHaveLength(3);
    expect(await s.n.onCommand({ name: "stop", args: "", from: "o" })).toMatch(/^EMERGENCY STOP · Already stopped\nWhat happened: Trading is already stopped, because you used \/stop/);
  });

  it("/status shows each part with ✅ or ❌, /pnl shows today and all time", async () => {
    const s = await setup();
    insertTrade(s.db, { pnl: 0.006, at: s.c.t - 1000 });
    const none = await s.n.onCommand({ name: "status", args: "", from: "o" }) as string;
    expect(none).toMatch(/^STATUS\n[\s\S]*⚠️ Be careful: /);
    expect(none).toMatch(/• ❌ Traders we copy: none yet \(the bot needs a few days of data\)\n/);
    expect(none).toMatch(/\nWhat to do: Nothing now\. It should fix itself\. Send \/status again later\.\n/); // no traders yet fills in by itself
    s.db.prepare("INSERT INTO tracked_wallets (wallet, added_at, source) VALUES ('w', 0, 'scoring')").run();
    const st = await s.n.onCommand({ name: "status", args: "", from: "o" }) as string;
    expect(st).toMatch(/^STATUS\nWhat happened: I checked every part of the bot\. All parts work\.\n✅ Good[\s\S]*• ✅ Data collector: working\n/);
    expect(st).toMatch(/\n• ✅ Trading part: working\n• ✅ Message part: working\n• ✅ Watching the traders we copy: yes\n[\s\S]*• We copy 1 trader\. 0 trades are open now\./);
    expect(st).toMatch(/\nWhat to do: Nothing, everything is fine\.\n/);
    crash(s.db, "trader", s.c.t);
    expect(await s.n.onCommand({ name: "status", args: "", from: "o" })).toMatch(/^STATUS\n[\s\S]*🚨 Bad: [\s\S]*❌ Trading part: down/);
    const pnl = await s.n.onCommand({ name: "pnl", args: "", from: "o" });
    expect(pnl).toMatch(/^PROFIT OR LOSS\nWhat happened: Our practice money went from 1 SOL \(the coin we trade with\) at the start to 0\.990 SOL now\.\n😐 Normal: In total: We lost 0\.010 SOL\. That is a small loss\.[\s\S]*• Today: 1 trade, 1 won\. We gained 0\.006 SOL \(a small gain\)\./);
    expect(pnl).toMatch(/• Since the start: 1 trade, 1 won\. We gained 0\.006 SOL \(a small gain\)\./);
    expect(await s.n.onCommand({ name: "unkill", args: "", from: "o" })).toMatch(/^SORRY\nWhat happened: I do not know that command\./);
  });

  it("/why explains what happened to a token, by name or address", async () => {
    const s = await setup();
    const mint = insertTrade(s.db, { pnl: 0.004, at: s.c.t - 60_000 });
    insertSignal(s.db, s.c.t - 30_000, "reject", ["re-entry cooldown"], mint);
    const w = await s.n.onCommand({ name: "why", args: "$moon", from: "o" }) as string;
    expect(w).toMatch(/^WHY · MOON\nWhat happened: The traders we copy bought MOON 2 times\. We copied 1\./);
    expect(w).toMatch(/• \d+ (minutes?|hours?) ago: copied\. Sold because the trader we copy sold\. We gained 0\.004 SOL \(the coin we trade with\)\. That is a small gain\./);
    expect(w).toMatch(/skipped, because we traded this coin less than an hour ago/);
    expect(await s.n.onCommand({ name: "why", args: mint, from: "o" })).toMatch(/^WHY · MOON/);
    expect(await s.n.onCommand({ name: "why", args: "NOPE", from: "o" })).toMatch(/^WHY\nWhat happened: I do not know a coin called "NOPE"/);
    expect(await s.n.onCommand({ name: "why", args: "", from: "o" })).toMatch(/^WHY\nWhat happened: You did not say which coin\./);
    s.db.prepare("INSERT INTO tokens (mint, symbol, created_at, first_seen_at, source) VALUES (?, 'QUIET', 0, 0, 't')").run(key());
    expect(await s.n.onCommand({ name: "why", args: "quiet", from: "o" })).toMatch(/^WHY · QUIET\nWhat happened: The bot never looked at QUIET\./);
  });
});

describe("beginner help", () => {
  it("the very first message ever is the guide, sent once", async () => {
    const s = await setup();
    s.db.prepare("DELETE FROM kv WHERE key = 'notifier.guide_sent'").run();
    s.n.start(null);
    await waitFor(() => s.tg.texts().length >= 1);
    expect(s.tg.texts()[0]).toMatch(/^HOW TO READ MY MESSAGES\n[\s\S]*Only 🚨 messages need you\.[\s\S]*\[PAPER\] means practice \(no real money\)/);
    s.n.stop();
    const again = new Notifier({ ...s.n["d"] });
    again.start("stopped");
    await waitFor(() => s.tg.texts().length >= 2);
    expect(s.tg.texts()[1]).toMatch(/^BOT STARTED/); // not the guide again
    again.stop();
  });

  it("/explain on a reply explains that message simply; without a reply it says how", async () => {
    const s = await setup();
    const original = samples().find((x) => x.name === "paper loss")!.text;
    const e = await s.n.onCommand({ name: "explain", args: "", from: "o", replyText: original });
    expect(e).toMatch(/^EXPLAINED · TRADE CLOSED · FROG\nWhat happened: We sold a coin we had bought\./);
    expect(e).toMatch(/• Example: You buy a toy for 10 coins and sell it for 12\./);
    expect(await s.n.onCommand({ name: "explain", args: "", from: "o" })).toMatch(/^EXPLAIN\n[\s\S]*tap Reply, and send \/explain/);
    expect(await s.n.onCommand({ name: "words", args: "", from: "o" })).toMatch(/^WORDS I USE\n[\s\S]*• SOL: the coin we trade with\./);
  });

  it("warns once when market data stops coming, and once when it is back", async () => {
    const s = await setup();
    s.db.prepare("INSERT INTO tokens (mint, created_at, first_seen_at, source) VALUES ('X', ?, ?, 't')").run(s.c.t, s.c.t);
    await s.n.tick();
    s.advance(11 * 60_000);
    s.db.prepare("UPDATE service_heartbeats SET ts = ? WHERE service = 'collector'").run(s.c.t);
    await s.n.tick();
    await s.n.tick();
    expect(s.tg.texts().filter((t) => t.startsWith("DATA"))).toEqual([expect.stringMatching(/^DATA · Market data stopped coming\nWhat happened: No new coins came in for 11 minutes\.\n🚨 Bad/)]);
    s.db.prepare("INSERT INTO tokens (mint, created_at, first_seen_at, source) VALUES ('Y', ?, ?, 't')").run(s.c.t, s.c.t);
    await s.n.tick();
    expect(s.tg.texts().filter((t) => t.startsWith("DATA"))[1]).toMatch(/^DATA · Market data is coming again\n[\s\S]*✅ Good/);
  });
});

describe("reports", () => {
  it("daily report: once, after the configured time, starting with balance / result / is it working", async () => {
    const s = await setup();
    insertTrade(s.db, { pnl: 0.005, at: Date.UTC(2026, 9, 20, 15) });
    s.db.prepare("UPDATE kv SET value = (SELECT max(id) FROM paper_fills) WHERE key = 'notifier.fill_cursor'").run(); // trade messages already sent
    s.c.t = Date.UTC(2026, 9, 21, 0, 4);
    s.db.prepare("UPDATE service_heartbeats SET ts = ?").run(s.c.t);
    s.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('notifier.last_hour', ?)").run(String(Date.UTC(2026, 9, 21)));
    await s.n.tick();
    expect(s.tg.texts()).toEqual([]);
    s.c.t = Date.UTC(2026, 9, 21, 0, 5);
    await s.n.tick();
    await s.n.tick();
    expect(s.tg.texts()).toHaveLength(1);
    const lines = s.tg.texts()[0]!.split("\n");
    expect(lines[0]).toBe("DAILY REPORT · Tuesday 20 October");
    expect(lines[1]).toBe("What happened: That day we made 1 practice trade (no real money). 1 won, 0 lost.");
    expect(lines[2]).toBe("✅ Good: We gained 0.005 SOL (the coin we trade with). That is a small gain.");
    expect(lines[3]).toBe("Is the bot working yet? Too early to tell. We have 1 trade. We need at least 50 to know.");
    expect(lines[4]).toBe("What to do: Nothing, everything is fine.");
  });

  it("weekly report: a 📊 summary message, then the file, once", async () => {
    const s = await setup();
    writeFileSync(join(s.reports, "old.md"), "# old");
    s.db.prepare("DELETE FROM kv WHERE key = 'notifier.reports_sent'").run();
    s.n.start("running"); // existing reports at first start are not re-sent
    writeFileSync(join(s.reports, "weekly-2026-10-26.md"), "# week");
    await s.n.tick();
    await s.n.tick();
    expect(s.tg.texts()).toEqual([expect.stringMatching(/^WEEKLY REPORT · \d+ October to \d+ October\nWhat happened: /)]);
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
