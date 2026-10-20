import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { raiseAlert } from "../lib/alerts.js";
import type { NotifierConfig } from "../lib/config.js";
import { heartbeat, type DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import { RiskManager } from "../risk/risk-manager.js";
import { dailySummaryText, fillsSince, fillText, pnlText, statusText, utcDayStart, type PnlNumbers } from "./texts.js";
import type { Command, Telegram } from "./telegram.js";

export const SERVICE = "notifier";


export interface NotifierDeps {
  db: DB;
  cfg: NotifierConfig;
  telegram: Telegram;
  killFile: string;
  reportsDir: string;
  now?: () => number;
}

/**
 * Everything that talks to the human: trade alerts, the error outbox (including crash alerts
 * services raise about themselves), the heartbeat watchdog, the daily summary, weekly reports, and the /stop /status /pnl commands.
 * Separate from the trader on purpose: a crashed trader can't silence its own alarm.
 */
export class Notifier {
  private timers: NodeJS.Timeout[] = [];
  private down = new Set<string>();
  private startedAt: number;
  private now: () => number;
  private busy = false;

  constructor(private d: NotifierDeps) {
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
  }

  start(): void {
    // first start: don't replay history
    if (this.kv("notifier.fill_cursor") === null) {
      this.setKv("notifier.fill_cursor", String((this.d.db.prepare("SELECT COALESCE(MAX(id), 0) m FROM paper_fills").get() as { m: number }).m));
    }
    if (this.kv("notifier.reports_sent") === null) this.setKv("notifier.reports_sent", JSON.stringify(this.reportFiles()));
    // first start: the first summary is tomorrow's (there's no "yesterday" yet)
    if (this.kv("notifier.last_daily") === null) this.setKv("notifier.last_daily", new Date(utcDayStart(this.now())).toISOString().slice(0, 10));
    this.timers.push(
      setInterval(() => void this.guard(() => this.tick()), 2_000),
      setInterval(() => heartbeat(this.d.db, SERVICE, this.d.telegram.stats), 30_000),
    );
    heartbeat(this.d.db, SERVICE, this.d.telegram.stats);
    void this.d.telegram.poll((c) => this.onCommand(c));
    void this.d.telegram.send("🤖 notifier started (paper mode). Commands: /status /pnl /stop");
    log.info("notifier started");
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.d.telegram.stop();
  }

  /** One pass of everything periodic (exposed for tests). */
  async tick(): Promise<void> {
    this.watchdog(); // before the outbox, so its alerts go out in the same pass
    await this.sendFills();
    await this.sendAlerts();
    await this.dailySummary();
    await this.sendReports();
  }

  async onCommand(c: Command): Promise<string | null> {
    log.info({ cmd: c.name, from: c.from }, "telegram command");
    switch (c.name) {
      case "stop": {
        new RiskManager(this.d.db, this.d.killFile, this.now).kill(`telegram /stop by ${c.from}${c.args ? `: ${c.args}` : ""}`);
        return "🛑 KILL SWITCH ON. Open positions are being sold, no new entries.\nClearing it is deliberately not possible from Telegram: run `make unkill` on the machine.";
      }
      case "status":
        return statusText(this.d.db, this.now(), this.d.cfg.watch_services, this.d.cfg.stale_after_s * 1000);
      case "pnl":
        return pnlText(this.d.db, this.pnl(), this.now());
      case "start":
      case "help":
        return "/status: services, streams, tracked wallets\n/pnl: paper PnL today / 7d / all\n/stop: kill switch (sell everything, stop entering)";
      default:
        return `unknown command /${c.name}. Try /help`;
    }
  }

  private async sendFills(): Promise<void> {
    if (!this.d.cfg.trade_alerts) return;
    const cursor = Number(this.kv("notifier.fill_cursor") ?? 0);
    const fills = fillsSince(this.d.db, cursor);
    for (const f of fills) {
      await this.d.telegram.send(fillText(f, this.pnl().balance));
      this.setKv("notifier.fill_cursor", String(f.id)); // advance even if Telegram failed: never resend old trades later
    }
  }

  private async sendAlerts(): Promise<void> {
    const rows = this.d.db.prepare("SELECT id, level, source, text FROM alerts WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT 20")
      .all() as { id: number; level: string; source: string; text: string }[];
    for (const a of rows) {
      const icon = a.level === "info" ? "ℹ️" : a.level === "warn" ? "⚠️" : "🚨";
      const ok = await this.d.telegram.send(`${icon} [${a.source}] ${a.text}`);
      this.d.db.prepare(`UPDATE alerts SET ${ok ? "sent_at = ?," : ""} attempts = attempts + 1 WHERE id = ?`).run(...(ok ? [this.now(), a.id] : [a.id]));
    }
  }

  /** Alert once when a service stops reporting, once when it comes back. */
  private watchdog(): void {
    const now = this.now();
    const staleMs = this.d.cfg.stale_after_s * 1000;
    for (const svc of this.d.cfg.watch_services) {
      const hb = this.d.db.prepare("SELECT ts FROM service_heartbeats WHERE service = ?").get(svc) as { ts: number } | undefined;
      const silentFor = now - (hb?.ts ?? this.startedAt);
      if (silentFor > staleMs && !this.down.has(svc)) {
        this.down.add(svc);
        raiseAlert(this.d.db, "error", "watchdog", `${svc} has not reported for ${Math.round(silentFor / 60_000)} min`, now);
      } else if (silentFor <= staleMs && this.down.has(svc)) {
        this.down.delete(svc);
        raiseAlert(this.d.db, "info", "watchdog", `${svc} is reporting again`, now);
      }
    }
  }

  private async dailySummary(): Promise<void> {
    const now = this.now();
    const [hh, mm] = this.d.cfg.daily_summary_utc.split(":").map(Number);
    const today = utcDayStart(now);
    if (now < today + (hh! * 60 + mm!) * 60_000) return;
    const key = new Date(today).toISOString().slice(0, 10);
    if (this.kv("notifier.last_daily") === key) return;
    this.setKv("notifier.last_daily", key);
    await this.d.telegram.send(dailySummaryText(this.d.db, today - 86_400_000, this.pnl()));
  }

  /** Weekly (and any other) markdown reports dropped into reports/ get sent as documents. */
  private async sendReports(): Promise<void> {
    const sent = new Set(JSON.parse(this.kv("notifier.reports_sent") ?? "[]") as string[]);
    for (const f of this.reportFiles()) {
      if (sent.has(f)) continue;
      const ok = await this.d.telegram.sendDocument(join(this.d.reportsDir, f), `📄 ${f}`);
      if (!ok) return;
      sent.add(f);
      this.setKv("notifier.reports_sent", JSON.stringify([...sent]));
    }
  }

  private reportFiles(): string[] {
    return existsSync(this.d.reportsDir) ? readdirSync(this.d.reportsDir).filter((f) => f.endsWith(".md")).sort() : [];
  }

  private pnl(): PnlNumbers {
    const hb = this.d.db.prepare("SELECT info FROM service_heartbeats WHERE service = 'trader'").get() as { info: string } | undefined;
    const acct = this.d.db.prepare("SELECT balance_sol, start_balance FROM paper_account WHERE id = 1").get() as { balance_sol: number; start_balance: number } | undefined;
    const balance = acct?.balance_sol ?? 0, start = acct?.start_balance ?? 1;
    const i = hb ? JSON.parse(hb.info) : {};
    const live = (this.d.db.prepare("SELECT count(*) n FROM paper_positions WHERE status IN ('pending', 'open')").get() as { n: number }).n;
    return { equity: i.equity ?? balance, start, balance, live };
  }

  private kv(key: string): string | null {
    return (this.d.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  private setKv(key: string, value: string): void {
    this.d.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private async guard(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn();
    } catch (err) {
      log.error({ err: String(err) }, "notifier loop error");
    } finally {
      this.busy = false;
    }
  }
}
