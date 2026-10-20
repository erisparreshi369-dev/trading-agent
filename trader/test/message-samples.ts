/**
 * Every message in messages.ts, rendered with realistic facts. The tests check the house rules on
 * all of them; `npx tsx test/message-samples.ts [name...]` prints them to proofread the wording.
 */
import * as M from "../src/notifier/messages.js";

const now = Date.UTC(2026, 9, 21, 0, 5);
const ctx: M.Ctx = { mode: "paper", tz: "UTC", usd: 105.2, now };
const MOON = { mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", symbol: "MOON" };
const RUG = { mint: "9sPqzB3vWnD4mXc8kLrT6hYfE2aJ5uGQ1oNbVi7Cpump", symbol: "FROG" };
const min = 60_000;

const report: M.ReportFacts = {
  from: now - 5 * min - 86_400_000, to: now - 5 * min, equity: 1.0123, start: 1,
  period: { closed: 7, wins: 4, pnl: 0.0081, missed: 3, best: { ...MOON, pnl: 0.009 }, worst: { ...RUG, pnl: -0.0061 }, avgSlippage: 0.021 },
  exits: [{ text: "leader_exit", n: 4 }, { text: "stop_loss", n: 2 }, { text: "time_exit", n: 1 }],
  buys: 412, copied: 10, skippedTotal: 400,
  skipped: [
    { text: M.explainSkip("token age 2400s outside [3, 1800]").short, n: 210 },
    { text: M.explainSkip("leader buy 0.040 < 0.1 SOL").short, n: 98 },
    { text: M.explainSkip("dev sold 80% of launch buy").short, n: 40 },
  ],
  blockedTotal: 2, blocked: [{ text: M.explainSkip("risk: max open positions (5)").short, n: 2 }],
  wallets: { tracked: 25, added: 2, removed: 1 }, data: { mb: 1210, capMb: 1500 },
  trouble: [{ service: "collector", restarts: 1, errors: 6 }],
  verdict: { closedAllTime: 12, pnlAllTime: 0.0123, start: 1, pnlLast7d: 0.0123 }, killed: false, stopLossPct: 0.25,
};

export function samples(): { name: string; text: string }[] {
  const out: [string, string][] = [
    ["guide (first message ever)", M.guide(ctx, "00:05 UTC")],
    ["words", M.words()],
    ["skipped: scam check", M.skipped(ctx, { token: RUG, reason: "dev sold 80% of launch buy" })],
    ["skipped: other", M.skipped(ctx, { token: MOON, reason: "token age 2400s outside [3, 1800]" })],
    ["data stopped", M.dataStopped(ctx, 12 * min, "launches")],
    ["data back", M.dataBack(ctx, 14 * min)],
    ["explain how-to", M.explainHowTo()],
    ["paper buy", M.bought(ctx, {
      token: MOON, sizeSol: 0.02, equity: 1.004, slippage: 0.011, trackedCount: 25, walletRoi: 0.18, walletTrades: 34, confirmations: 2, windowS: 120,
      tokenAgeS: 190, top10Pct: 23.4, devSoldFrac: 0, maxTop10Pct: 40,
    })],
    ["paper win", M.sold(ctx, { token: MOON, costSol: 0.02, proceedsSol: 0.0242, pnlSol: 0.0042, heldMs: 4 * min, reason: "leader_exit", equity: 1.0082, start: 1, stopLossPct: 0.25, maxHoldMs: 30 * min })],
    ["paper loss", M.sold(ctx, { token: RUG, costSol: 0.02, proceedsSol: 0.0139, pnlSol: -0.0061, heldMs: 95_000, reason: "stop_loss", equity: 1.0021, start: 1, stopLossPct: 0.25, maxHoldMs: 30 * min })],
    ["paper missed", M.missed(ctx, { token: MOON, reason: "slippage 1840bps > limit", feeSol: 0.0003, maxSlippage: 0.15 })],
    ["activity", M.activity(ctx, {
      from: now - 65 * min, to: now - 5 * min, buys: 46, copied: 2, skippedTotal: 43, blockedTotal: 1,
      skipped: [
        { text: M.explainSkip("token age 2400s outside [3, 1800]").short, n: 21 },
        { text: M.explainSkip("leader buy 0.040 < 0.1 SOL").short, n: 12 },
        { text: M.explainSkip("dev sold 80% of launch buy").short, n: 6 },
      ],
      blocked: [{ text: M.explainSkip("risk: max open positions (5)").short, n: 1 }],
    })],
    ["crash, still down", M.partDown(ctx, "trader", now - 25_000, "trader crashed: TypeError: x is undefined")],
    ["crash, disk full", M.partDown(ctx, "collector", now - 40_000, "db write failed: SqliteError: database or disk is full")],
    ["frozen", M.partFrozen(ctx, "collector", 5 * min)],
    ["switched off", M.partSwitchedOff(ctx, "trader", 6 * min)],
    ["back", M.partBack(ctx, "trader", 3 * min)],
    ["restart once", M.restarted(ctx, "trader", 1, "killed", null)],
    ["restart grouped", M.restarted(ctx, "collector", 3, "crash", "collector crashed: Error: socket hang up")],
    ["restart loop", M.restarted(ctx, "trader", 7, "crash", null)],
    ["many errors", M.manyErrors(ctx, "collector", 23)],
    ["job failed: score", M.jobFailed(ctx, "score")],
    ["job failed: weekly", M.jobFailed(ctx, "weekly")],
    ["job failed: logrotate", M.jobFailed(ctx, "logrotate")],
    ["job failed: intel", M.jobFailed(ctx, "intel")],
    ["job failed: other", M.jobFailed(ctx, "drill")],
    ["kill: drawdown", M.killSwitch(ctx, "max drawdown: equity 0.6950 < 70% of start 1", 0.695, 1)],
    ["kill: server", M.killSwitch(ctx, "make kill", 0.98, 1)],
    ["daily loss cap", M.dailyLossCap(ctx, 0.95, 1.0)],
    ["data cap", M.dataCapReached(ctx, 1500)],
    ["data cap, trades open", M.dataCapReached(ctx, 1500, 2)],
    ["helper 70%", M.helperBudget(ctx, { pct: 70, used: 140, limit: 200 })],
    ["helper 90%", M.helperBudget(ctx, { pct: 90, used: 180, limit: 200 })],
    ["helper out", M.helperBudget(ctx, { pct: 100, used: 200, limit: 200 })],
    ["data 70%", M.dataBudget(ctx, { pct: 70, mbToday: 1050, capMb: 1500, mbPerHour: 120, capAt: now + 3.75 * 60 * min })],
    ["data 85%", M.dataBudget(ctx, { pct: 85, mbToday: 1276, capMb: 1500, mbPerHour: 40, capAt: null })],
    ["data 95%", M.dataBudget(ctx, { pct: 95, mbToday: 1426, capMb: 1500, mbPerHour: 0, capAt: null })],
    ["startup: helius", M.startupBlocked(ctx, "helius_key_missing")],
    ["startup: live", M.startupBlocked(ctx, "live_not_ready")],
    ["startup: other", M.startupBlocked(ctx, "?")],
    ["hello", M.hello(ctx, "00:05 UTC")],
    ["help", M.help()],
    ["unknown command", M.unknownCommand()],
    ["command failed", M.commandFailed()],
    ["status ok", M.status(ctx, {
      parts: [{ service: "collector", health: "up", since: null }, { service: "trader", health: "up", since: null }, { service: "notifier", health: "up", since: null }],
      lastTradeAt: now - 3000, streams: { watching: "on", discovery: "resting", discoveryResumesAt: now + 14 * 60 * min, mbToday: 820, capMb: 1500 },
      tracked: 25, open: 2, killed: null, halted: false, quietUntil: null,
    })],
    ["status bad", M.status(ctx, {
      parts: [{ service: "collector", health: "up", since: null }, { service: "trader", health: "down", since: now - 4 * min }, { service: "notifier", health: "up", since: null }],
      lastTradeAt: now - 3000, streams: { watching: "capped", discovery: "budget_used", discoveryResumesAt: null, mbToday: 1500, capMb: 1500 },
      tracked: 25, open: 0, killed: { reason: "telegram /stop by owner", at: now - 60 * min }, halted: false, quietUntil: now + 3 * 60 * min,
    })],
    ["pnl", M.pnl(ctx, {
      equity: 1.0123, start: 1, open: 2, today: { closed: 3, wins: 2, pnl: 0.004 }, week: { closed: 12, wins: 7, pnl: 0.0081 }, all: { closed: 40, wins: 22, pnl: 0.0123 },
    })],
    ["stop confirm", M.stopConfirm(ctx, 2)],
    ["stop done", M.stopDone(ctx, 2)],
    ["stop cancelled", M.stopCancelled()],
    ["stop expired", M.stopExpired()],
    ["already halted", M.alreadyHalted(ctx, "telegram /stop by owner", now - 60 * min)],
    ["quiet on", M.quietOn(ctx, now + 8 * 60 * min)],
    ["quiet over", M.quietOver(ctx, 3, 0.0021, 5)],
    ["quiet was off", M.quietWasOff()],
    ["why", M.why(ctx, MOON, [
      { at: now - 30 * min, decision: "reject", reasons: ["token age 2s outside [3, 1800]"], confirmations: 1, position: null },
      { at: now - 29 * min, decision: "enter", reasons: [], confirmations: 2,
        position: { status: "closed", sizeSol: 0.02, closedAt: now - 25 * min, exitReason: "leader_exit", pnlSol: 0.0042, costSol: 0.02 } },
      { at: now - 20 * min, decision: "risk_block", reasons: ["risk: already in this token"], confirmations: 1, position: null },
      { at: now - 10 * min, decision: "enter", reasons: [], confirmations: 1,
        position: { status: "failed", sizeSol: 0.02, closedAt: now - 10 * min, exitReason: "slippage 1840bps over limit", pnlSol: -0.0003, costSol: null } },
    ], 4, 2, { stopLossPct: 0.25, maxHoldMs: 30 * min, maxSlippage: 0.15 })],
    ["why: no arg", M.whyNoArg()],
    ["why: not found", M.whyNotFound("MOOON")],
    ["why: nothing", M.whyNothing(RUG)],
    ["daily report", M.dailyReport(ctx, report)],
    ["weekly report", M.weeklyReport(ctx, { ...report, from: now - 7 * 86_400_000, to: now, data: null }, true)],
    ["live buy", M.bought({ ...ctx, mode: "live", usd: null }, {
      token: { mint: MOON.mint, symbol: null }, sizeSol: 0.02, equity: 1, slippage: -0.004, trackedCount: 25, walletRoi: null, walletTrades: null,
      confirmations: 1, windowS: 120, tokenAgeS: null, top10Pct: null, devSoldFrac: 0.3, maxTop10Pct: 40,
    })],
  ];
  return out.map(([name, text]) => ({ name, text }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = process.argv.slice(2);
  for (const s of samples()) if (!want.length || want.includes(s.name)) console.log(`──── ${s.name}\n${s.text}\n`);
}
