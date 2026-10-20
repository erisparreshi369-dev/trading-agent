/**
 * THE WORDING OF EVERY TELEGRAM MESSAGE THE BOT SENDS. Edit anything here freely.
 *
 * The functions get plain facts (numbers, names, times) and return the text. The only other
 * wording is the last-resort line in scripts/notify-failure.sh, used when Node itself can't run.
 *
 * Every message has the same shape (the tests check this on every message):
 *
 *   TITLE IN CAPITALS · name          <- the same title for the same kind of message, always
 *   What happened: <one sentence>
 *   <emoji> <Good | Be careful | Bad | Normal>: <short why>
 *   (at most 2 more short lines)
 *   What to do: Nothing, everything is fine.   or   What to do: <one clear step>
 *   More details:                     <- optional, everything else goes below this line
 *   • ...
 *
 *   ✅ good   ⚠️ be careful   🚨 bad (only these need you)   😐 normal
 *
 * Writing rules: words a 12-year-old knows, one idea per sentence, no jargon. Use the same words
 * every time (see WORDS below). No coin addresses, no ids. Round numbers.
 */

// ---------------------------------------------------------------------------------------------
// Context, the message shape, numbers
// ---------------------------------------------------------------------------------------------

export interface Ctx {
  mode: "paper" | "live";
  /** IANA time zone for clock times, e.g. "UTC" or "Europe/London". */
  tz: string;
  /** Dollars per SOL, or null when the price feed is off (then no $ amounts). */
  usd: number | null;
  now: number;
}

export type Mood = "good" | "careful" | "bad" | "normal";
const MOOD: Record<Mood, string> = { good: "✅ Good", careful: "⚠️ Be careful", bad: "🚨 Bad", normal: "😐 Normal" };

export const NOTHING: string = "Nothing, everything is fine.";
export const todo = (step: string) => step;

type Line = string | false | 0 | null | undefined;

interface Shape {
  title: string;
  happened: string;
  mood: Mood;
  why: string;
  extra?: Line[]; // at most 2 short lines after the verdict
  todo: string;
  details?: Line[];
  /** /words and /explain explain words themselves: no automatic brackets */
  noExplain?: boolean;
}

/** Words that get a plain explanation in brackets the first time they appear in a message. */
const EXPLAIN_ONCE: [RegExp, string][] = [
  [/\bSOL\b/, "SOL (the coin we trade with)"],
  [/\bUTC\b/, "UTC (world time)"],
  [/\bscam\b/, "scam (the creator took the money and left)"],
];

function render(s: Shape): string {
  const keep = (l: Line): l is string => typeof l === "string" && l !== "";
  const lines = [s.title, `What happened: ${s.happened}`, `${MOOD[s.mood]}: ${s.why}`, ...(s.extra ?? []).filter(keep), `What to do: ${s.todo}`];
  const details = (s.details ?? []).filter(keep);
  if (details.length) lines.push("More details:", ...details.map((d) => (d.startsWith("  ") ? d : `• ${d}`)));
  let text = lines.join("\n");
  if (!s.noExplain) for (const [re, full] of EXPLAIN_ONCE) text = text.replace(re, full);
  return text;
}

/** "0.004 SOL", "1.008 SOL", "less than 0.001 SOL" */
export function sol(_c: Ctx, x: number): string {
  const a = Math.abs(x);
  if (a > 0 && a < 0.001) return "less than 0.001 SOL";
  return `${a >= 100 ? a.toFixed(1) : a.toFixed(3)} SOL`;
}

/** "+0.004 SOL" / "−0.006 SOL" */
export function signedSol(c: Ctx, x: number): string {
  return `${x < 0 ? "−" : "+"}${sol(c, x)}`;
}

/** Size of a gain or loss compared with the money we started with. */
export function size(x: number, start: number): string {
  const r = Math.abs(x) / (start || 1);
  if (Math.abs(x) < 0.0005) return "almost nothing";
  return r < 0.02 ? "small" : r < 0.1 ? "medium" : "big";
}

/** "we gained 0.004 SOL (a small gain)" / "we lost 0.006 SOL (a small loss)" */
export function gainWords(c: Ctx, x: number, start: number): string {
  if (Math.abs(x) < 0.0005) return "we neither gained nor lost money (almost nothing changed)";
  return x >= 0 ? `we gained ${sol(c, x)} (a ${size(x, start)} gain)` : `we lost ${sol(c, x)} (a ${size(x, start)} loss)`;
}

/** "We gained 0.004 SOL. That is a small gain." (for the verdict line, where SOL is first explained) */
export function moneySentence(c: Ctx, x: number, start: number): string {
  if (Math.abs(x) < 0.0005) return "We neither gained nor lost money. Almost nothing changed.";
  return `We ${x >= 0 ? "gained" : "lost"} ${sol(c, x)}. That is a ${size(x, start)} ${x >= 0 ? "gain" : "loss"}.`;
}

/** Kept for other modules: "+0.004 SOL (21%)" */
export function gain(c: Ctx, x: number, ratio: number): string {
  return `${signedSol(c, x)} (${pct(ratio)})`;
}

/** "+21%", "−4%", "+0.3%" */
export function pct(x: number): string {
  const p = x * 100;
  return `${p < 0 ? "−" : "+"}${Math.abs(p) >= 10 ? Math.abs(p).toFixed(0) : Math.abs(p).toFixed(1)}%`;
}

const plainPct = (x: number) => `${Math.abs(x * 100) >= 10 ? Math.abs(x * 100).toFixed(0) : Math.abs(x * 100).toFixed(1).replace(/\.0$/, "")}%`;

/** "If we had used 100 SOL, we would have gained about 21 SOL." Helps read a percentage. */
const per100 = (ratio: number) =>
  Math.abs(ratio) < 0.005 ? null : `If we had used 100 SOL, we would have ${ratio >= 0 ? "gained" : "lost"} about ${Math.round(Math.abs(ratio) * 100)} SOL.`;

const dollars = (c: Ctx, x: number) => (c.usd ? ` (about $${Math.abs(x * c.usd) >= 10 ? Math.abs(x * c.usd).toFixed(0) : Math.abs(x * c.usd).toFixed(2)})` : "");

/** "once", "twice", "5 times" */
export const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a few seconds", "4 minutes", "2 hours", "3 days" */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return "a few seconds";
  const m = Math.round(s / 60);
  if (m < 60) return plural(m, "minute");
  const h = Math.round(m / 60);
  if (h < 48) return plural(h, "hour");
  return plural(Math.round(h / 24), "day");
}

/** "14:02 UTC" (the zone is only named when it's UTC; otherwise it's your own clock). */
export function clock(c: Ctx, ms: number): string {
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: c.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
  return c.tz === "UTC" ? `${t} UTC` : t;
}

/** "Monday 20 October" */
export function dayName(c: Ctx, ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: c.tz, weekday: "long", day: "numeric", month: "long" }).format(ms);
}

const shortDay = (c: Ctx, ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: c.tz, day: "numeric", month: "long" }).format(ms);

const midnight = (c: Ctx) => (c.tz === "UTC" ? "midnight UTC" : `${clock(c, Date.parse(new Date(c.now).toISOString().slice(0, 10)) + 86_400_000)} your time`);

export const shortAddr = (a: string) => a.slice(0, 4);

export interface TokenRef {
  mint: string;
  symbol: string | null;
}

/** A coin's short name: "MOON", or the first 4 letters of its address when it has no name. */
export const token = (t: TokenRef) => {
  const s = t.symbol?.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 12);
  return s ? s.toUpperCase() : t.mint.slice(0, 4);
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const modeTag = (c: Ctx) => (c.mode === "live" ? "[LIVE]" : "[PAPER]");
const tradeWords = (c: Ctx) => (c.mode === "live" ? "a real trade (real money)" : "a practice trade (no real money)");
const moneyWords = (c: Ctx) => (c.mode === "live" ? "Our money" : "Our practice money");

/** How to do something on the computer the bot runs on. */
const onComputer = (cmd: string, what: string) => `On the bot's computer, type: ${cmd} (${what}).`;
const RESTART = onComputer("make restart", "this starts all parts of the bot again");

// ---------------------------------------------------------------------------------------------
// The special words, the parts of the bot
// ---------------------------------------------------------------------------------------------

/** Every special word the bot uses, in one simple line each. Shown by /words and /explain. */
export const WORDS: [string, string][] = [
  ["SOL", "the coin we trade with. We pay in SOL and get paid in SOL."],
  ["coin", "a small new crypto coin. Anyone can make one on the market we watch."],
  ["the trader we copy", "a person whose trades we copy, because their past trades went well."],
  ["a chance to copy a trade", "the moment a trader we copy buys a coin. We then decide: copy it or skip it."],
  ["skipped", "we did not copy that trade, because it failed one of our safety checks."],
  ["PAPER", "practice mode. Trades are pretend. No real money is used."],
  ["practice trade (no real money)", "a pretend trade, to test the bot safely."],
  ["LIVE", "real-money mode. Not switched on. Only you can switch it on."],
  ["profit or loss", "how much money we gained or lost."],
  ["fees", "small costs we pay for every buy and every sell."],
  ["the price moved against us before our trade went through", "between seeing the trade and our own trade going through, the price changed, so we paid a bit more."],
  ["automatic sell to stop a big loss", "if the price falls a lot, the bot sells by itself so the loss does not get bigger."],
  ["how far our money went down from its highest point", "how much we lost compared with our best moment."],
  ["scam (the creator took the money and left)", "the person who made a coin sells everything at once and the price crashes."],
  ["emergency stop", "stops all trading at once and sells everything. You start it with /stop."],
  ["daily loss limit", "if we lose too much in one day, the bot stops buying until the next day."],
  ["data collector", "the part of the bot that watches the market."],
  ["trading part", "the part of the bot that decides what to copy and makes the trades."],
  ["message part", "the part of the bot that sends you these messages."],
  ["data", "the market information the bot reads. We get a free amount every day."],
  ["UTC", "world time. The same clock everywhere. Daily limits start again at midnight UTC."],
];

const PARTS: Record<string, { name: string; whileDown: string }> = {
  collector: { name: "the data collector", whileDown: "While it is down, the bot cannot see the market, so it cannot trade." },
  trader: { name: "the trading part", whileDown: "While it is down, the bot cannot buy or sell, not even trades that are open." },
  notifier: { name: "the message part", whileDown: "While it is down, you get no messages." },
  score: { name: "the nightly trader check", whileDown: "" },
  weekly: { name: "the weekly report maker", whileDown: "" },
  logrotate: { name: "the log cleaner", whileDown: "" },
  dashboard: { name: "the dashboard (the web page)", whileDown: "" },
};

export const partName = (service: string) => PARTS[service]?.name ?? "a part of the bot";

/** Plain words for why a part stopped, from its last error. */
function crashCause(detail: string | null | undefined): string | null {
  if (!detail) return null;
  if (/db write failed|SQLITE_FULL|ENOSPC|disk/i.test(detail)) return "it could not save data, maybe the disk is full";
  if (/SQLITE_BUSY|database is locked/i.test(detail)) return "its storage was busy for too long";
  if (/ENOMEM|heap out of memory/i.test(detail)) return "it ran out of memory";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Why we skipped, why we sold, why a buy did not go through
// ---------------------------------------------------------------------------------------------

export interface Explained {
  /** groups the same reason */
  key: string;
  /** for lists: no numbers, so the same reasons group together */
  short: string;
  /** for one trade: with its numbers */
  long: string;
}

type Rule = [RegExp, (m: RegExpMatchArray) => Explained];
const same = (key: string, text: string): Explained => ({ key, short: text, long: text });

/** One rule per reason the trading part writes (signals/engine.ts, risk/risk-manager.ts, signals/model.ts). */
const SKIP_RULES: Rule[] = [
  [/^venue (\S+) not enabled/, () => same("venue", "the coin was on a market we do not use yet")],
  [/^leader buy ([\d.]+) < ([\d.]+) SOL/, (m) => ({
    key: "small_buy",
    short: `the trader we copy only bought a little, under ${m[2]} SOL`,
    long: `the trader we copy only bought ${(+m[1]!).toFixed(2)} SOL. Small buys do not tell us much, so we wait for ${m[2]} SOL or more`,
  })],
  [/^token launch not seen/, () => same("no_launch", "we did not see the coin being made, so we could not check it")],
  [/^token age (\d+)s outside \[(\d+), (\d+)\]/, (m) => (+m[1]! < +m[2]!
    ? same("too_new", "the coin was only a few seconds old")
    : { key: "too_old", short: `the coin was too old (we only copy in its first ${duration(+m[3]! * 1000)})`,
        long: `the coin was ${duration(+m[1]! * 1000)} old. We only copy in its first ${duration(+m[3]! * 1000)}` })],
  [/^mayhem mode token/, () => same("mayhem", "it was a special kind of coin with wild prices, and we avoid those")],
  [/^dev launched (\d+) tokens in 24h/, (m) => ({
    key: "serial_dev",
    short: "the person who made it makes many coins a day, which is often a scam",
    long: `the person who made it made ${m[1]} coins in one day, which is often a scam`,
  })],
  [/^leader is the token's dev/, () => same("leader_dev", "the trader we copy made this coin themselves, which is often a trick")],
  [/^curve SOL ([\d.]+) outside \[([\d.]+), ([\d.]+)\]/, (m) => (+m[1]! < +m[2]!
    ? same("too_little_sol", "too little money was in the coin yet")
    : same("near_graduation", "the coin was about to move to a bigger market, and prices jump a lot then"))],
  [/^(\d+) tracked buyers < (\d+)/, (m) => ({
    key: "confirmations",
    short: `not enough of the traders we copy bought it (we wait for ${m[2]})`,
    long: `only ${m[1]} of the traders we copy bought it. We wait for ${m[2]}`,
  })],
  [/^re-entry cooldown/, () => same("cooldown", "we traded this coin less than an hour ago")],
  [/^top10 holders ([\d.]+)% > ([\d.]+)%/, (m) => ({
    key: "concentrated",
    short: "a few people owned too much of it and could crash the price",
    long: `the 10 biggest owners had ${Math.round(+m[1]!)}% of it (our limit is ${m[2]}%). They could crash the price`,
  })],
  [/^dev holds ([\d.]+)% > ([\d.]+)%/, () => same("dev_holds", "the person who made it still owned a lot and could sell it all at once")],
  [/^dev sold (\d+)% of launch buy/, () => same("dev_sold", "the person who made it already sold, which is often a scam")],
  [/^on-chain check failed/, () => same("check_failed", "our safety check got no answer, so we stayed out to be safe")],
  [/^score (-?[\d.]+) < (-?[\d.]+)/, () => same("low_score", "the trader we copy has not done well enough lately")],
  [/^model expects/, () => same("model", "our learning system expected this trade to lose money")],
  // safety limits (we wanted to copy, then a limit said no)
  [/^risk: kill switch/, () => same("risk_killed", "the emergency stop is on")],
  [/^risk: daily loss cap/, () => same("risk_daily_loss", "we reached today's loss limit")],
  [/^risk: max open positions \((\d+)\)/, (m) => same("risk_open", `we already had ${m[1]} trades open, our limit`)],
  [/^risk: max entries per day \((\d+)\)/, (m) => same("risk_per_day", `we already made ${m[1]} trades today, our limit`)],
  [/^risk: leader has (\d+) of our last (\d+) entries/, () => same("risk_wallet_share", "we copied this trader a lot lately, and we spread our trades")],
  [/^risk: position size/, () => same("risk_min_size", "we had too little money left for a trade")],
  [/^risk: free balance/, () => same("risk_reserve", "we keep some money aside to pay fees")],
  [/^risk: already in this token/, () => same("risk_holding", "we already own this coin")],
];

export function explainSkip(reason: string): Explained {
  for (const [re, f] of SKIP_RULES) {
    const m = reason.match(re);
    if (m) return f(m);
  }
  return same("other", "it failed one of our other checks");
}

export const isRiskBlock = (e: Explained) => e.key.startsWith("risk_");
/** Skips that protected us from a likely scam. */
const SCAM_KEYS = new Set(["serial_dev", "leader_dev", "concentrated", "dev_holds", "dev_sold"]);
export const isScamSkip = (e: Explained) => SCAM_KEYS.has(e.key);

/** Why we sold. */
export function explainExit(reason: string | null, _stopLossPct = 0.25, maxHoldMs = 30 * 60_000): string {
  switch (reason) {
    case "leader_exit":
      return "the trader we copy sold";
    case "stop_loss":
      return "the price fell a lot, so our automatic sell to stop a big loss sold it";
    case "time_exit":
      return `we held it for ${duration(maxHoldMs)}, our longest time`;
    case "kill_switch":
      return "the emergency stop sold everything";
    default:
      return "one of our selling rules said so";
  }
}

/** Why a buy did not go through. */
export function explainMissed(reason: string | null, maxSlippage: number): string {
  const slip = reason?.match(/slippage (-?\d+)bps/);
  if (slip) return `the price moved against us before our trade went through. It went up ${plainPct(+slip[1]! / 10_000)}, and we only allow ${plainPct(maxSlippage)}`;
  if (reason === "no market data") return "we could not see a price at that moment";
  if (reason === "curve completed") return "the coin moved to a bigger market at that moment";
  if (reason === "size too small after fixed costs") return "the trade was too small to be worth the fees";
  if (reason === "kill switch") return "the emergency stop was switched on";
  return "the trade could not be finished";
}

// ---------------------------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------------------------

export interface BuyFacts {
  token: TokenRef;
  sizeSol: number;
  equity: number;
  slippage: number; // +0.011 = we paid 1.1% more than the trader we copy
  trackedCount: number;
  walletRoi: number | null;
  walletTrades: number | null;
  confirmations: number;
  windowS: number;
  tokenAgeS: number | null;
  top10Pct: number | null;
  devSoldFrac: number | null;
  maxTop10Pct: number;
}

export function bought(c: Ctx, b: BuyFacts): string {
  const t = token(b.token);
  return render({
    title: `${modeTag(c)} TRADE OPENED · ${t}`,
    happened: `We copied a trade. We bought ${t} for ${sol(c, b.sizeSol)} as ${tradeWords(c)}.`,
    mood: "normal",
    why: "This is how the bot works. You get another message when we sell.",
    todo: NOTHING,
    details: [
      b.walletRoi !== null && b.walletTrades
        ? `Why: copying this trader went well before. Over their last ${b.walletTrades} trades we would have gained ${plainPct(b.walletRoi)} on average.`
        : "Why: this trader is one of the best we follow.",
      b.confirmations >= 2 && `${b.confirmations} of the traders we copy bought it.`,
      b.devSoldFrac !== null && b.devSoldFrac < 0.01 && "Safety check: the person who made the coin has not sold.",
      b.top10Pct !== null && `Safety check: the 10 biggest owners have ${Math.round(b.top10Pct)}% of it. Our limit is ${b.maxTop10Pct}%.`,
      b.tokenAgeS !== null && `The coin is ${duration(b.tokenAgeS * 1000)} old.`,
      Math.abs(b.slippage) >= 0.001 && (b.slippage > 0
        ? `The price moved against us before our trade went through. We paid ${plainPct(b.slippage)} more than the trader we copy.`
        : `The price moved in our favour. We paid ${plainPct(b.slippage)} less than the trader we copy.`),
      `We used ${plainPct(b.sizeSol / b.equity)} of our money for this trade.`,
    ],
  });
}

export interface SellFacts {
  token: TokenRef;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  heldMs: number;
  reason: string | null;
  equity: number;
  start: number;
  stopLossPct: number;
  maxHoldMs: number;
}

export function sold(c: Ctx, s: SellFacts): string {
  const t = token(s.token);
  const roi = s.pnlSol / (s.costSol || 1);
  const big = s.pnlSol < 0 && size(s.pnlSol, s.start) !== "small" && size(s.pnlSol, s.start) !== "almost nothing";
  return render({
    title: `${modeTag(c)} TRADE CLOSED · ${t}`,
    happened: `We sold ${t}. ${s.pnlSol >= 0 ? "We got back more than we paid." : "We got back less than we paid."}`,
    mood: s.pnlSol >= 0 ? "good" : big ? "careful" : "normal",
    why: `${moneySentence(c, s.pnlSol, s.start)}${s.pnlSol < 0 && !big ? " Losses are a normal part of trading." : ""}`,
    todo: NOTHING,
    details: [
      `Why we sold: ${explainExit(s.reason, s.stopLossPct, s.maxHoldMs)}.`,
      s.reason === "stop_loss" && roi < -(s.stopLossPct + 0.05) && "The price kept falling while we were selling, so the loss is a bit bigger.",
      `We paid ${sol(c, s.costSol)} and got back ${sol(c, s.proceedsSol)}${dollars(c, s.proceedsSol)}, after fees. We held it for ${duration(s.heldMs)}.`,
      per100(roi),
      `${moneyWords(c)} now: ${sol(c, s.equity)}. We started with ${s.start} SOL.`,
    ],
  });
}

export interface MissedFacts {
  token: TokenRef;
  reason: string | null;
  feeSol: number;
  maxSlippage: number;
}

export function missed(c: Ctx, m: MissedFacts): string {
  const t = token(m.token);
  return render({
    title: `${modeTag(c)} TRADE NOT DONE · ${t}`,
    happened: `We tried to copy a trade on ${t}, but our buy did not go through.`,
    mood: "normal",
    why: "This happens sometimes. Nothing was bought.",
    todo: NOTHING,
    details: [
      `Why: ${explainMissed(m.reason, m.maxSlippage)}.`,
      m.feeSol > 0 && `The try cost a tiny fee: ${sol(c, m.feeSol)}.`,
    ],
  });
}

export interface SkipFacts {
  token: TokenRef;
  reason: string; // the first reason the trading part wrote
}

/** One chance we skipped (sent only for skips that likely saved us from a scam; the rest go in the hourly summary). */
export function skipped(c: Ctx, s: SkipFacts): string {
  const t = token(s.token);
  const e = explainSkip(s.reason);
  return render({
    title: `SKIPPED CHANCE · ${t}`,
    happened: `A trader we copy bought ${t}, but we did not copy it.`,
    mood: isScamSkip(e) ? "good" : "normal",
    why: isScamSkip(e) ? `Our safety check found a danger: ${e.short}.` : `We skip most chances. This keeps our money safe.`,
    todo: NOTHING,
    details: [`Why we skipped: ${e.long}.`, "No money was used."],
  });
}

// ---------------------------------------------------------------------------------------------
// Hourly summary
// ---------------------------------------------------------------------------------------------

export interface Counted {
  text: string;
  n: number;
}

export interface ActivityFacts {
  from: number;
  to: number;
  buys: number;
  copied: number;
  skipped: Counted[];
  skippedTotal: number;
  blocked: Counted[];
  blockedTotal: number;
}

export function activity(c: Ctx, a: ActivityFacts): string {
  const skippedAll = a.skippedTotal + a.blockedTotal;
  const other = a.skippedTotal - a.skipped.reduce((s, r) => s + r.n, 0);
  return render({
    title: "HOURLY SUMMARY",
    happened: `In the last hour, the traders we copy made ${plural(a.buys, "buy")}. We copied ${a.copied} and skipped ${skippedAll}.`,
    mood: "normal",
    why: "We skip most chances. This keeps our money safe.",
    todo: NOTHING,
    details: [
      ...a.skipped.map((r) => `Skipped ${times(r.n)}: ${r.text}.`),
      other > 0 && `Skipped ${times(other)} for other reasons.`,
      ...a.blocked.map((b) => `Skipped ${times(b.n)} by a safety limit: ${b.text}.`),
      a.copied > 0 && `You got a separate message for each trade we copied.`,
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Parts of the bot
// ---------------------------------------------------------------------------------------------

export function partDown(c: Ctx, service: string, since: number, detail: string | null): string {
  const cause = crashCause(detail);
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} is down`,
    happened: `${cap(partName(service))} stopped ${duration(c.now - since)} ago and did not start again by itself.`,
    mood: "bad",
    why: PARTS[service]?.whileDown || "One part of the bot is not working.",
    todo: cause?.includes("disk") ? onComputer("df -h", "this shows if the disk is full") : RESTART,
    details: [cause && `Probable reason: ${cause}.`, "You get a ✅ message when it works again."],
  });
}

export function partFrozen(c: Ctx, service: string, silentMs: number): string {
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} is not answering`,
    happened: `${cap(partName(service))} is switched on, but it has not answered for ${duration(silentMs)}.`,
    mood: "bad",
    why: PARTS[service]?.whileDown || "One part of the bot is not working.",
    todo: RESTART,
    details: ["You get a ✅ message when it works again."],
  });
}

export function partSwitchedOff(c: Ctx, service: string, offMs: number): string {
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} is switched off`,
    happened: `${cap(partName(service))} was switched off on purpose ${duration(offMs)} ago.`,
    mood: "careful",
    why: PARTS[service]?.whileDown || "One part of the bot is not working.",
    todo: `If you did not switch it off: ${RESTART.charAt(0).toLowerCase()}${RESTART.slice(1)}`,
  });
}

export function partBack(c: Ctx, service: string, downMs: number): string {
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} is working again`,
    happened: `${cap(partName(service))} is working again. It was down for ${duration(downMs)}.`,
    mood: "good",
    why: "The problem is fixed.",
    todo: NOTHING,
  });
}

export const KEEPS_RESTARTING = 5;

export function restarted(c: Ctx, service: string, n: number, lastCause: "crash" | "killed", lastDetail: string | null): string {
  const cause = crashCause(lastDetail) ?? (lastCause === "killed" ? "the computer stopped it suddenly, maybe it was short on memory" : "it hit an unexpected problem");
  const loop = n >= KEEPS_RESTARTING;
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} restarted by itself`,
    happened: loop
      ? `${cap(partName(service))} stopped and started again ${n} times in the last hour.`
      : `${cap(partName(service))} stopped suddenly and started again by itself a few seconds later.`,
    mood: loop ? "careful" : "normal",
    why: loop ? "It works now, but something keeps making it stop." : "This can happen. It works again now.",
    todo: loop ? onComputer(`make logs S=${service}`, "this shows why it stops") : NOTHING,
    details: [`Probable reason: ${cause}.`, !loop && n > 1 && `It happened ${times(n)} in the last hour.`],
  });
}

export function manyErrors(c: Ctx, service: string, n: number): string {
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} has many errors`,
    happened: `${cap(partName(service))} had ${n} errors in the last hour.`,
    mood: "careful",
    why: "It still works, but something may be wrong.",
    todo: onComputer(`make logs S=${service}`, "this shows the errors"),
    details: ["A common reason: our data provider did not answer for a while."],
  });
}

export function jobFailed(c: Ctx, job: string): string {
  const what: Record<string, { name: string; effect: string; step: string }> = {
    score: { name: "The nightly trader check", effect: "We keep copying yesterday's list of traders.", step: onComputer("make score", "this runs the check again") },
    weekly: { name: "The weekly report", effect: "Trading is not affected. Only the report is missing.", step: onComputer("make weekly", "this makes the report again") },
    intel: { name: "The nightly MadeOnSol helper job", effect: "Trading is not affected. We just keep yesterday's creator records.", step: onComputer("make logs S=intel", "this shows what went wrong") },
    logrotate: { name: "The log cleaner", effect: "Old log files were not cleaned. If this keeps happening, the disk slowly fills up.", step: onComputer("df -h", "this shows how full the disk is") },
  };
  const w = what[job] ?? { name: "A planned job", effect: "Trading is not directly affected.", step: onComputer("make status", "this shows what is running") };
  return render({
    title: "BOT HEALTH · A planned job failed",
    happened: `${w.name} did not finish.`,
    mood: "careful",
    why: w.effect,
    todo: w.step,
  });
}

// ---------------------------------------------------------------------------------------------
// Data coming in
// ---------------------------------------------------------------------------------------------

export function dataCapReached(c: Ctx, capMb: number, openTrades = 0): string {
  return render({
    title: "DATA · Today's free data is used up",
    happened: "We used all the market data we get for free today.",
    mood: "careful",
    why: `Until ${midnight(c)}, the bot cannot watch the traders we copy, so it will not trade.`,
    extra: [openTrades > 0 && `It still watches our ${plural(openTrades, "open trade")} until ${openTrades === 1 ? "it is" : "they are"} sold.`],
    todo: `Nothing. It starts again by itself at ${midnight(c)}.`,
    details: [`We get ${capMb} MB (megabytes) of data per day for free.`, "If this happens often, a paid data plan would fix it."],
  });
}

/** The day's free data is 70/85/95% used: the bot just switched to a lighter way of working. */
export function dataBudget(c: Ctx, d: { pct: number; mbToday: number; capMb: number; mbPerHour: number; capAt: number | null }): string {
  const steps: Record<number, [string, string]> = {
    70: ["To make it last, the bot stopped looking for new traders to copy.", "Copying the traders we follow works as normal."],
    85: ["To make it last, the bot now only watches the traders we copy and our open trades.", "Copying still works."],
    95: [`To make it last, the bot will not start new trades until ${midnight(c)}.`, "It keeps watching our open trades until they are sold."],
  };
  const [did, effect] = steps[d.pct] ?? steps[95]!;
  const speed = d.mbPerHour > 0
    ? `We use about ${d.mbPerHour} MB an hour. ${d.capAt ? `At this speed it runs out at ${clock(c, d.capAt)}.` : `At this speed it lasts until ${midnight(c)}.`}`
    : null;
  return render({
    title: `DATA · ${d.pct}% of today's free data used`,
    happened: `We used ${d.mbToday} of the ${d.capMb} MB (megabytes) of market data we get for free each day.`,
    mood: "careful",
    why: did,
    extra: [effect, speed],
    todo: `Nothing. Everything goes back to normal by itself at ${midnight(c)}.`,
    details: [
      "If you get this message most days, the free data is too small for this bot. A paid data plan costs $49 a month and gives about 10 times more.",
      "The free data is counted per day and starts again at midnight UTC.",
    ],
  });
}

/** A limit was changed on the dashboard (or set back to normal). */
export function settingChanged(c: Ctx, d: { setting: string; from: number; to: number; reset: boolean; guardMb: number | null; limit: number | null }): string {
  const data = d.setting === "helius_daily_mb_cap";
  const what = data ? "the daily market-data limit" : "where the daily MadeOnSol job stops";
  const value = (x: number) => (data ? `${Math.round(x)} MB` : `${Math.round(x)}% of its ${d.limit ?? 200} requests`);
  return render({
    title: "SETTINGS · A daily limit was changed",
    happened: d.reset ? `You set ${what} back to normal: ${value(d.to)}.` : `You changed ${what} from ${value(d.from)} to ${value(d.to)} on the dashboard.`,
    mood: "normal",
    why: data ? "More data lets the bot follow the market longer each day." : "The helper may now ask MadeOnSol more often each day.",
    extra: [data && d.guardMb !== null && `It still never uses up the month's free data: today it can use at most ${Math.round(d.guardMb)} MB.`],
    todo: d.reset ? NOTHING : "Nothing. To undo it, change it back on the dashboard.",
  });
}

/** The optional MadeOnSol helper used 70% / 90% / all of its free requests for today. Trading never waits for it. */
export function helperBudget(c: Ctx, d: { pct: number; used: number; limit: number }): string {
  const why = d.pct >= 100 ? "No requests to MadeOnSol are left for today."
    : d.pct >= 90 ? "The daily helper job stopped for today, so the last requests stay free for you."
    : "That is still fine, the daily helper job is almost done.";
  return render({
    title: `DATA HELPER · ${d.pct >= 100 ? "MadeOnSol requests used up" : `${d.pct}% of today's MadeOnSol requests used`}`,
    happened: `We used ${d.used} of the ${d.limit} free requests to MadeOnSol today.`,
    mood: d.pct >= 90 ? "careful" : "normal",
    why,
    extra: ["Trading is not affected: the bot never waits for MadeOnSol."],
    todo: d.pct >= 90 ? `Nothing. The requests start again by itself at ${midnight(c)}.` : NOTHING,
    details: ["MadeOnSol gives us the past results of coin creators and lists of good traders.", `The free plan has ${d.limit} requests a day.`],
  });
}

/** No new market data for a while although the data collector is running. */
export function dataStopped(c: Ctx, silentMs: number, what: "launches" | "trades"): string {
  return render({
    title: "DATA · Market data stopped coming",
    happened: `No new ${what === "launches" ? "coins" : "trades"} came in for ${duration(silentMs)}.`,
    mood: "bad",
    why: "Without data, the bot cannot see the market or trade.",
    todo: `Wait 10 minutes. If you get no ✅ message by then: ${RESTART.charAt(0).toLowerCase()}${RESTART.slice(1)}`,
    details: ["The data collector is running, but the market information is not reaching it.", "Usually the internet connection or our data provider is the reason."],
  });
}

export function dataBack(c: Ctx, silentMs: number): string {
  return render({
    title: "DATA · Market data is coming again",
    happened: `Market data is coming again. It was missing for ${duration(silentMs)}.`,
    mood: "good",
    why: "The bot can see the market again.",
    todo: NOTHING,
  });
}

// ---------------------------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------------------------

export function killSwitch(c: Ctx, reason: string | null, equity: number, start: number): string {
  if (reason?.startsWith("max drawdown")) {
    return render({
      title: "EMERGENCY STOP · Trading stopped",
      happened: `Our money fell ${plainPct((start - equity) / start)} below where we started, so the bot stopped all trading.`,
      mood: "bad",
      why: "This is our safety rule. The bot sold everything and buys nothing new.",
      todo: onComputer("make unkill", "this switches trading on again; only do it when you are ready"),
      details: [`${moneyWords(c)} now: ${sol(c, equity)}. We started with ${start} SOL.`],
    });
  }
  return render({
    title: "EMERGENCY STOP · Trading stopped",
    happened: "Someone used the emergency stop on the bot's computer.",
    mood: "careful",
    why: "The bot sold everything and buys nothing new.",
    todo: onComputer("make unkill", "this switches trading on again"),
  });
}

export function dailyLossCap(c: Ctx, equity: number, dayStart: number): string {
  return render({
    title: "SAFETY LIMIT · Trading paused for today",
    happened: `Today we lost ${plainPct((dayStart - equity) / dayStart)} of our money. That is our daily loss limit.`,
    mood: "careful",
    why: `The bot buys nothing new until ${midnight(c)}. Open trades are still sold normally.`,
    todo: `Nothing. Trading starts again by itself at ${midnight(c)}.`,
  });
}

export function startupBlocked(c: Ctx, why: string): string {
  if (why === "helius_key_missing") {
    return render({
      title: "BOT HEALTH · The trading part cannot start",
      happened: "The trading part needs a key (a password) for our data provider, and it is missing.",
      mood: "bad",
      why: "Without it the bot cannot check coins, so it cannot trade.",
      todo: "Add HELIUS_API_KEY to the .env settings file, then type on the bot's computer: make restart.",
    });
  }
  if (why === "live_not_ready") {
    return render({
      title: "BOT HEALTH · The trading part cannot start",
      happened: "The settings say LIVE (real money), but real-money trading is not built yet.",
      mood: "bad",
      why: "The bot refuses to start, so no real money can be used by mistake.",
      todo: "Remove the line LIVE_TRADING=true from the .env settings file, then type: make restart.",
    });
  }
  return render({
    title: "BOT HEALTH · The trading part cannot start",
    happened: "A setting the trading part needs is missing or wrong.",
    mood: "bad",
    why: "The bot cannot trade until this is fixed.",
    todo: onComputer("make logs S=trader", "this shows which setting"),
  });
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/** The very first message the bot ever sends. */
export function guide(c: Ctx, dailyAt: string): string {
  return render({
    title: "HOW TO READ MY MESSAGES",
    happened: "I am your trading bot. I will tell you what I do, in simple words.",
    mood: "normal",
    why: "Every message says: what happened, if it is good or bad, and what you should do.",
    extra: ["Only 🚨 messages need you. All others are just for your information."],
    todo: NOTHING,
    details: [
      "✅ good news.",
      "⚠️ be careful. Read it, but usually you do not need to do anything.",
      "🚨 bad. Something is broken. Do the step in \"What to do\".",
      "😐 normal. Just information.",
      `[PAPER] means practice (no real money). This is how the bot runs now.`,
      "[LIVE] means real money. It is off. Only you can switch it on.",
      `You get: a message for every trade, a summary every hour, a daily report at ${dailyAt}, and a weekly report.`,
      "Reply to any message with /explain and I explain it more simply.",
      "Send /words to see what my special words mean. Send /help for all commands.",
    ],
  });
}

/** After a deliberate restart (not the first start ever). */
export function hello(c: Ctx, _dailyAt: string): string {
  return render({
    title: "BOT STARTED",
    happened: `The message part started. The bot runs in ${c.mode === "live" ? "LIVE mode (real money)" : "PAPER mode (practice, no real money)"}.`,
    mood: "normal",
    why: "This happens after an update or a restart.",
    todo: NOTHING,
    details: ["Send /help to see what I can do."],
  });
}

export function help(): string {
  return render({
    title: "COMMANDS",
    happened: "Here is what you can send me.",
    mood: "normal",
    why: "Just information.",
    todo: NOTHING,
    details: [
      "/status: is every part of the bot working?",
      "/pnl: our profit or loss today, this week and in total.",
      "/explain: reply to one of my messages with this, and I explain it more simply.",
      "/words: what my special words mean.",
      "/why MOON: what the bot did with a coin, and why.",
      "/quiet: no messages for 8 hours, except 🚨 ones. /quiet off ends it.",
      "/stop: emergency stop. Sells everything and stops trading. I ask you first.",
    ],
  });
}

export function words(): string {
  return render({
    title: "WORDS I USE",
    happened: "Here are my special words and what they mean.",
    mood: "normal",
    why: "Just information.",
    todo: NOTHING,
    details: WORDS.map(([w, m]) => `${w}: ${m}`),
    noExplain: true,
  });
}

/** /explain without replying to a message. */
export function explainHowTo(): string {
  return render({
    title: "EXPLAIN",
    happened: "You sent /explain, but not as a reply to one of my messages.",
    mood: "normal",
    why: "I need to know which message you mean.",
    todo: "Press and hold one of my messages, tap Reply, and send /explain.",
  });
}

interface Explainer {
  /** matches the original message's title line */
  match: RegExp;
  simple: (title: string) => string;
  example: string;
}

const EXPLAINERS: Explainer[] = [
  { match: /TRADE OPENED/, simple: () => "We saw a good trader buy a coin, and we bought the same coin.",
    example: "Like copying a friend who is good at a game: when they make a move, we make the same move." },
  { match: /TRADE CLOSED/, simple: () => "We sold a coin we had bought. The message says if we made or lost money.",
    example: "You buy a toy for 10 coins and sell it for 12. You made 2. If you sell it for 8, you lost 2." },
  { match: /TRADE NOT DONE/, simple: () => "We wanted to buy a coin, but the buy did not work, so we bought nothing.",
    example: "You run to a shop to buy a toy, but the price went up while you ran, so you do not buy it." },
  { match: /SKIPPED CHANCE/, simple: () => "A trader we copy bought a coin. We decided not to copy it, to stay safe.",
    example: "A friend jumps into a pool, but you see there is no water. You do not jump." },
  { match: /HOURLY SUMMARY/, simple: () => "Every hour I count what the traders we copy did, and what we copied.",
    example: "50 buys, we copied 2: we only copy the few that pass all our safety checks." },
  { match: /DAILY REPORT/, simple: () => "The results of one whole day: how many trades, and how much we gained or lost.",
    example: "Like a school report for one day." },
  { match: /WEEKLY REPORT/, simple: () => "The results of the last 7 days, and if the bot is working well yet.",
    example: "Like a school report for the whole week." },
  { match: /restarted by itself/, simple: () => "A part of the bot stopped for a moment and switched itself back on.",
    example: "Like a computer that restarts by itself. It works again after." },
  { match: /cannot start/, simple: () => "A part of the bot will not switch on, because a setting is missing or wrong.",
    example: "Like a car that will not start because the key is missing." },
  { match: /is down|is not answering|is switched off/, simple: () => "A part of the bot is not working right now.",
    example: "Like a car with an engine that stopped. It needs a restart." },
  { match: /is working again/, simple: () => "A part of the bot was broken and now works again.", example: "Like a light that came back on after a power cut." },
  { match: /has many errors|planned job failed/, simple: () => "Something in the bot did not work well, but the bot still runs.",
    example: "Like a car with a warning light on. It still drives, but you should check it." },
  { match: /DATA ·/, simple: () => "This is about the market information the bot reads to trade.",
    example: "Like a weather app with no internet: it cannot show the weather." },
  { match: /^SETTINGS/, simple: () => "Someone changed one of the bot's daily limits on the dashboard. The message says which, and how to undo it.",
    example: "Like turning up the volume: louder now, and you can turn it back down any time." },
  { match: /DATA HELPER/, simple: () => "MadeOnSol is an extra helper that tells us how a coin's creator did before. We may ask it a few times a day for free.",
    example: "Like a free library card: a few books a day. When they are used up, you come back tomorrow." },
  { match: /EMERGENCY STOP/, simple: () => "All trading is stopped. The bot sold everything and buys nothing new.",
    example: "Like pressing the big red stop button on a machine." },
  { match: /SAFETY LIMIT/, simple: () => "We lost too much today, so the bot rests until tomorrow.",
    example: "Like a rule: if you lose 5 games today, you stop playing until tomorrow." },
  { match: /^STATUS/, simple: () => "A check of every part of the bot: is it working or not?", example: "Like checking that all lights in a house are on." },
  { match: /PROFIT OR LOSS/, simple: () => "How much money we gained or lost: today, this week, and since the start.",
    example: "Start with 1 SOL, now 1.01 SOL: we gained 0.01 SOL." },
  { match: /HOW TO READ/, simple: () => "This is the guide for my messages. Each message has the same 3 parts.",
    example: "\"What happened\" tells the news. The emoji tells if it is good or bad. \"What to do\" tells your job, usually nothing." },
  { match: /COMMANDS|WORDS I USE/, simple: () => "This is a list to help you use the bot.", example: "Send /status to check that the bot works." },
  { match: /BOT STARTED/, simple: () => "The bot was switched on again.", example: "Like a phone that was restarted. It works normally after." },
  { match: /QUIET MODE/, simple: () => "Quiet mode means fewer messages for a while. Only 🚨 messages still come.",
    example: "Like a phone on silent, but alarms still ring." },
  { match: /^WHY/, simple: () => "This tells you what the bot did with one coin, and why.", example: "Like asking: why did you buy that?" },
  { match: /SORRY|^EXPLAIN$/, simple: () => "I could not do what you asked. The message tells you what to try.", example: "Like a shop that is closed: come back later." },
];

/** /explain, replying to one of the bot's messages. `original` is that message's text. */
export function explain(original: string): string {
  const title = original.split("\n")[0] ?? "";
  const ex = EXPLAINERS.find((e) => e.match.test(title));
  const lower = original.toLowerCase();
  const used = WORDS.filter(([w]) => lower.includes(w.toLowerCase().split(" (")[0]!));
  return render({
    title: `EXPLAINED · ${title.replace(/^\[(PAPER|LIVE)\] /, "").slice(0, 40)}`,
    happened: ex ? ex.simple(title) : "This is one of my messages about the bot.",
    mood: "normal",
    why: original.includes("🚨") ? "This one needs you. Do the step in \"What to do\"." : "This one does not need you.",
    todo: NOTHING,
    details: [
      ex && `Example: ${ex.example}`,
      used.length > 0 && "Words in that message:",
      ...used.map(([w, m]) => `  - ${w}: ${m}`),
    ],
    noExplain: true,
  });
}

export function commandFailed(): string {
  return render({ title: "SORRY", happened: "Something went wrong when I tried to answer.", mood: "careful", why: "The bot itself is probably fine.", todo: "Send the command again in one minute." });
}

export function unknownCommand(): string {
  return render({ title: "SORRY", happened: "I do not know that command.", mood: "normal", why: "Nothing is wrong.", todo: "Send /help to see the commands I know." });
}

export type Health = "up" | "starting" | "down" | "frozen" | "off" | "unknown";

export interface StatusFacts {
  parts: { service: string; health: Health; since: number | null }[];
  lastTradeAt: number | null;
  streams: {
    watching: "on" | "capped" | "reconnecting" | "disabled";
    discovery: "on" | "resting" | "budget_used" | "reconnecting" | "disabled";
    discoveryResumesAt: number | null;
    mbToday: number;
    capMb: number;
  } | null;
  tracked: number | null;
  open: number;
  killed: { reason: string | null; at: number | null } | null;
  halted: boolean;
  quietUntil: number | null;
}

const killWho = (reason: string | null) =>
  reason?.startsWith("telegram") ? "you used /stop" : reason?.startsWith("max drawdown") ? "our money fell too far" : "someone used the emergency stop on the bot's computer";

export function status(c: Ctx, s: StatusFacts): string {
  const rows: { ok: boolean; text: string; urgent?: boolean; step?: string }[] = [];
  for (const p of s.parts) {
    const ok = p.health === "up" || p.health === "starting";
    const state = p.health === "up" ? "working" : p.health === "starting" ? "starting" : p.health === "frozen" ? "not answering"
      : p.health === "off" ? "switched off" : p.health === "down" ? "down" : "no news yet";
    rows.push({ ok, text: `${cap(partName(p.service).replace(/^the /, ""))}: ${state}`, urgent: !ok && p.service !== "dashboard", step: ok ? undefined : RESTART });
  }
  if (s.streams) {
    const w = s.streams;
    rows.push(w.watching === "on" ? { ok: true, text: "Watching the traders we copy: yes" }
      : w.watching === "capped" ? { ok: false, text: `Watching the traders we copy: no, today's free data is used up until ${midnight(c)}` }
      : w.watching === "reconnecting" ? { ok: false, text: "Watching the traders we copy: reconnecting", step: "Wait 10 minutes and send /status again." }
      : { ok: false, text: "Watching the traders we copy: switched off in the settings" });
    rows.push({ ok: w.mbToday < w.capMb, text: `Free data used today: ${Math.round((w.mbToday / w.capMb) * 100)}%` });
  }
  if (s.tracked === 0) rows.push({ ok: false, text: "Traders we copy: none yet (the bot needs a few days of data)" });
  rows.push(s.killed ? { ok: false, text: `Trading: stopped, because ${killWho(s.killed.reason)}`, step: onComputer("make unkill", "this switches trading on again") }
    : s.halted ? { ok: false, text: `Trading: paused until ${midnight(c)} (daily loss limit)` }
    : { ok: true, text: `Trading: on, ${c.mode === "live" ? "LIVE (real money)" : "PAPER (practice, no real money)"}` });
  const bad = rows.filter((r) => !r.ok);
  const urgent = bad.some((r) => r.urgent);
  return render({
    title: "STATUS",
    happened: bad.length === 0 ? "I checked every part of the bot. All parts work." : `I checked every part of the bot. ${plural(bad.length, "thing needs", "things need")} attention.`,
    mood: bad.length === 0 ? "good" : urgent ? "bad" : "careful",
    why: bad.length === 0 ? "The bot is working normally." : bad.length === 1 ? `${bad[0]!.text}.` : `${plural(bad.length, "thing is", "things are")} not right. See the ❌ lines below.`,
    todo: bad.find((r) => r.step)?.step ?? (bad.length ? "Nothing now. It should fix itself. Send /status again later." : NOTHING),
    details: [
      ...rows.map((r) => `${r.ok ? "✅" : "❌"} ${r.text}`),
      s.tracked && `We copy ${plural(s.tracked, "trader")}. ${plural(s.open, "trade is", "trades are")} open now.`,
      s.lastTradeAt && `Last market data: ${duration(c.now - s.lastTradeAt)} ago.`,
      s.quietUntil && `Quiet mode is on until ${clock(c, s.quietUntil)}.`,
    ],
  });
}

export interface PeriodResult {
  closed: number;
  wins: number;
  pnl: number;
}

export interface PnlFacts {
  equity: number;
  start: number;
  open: number;
  today: PeriodResult;
  week: PeriodResult;
  all: PeriodResult;
}

const periodLine = (c: Ctx, label: string, r: PeriodResult, start: number) =>
  r.closed === 0 ? `${label}: no trades.` : `${label}: ${plural(r.closed, "trade")}, ${r.wins} won. ${cap(gainWords(c, r.pnl, start))}.`;

export function pnl(c: Ctx, p: PnlFacts): string {
  const total = p.equity - p.start;
  return render({
    title: "PROFIT OR LOSS",
    happened: `${moneyWords(c)} went from ${p.start} SOL at the start to ${sol(c, p.equity)} now.`,
    mood: Math.abs(total) < 0.0005 ? "normal" : total > 0 ? "good" : size(total, p.start) === "small" ? "normal" : "careful",
    why: `In total: ${moneySentence(c, total, p.start)}`,
    todo: NOTHING,
    details: [
      periodLine(c, "Today", p.today, p.start),
      periodLine(c, "Last 7 days", p.week, p.start),
      periodLine(c, "Since the start", p.all, p.start),
      `${plural(p.open, "trade is", "trades are")} open now.`,
      c.mode === "paper" && "These are practice trades (no real money).",
    ],
  });
}

export const STOP_YES = "Yes, stop trading";
export const STOP_NO = "No, cancel";

export function stopConfirm(_c: Ctx, open: number): string {
  return render({
    title: "EMERGENCY STOP · Are you sure?",
    happened: "You asked me to stop all trading.",
    mood: "careful",
    why: open ? `The bot will sell the ${plural(open, "trade")} it has open, and buy nothing new.` : "The bot will buy nothing new.",
    extra: ["Only you can switch trading on again, on the bot's computer."],
    todo: `Tap "${STOP_YES}" to stop, or "${STOP_NO}".`,
  });
}

export function stopDone(_c: Ctx, open: number): string {
  return render({
    title: "EMERGENCY STOP · Trading stopped",
    happened: open ? `Trading is stopped. The bot is selling the ${plural(open, "trade")} it had open.` : "Trading is stopped. Nothing was open.",
    mood: "careful",
    why: "The bot will not trade until you switch it on again.",
    todo: `Nothing now. When you want to trade again: ${onComputer("make unkill", "this switches trading on again").charAt(0).toLowerCase()}${onComputer("make unkill", "this switches trading on again").slice(1)}`,
  });
}

export function stopCancelled(): string {
  return render({ title: "EMERGENCY STOP · Cancelled", happened: "You cancelled the emergency stop.", mood: "good", why: "Trading goes on as before.", todo: NOTHING });
}

export function stopExpired(): string {
  return render({ title: "EMERGENCY STOP · Too late", happened: "That button is too old to use.", mood: "normal", why: "Nothing was changed.", todo: "Send /stop again if you still want to stop trading." });
}

export function alreadyHalted(c: Ctx, reason: string | null, _at: number | null): string {
  return render({
    title: "EMERGENCY STOP · Already stopped",
    happened: `Trading is already stopped, because ${killWho(reason)}.`,
    mood: "careful",
    why: "The bot does not trade.",
    todo: onComputer("make unkill", "this switches trading on again"),
  });
}

export function quietOn(c: Ctx, until: number): string {
  return render({
    title: "QUIET MODE · On",
    happened: `I will be quiet until ${clock(c, until)}.`,
    mood: "normal",
    why: "You will still get 🚨 messages. Reports wait until quiet mode ends.",
    todo: "Nothing. Send /quiet off to end it early.",
  });
}

export function quietOver(c: Ctx, closed: number, pnlSol: number, missedOther: number): string {
  return render({
    title: "QUIET MODE · Over",
    happened: closed ? `Quiet mode is over. ${plural(closed, "trade")} closed while I was quiet.` : "Quiet mode is over. No trades closed while I was quiet.",
    mood: "normal",
    why: closed ? `Together: ${moneySentence(c, pnlSol, 1)}` : "Nothing important happened.",
    todo: NOTHING,
    details: [missedOther > 0 && `I did not send ${plural(missedOther, "message")}. Send /pnl to see the results.`],
  });
}

export function quietWasOff(): string {
  return render({ title: "QUIET MODE · Was not on", happened: "Quiet mode was not on.", mood: "normal", why: "You get all messages.", todo: NOTHING });
}

// ---------------------------------------------------------------------------------------------
// /why <coin>
// ---------------------------------------------------------------------------------------------

export interface WhyEvent {
  at: number;
  decision: "enter" | "reject" | "risk_block";
  reasons: string[];
  confirmations: number;
  position: null | {
    status: "pending" | "open" | "closed" | "failed";
    sizeSol: number;
    closedAt: number | null;
    exitReason: string | null;
    pnlSol: number | null;
    costSol: number | null;
  };
}

export function whyNoArg(): string {
  return render({ title: "WHY", happened: "You did not say which coin.", mood: "normal", why: "Nothing is wrong.", todo: "Send /why and the coin's name, for example: /why MOON." });
}

export function whyNotFound(query: string): string {
  return render({
    title: "WHY",
    happened: `I do not know a coin called "${query.slice(0, 20)}".`,
    mood: "normal",
    why: "I only know coins that the traders we copy bought.",
    todo: "Check the spelling and send it again.",
  });
}

export function whyNothing(t: TokenRef): string {
  return render({
    title: `WHY · ${token(t)}`,
    happened: `The bot never looked at ${token(t)}.`,
    mood: "normal",
    why: "None of the traders we copy bought it.",
    todo: NOTHING,
  });
}

export function why(c: Ctx, t: TokenRef, events: WhyEvent[], total: number, _sameName: number, limits: { stopLossPct: number; maxHoldMs: number; maxSlippage: number }): string {
  const copied = events.filter((e) => e.decision === "enter").length;
  return render({
    title: `WHY · ${token(t)}`,
    happened: `The traders we copy bought ${token(t)} ${plural(total, "time")}. We copied ${copied}.`,
    mood: "normal",
    why: "Here is what we did each time.",
    todo: NOTHING,
    details: events.map((e) => {
      const when = `${duration(c.now - e.at)} ago`;
      if (e.decision === "reject") return `${cap(when)}: skipped, because ${explainSkip(e.reasons[0] ?? "").long}.`;
      if (e.decision === "risk_block") return `${cap(when)}: skipped by a safety limit: ${explainSkip(e.reasons.find((x) => x.startsWith("risk:")) ?? "").long}.`;
      const p = e.position;
      if (!p || p.status === "pending") return `${cap(when)}: copied. The buy was still going through.`;
      if (p.status === "open") return `${cap(when)}: copied. We still own it.`;
      if (p.status === "failed") return `${cap(when)}: tried to copy, but ${explainMissed(p.exitReason, limits.maxSlippage)}.`;
      return `${cap(when)}: copied. Sold because ${explainExit(p.exitReason, limits.stopLossPct, limits.maxHoldMs)}. ${moneySentence(c, p.pnlSol ?? 0, 1)}`;
    }),
  });
}

// ---------------------------------------------------------------------------------------------
// Daily and weekly reports
// ---------------------------------------------------------------------------------------------

/** Below this many closed trades, results are mostly luck. */
export const TRADES_TO_JUDGE = 50;

export interface Verdict {
  closedAllTime: number;
  pnlAllTime: number;
  start: number;
  pnlLast7d: number;
}

export function verdict(v: Verdict): string {
  if (v.closedAllTime < TRADES_TO_JUDGE) return `Too early to tell. We have ${plural(v.closedAllTime, "trade")}. We need at least ${TRADES_TO_JUDGE} to know.`;
  if (v.pnlAllTime > 0 && v.pnlLast7d >= 0) return `Looks good so far, after ${v.closedAllTime} trades. Keep watching before using real money.`;
  if (v.pnlAllTime > 0) return "Mixed. We gained in total, but lost in the last 7 days. Keep watching.";
  return `Not yet. After ${v.closedAllTime} trades we lost money. Not ready for real money.`;
}

export interface TradeRef extends TokenRef {
  pnl: number;
}

export interface ReportFacts {
  from: number;
  to: number;
  equity: number;
  start: number;
  period: PeriodResult & { missed: number; best: TradeRef | null; worst: TradeRef | null; avgSlippage: number | null };
  exits: Counted[];
  buys: number;
  copied: number;
  skipped: Counted[];
  skippedTotal: number;
  blocked: Counted[];
  blockedTotal: number;
  wallets: { tracked: number; added: number; removed: number } | null;
  data: { mb: number; capMb: number } | null;
  trouble: { service: string; restarts: number; errors: number }[];
  verdict: Verdict;
  killed: boolean;
  stopLossPct: number;
}

const exitLabel = (r: string) =>
  ({ leader_exit: "the trader we copy sold", stop_loss: "automatic sell to stop a big loss", time_exit: "held for our longest time", kill_switch: "emergency stop" })[r] ?? "other";

function reportDetails(c: Ctx, r: ReportFacts): Line[] {
  const p = r.period;
  return [
    p.best && p.worst && p.closed > 1 && `Best trade: ${token(p.best)}, ${gainWords(c, p.best.pnl, r.start)}. Worst: ${token(p.worst)}, ${gainWords(c, p.worst.pnl, r.start)}.`,
    r.exits.length > 0 && `Why we sold: ${r.exits.map((e) => `${exitLabel(e.text)} (${times(e.n)})`).join(", ")}.`,
    p.avgSlippage !== null && Math.abs(p.avgSlippage) >= 0.001 && `On average, the price moved against us by ${plainPct(p.avgSlippage)} before our trades went through.`,
    p.missed > 0 && `${plural(p.missed, "buy")} did not go through.`,
    r.buys > 0 ? `The traders we copy made ${plural(r.buys, "buy")}. We copied ${r.copied} and skipped ${r.skippedTotal + r.blockedTotal}.` : "The traders we copy did not buy anything.",
    ...r.skipped.map((s) => `  - Skipped ${times(s.n)}: ${s.text}.`),
    r.wallets && `We copy ${plural(r.wallets.tracked, "trader")}${r.wallets.added || r.wallets.removed ? ` (${r.wallets.added} new, ${r.wallets.removed} removed)` : ""}.`,
    r.data && `Free data used: ${Math.round((r.data.mb / r.data.capMb) * 100)}% of the daily amount.`,
    ...r.trouble.map((t) => `${cap(partName(t.service))} restarted ${times(t.restarts)} and had ${plural(t.errors, "error")}.`),
    r.trouble.length === 0 && "No part of the bot had problems.",
  ];
}

function reportMood(r: ReportFacts): Mood {
  if (r.killed) return "careful";
  if (Math.abs(r.period.pnl) < 0.0005) return "normal";
  if (r.period.pnl > 0) return "good";
  return size(r.period.pnl, r.start) === "small" ? "normal" : "careful";
}

export function dailyReport(c: Ctx, r: ReportFacts): string {
  const p = r.period;
  return render({
    title: `DAILY REPORT · ${dayName(c, r.from)}`,
    happened: p.closed ? `That day we made ${plural(p.closed, "practice trade")} (no real money). ${p.wins} won, ${p.closed - p.wins} lost.` : "That day we made no trades.",
    mood: reportMood(r),
    why: p.closed ? `${moneySentence(c, p.pnl, r.start)}${p.pnl < 0 && reportMood(r) === "normal" ? " Small losses are normal." : ""}` : "Nothing to judge.",
    extra: [`Is the bot working yet? ${verdict(r.verdict)}`],
    todo: r.killed ? onComputer("make unkill", "trading is stopped; this switches it on again") : NOTHING,
    details: [`${moneyWords(c)} now: ${sol(c, r.equity)}. We started with ${r.start} SOL.`, ...reportDetails(c, r)],
  });
}

export function weeklyReport(c: Ctx, r: ReportFacts, attached: boolean): string {
  const p = r.period;
  return render({
    title: `WEEKLY REPORT · ${shortDay(c, r.from)} to ${shortDay(c, r.to)}`,
    happened: p.closed ? `This week we made ${plural(p.closed, "practice trade")} (no real money). ${p.wins} won, ${p.closed - p.wins} lost.` : "This week we made no trades.",
    mood: reportMood(r),
    why: p.closed ? moneySentence(c, p.pnl, r.start) : "Nothing to judge.",
    extra: [`Is the bot working yet? ${verdict(r.verdict)}`],
    todo: r.killed ? onComputer("make unkill", "trading is stopped; this switches it on again") : NOTHING,
    details: [`${moneyWords(c)} now: ${sol(c, r.equity)}. We started with ${r.start} SOL.`, ...reportDetails(c, r), attached && "The full report is in the file below."],
  });
}

export const weeklyFileCaption: string = "WEEKLY REPORT · the full report as a file (with tables)";
