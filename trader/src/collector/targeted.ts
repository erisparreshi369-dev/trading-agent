import { log } from "../lib/log.js";
import type { ReconnectingWs } from "../lib/reconnecting-ws.js";

export interface WatchTarget {
  address: string;
  priority: number; // lower = more important
}

/**
 * Keeps one logsSubscribe(mentions: [address]) per wanted address on a single connection,
 * capped at `max`. Call reconcile() with the full wanted set; it subscribes the missing ones and
 * unsubscribes the rest. After a reconnect every subscription is gone server-side, so
 * openMessages() rebuilds them from scratch.
 */
export class TargetedSubscriptions {
  private wanted: WatchTarget[] = [];
  private active = new Map<string, number>(); // address -> subscription id
  private pending = new Map<number, string>(); // request id -> address
  private subToAddr = new Map<number, string>();
  private nextId = 1000;
  stats = { subscribed: 0, unsubscribed: 0, errors: 0, overCap: 0 };

  constructor(private ws: ReconnectingWs, private max: number) {}

  /** Used as the ReconnectingWs onOpenMessages hook. */
  openMessages(): unknown[] {
    this.active.clear();
    this.pending.clear();
    this.subToAddr.clear();
    return this.top().map((t) => this.subscribeMsg(t.address));
  }

  reconcile(wanted: WatchTarget[]): void {
    this.wanted = wanted;
    if (!this.ws.up) return;
    const keep = new Set(this.top().map((t) => t.address));
    const inFlight = new Set(this.pending.values());
    for (const addr of keep) {
      if (!this.active.has(addr) && !inFlight.has(addr)) this.ws.send(this.subscribeMsg(addr));
    }
    for (const [addr, subId] of this.active) {
      if (keep.has(addr)) continue;
      this.ws.send({ jsonrpc: "2.0", id: this.nextId++, method: "logsUnsubscribe", params: [subId] });
      this.active.delete(addr);
      this.subToAddr.delete(subId);
      this.stats.unsubscribed++;
    }
  }

  /** Feed every non-notification message here. Returns true if it was ours. */
  onReply(msg: { id?: number; result?: unknown; error?: unknown }): boolean {
    if (msg.id === undefined) return false;
    const addr = this.pending.get(msg.id);
    if (addr === undefined) return msg.id >= 1000; // unsubscribe acks
    this.pending.delete(msg.id);
    if (typeof msg.result === "number") {
      this.active.set(addr, msg.result);
      this.subToAddr.set(msg.result, addr);
      this.stats.subscribed++;
    } else {
      this.stats.errors++;
      log.warn({ addr, error: msg.error }, "targeted subscribe failed");
    }
    return true;
  }

  get size(): number {
    return this.active.size;
  }

  private top(): WatchTarget[] {
    const sorted = [...new Map(this.wanted.map((t) => [t.address, t])).values()].sort((a, b) => a.priority - b.priority);
    this.stats.overCap = Math.max(0, sorted.length - this.max);
    return sorted.slice(0, this.max);
  }

  private subscribeMsg(address: string) {
    const id = this.nextId++;
    this.pending.set(id, address);
    return { jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [address] }, { commitment: "confirmed" }] };
  }
}
