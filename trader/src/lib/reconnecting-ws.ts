import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { log, scrubUrl } from "./log.js";

export interface ReconnectingWsOptions {
  name: string;
  url: string;
  /** Messages (re)sent on every successful open, e.g. subscriptions. */
  onOpenMessages: () => unknown[];
  /** Reconnect if nothing arrives for this long. */
  staleMs: number;
  pingMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Websocket that never gives up: exponential backoff with jitter, ping keepalive, and a
 * stale-stream watchdog (a socket can stay "open" while silently delivering nothing).
 * Emits: 'message' (raw string, bytes), 'up', 'down' (reason).
 */
export class ReconnectingWs extends EventEmitter {
  private ws?: WebSocket;
  private attempt = 0;
  private lastMsgAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private isUp = false;
  readonly o: Required<ReconnectingWsOptions>;

  constructor(opts: ReconnectingWsOptions) {
    super();
    this.o = { pingMs: 20_000, minBackoffMs: 500, maxBackoffMs: 30_000, ...opts };
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.clearTimers();
    this.ws?.removeAllListeners();
    this.ws?.on("error", () => {});
    this.ws?.terminate();
    this.ws = undefined;
    this.markDown("stopped");
  }

  send(msg: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  get up(): boolean {
    return this.isUp;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.o.url, { handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.lastMsgAt = Date.now();
      for (const m of this.o.onOpenMessages()) ws.send(JSON.stringify(m));
      this.isUp = true;
      log.info({ ws: this.o.name }, "ws connected");
      this.emit("up");
      this.timers.push(
        setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), this.o.pingMs),
        setInterval(() => {
          if (Date.now() - this.lastMsgAt > this.o.staleMs) {
            log.warn({ ws: this.o.name, silentMs: Date.now() - this.lastMsgAt }, "ws stale, reconnecting");
            ws.terminate();
          }
        }, Math.min(5_000, this.o.staleMs)),
      );
    });
    ws.on("message", (data: WebSocket.RawData) => {
      this.lastMsgAt = Date.now();
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      this.emit("message", buf.toString("utf8"), buf.length);
    });
    ws.on("pong", () => {
      // pongs prove the socket is alive but not that data flows; don't reset lastMsgAt
    });
    ws.on("error", (err) => log.warn({ ws: this.o.name, err: err.message }, "ws error"));
    ws.on("close", (code, reason) => {
      this.clearTimers();
      this.markDown(`close ${code} ${reason.toString()}`.trim());
      if (this.stopped) return;
      const delay = this.backoff();
      log.warn({ ws: this.o.name, code, delay, url: scrubUrl(this.o.url) }, "ws closed, will reconnect");
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private backoff(): number {
    const exp = Math.min(this.o.maxBackoffMs, this.o.minBackoffMs * 2 ** this.attempt++);
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  private markDown(reason: string): void {
    if (!this.isUp) return;
    this.isUp = false;
    this.emit("down", reason);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
