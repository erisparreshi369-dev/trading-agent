import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../lib/config.js";
import { heartbeat, type DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import type { RunState } from "../lib/service.js";
import { limitsFor } from "../risk/limits.js";
import { RiskManager } from "../risk/risk-manager.js";
import {
  account, brainMemoryFacts, buyFacts, DAY, fillsSince, HOUR, missedFacts, partHealth, period, pnlFacts, reportFacts, sellFacts, signalFacts, statusFacts,
  utcDayStart, whyFacts,
} from "./data.js";
import type { Ctx } from "./messages.js";
import { M } from "./voice.js";

/** No new coin launch seen for this long (while the data collector runs) = market data stopped. */
const DATA_SILENT_MS = 10 * 60_000;
import type { Command, Reply, Tap, TapResult, Telegram } from "./telegram.js";

export const SERVICE = "notifier";

/** A part must stay down this long before it's reported (systemd normally restarts it within ~5s). */
export const DOWN_GRACE_MS = 20_000;
/** At most one "restarted by itself" message per part per hour; restarts in between are counted into the next one. */
export const RESTART_MSG_EVERY_MS = HOUR;
/** Fewer errors than this in an hour (from a part that kept running) only show up in the daily report. */
export const ERRORS_WORTH_A_MESSAGE = 10;
export const QUIET_MS = 8 * HOUR;
const STOP_BUTTON_TTL_MS = 5 * 60_000;
const USD_REFRESH_MS = 10 * 60_000;

export interface NotifierDeps {
  db: DB;
  cfg: Config;
  telegram: Telegram;
  killFile: string;
  reportsDir: string;
  now?: () => number;
  /** Dollars per SOL. Omit for SOL-only messages. */
  usdPrice?: () => Promise<number | null>;
}

interface PartState {
  seenDownAt: number | null;
  reported: null | { at: number; since: number };
}

interface AlertRow {
  id: number;
  ts: number;
  kind: string;
  source: string;
  data: string | null;
}

/**
 * Everything that talks to the human: trade messages, the hourly activity summary, the alert
 * outbox (crashes, safety switches), watching the other parts, the daily and weekly reports, and
 * the commands. All wording comes from messages.ts. Separate from the trader on purpose: a
 * crashed trader can't silence its own alarm.
 */
export class Notifier {
  private timers: NodeJS.Timeout[] = [];
  private parts = new Map<string, PartState>();
  private now: () => number;
  private busy = false;
  private pendingStop: { nonce: string; reason: string; at: number } | null = null;
  private usd: { value: number | null; at: number } = { value: null, at: 0 };

  constructor(private d: NotifierDeps) {
    this.now = d.now ?? Date.now;
  }

  /** `previous` is what markStarted() returned: say hello after a deliberate start, not after a crash. */
  start(previous: RunState | null = null): void {
    const now = this.now();
    // first start: don't replay history
    if (this.kv("notifier.fill_cursor") === null) {
      this.setKv("notifier.fill_cursor", String((this.d.db.prepare("SELECT COALESCE(MAX(id), 0) m FROM paper_fills").get() as { m: number }).m));
    }
    if (this.kv("notifier.reports_sent") === null) this.setKv("notifier.reports_sent", JSON.stringify(this.reportFiles()));
    if (this.kv("notifier.last_daily") === null) this.setKv("notifier.last_daily", new Date(utcDayStart(now)).toISOString().slice(0, 10));
    if (this.kv("notifier.last_hour") === null) this.setKv("notifier.last_hour", String(Math.floor(now / HOUR) * HOUR));
    this.timers.push(
      setInterval(() => void this.guard(() => this.tick()), 2_000),
      setInterval(() => heartbeat(this.d.db, SERVICE, this.d.telegram.stats), 30_000),
    );
    heartbeat(this.d.db, SERVICE, this.d.telegram.stats);
    void this.d.telegram.poll((c) => this.onCommand(c), (t) => this.onTap(t));
    if (this.kv("notifier.guide_sent") === null) {
      // the very first message ever: how to read the messages
      void this.say(M.guide(this.ctx(), this.dailyAt()), { urgent: true });
      this.setKv("notifier.guide_sent", String(now));
    } else if (previous === null || previous === "stopped") void this.say(M.hello(this.ctx(), this.dailyAt()));
    if (this.kv("notifier.signal_cursor") === null) {
      this.setKv("notifier.signal_cursor", String((this.d.db.prepare("SELECT COALESCE(MAX(id), 0) m FROM signals").get() as { m: number }).m));
    }
    log.info("notifier started");
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.d.telegram.stop();
  }

  /** One pass of everything periodic (exposed for tests). */
  async tick(): Promise<void> {
    void this.refreshUsd();
    await this.watchParts();
    await this.watchData();
    await this.sendFills();
    await this.sendSkips();
    await this.sendAlerts();
    await this.sendRestarts();
    await this.hourly();
    await this.quietEnded();
    await this.dailyReport();
    await this.weeklyReports();
  }

  // ---------------------------------------------------------------------------------------------
  // sending
  // ---------------------------------------------------------------------------------------------

  private ctx(): Ctx {
    return { mode: "paper", tz: this.d.cfg.notifier.timezone, usd: this.usd.value, now: this.now() };
  }

  /**
   * Send unless quiet mode is on. Urgent (🚨) messages always go through. Held-back messages are
   * counted (except trades, which the end-of-quiet message sums up from the database).
   */
  private async say(text: string, opts: { urgent?: boolean; trade?: boolean } = {}): Promise<boolean> {
    if (!opts.urgent && this.quietUntil() !== null) {
      if (!opts.trade) this.setKv("notifier.quiet_held", String(Number(this.kv("notifier.quiet_held") ?? 0) + 1));
      return true;
    }
    return this.d.telegram.send(text);
  }

  private quietUntil(): number | null {
    const v = Number(this.kv("notifier.quiet_until") ?? 0);
    return v > this.now() ? v : null;
  }

  private async refreshUsd(): Promise<void> {
    if (!this.d.usdPrice || this.now() - this.usd.at < USD_REFRESH_MS) return;
    this.usd.at = this.now();
    const v = await this.d.usdPrice().catch(() => null);
    if (v !== null) this.usd.value = v; // keep the last good price through a failed refresh
  }

  // ---------------------------------------------------------------------------------------------
  // watching the other parts
  // ---------------------------------------------------------------------------------------------

  private async watchParts(): Promise<void> {
    const now = this.now();
    const staleMs = this.d.cfg.notifier.stale_after_s * 1000;
    for (const svc of this.d.cfg.notifier.watch_services) {
      const h = partHealth(this.d.db, svc, now, staleMs);
      const st = this.parts.get(svc) ?? { seenDownAt: null, reported: null };
      this.parts.set(svc, st);
      if (h.health === "up" || h.health === "starting") {
        if (st.reported) {
          await this.say(M.partBack(this.ctx(), svc, now - st.reported.since), { urgent: true }); // the 🚨 got through quiet, so must this
          this.markRestartsHandled(svc); // the ✅ covers them
        }
        st.seenDownAt = null;
        st.reported = null;
        continue;
      }
      if (h.health === "unknown" || st.reported) continue;
      st.seenDownAt ??= now;
      const since = h.since ?? st.seenDownAt;
      if (h.health === "down" && now - since >= DOWN_GRACE_MS) {
        st.reported = { at: now, since };
        // a part that refuses to start already said why (startup_blocked alert)
        if (!h.detail?.startsWith("startup_blocked")) await this.say(M.partDown(this.ctx(), svc, since, h.detail), { urgent: true });
      } else if (h.health === "frozen") {
        st.reported = { at: now, since };
        await this.say(M.partFrozen(this.ctx(), svc, now - since), { urgent: true });
      } else if (h.health === "off" && now - since >= staleMs) {
        st.reported = { at: now, since };
        await this.say(M.partSwitchedOff(this.ctx(), svc, now - since));
      }
    }
  }

  /** Restarts are grouped: at most one message per part per hour, once it has stayed up for the grace period. */
  private async sendRestarts(): Promise<void> {
    const now = this.now();
    const rows = this.unsent("restart");
    const bySvc = new Map<string, AlertRow[]>();
    for (const r of rows) bySvc.set(r.source, [...(bySvc.get(r.source) ?? []), r]);
    for (const [svc, list] of bySvc) {
      const data = list.map((r) => JSON.parse(r.data ?? "{}") as { cause: "crash" | "killed"; detail: string | null });
      if (data.every((x) => x.detail?.startsWith("startup_blocked"))) {
        this.markSent(list); // retries of a part that can't start: the 🚨 already explained it
        continue;
      }
      if (this.parts.get(svc)?.reported) continue; // an outage message is out; its ✅ covers these
      const last = list[list.length - 1]!;
      if (now - last.ts < DOWN_GRACE_MS) continue;
      if (svc !== SERVICE) {
        const h = partHealth(this.d.db, svc, now, this.d.cfg.notifier.stale_after_s * 1000).health;
        if (h !== "up" && h !== "starting") continue;
      }
      if (now - Number(this.kv(`notifier.restart_msg.${svc}`) ?? 0) < RESTART_MSG_EVERY_MS) continue;
      const lastData = data[data.length - 1]!;
      await this.say(M.restarted(this.ctx(), svc, list.length, lastData.cause, lastData.detail));
      this.markSent(list);
      this.setKv(`notifier.restart_msg.${svc}`, String(now));
    }
  }

  private markRestartsHandled(svc: string): void {
    this.d.db.prepare("UPDATE alerts SET sent_at = ? WHERE kind = 'restart' AND source = ? AND sent_at IS NULL").run(this.now(), svc);
  }

  // ---------------------------------------------------------------------------------------------
  // trades and the alert outbox
  // ---------------------------------------------------------------------------------------------

  private async sendFills(): Promise<void> {
    const cursor = Number(this.kv("notifier.fill_cursor") ?? 0);
    for (const f of fillsSince(this.d.db, cursor)) {
      if (this.d.cfg.notifier.trade_alerts) {
        const c = this.ctx();
        const text = f.side === "buy" && !f.ok ? M.missed(c, missedFacts(this.d.cfg, f))
          : f.side === "buy" ? M.bought(c, buyFacts(this.d.db, this.d.cfg, f))
          : M.sold(c, sellFacts(this.d.db, f));
        await this.say(text, { trade: true });
      }
      this.setKv("notifier.fill_cursor", String(f.id)); // advance even if Telegram failed: never resend old trades later
    }
  }

  private async sendAlerts(): Promise<void> {
    const rows = this.d.db.prepare(`SELECT id, ts, kind, source, data FROM alerts WHERE sent_at IS NULL AND attempts < 5
      AND kind NOT IN ('restart', 'error') ORDER BY id LIMIT 20`).all() as AlertRow[];
    for (const a of rows) {
      const data = JSON.parse(a.data ?? "{}") as Record<string, unknown>;
      const c = this.ctx();
      let ok = true;
      switch (a.kind) {
        case "kill_switch": {
          if (String(data.reason ?? "").startsWith("telegram")) break; // they pressed the button and got a confirmation
          const acct = account(this.d.db);
          ok = await this.say(M.killSwitch(c, (data.reason as string) ?? null, acct.equity, acct.start), { urgent: true });
          break;
        }
        case "daily_loss_cap":
          ok = await this.say(M.dailyLossCap(c, Number(data.equity), Number(data.dayStart)));
          break;
        case "helius_cap":
          ok = await this.say(M.dataCapReached(c, Number(data.capMb ?? this.d.cfg.collector.helius.daily_mb_cap), Number(data.openPositions ?? 0)));
          break;
        case "helius_budget":
          ok = await this.say(M.dataBudget(c, { pct: Number(data.pct), mbToday: Number(data.mbToday), capMb: Number(data.capMb),
            mbPerHour: Number(data.mbPerHour ?? 0), capAt: data.capAt == null ? null : Number(data.capAt) }));
          break;
        case "setting_changed":
          ok = await this.say(M.settingChanged(c, {
            setting: String(data.setting), from: Number(data.from), to: Number(data.to), reset: !!data.reset,
            guardMb: data.guardMb == null ? null : Number(data.guardMb), limit: data.limit == null ? null : Number(data.limit),
            ...(typeof data.label === "string" && { label: data.label }), ...(typeof data.fromText === "string" && { fromText: data.fromText }),
            ...(typeof data.toText === "string" && { toText: data.toText }), ...(typeof data.group === "string" && { group: data.group }),
          }));
          break;
        case "madeonsol_budget":
          ok = await this.say(M.helperBudget(c, { pct: Number(data.pct), used: Number(data.used), limit: Number(data.limit) }));
          break;
        case "brain":
          ok = await this.say(M.brainChanged(c, {
            active: !!data.active, allowed: data.use_brain !== false, studied: Number(data.studied ?? 0), testTrades: Number(data.test_taken ?? 0),
            takenAvg: data.taken_avg == null ? null : Number(data.taken_avg), keptAvg: data.kept_avg == null ? null : Number(data.kept_avg),
            skipped: data.skipped == null ? null : Number(data.skipped),
          }));
          break;
        case "startup_blocked":
          ok = await this.say(M.startupBlocked(c, String(data.why ?? "")), { urgent: true });
          break;
        case "job_failed":
          ok = await this.say(M.jobFailed(c, String(data.job ?? "")));
          break;
        default:
          log.warn({ kind: a.kind }, "alert kind without a message, dropped");
      }
      this.d.db.prepare(`UPDATE alerts SET ${ok ? "sent_at = ?," : ""} attempts = attempts + 1 WHERE id = ?`).run(...(ok ? [this.now(), a.id] : [a.id]));
    }
  }

  private unsent(kind: string): AlertRow[] {
    return this.d.db.prepare("SELECT id, ts, kind, source, data FROM alerts WHERE kind = ? AND sent_at IS NULL ORDER BY id").all(kind) as AlertRow[];
  }

  private markSent(rows: AlertRow[]): void {
    const upd = this.d.db.prepare("UPDATE alerts SET sent_at = ? WHERE id = ?");
    for (const r of rows) upd.run(this.now(), r.id);
  }

  // ---------------------------------------------------------------------------------------------
  // scheduled: hourly digest, end of quiet time, daily and weekly reports
  // ---------------------------------------------------------------------------------------------

  /** On the hour: what the signal engine did last hour, and parts that logged lots of errors. */
  private async hourly(): Promise<void> {
    const hourStart = Math.floor(this.now() / HOUR) * HOUR;
    if (Number(this.kv("notifier.last_hour") ?? 0) >= hourStart) return;
    this.setKv("notifier.last_hour", String(hourStart));
    const from = hourStart - HOUR;
    const a = signalFacts(this.d.db, from, hourStart);
    if (a.buys > 0) await this.say(M.activity(this.ctx(), { ...a, from, to: hourStart }));
    const errors = this.d.db.prepare("SELECT id, ts, kind, source, data FROM alerts WHERE kind = 'error' AND sent_at IS NULL AND ts < ? ORDER BY id")
      .all(hourStart) as AlertRow[];
    const bySvc = new Map<string, number>();
    for (const e of errors) bySvc.set(e.source, (bySvc.get(e.source) ?? 0) + 1);
    for (const [svc, n] of bySvc) if (n >= ERRORS_WORTH_A_MESSAGE) await this.say(M.manyErrors(this.ctx(), svc, n));
    this.markSent(errors); // the daily report still counts them
  }

  private async quietEnded(): Promise<void> {
    const until = Number(this.kv("notifier.quiet_until") ?? 0);
    if (!until || this.now() < until) return;
    await this.d.telegram.send(this.endQuiet(until));
  }

  /** Clear quiet mode; returns the "quiet time is over" message (sent by the caller). */
  private endQuiet(end: number): string {
    const from = Number(this.kv("notifier.quiet_from") ?? end);
    const p = period(this.d.db, from, end);
    const text = M.quietOver(this.ctx(), p.closed, p.pnl, Number(this.kv("notifier.quiet_held") ?? 0));
    for (const k of ["quiet_until", "quiet_from", "quiet_held"]) this.d.db.prepare("DELETE FROM kv WHERE key = ?").run(`notifier.${k}`);
    return text;
  }

  private dailyAt(): string {
    const [hh, mm] = this.d.cfg.notifier.daily_summary_utc.split(":").map(Number);
    return M.clock(this.ctx(), utcDayStart(this.now()) + (hh! * 60 + mm!) * 60_000);
  }

  private async dailyReport(): Promise<void> {
    const now = this.now();
    const [hh, mm] = this.d.cfg.notifier.daily_summary_utc.split(":").map(Number);
    const today = utcDayStart(now);
    if (now < today + (hh! * 60 + mm!) * 60_000) return;
    const key = new Date(today).toISOString().slice(0, 10);
    if (this.kv("notifier.last_daily") === key || this.quietUntil() !== null) return; // reports wait out quiet time
    this.setKv("notifier.last_daily", key);
    const from = today - DAY;
    await this.say(M.dailyReport(this.ctx(), reportFacts(this.d.db, this.d.cfg, from, today, { dataDay: new Date(from).toISOString().slice(0, 10) })));
  }

  /** The weekly job drops a markdown report into reports/: send the summary message, then the file. */
  private async weeklyReports(): Promise<void> {
    if (this.quietUntil() !== null) return;
    const sent = new Set(JSON.parse(this.kv("notifier.reports_sent") ?? "[]") as string[]);
    for (const f of this.reportFiles()) {
      if (sent.has(f)) continue;
      const now = this.now();
      await this.d.telegram.send(M.weeklyReport(this.ctx(), reportFacts(this.d.db, this.d.cfg, now - 7 * DAY, now, { dataDay: null }), true));
      const ok = await this.d.telegram.sendDocument(join(this.d.reportsDir, f), M.weeklyFileCaption);
      if (!ok) return;
      sent.add(f);
      this.setKv("notifier.reports_sent", JSON.stringify([...sent]));
    }
  }

  private reportFiles(): string[] {
    return existsSync(this.d.reportsDir) ? readdirSync(this.d.reportsDir).filter((f) => f.endsWith(".md")).sort() : [];
  }

  // ---------------------------------------------------------------------------------------------
  // commands
  // ---------------------------------------------------------------------------------------------

  /** Skipped chances that a safety check caught as a likely scam get their own message; the rest go in the hourly summary. */
  private async sendSkips(): Promise<void> {
    if (!this.d.cfg.notifier.trade_alerts) return;
    const cursor = Number(this.kv("notifier.signal_cursor") ?? 0);
    const rows = this.d.db.prepare(`SELECT s.id, s.mint, s.reasons, t.symbol FROM signals s LEFT JOIN tokens t ON t.mint = s.mint
      WHERE s.id > ? ORDER BY s.id LIMIT 200`).all(cursor) as { id: number; mint: string; reasons: string; symbol: string | null }[];
    for (const r of rows) {
      const first = (JSON.parse(r.reasons) as string[])[0];
      if (first && M.isScamSkip(M.explainSkip(first))) await this.say(M.skipped(this.ctx(), { token: { mint: r.mint, symbol: r.symbol }, reason: first }), { trade: true });
      this.setKv("notifier.signal_cursor", String(r.id));
    }
  }

  /** New coins launch every few seconds: 10 minutes without one while the data collector runs means data stopped coming. */
  private async watchData(): Promise<void> {
    const now = this.now();
    const collectorUp = partHealth(this.d.db, "collector", now, this.d.cfg.notifier.stale_after_s * 1000).health === "up";
    const last = (this.d.db.prepare("SELECT MAX(first_seen_at) t FROM tokens").get() as { t: number | null }).t;
    const silentSince = Number(this.kv("notifier.data_silent_since") ?? 0);
    if (!collectorUp || !last) return; // a down collector has its own message
    if (now - last > DATA_SILENT_MS && !silentSince) {
      this.setKv("notifier.data_silent_since", String(last));
      await this.say(M.dataStopped(this.ctx(), now - last, "launches"), { urgent: true });
    } else if (now - last <= DATA_SILENT_MS && silentSince) {
      this.setKv("notifier.data_silent_since", "0");
      await this.say(M.dataBack(this.ctx(), last - silentSince), { urgent: true });
    }
  }

  async onCommand(c: Command): Promise<Reply> {
    log.info({ cmd: c.name, from: c.from }, "telegram command");
    const ctx = this.ctx();
    switch (c.name) {
      case "status":
        return M.status(ctx, statusFacts(this.d.db, this.d.cfg, this.now(), this.quietUntil()));
      case "pnl":
        return M.pnl(ctx, pnlFacts(this.d.db, this.now()));
      case "stop": {
        const k = this.risk().isKilled();
        if (k.killed) {
          const r = this.d.db.prepare("SELECT kill_at FROM risk_state WHERE id = 1").get() as { kill_at: number | null };
          return M.alreadyHalted(ctx, k.reason, r.kill_at);
        }
        this.pendingStop = { nonce: randomBytes(6).toString("hex"), reason: c.args, at: this.now() };
        const n = this.pendingStop.nonce;
        return { text: M.stopConfirm(ctx, account(this.d.db).open), buttons: [[{ text: M.STOP_YES, data: `stop:yes:${n}` }, { text: M.STOP_NO, data: `stop:no:${n}` }]] };
      }
      case "why": {
        if (!c.args.trim()) return M.whyNoArg();
        const w = whyFacts(this.d.db, c.args);
        if (!w.found) return M.whyNotFound(c.args.trim());
        if (w.total === 0) return M.whyNothing(w.token);
        return M.why(ctx, w.token, w.events, w.total, w.sameName, {
          stopLossPct: limitsFor("paper", this.d.db).STOP_LOSS_PCT, maxHoldMs: limitsFor("paper", this.d.db).TIME_EXIT_MS, maxSlippage: this.d.cfg.paper.max_slippage_bps / 10_000,
        });
      }
      case "quiet": {
        if (c.args.trim().toLowerCase() === "off") return this.quietUntil() === null ? M.quietWasOff() : this.endQuiet(this.now());
        const until = this.now() + QUIET_MS;
        if (this.quietUntil() === null) {
          this.setKv("notifier.quiet_from", String(this.now()));
          this.setKv("notifier.quiet_held", "0");
        }
        this.setKv("notifier.quiet_until", String(until));
        return M.quietOn(ctx, until);
      }
      case "explain":
        return c.replyText ? M.explain(c.replyText) : M.explainHowTo();
      case "words":
        return M.words();
      case "brain":
        return M.brainMemory(ctx, brainMemoryFacts(this.d.db));
      case "start":
      case "help":
        return M.help();
      default:
        return M.unknownCommand();
    }
  }

  async onTap(t: Tap): Promise<TapResult> {
    const [what, answer, nonce] = t.data.split(":");
    if (what !== "stop") return null;
    const p = this.pendingStop;
    if (!p || p.nonce !== nonce || this.now() - p.at > STOP_BUTTON_TTL_MS) return { edit: M.stopExpired() };
    this.pendingStop = null;
    if (answer !== "yes") return { edit: M.stopCancelled() };
    const open = account(this.d.db).open;
    this.risk().kill(`telegram /stop by ${t.from}${p.reason ? `: ${p.reason}` : ""}`);
    log.info({ from: t.from }, "trading halted from telegram");
    return { edit: M.stopDone(this.ctx(), open) };
  }

  private risk(): RiskManager {
    return new RiskManager(this.d.db, this.d.killFile, this.now);
  }

  // ---------------------------------------------------------------------------------------------

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
