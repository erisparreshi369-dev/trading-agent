import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { Collector } from "../src/collector/collector.js";
import { encodeCreate, encodeTrade, PUMP_PROGRAM } from "../src/collector/pump-events.js";
import { openDb } from "../src/lib/db.js";
import { ReconnectingWs } from "../src/lib/reconnecting-ws.js";
import { key, sampleTrade } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
}

/** Minimal stand-in for a websocket provider: records what clients send, lets tests push/kill. */
async function fakeServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const received: unknown[] = [];
  let connections = 0;
  wss.on("connection", (ws: WebSocket) => {
    connections++;
    ws.on("message", (m) => received.push(JSON.parse(m.toString())));
  });
  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    get connections() {
      return connections;
    },
    clients: () => [...wss.clients],
    push: (msg: unknown) => wss.clients.forEach((c) => c.send(JSON.stringify(msg))),
    killAll: () => wss.clients.forEach((c) => c.terminate()),
    close: () => new Promise<void>((r) => { wss.clients.forEach((c) => c.terminate()); wss.close(() => r()); }),
  };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("ReconnectingWs", () => {
  it("reconnects after the server drops it and re-sends subscriptions", async () => {
    const srv = await fakeServer();
    cleanups.push(srv.close);
    const ws = new ReconnectingWs({ name: "t", url: srv.url, staleMs: 60_000, onOpenMessages: () => [{ method: "sub" }], minBackoffMs: 20 });
    cleanups.push(() => ws.stop());
    const events: string[] = [];
    ws.on("up", () => events.push("up"));
    ws.on("down", () => events.push("down"));
    ws.start();
    await until(() => srv.received.length === 1);
    srv.killAll();
    await until(() => srv.received.length === 2);
    expect(srv.received).toEqual([{ method: "sub" }, { method: "sub" }]);
    expect(events).toEqual(["up", "down", "up"]);
  });

  it("treats a silent-but-open socket as dead", async () => {
    const srv = await fakeServer();
    cleanups.push(srv.close);
    const ws = new ReconnectingWs({ name: "t", url: srv.url, staleMs: 300, onOpenMessages: () => [], minBackoffMs: 20 });
    cleanups.push(() => ws.stop());
    ws.start();
    await until(() => srv.connections >= 2, 3_000);
  });

  it("keeps retrying while the server is unreachable", async () => {
    const srv = await fakeServer();
    const url = srv.url;
    await srv.close();
    const ws = new ReconnectingWs({ name: "t", url, staleMs: 60_000, onOpenMessages: () => [], minBackoffMs: 10, maxBackoffMs: 50 });
    cleanups.push(() => ws.stop());
    ws.start();
    await sleep(300); // several failed attempts: must neither throw nor give up
    expect(ws.up).toBe(false);
  });
});

describe("Collector end-to-end (fake Helius + PumpPortal)", () => {
  const cfg = {
    helius_firehose: true, helius_daily_mb_cap: 1500, pumpportal_streams: true,
    bars: { fine_bucket_ms: 5_000, fine_window_ms: 3_600_000, coarse_bucket_ms: 60_000, coarse_window_ms: 86_400_000 },
    holder_checks: { enabled: false, min_trades: 25, ages_s: [60], max_per_minute: 30 },
    retention: { raw_trades_days: 30, holders_days: 3 }, heartbeat_s: 30, stale_stream_s: 60,
  };

  function notify(signature: string, slot: number, logs: string[], err: unknown = null) {
    return { jsonrpc: "2.0", method: "logsNotification", params: { subscription: 1, result: { context: { slot }, value: { signature, err, logs } } } };
  }
  const pumpLogs = (...datas: Buffer[]) => [
    `Program ${PUMP_PROGRAM} invoke [1]`, ...datas.map((d) => `Program data: ${d.toString("base64")}`), `Program ${PUMP_PROGRAM} success`,
  ];

  it("stores creates and trades, flags dev trades, records gaps, survives a disconnect", async () => {
    const helius = await fakeServer();
    const pp = await fakeServer();
    cleanups.push(helius.close, pp.close);
    const db = openDb(":memory:");
    const c = new Collector({ db, cfg, heliusWsUrl: helius.url, pumpportalUrl: pp.url });
    cleanups.push(() => c.stop());
    c.start();
    await until(() => helius.received.length === 1 && pp.received.length === 2);
    expect(helius.received[0]).toMatchObject({ method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "confirmed" }] });
    expect(pp.received).toEqual([{ method: "subscribeNewToken" }, { method: "subscribeMigration" }]);

    const mint = key(), dev = key(), buyer = key();
    const now = Math.floor(Date.now() / 1000);
    helius.push(notify("sigCreate", 100, pumpLogs(
      encodeCreate({ name: "T", symbol: "T", uri: "u", mint, bondingCurve: key(), user: dev, creator: dev, timestamp: now }),
      encodeTrade(sampleTrade({ mint, user: dev, creator: dev, timestamp: now })),
    )));
    helius.push(notify("sigBuy", 101, pumpLogs(encodeTrade(sampleTrade({ mint, user: buyer, creator: dev, timestamp: now })))));
    helius.push(notify("sigFailed", 101, pumpLogs(encodeTrade(sampleTrade({ mint })) ), { InstructionError: [0, "x"] }));
    pp.push({ signature: "sigCreate", mint, traderPublicKey: dev, txType: "create", initialBuy: 1000.5, solAmount: 0.5, name: "T", symbol: "T" });
    pp.push({ signature: "sigMig", mint, txType: "migrate", pool: "pump-amm" });

    await until(() => (db.prepare("SELECT count(*) n FROM trades").get() as { n: number }).n === 2);
    await until(() => (db.prepare("SELECT migrated_at FROM tokens").get() as { migrated_at: number | null })?.migrated_at != null);
    const tok = db.prepare("SELECT creator, created_slot, initial_buy_lamports, initial_buy_tokens, migration_pool FROM tokens WHERE mint = ?").get(mint);
    expect(tok).toEqual({ creator: dev, created_slot: 100, initial_buy_lamports: 500_000_000, initial_buy_tokens: 1_000_500_000, migration_pool: "pump-amm" });
    const trades = db.prepare("SELECT signature, ev_index, slot, wallet, is_dev FROM trades ORDER BY slot").all();
    expect(trades).toEqual([
      { signature: "sigCreate", ev_index: 1, slot: 100, wallet: dev, is_dev: 1 },
      { signature: "sigBuy", ev_index: 0, slot: 101, wallet: buyer, is_dev: 0 },
    ]);
    expect(db.prepare("SELECT count(*) n FROM dev_trades").get()).toEqual({ n: 1 });

    // drop the firehose: a gap opens, then closes when the reconnect succeeds
    helius.killAll();
    await until(() => helius.received.length === 2, 10_000);
    await until(() => (db.prepare("SELECT count(*) n FROM collector_gaps WHERE source='helius' AND ended_at IS NOT NULL").get() as { n: number }).n === 1);

    c.stop();
    cleanups.pop();
    expect((db.prepare("SELECT count(*) n FROM token_bars").get() as { n: number }).n).toBe(1);
    expect(db.prepare("SELECT source, messages FROM stream_usage ORDER BY source").all()).toEqual([
      { source: "helius", messages: 3 },
      { source: "pumpportal", messages: 2 },
    ]);
    expect(c.stats).toMatchObject({ trades: 2, creates: 1, ppCreates: 1, ppMigrations: 1 });
    expect(db.prepare("SELECT count(*) n FROM service_heartbeats WHERE service='collector'").get()).toEqual({ n: 1 });
  }, 20_000);

  it("pauses the firehose at the daily MB cap", async () => {
    const helius = await fakeServer();
    cleanups.push(helius.close);
    const db = openDb(":memory:");
    const c = new Collector({ db, cfg: { ...cfg, pumpportal_streams: false, helius_daily_mb_cap: 0.001 }, heliusWsUrl: helius.url });
    cleanups.push(() => c.stop());
    c.start();
    await until(() => helius.received.length === 1);
    helius.push(notify("big", 1, ["x".repeat(2_000)]));
    await until(() => c.streams.heliusPausedForCap);
    expect(db.prepare("SELECT reason FROM collector_gaps").get()).toEqual({ reason: "daily MB cap reached" });
  });
});
