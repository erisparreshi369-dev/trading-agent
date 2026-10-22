/**
 * SHORT MESSAGES: one line per message, for the owner who finds the full ones too long.
 * Switch with notifier.short (true = this file, false = the full messages of the chosen voice).
 *
 *   🟢 bought MOON 0.020 SOL
 *   ✅ sold MOON +0.004 SOL (+21%) · bag 1.008 SOL
 *   🚨 BOT HEALTH · Data collector is down → <what to type>
 *
 * Trades and reports get their own line below. Every other message the bot sends by itself
 * becomes "<emoji> <title>", plus "→ <step>" when the owner has to do something. Skipped chances
 * and the hourly summary are not sent at all: the daily report counts them.
 * Answers to commands (/status, /why, /help, ...) stay full: the owner asked for them.
 */
import { pct, signedSol, size, sol, token, TRADES_TO_JUDGE, type BuyFacts, type Ctx, type MissedFacts, type ReportFacts, type SellFacts, type Verdict } from "./messages.js";
import type { Messages } from "./voice.js";

const live = (c: Ctx) => (c.mode === "live" ? "[LIVE] " : "");

const bag = (c: Ctx, equity: number) => `bag ${sol(c, equity)}`;

function missedWhy(reason: string | null): string {
  if (reason?.match(/slippage (-?\d+)bps/)) return "price moved too much";
  if (reason === "no market data") return "no price";
  if (reason === "curve completed") return "coin moved to a bigger market";
  if (reason === "size too small after fixed costs") return "too small for the fees";
  if (reason === "kill switch") return "emergency stop is on";
  return "didn't go through";
}

function verdictShort(v: Verdict): string {
  if (v.closedAllTime < TRADES_TO_JUDGE) return `too early to judge (${v.closedAllTime}/${TRADES_TO_JUDGE} trades)`;
  if (v.pnlAllTime > 0 && v.pnlLast7d >= 0) return "looks good so far";
  if (v.pnlAllTime > 0) return "mixed: lost in the last 7 days";
  return "not working yet";
}

function report(c: Ctx, r: ReportFacts, label: string, killedStep: string): string {
  const p = r.period;
  const emoji = r.killed ? "⚠️" : Math.abs(p.pnl) < 0.0005 ? "😐" : p.pnl > 0 ? "✅" : size(p.pnl, r.start) === "small" ? "😐" : "⚠️";
  const trades = p.closed ? `${p.closed} trades, ${p.wins}W ${p.closed - p.wins}L, ${signedSol(c, p.pnl)}` : "no trades";
  return `${emoji} ${label}: ${trades} · ${bag(c, r.equity)} · ${verdictShort(r.verdict)}${r.killed ? ` → ${killedStep}` : ""}`;
}

/** "<emoji> <title>", and the step when there is one. Works on any message in the house shape. */
function oneLine(long: Messages, text: string): string {
  const lines = text.split("\n");
  const title = lines[0] ?? "";
  const emoji = (lines[2] ?? "").split(" ")[0] ?? "";
  const step = lines.find((l) => /^(What to do|your move): /.test(l))?.replace(/^(What to do|your move): /, "") ?? long.NOTHING;
  return `${emoji} ${title}${/^nothing\b/i.test(step) ? "" : ` → ${step}`}`;
}

/** Messages the bot sends by itself that become "<emoji> <title>". */
const ALERTS = ["partDown", "partFrozen", "partSwitchedOff", "partBack", "restarted", "manyErrors", "jobFailed", "dataCapReached", "dataBudget",
  "settingChanged", "helperBudget", "brainChanged", "dataStopped", "dataBack", "killSwitch", "dailyLossCap", "sizeStep", "mistake", "startupBlocked", "hello", "quietOver"] as const;

/** Short titles back to the full ones, so /explain still recognises a short message. */
const EXPLAIN_AS: [RegExp, string][] = [
  [/^\S+ (\[LIVE\] )?bought /, "TRADE OPENED"],
  [/^\S+ (\[LIVE\] )?sold /, "TRADE CLOSED"],
  [/^\S+ (\[LIVE\] )?couldn't buy /, "TRADE NOT DONE"],
  [/^\S+ day /, "DAILY REPORT"],
  [/^\S+ week: /, "WEEKLY REPORT"],
];

export function shorten(long: Messages): Messages {
  const short: Messages = {
    ...long,

    bought: (c: Ctx, b: BuyFacts) => `🟢 ${live(c)}bought ${token(b.token)} ${sol(c, b.sizeSol)}`,

    sold: (c: Ctx, s: SellFacts) => {
      const big = s.pnlSol < 0 && size(s.pnlSol, s.start) !== "small" && size(s.pnlSol, s.start) !== "almost nothing";
      const emoji = s.pnlSol >= 0 ? "✅" : big ? "⚠️" : "🔻";
      return `${emoji} ${live(c)}sold ${token(s.token)} ${signedSol(c, s.pnlSol)} (${pct(s.pnlSol / (s.costSol || 1))}) · ${bag(c, s.equity)}`;
    },

    missed: (c: Ctx, m: MissedFacts) => `😐 ${live(c)}couldn't buy ${token(m.token)} (${missedWhy(m.reason)})`,

    // not sent (the notifier sends nothing for an empty text): the daily report counts them
    skipped: () => "",
    activity: () => "",

    dailyReport: (c: Ctx, r: ReportFacts) =>
      report(c, r, `day ${new Intl.DateTimeFormat("en-GB", { timeZone: c.tz, weekday: "short", day: "numeric", month: "short" }).format(r.from)}`, oneLine(long, long.dailyReport(c, r)).split(" → ")[1] ?? ""),

    weeklyReport: (c: Ctx, r: ReportFacts, attached: boolean) =>
      `${report(c, r, "week", oneLine(long, long.weeklyReport(c, r, attached)).split(" → ")[1] ?? "")}${attached ? " · full report in the file" : ""}`,

    explain: (original: string) => {
      const as = EXPLAIN_AS.find(([re]) => re.test(original));
      return long.explain(as ? as[1] : original.replace(/^\S+ /, "").replace(/ → .*/s, "")); // alerts: the title between the emoji and the step
    },
  };
  for (const name of ALERTS) {
    const full = long[name] as (...a: unknown[]) => string;
    (short as Record<string, unknown>)[name] = (...a: unknown[]) => oneLine(long, full(...a));
  }
  return short;
}
