import type { DB } from "../lib/db.js";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const sol = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(4)}`;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const age = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);
export const utcDayStart = (ms: number) => Date.parse(new Date(ms).toISOString().slice(0, 10));

interface FillRow {
  id: number;
  side: string;
  ok: number;
  sol: number | null;
  slippage_bps: number | null;
  reason: string | null;
  ts: number;
  position_id: number;
  mint: string;
  leader_wallet: string;
  cost_sol: number | null;
  pnl_sol: number | null;
  opened_at: number | null;
  closed_at: number | null;
  symbol: string | null;
}

export function fillsSince(db: DB, cursor: number): FillRow[] {
  return db.prepare(`SELECT f.id, f.side, f.ok, f.sol, f.slippage_bps, f.reason, f.ts, f.position_id, p.mint, p.leader_wallet, p.cost_sol,
    p.pnl_sol, p.opened_at, p.closed_at, t.symbol FROM paper_fills f JOIN paper_positions p ON p.id = f.position_id
    LEFT JOIN tokens t ON t.mint = p.mint WHERE f.id > ? ORDER BY f.id`).all(cursor) as FillRow[];
}

export function fillText(f: FillRow, balance: number): string {
  const name = f.symbol ? `$${f.symbol}` : short(f.mint);
  if (f.side === "buy" && !f.ok) return `⚪ MISSED ${name}: ${f.reason ?? "fill failed"} (leader ${short(f.leader_wallet)})`;
  if (f.side === "buy") {
    return `🟢 BUY ${name} ${f.sol!.toFixed(4)} SOL [paper]\nleader ${short(f.leader_wallet)} · slippage ${f.slippage_bps! >= 0 ? "+" : ""}${Math.round(f.slippage_bps!)}bps\n${f.mint}`;
  }
  const pnl = f.pnl_sol ?? 0;
  const held = f.closed_at && f.opened_at ? ` · held ${age(f.closed_at - f.opened_at)}` : "";
  return `${pnl >= 0 ? "✅" : "🔴"} SELL ${name} ${sol(pnl)} SOL (${pct(pnl / (f.cost_sol || 1))}) [paper]\n${f.reason ?? "exit"}${held} · free balance ${balance.toFixed(4)}`;
}

export interface PnlNumbers {
  equity: number;
  start: number;
  balance: number;
  live: number;
}

export function periodStats(db: DB, from: number, to = Number.MAX_SAFE_INTEGER) {
  const r = db.prepare(`SELECT count(*) n, SUM(status = 'failed') failed, SUM(status = 'closed' AND pnl_sol > 0) wins,
    COALESCE(SUM(pnl_sol), 0) pnl, MAX(pnl_sol) best, MIN(CASE WHEN status = 'closed' THEN pnl_sol END) worst
    FROM paper_positions WHERE status IN ('closed', 'failed') AND closed_at >= ? AND closed_at < ?`).get(from, to) as {
    n: number; failed: number | null; wins: number | null; pnl: number; best: number | null; worst: number | null;
  };
  const closed = r.n - (r.failed ?? 0);
  return { closed, failed: r.failed ?? 0, wins: r.wins ?? 0, pnl: r.pnl, best: r.best, worst: r.worst, winRate: closed ? (r.wins ?? 0) / closed : null };
}

export function pnlText(db: DB, p: PnlNumbers, now: number): string {
  const lines = [`💰 Paper PnL`, `equity ${p.equity.toFixed(4)} SOL (${sol(p.equity - p.start)} SOL, ${pct((p.equity - p.start) / p.start)} since start)`,
    `free ${p.balance.toFixed(4)} · open/pending ${p.live}`];
  for (const [label, from] of [["today", utcDayStart(now)], ["7d", now - 7 * 86_400_000], ["all", 0]] as const) {
    const s = periodStats(db, from);
    lines.push(`${label}: ${s.closed} trades, ${s.winRate === null ? "-" : Math.round(s.winRate * 100) + "% win"}, ${sol(s.pnl)} SOL${s.failed ? `, ${s.failed} missed` : ""}`);
  }
  return lines.join("\n");
}

export function statusText(db: DB, now: number, watch: string[], staleMs: number): string {
  const lines = ["📊 Status"];
  for (const svc of [...watch, "notifier"]) {
    const hb = db.prepare("SELECT ts, info FROM service_heartbeats WHERE service = ?").get(svc) as { ts: number; info: string } | undefined;
    const fresh = hb && now - hb.ts < staleMs;
    lines.push(`${fresh ? "🟢" : "🔴"} ${svc}${hb ? ` (${age(now - hb.ts)} ago)` : " (never)"}`);
    if (hb && svc === "collector") {
      const i = JSON.parse(hb.info);
      const st = i.streams ?? {};
      lines.push(`   firehose ${st.firehose ? "on" : `off${st.firehoseOff ? ` (${st.firehoseOff})` : ""}`}, targeted ${st.targeted ? "on" : "OFF"} [${st.targetedSubs ?? 0} subs], helius ${i.heliusMbToday}/${i.heliusCapMb} MB`);
    }
    if (hb && svc === "trader") {
      const i = JSON.parse(hb.info);
      lines.push(`   tracked ${i.tracked}, signals ${i.signals}, entered ${i.entered}${i.killed ? " · 🛑 KILL SWITCH ON" : ""}${i.haltedToday ? " · halted (daily loss cap)" : ""}`);
    }
  }
  const last = db.prepare("SELECT max(received_at) t FROM trades").get() as { t: number | null };
  lines.push(`last trade seen ${last.t ? age(now - last.t) + " ago" : "never"}`);
  return lines.join("\n");
}

export function dailySummaryText(db: DB, dayStart: number, p: PnlNumbers): string {
  const dayEnd = dayStart + 86_400_000;
  const s = periodStats(db, dayStart, dayEnd);
  const day = new Date(dayStart).toISOString().slice(0, 10);
  const sig = db.prepare(`SELECT count(*) n, SUM(decision = 'enter') e, SUM(decision = 'risk_block') rb FROM signals WHERE ts >= ? AND ts < ?`)
    .get(dayStart, dayEnd) as { n: number; e: number | null; rb: number | null };
  const reasons = db.prepare(`SELECT reasons, count(*) n FROM signals WHERE decision = 'reject' AND ts >= ? AND ts < ? GROUP BY reasons ORDER BY n DESC LIMIT 3`)
    .all(dayStart, dayEnd) as { reasons: string; n: number }[];
  const usage = db.prepare("SELECT source, bytes FROM stream_usage WHERE day = ?").all(day) as { source: string; bytes: number }[];
  const helius = usage.filter((u) => u.source !== "pumpportal").reduce((a, u) => a + u.bytes, 0) / 1e6;
  const scoring = db.prepare("SELECT info FROM service_heartbeats WHERE service = 'scoring'").get() as { info: string } | undefined;
  const sc = scoring ? JSON.parse(scoring.info) : null;
  const lines = [
    `📅 Daily summary ${day} [paper]`,
    `PnL ${sol(s.pnl)} SOL · ${s.closed} trades · ${s.winRate === null ? "-" : Math.round(s.winRate * 100) + "% win"}${s.failed ? ` · ${s.failed} missed fills` : ""}`,
    s.closed ? `best ${sol(s.best ?? 0)} · worst ${sol(s.worst ?? 0)}` : "",
    `equity ${p.equity.toFixed(4)} SOL (${pct((p.equity - p.start) / p.start)} since start)`,
    `signals ${sig.n}: ${sig.e ?? 0} entered, ${sig.rb ?? 0} blocked by risk`,
    ...reasons.map((r) => `  ${r.n}× ${(JSON.parse(r.reasons) as string[]).join(", ").slice(0, 80)}`),
    sc ? `tracked wallets ${sc.tracked} (+${sc.added}/−${sc.removed} at last scoring)` : "",
    `Helius ${helius.toFixed(0)} MB`,
  ];
  return lines.filter(Boolean).join("\n");
}
