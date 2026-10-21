/**
 * THE GEN Z VOICE: every Telegram message from messages.ts, same facts, same numbers, same steps,
 * Gen Z wording. Pick it with notifier.voice: genz (plain is the fallback). Edit freely.
 *
 * Shape (the tests check it on every message):
 *
 *   TITLE IN CAPITALS · name          <- same titles as plain, so /explain recognises them
 *   the tea: <what happened>
 *   <emoji> <W | lowkey sus | not good fr | mid>: <short why>
 *   (at most 2 more short lines)
 *   your move: <nothing, or one clear step>
 *   the deets:                        <- optional
 *   • ...
 *
 * Rules: slang yes, confusion no. 🚨 messages still say exactly what to type. No jargon words
 * (same list as plain), no addresses, round numbers, SOL explained the first time.
 */
import { clock, dayName, duration, plural, size, sol, times, token, TRADES_TO_JUDGE, type ActivityFacts, type BrainFacts, type BrainMemoryFacts, type BuyFacts, type Counted, type Ctx,
  type Explained, type MissedFacts, type PnlFacts, type ReportFacts, type SellFacts, type SkipFacts, type StatusFacts, type TokenRef, type Verdict,
  type WhyEvent, type PeriodResult, type SettingChange, KEEPS_RESTARTING } from "./messages.js";

// everything else (types, number helpers, isScamSkip, STOP_YES/NO, ...) is shared with plain
export * from "./messages.js";

type Mood = "good" | "careful" | "bad" | "normal";
const MOOD: Record<Mood, string> = { good: "✅ W", careful: "⚠️ lowkey sus", bad: "🚨 not good fr", normal: "😐 mid" };
export const NOTHING: string = "nothing, we're chillin.";

type Line = string | false | 0 | null | undefined;

interface Shape {
  title: string;
  happened: string;
  mood: Mood;
  why: string;
  extra?: Line[];
  todo: string;
  details?: Line[];
  noExplain?: boolean;
}

const EXPLAIN_ONCE: [RegExp, string][] = [
  [/\bSOL\b/, "SOL (the coin we trade with)"],
  [/\bUTC\b/, "UTC (world time)"],
  [/\bscam\b/, "scam (the creator dipped with the money)"],
];

function render(s: Shape): string {
  const keep = (l: Line): l is string => typeof l === "string" && l !== "";
  const lines = [s.title, `the tea: ${s.happened}`, `${MOOD[s.mood]}: ${s.why}`, ...(s.extra ?? []).filter(keep), `your move: ${s.todo}`];
  const details = (s.details ?? []).filter(keep);
  if (details.length) lines.push("the deets:", ...details.map((d) => (d.startsWith("  ") ? d : `• ${d}`)));
  let text = lines.join("\n");
  if (!s.noExplain) for (const [re, full] of EXPLAIN_ONCE) text = text.replace(re, full);
  return text;
}

const plainPct = (x: number) => `${Math.abs(x * 100) >= 10 ? Math.abs(x * 100).toFixed(0) : Math.abs(x * 100).toFixed(1).replace(/\.0$/, "")}%`;
const dollars = (c: Ctx, x: number) => (c.usd ? ` (about $${Math.abs(x * c.usd) >= 10 ? Math.abs(x * c.usd).toFixed(0) : Math.abs(x * c.usd).toFixed(2)})` : "");
const shortDay = (c: Ctx, ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: c.tz, day: "numeric", month: "long" }).format(ms);
const midnight = (c: Ctx) => (c.tz === "UTC" ? "midnight UTC" : `${clock(c, Date.parse(new Date(c.now).toISOString().slice(0, 10)) + 86_400_000)} your time`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const modeTag = (c: Ctx) => (c.mode === "live" ? "[LIVE]" : "[PAPER]");
const tradeWords = (c: Ctx) => (c.mode === "live" ? "a real trade (real money)" : "a practice trade (no real money)");
const moneyWords = (c: Ctx) => (c.mode === "live" ? "our bag" : "our practice bag");
const onComputer = (cmd: string, what: string) => `on the bot's computer, type: ${cmd} (${what}).`;
const RESTART = onComputer("make restart", "turns every part of the bot back on");
const per100 = (ratio: number) =>
  Math.abs(ratio) < 0.005 ? null : `if we'd put in 100 SOL, we'd be ${ratio >= 0 ? "up" : "down"} about ${Math.round(Math.abs(ratio) * 100)} SOL.`;

/** "a small W" / "a medium L" */
const wl = (x: number, start: number) => `a ${size(x, start)} ${x >= 0 ? "W" : "L"}`;

export function gainWords(c: Ctx, x: number, start: number): string {
  if (Math.abs(x) < 0.0005) return "we broke even (basically nothing changed)";
  return x >= 0 ? `we're up ${sol(c, x)} (${wl(x, start)})` : `we're down ${sol(c, x)} (${wl(x, start)})`;
}

export function moneySentence(c: Ctx, x: number, start: number): string {
  if (Math.abs(x) < 0.0005) return "we broke even. basically nothing changed.";
  return `we ${x >= 0 ? "made" : "lost"} ${sol(c, x)}. that's ${wl(x, start)}.`;
}

// ---------------------------------------------------------------------------------------------
// words, parts
// ---------------------------------------------------------------------------------------------

export const WORDS: [string, string][] = [
  ["SOL", "the coin we trade with. we pay in SOL and get paid in SOL."],
  ["coin", "a tiny new crypto coin. literally anyone can make one on the market we watch."],
  ["our traders", "the people whose trades we copy, cuz their past trades went hard."],
  ["a chance to copy", "the moment one of our traders buys a coin. then we decide: copy or skip."],
  ["skipped", "we didn't copy it, cuz it failed one of our safety checks."],
  ["PAPER", "practice mode. pretend trades, zero real money."],
  ["practice trade (no real money)", "a pretend trade, so we can test the bot without risking anything."],
  ["LIVE", "real-money mode. it's off. only you can turn it on."],
  ["W / L", "a win / a loss."],
  ["fees", "tiny costs we pay on every buy and every sell."],
  ["the price ran before our buy landed", "between spotting the trade and our own buy going through, the price went up, so we paid a bit more."],
  ["auto-sell to stop a big L", "if the price tanks, the bot sells by itself so the loss doesn't get worse."],
  ["scam (the creator dipped with the money)", "the person who made a coin sells everything at once and the price dies."],
  ["emergency stop", "stops all trading instantly and sells everything. you start it with /stop."],
  ["daily loss limit", "if we lose too much in one day, the bot stops buying until tomorrow."],
  ["data collector", "the part of the bot that watches the market."],
  ["learning brain", "the part of the bot that studies again after every trade, never forgets, and may skip trades it thinks will flop."],
  ["trading brain", "the part of the bot that decides what to copy and makes the trades."],
  ["message bot", "the part of the bot that sends you these texts."],
  ["data", "the market info the bot reads. we get a free amount every day."],
  ["UTC", "world time. same clock everywhere. daily limits reset at midnight UTC."],
];

const PARTS: Record<string, { name: string; whileDown: string }> = {
  collector: { name: "the data collector", whileDown: "while it's down the bot is blind, so it can't trade." },
  trader: { name: "the trading brain", whileDown: "while it's down the bot can't buy or sell, not even trades that are open." },
  notifier: { name: "the message bot", whileDown: "while it's down you get no texts." },
  score: { name: "the nightly trader check", whileDown: "" },
  brain: { name: "the learning brain", whileDown: "while it's down the bot keeps trading with what the brain learned last, it just stops learning." },
  weekly: { name: "the weekly report maker", whileDown: "" },
  logrotate: { name: "the log cleaner", whileDown: "" },
  dashboard: { name: "the dashboard (the web page)", whileDown: "" },
};
export const partName = (service: string) => PARTS[service]?.name ?? "a part of the bot";

function crashCause(detail: string | null | undefined): string | null {
  if (!detail) return null;
  if (/db write failed|SQLITE_FULL|ENOSPC|disk/i.test(detail)) return "it couldn't save data, the disk might be full";
  if (/SQLITE_BUSY|database is locked/i.test(detail)) return "its storage was busy for way too long";
  if (/ENOMEM|heap out of memory/i.test(detail)) return "it ran out of memory";
  return null;
}

// ---------------------------------------------------------------------------------------------
// why we skipped / sold / missed
// ---------------------------------------------------------------------------------------------

type Rule = [RegExp, (m: RegExpMatchArray) => Explained];
const same = (key: string, text: string): Explained => ({ key, short: text, long: text });

/** Same rules and keys as plain (isScamSkip / isRiskBlock work on the keys), Gen Z words. */
const SKIP_RULES: Rule[] = [
  [/^venue (\S+) not enabled/, () => same("venue", "the coin was on a market we don't use yet")],
  [/^leader buy ([\d.]+) < ([\d.]+) SOL/, (m) => ({
    key: "small_buy",
    short: `our trader only bought a little, under ${m[2]} SOL`,
    long: `our trader only bought ${(+m[1]!).toFixed(2)} SOL. tiny buys don't mean much, so we wait for ${m[2]} SOL or more`,
  })],
  [/^token launch not seen/, () => same("no_launch", "we didn't catch the coin being made, so we couldn't vibe check it")],
  [/^token age (\d+)s outside \[(\d+), (\d+)\]/, (m) => (+m[1]! < +m[2]!
    ? same("too_new", "the coin was literally seconds old")
    : { key: "too_old", short: `the coin was too old (we only copy in its first ${duration(+m[3]! * 1000)})`,
        long: `the coin was ${duration(+m[1]! * 1000)} old. we only copy in its first ${duration(+m[3]! * 1000)}` })],
  [/^mayhem mode token/, () => same("mayhem", "it was a chaos-mode coin with unhinged prices, we stay away")],
  [/^dev launched (\d+) tokens in 24h/, (m) => ({
    key: "serial_dev",
    short: "the creator pumps out tons of coins a day, that's giving scam",
    long: `the creator made ${m[1]} coins in one day, that's giving scam`,
  })],
  [/^leader is the token's dev/, () => same("leader_dev", "our trader made this coin themselves, which is usually a trick")],
  [/^curve SOL ([\d.]+) outside \[([\d.]+), ([\d.]+)\]/, (m) => (+m[1]! < +m[2]!
    ? same("too_little_sol", "barely any money was in the coin yet")
    : same("near_graduation", "the coin was about to move to a bigger market, and prices go crazy then"))],
  [/^(\d+) tracked buyers < (\d+)/, (m) => ({
    key: "confirmations",
    short: `not enough of our traders bought it (we wait for ${m[2]})`,
    long: `only ${m[1]} of our traders bought it. we wait for ${m[2]}`,
  })],
  [/^re-entry cooldown/, () => same("cooldown", "we traded this coin less than an hour ago")],
  [/^top10 holders ([\d.]+)% > ([\d.]+)%/, (m) => ({
    key: "concentrated",
    short: "a few people owned way too much of it and could crash the price",
    long: `the 10 biggest owners had ${Math.round(+m[1]!)}% of it (our limit is ${m[2]}%). they could crash it`,
  })],
  [/^dev holds ([\d.]+)% > ([\d.]+)%/, () => same("dev_holds", "the creator still owned a lot and could dump it all at once")],
  [/^dev sold (\d+)% of launch buy/, () => same("dev_sold", "the creator already sold, that's giving scam")],
  [/^on-chain check failed/, () => same("check_failed", "our safety check got ghosted, so we stayed out to be safe")],
  [/^score (-?[\d.]+) < (-?[\d.]+)/, () => same("low_score", "our trader hasn't been doing great lately")],
  [/^model expects/, () => same("model", "our learning system thinks this one would lose money")],
  [/^bad creator/, () => same("bad_creator", "the creator's past coins basically all flopped")],
  [/^risk: kill switch/, () => same("risk_killed", "the emergency stop is on")],
  [/^risk: daily loss cap/, () => same("risk_daily_loss", "we hit today's loss limit")],
  [/^risk: max open positions \((\d+)\)/, (m) => same("risk_open", `we already had ${m[1]} trades open, our max`)],
  [/^risk: max entries per day \((\d+)\)/, (m) => same("risk_per_day", `we already did ${m[1]} trades today, our max`)],
  [/^risk: leader has (\d+) of our last (\d+) entries/, () => same("risk_wallet_share", "we copied this trader a lot lately, so we spread it out")],
  [/^risk: position size/, () => same("risk_min_size", "we had too little money left for a trade")],
  [/^risk: free balance/, () => same("risk_reserve", "we keep some money aside for fees")],
  [/^risk: already in this token/, () => same("risk_holding", "we already own this coin")],
  [/^risk: data budget/, () => same("risk_data", "today's free data is almost gone, so no new trades until it resets")],
];

export function explainSkip(reason: string): Explained {
  for (const [re, f] of SKIP_RULES) {
    const m = reason.match(re);
    if (m) return f(m);
  }
  return same("other", "it failed one of our other checks");
}

export function explainExit(reason: string | null, _stopLossPct = 0.25, maxHoldMs = 30 * 60_000): string {
  switch (reason) {
    case "leader_exit":
      return "our trader sold, so we sold too";
    case "stop_loss":
      return "the price tanked, so our auto-sell to stop a big L kicked in";
    case "time_exit":
      return `we held it for ${duration(maxHoldMs)}, our max`;
    case "kill_switch":
      return "the emergency stop sold everything";
    default:
      return "one of our selling rules said so";
  }
}

export function explainMissed(reason: string | null, maxSlippage: number): string {
  const slip = reason?.match(/slippage (-?\d+)bps/);
  if (slip) return `the price ran before our buy landed. it went up ${plainPct(+slip[1]! / 10_000)}, and we only allow ${plainPct(maxSlippage)}`;
  if (reason === "no market data") return "we couldn't see a price right then";
  if (reason === "curve completed") return "the coin moved to a bigger market right then";
  if (reason === "size too small after fixed costs") return "the trade was too small to be worth the fees";
  if (reason === "kill switch") return "the emergency stop was on";
  return "the trade just didn't go through";
}

// ---------------------------------------------------------------------------------------------
// trades
// ---------------------------------------------------------------------------------------------

export function bought(c: Ctx, b: BuyFacts): string {
  const t = token(b.token);
  return render({
    title: `${modeTag(c)} TRADE OPENED · ${t}`,
    happened: `we copied a trade. bought ${t} for ${sol(c, b.sizeSol)} as ${tradeWords(c)}.`,
    mood: "normal",
    why: "this is just the bot doing its thing. you'll get another text when we sell.",
    todo: NOTHING,
    details: [
      b.walletRoi !== null && b.walletTrades
        ? `why: copying this trader has been bussin. over their last ${b.walletTrades} trades we'd have made ${plainPct(b.walletRoi)} on average.`
        : "why: this trader is one of the best we follow.",
      b.confirmations >= 2 && `${b.confirmations} of our traders bought it.`,
      b.devSoldFrac !== null && b.devSoldFrac < 0.01 && "vibe check: the creator hasn't sold.",
      b.top10Pct !== null && `vibe check: the 10 biggest owners have ${Math.round(b.top10Pct)}% of it. our limit is ${b.maxTop10Pct}%.`,
      b.tokenAgeS !== null && `the coin is ${duration(b.tokenAgeS * 1000)} old.`,
      Math.abs(b.slippage) >= 0.001 && (b.slippage > 0
        ? `the price ran before our buy landed. we paid ${plainPct(b.slippage)} more than our trader.`
        : `the price moved our way. we paid ${plainPct(b.slippage)} less than our trader.`),
      `we used ${plainPct(b.sizeSol / b.equity)} of our money on this one.`,
    ],
  });
}

export function sold(c: Ctx, s: SellFacts): string {
  const t = token(s.token);
  const roi = s.pnlSol / (s.costSol || 1);
  const big = s.pnlSol < 0 && size(s.pnlSol, s.start) !== "small" && size(s.pnlSol, s.start) !== "almost nothing";
  return render({
    title: `${modeTag(c)} TRADE CLOSED · ${t}`,
    happened: `we sold ${t}. ${s.pnlSol >= 0 ? "got back more than we paid, let's go." : "got back less than we paid."}`,
    mood: s.pnlSol >= 0 ? "good" : big ? "careful" : "normal",
    why: `${moneySentence(c, s.pnlSol, s.start)}${s.pnlSol < 0 && !big ? " Ls are part of the game." : ""}`,
    todo: NOTHING,
    details: [
      `why we sold: ${explainExit(s.reason, s.stopLossPct, s.maxHoldMs)}.`,
      s.reason === "stop_loss" && roi < -(s.stopLossPct + 0.05) && "the price kept dropping while we were selling, so the L is a bit bigger.",
      `we paid ${sol(c, s.costSol)} and got back ${sol(c, s.proceedsSol)}${dollars(c, s.proceedsSol)}, after fees. held it for ${duration(s.heldMs)}.`,
      per100(roi),
      `${moneyWords(c)} now: ${sol(c, s.equity)}. we started with ${s.start} SOL.`,
    ],
  });
}

export function missed(c: Ctx, m: MissedFacts): string {
  const t = token(m.token);
  return render({
    title: `${modeTag(c)} TRADE NOT DONE · ${t}`,
    happened: `we tried to copy a trade on ${t}, but our buy didn't go through.`,
    mood: "normal",
    why: "happens sometimes. nothing was bought.",
    todo: NOTHING,
    details: [`why: ${explainMissed(m.reason, m.maxSlippage)}.`, m.feeSol > 0 && `the try cost a tiny fee: ${sol(c, m.feeSol)}.`],
  });
}

export function skipped(c: Ctx, s: SkipFacts): string {
  const t = token(s.token);
  const e = explainSkip(s.reason);
  const scam = ["serial_dev", "leader_dev", "concentrated", "dev_holds", "dev_sold"].includes(e.key);
  return render({
    title: `SKIPPED CHANCE · ${t}`,
    happened: `one of our traders bought ${t}, but we didn't copy it.`,
    mood: scam ? "good" : "normal",
    why: scam ? `our safety check caught something sus: ${e.short}.` : "we skip most chances. that's how we keep the bag safe.",
    todo: NOTHING,
    details: [`why we skipped: ${e.long}.`, "no money was used."],
  });
}

export function activity(c: Ctx, a: ActivityFacts): string {
  const skippedAll = a.skippedTotal + a.blockedTotal;
  const other = a.skippedTotal - a.skipped.reduce((s, r) => s + r.n, 0);
  return render({
    title: "HOURLY SUMMARY",
    happened: `last hour our traders made ${plural(a.buys, "buy")}. we copied ${a.copied} and skipped ${skippedAll}.`,
    mood: "normal",
    why: "we skip most chances. that's how we keep the bag safe.",
    todo: NOTHING,
    details: [
      ...a.skipped.map((r) => `skipped ${times(r.n)}: ${r.text}.`),
      other > 0 && `skipped ${times(other)} for other reasons.`,
      ...a.blocked.map((b) => `skipped ${times(b.n)} by a safety limit: ${b.text}.`),
      a.copied > 0 && "you got a separate text for each trade we copied.",
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// parts of the bot
// ---------------------------------------------------------------------------------------------

export function partDown(c: Ctx, service: string, since: number, detail: string | null): string {
  const cause = crashCause(detail);
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} is down`,
    happened: `${partName(service)} stopped ${duration(c.now - since)} ago and didn't come back by itself.`,
    mood: "bad",
    why: PARTS[service]?.whileDown || "one part of the bot isn't working.",
    todo: cause?.includes("disk") ? onComputer("df -h", "shows if the disk is full") : RESTART,
    details: [cause && `probably cuz ${cause}.`, "you'll get a ✅ text when it's back."],
  });
}

export function partFrozen(c: Ctx, service: string, silentMs: number): string {
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} is not answering`,
    happened: `${partName(service)} is on, but it's been ghosting us for ${duration(silentMs)}.`,
    mood: "bad",
    why: PARTS[service]?.whileDown || "one part of the bot isn't working.",
    todo: RESTART,
    details: ["you'll get a ✅ text when it's back."],
  });
}

export function partSwitchedOff(c: Ctx, service: string, offMs: number): string {
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} is switched off`,
    happened: `${partName(service)} was switched off on purpose ${duration(offMs)} ago.`,
    mood: "careful",
    why: PARTS[service]?.whileDown || "one part of the bot isn't working.",
    todo: `if that wasn't you: ${RESTART}`,
  });
}

export function partBack(c: Ctx, service: string, downMs: number): string {
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} is working again`,
    happened: `${partName(service)} is back. it was down for ${duration(downMs)}.`,
    mood: "good",
    why: "problem solved, we're so back.",
    todo: NOTHING,
  });
}

export function restarted(c: Ctx, service: string, n: number, lastCause: "crash" | "killed", lastDetail: string | null): string {
  const cause = crashCause(lastDetail) ?? (lastCause === "killed" ? "the computer stopped it out of nowhere, maybe low on memory" : "it hit an unexpected problem");
  const loop = n >= KEEPS_RESTARTING;
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} restarted by itself`,
    happened: loop
      ? `${partName(service)} crashed and came back ${n} times in the last hour.`
      : `${partName(service)} crashed out of nowhere and came back by itself a few seconds later.`,
    mood: loop ? "careful" : "normal",
    why: loop ? "it works now, but something keeps taking it down." : "it happens. it's working again.",
    todo: loop ? onComputer(`make logs S=${service}`, "shows why it keeps stopping") : NOTHING,
    details: [`probably cuz ${cause}.`, !loop && n > 1 && `happened ${times(n)} in the last hour.`],
  });
}

export function manyErrors(c: Ctx, service: string, n: number): string {
  return render({
    title: `BOT HEALTH · ${cap(partName(service))} has many errors`,
    happened: `${partName(service)} threw ${n} errors in the last hour.`,
    mood: "careful",
    why: "it still works, but something might be off.",
    todo: onComputer(`make logs S=${service}`, "shows the errors"),
    details: ["usual reason: our data provider went quiet for a bit."],
  });
}

export function jobFailed(c: Ctx, job: string): string {
  const what: Record<string, { name: string; effect: string; step: string }> = {
    score: { name: "the nightly trader check", effect: "we keep copying yesterday's list of traders.", step: onComputer("make score", "runs the check again") },
    weekly: { name: "the weekly report", effect: "trading is fine. only the report is missing.", step: onComputer("make weekly", "makes the report again") },
    intel: { name: "the nightly MadeOnSol helper job", effect: "trading is fine. we just keep yesterday's creator records.", step: onComputer("make logs S=intel", "shows what went wrong") },
    brain: { name: "the learning brain", effect: "trading is fine. the bot keeps using what the brain learned last, it just stops learning.", step: onComputer("make restart", "starts it again") },
    logrotate: { name: "the log cleaner", effect: "old log files didn't get cleaned. if it keeps happening the disk slowly fills up.", step: onComputer("df -h", "shows how full the disk is") },
  };
  const w = what[job] ?? { name: "a planned job", effect: "trading isn't directly affected.", step: onComputer("make status", "shows what's running") };
  return render({ title: "BOT HEALTH · A planned job failed", happened: `${w.name} didn't finish.`, mood: "careful", why: w.effect, todo: w.step });
}

// ---------------------------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------------------------

export function dataCapReached(c: Ctx, capMb: number, openTrades = 0): string {
  return render({
    title: "DATA · Today's free data is used up",
    happened: "we burned through all of today's free market data.",
    mood: "careful",
    why: `until ${midnight(c)} the bot can't watch our traders, so no trading.`,
    extra: [openTrades > 0 && `it still watches our ${plural(openTrades, "open trade")} until ${openTrades === 1 ? "it's" : "they're"} sold.`],
    todo: `nothing, it comes back by itself at ${midnight(c)}.`,
    details: [`we get ${capMb} MB of free data per day.`, "if this keeps happening, a paid data plan would fix it."],
  });
}

export function dataBudget(c: Ctx, d: { pct: number; mbToday: number; capMb: number; mbPerHour: number; capAt: number | null }): string {
  const steps: Record<number, [string, string]> = {
    70: ["bot stopped scouting new traders to make it last.", "copying the ones we follow still hits tho."],
    85: ["bot is only watching our traders and our open trades now, to make it last.", "copying still works."],
    95: [`no new trades until ${midnight(c)}, to make it last.`, "open trades are still watched until they're sold."],
  };
  const [did, effect] = steps[d.pct] ?? steps[95]!;
  const speed = d.mbPerHour > 0
    ? `we're using ~${d.mbPerHour} MB an hour, ${d.capAt ? `at this rate we're cooked by ${clock(c, d.capAt)}.` : `at this rate it lasts till ${midnight(c)}.`}`
    : null;
  return render({
    title: `DATA · ${d.pct}% of today's free data gone 💀`,
    happened: `we burned ${d.mbToday} of our ${d.capMb} MB of free market data today.`,
    mood: "careful",
    why: did,
    extra: [effect, speed],
    todo: `nothing, it resets by itself at ${midnight(c)} fr.`,
    details: [
      "if you get this most days, the free data is too small for this bot. a paid data plan is $49 a month and gives about 10x more.",
      "the free data counts per day and resets at midnight UTC.",
    ],
  });
}

export function settingChanged(c: Ctx, d: SettingChange): string {
  if (d.setting !== "helius_daily_mb_cap" && d.setting !== "madeonsol_stop_pct") return limitChanged(c, d);
  const data = d.setting === "helius_daily_mb_cap";
  const what = data ? "the daily market-data limit" : "where the daily MadeOnSol job stops";
  const value = (x: number) => (data ? `${Math.round(x)} MB` : `${Math.round(x)}% of its ${d.limit ?? 200} requests`);
  return render({
    title: "SETTINGS · A daily limit was changed",
    happened: d.reset ? `you set ${what} back to normal: ${value(d.to)}.` : `you changed ${what} from ${value(d.from)} to ${value(d.to)} on the dashboard.`,
    mood: "normal",
    why: data ? "more data = the bot can follow the market longer each day." : "the helper can ask MadeOnSol more often each day now.",
    extra: [data && d.guardMb !== null && `it still can't burn the month's free data: today it maxes out at ${Math.round(d.guardMb)} MB.`],
    todo: d.reset ? NOTHING : "nothing. wanna undo it? change it back on the dashboard.",
  });
}

function limitChanged(c: Ctx, d: SettingChange): string {
  const what = d.label ?? d.setting;
  const from = d.fromText ?? String(d.from), to = d.toText ?? String(d.to);
  return render({
    title: "SETTINGS · A limit was changed",
    happened: d.reset ? `you put "${what}" back to normal: ${to}.` : `you changed "${what}" from ${from} to ${to} on the dashboard.`,
    mood: d.group === "safety" ? "careful" : "normal",
    why: d.group === "safety" ? "practice trades use it from now on. real money will too later, but never past the safety walls in the code."
      : d.group === "wallets" ? "the nightly trader check (00:15 UTC) uses it from tonight."
      : "the bot picks it up in a few secs.",
    todo: d.reset ? NOTHING : "nothing. wanna undo it? hit \"back to normal\" on the dashboard's Limits tab.",
  });
}

export function helperBudget(c: Ctx, d: { pct: number; used: number; limit: number }): string {
  const why = d.pct >= 100 ? "no MadeOnSol requests left for today."
    : d.pct >= 90 ? "the daily helper job stopped for today, so the last requests stay free for you."
    : "still fine, the daily helper job is almost done.";
  return render({
    title: `DATA HELPER · ${d.pct >= 100 ? "MadeOnSol requests used up" : `${d.pct}% of today's MadeOnSol requests used`}`,
    happened: `we used ${d.used} of the ${d.limit} free MadeOnSol requests today.`,
    mood: d.pct >= 90 ? "careful" : "normal",
    why,
    extra: ["trading doesn't care: the bot never waits for MadeOnSol."],
    todo: d.pct >= 90 ? `nothing, the requests reset by themselves at ${midnight(c)}.` : NOTHING,
    details: ["MadeOnSol tells us how coin creators did before and lists good traders.", `the free plan has ${d.limit} requests a day.`],
  });
}

const madeOrLost = (x: number) => `${x >= 0 ? "made" : "lost"} ${plainPct(x)}`;

const LESSON_GZ: Record<string, string> = {
  two_traders: "2+ of our traders aped in", dev_sold: "the creator already dipped (sold half+)", very_new: "the coin was under a minute old",
  older: "the coin was 10+ minutes old", big_buy: "our trader went big, 0.5+ SOL", small_buy: "our trader bought tiny, under 0.1 SOL",
  concentrated: "the 10 biggest owners had 40%+", serial_creator: "the creator spammed 5+ coins that day", thin: "under 5 SOL was in the coin",
  deep: "30+ SOL was in the coin", good_trader: "the trader had a good grade", launch_unseen: "we missed the coin's launch",
  bad_creator: "the creator's coins basically never took off",
};

export function brainMemory(_c: Ctx, f: BrainMemoryFacts): string {
  if (!f.nights) {
    return render({ title: "LEARNING BRAIN · What it remembers", happened: "the learning brain hasn't studied yet.", mood: "normal",
      why: "it hits the books as soon as the first trades have a result.", todo: NOTHING });
  }
  const needs = f.missing.map((x) => ({
    enough_signals: `${x.need} chances studied (has ${x.have})`,
    enough_test_trades: `${x.need} trades in its test (has ${x.have})`,
    beats_rules: "to beat our normal rules in its test",
    own_skips_right: "its skips to actually flop",
  } as Record<string, string>)[x.key]).filter(Boolean).join(" and ");
  const pts = (d: number | null) => `${(Math.abs(d ?? 0) * 100).toFixed(1)} pts`;
  const line = (m: BrainMemoryFacts["memory"][number]) => {
    const w = LESSON_GZ[m.key] ?? m.words;
    const better = m.direction > 0 ? "W" : "L";
    if (m.status === "confirmed") return `📌 locked in, ${m.nightsSame} days straight: when ${w}, copying = ${better} (${pts(m.diff)}).`;
    if (m.status === "changed_mind") return `🔄 changed its mind: when ${w}, copying is now a ${better} (${pts(m.diff)}).`;
    if (m.status === "fading") return `🌫️ not sure anymore: when ${w}, it barely matters now.`;
    return `🆕 new: when ${w}, copying = ${better} (${pts(m.diff)}).`;
  };
  const o = f.ownSkips;
  return render({
    title: "LEARNING BRAIN · What it remembers",
    happened: `it studied ${f.studied} chances to copy over ${f.nights} day${f.nights === 1 ? "" : "s"} and remembers ${f.remembered} lesson${f.remembered === 1 ? "" : "s"}. it never deletes anything 🔒`,
    mood: "normal",
    why: f.active ? "it passed its test, so it skips trades it thinks will flop." : `it's just studying for now.${needs ? ` before it can skip trades it needs ${needs}.` : ""}`,
    todo: NOTHING,
    details: [
      ...(f.memory.length ? f.memory.map(line) : ["no lessons yet: it needs more trades to compare."]),
      o && o.n > 0 && `its own skips: ${o.n} so far, ${o.losers} would've flopped${o.avg !== null ? `, ${madeOrLost(o.avg)} on average` : ""}.`,
    ],
  });
}

export function brainChanged(_c: Ctx, b: BrainFacts): string {
  const result = b.takenAvg !== null && b.keptAvg !== null
    ? `in its test, our rules took ${b.testTrades} trades, which ${madeOrLost(b.takenAvg)} on average. it would've skipped ${b.skipped ?? 0}, and the rest ${madeOrLost(b.keptAvg)} on average.`
    : "";
  const off = "to switch it off yourself: set use_brain to false in config/config.yaml and restart the bot.";
  if (b.active && !b.allowed) {
    return render({
      title: "LEARNING BRAIN · Passed its test, but switched off",
      happened: "the learning brain passed its test, but it's switched off in the settings, so it just keeps studying.",
      mood: "normal",
      why: result || "it got better at telling Ws from Ls.",
      todo: "nothing. wanna let it skip trades it thinks will flop? set use_brain to true in config/config.yaml and restart the bot.",
      details: [`it studied ${b.studied} chances to copy.`],
    });
  }
  if (b.active) {
    return render({
      title: "LEARNING BRAIN · It now skips trades it expects to lose",
      happened: "the learning brain passed its test 🧠 from now on it skips a chance to copy when it thinks that trade will flop.",
      mood: "good",
      why: result || "it got better at telling Ws from Ls.",
      extra: ["it can only skip trades. it never buys more, never goes bigger and never touches the safety limits."],
      todo: NOTHING,
      details: [`it studied ${b.studied} chances to copy. it retakes the test after every trade.`,
        "if it starts flopping, it goes back to just studying by itself.", off],
    });
  }
  return render({
    title: "LEARNING BRAIN · Back to only studying",
    happened: "the learning brain didn't pass its latest test, so it stopped skipping trades.",
    mood: "normal",
    why: "our normal rules run the show again. it keeps studying after every trade and starts skipping again once it passes.",
    todo: NOTHING,
    details: [`it studied ${b.studied} chances to copy.`, result],
  });
}

export function dataStopped(c: Ctx, silentMs: number, what: "launches" | "trades"): string {
  return render({
    title: "DATA · Market data stopped coming",
    happened: `no new ${what === "launches" ? "coins" : "trades"} came in for ${duration(silentMs)}.`,
    mood: "bad",
    why: "no data = the bot is blind and can't trade.",
    todo: `wait 10 minutes. no ✅ text by then? ${RESTART}`,
    details: ["the data collector is running, but the market info isn't reaching it.", "usually the internet or our data provider is the problem."],
  });
}

export function dataBack(c: Ctx, silentMs: number): string {
  return render({
    title: "DATA · Market data is coming again",
    happened: `market data is back. it was gone for ${duration(silentMs)}.`,
    mood: "good",
    why: "the bot can see the market again, we're so back.",
    todo: NOTHING,
  });
}

// ---------------------------------------------------------------------------------------------
// safety
// ---------------------------------------------------------------------------------------------

export function killSwitch(c: Ctx, reason: string | null, equity: number, start: number): string {
  if (reason?.startsWith("max drawdown")) {
    return render({
      title: "EMERGENCY STOP · Trading stopped",
      happened: `our money dropped ${plainPct((start - equity) / start)} below where we started, so the bot stopped all trading.`,
      mood: "bad",
      why: "that's our safety rule. the bot sold everything and buys nothing new.",
      todo: onComputer("make unkill", "turns trading back on; only do it when you're ready"),
      details: [`${moneyWords(c)} now: ${sol(c, equity)}. we started with ${start} SOL.`],
    });
  }
  return render({
    title: "EMERGENCY STOP · Trading stopped",
    happened: "someone hit the emergency stop on the bot's computer.",
    mood: "careful",
    why: "the bot sold everything and buys nothing new.",
    todo: onComputer("make unkill", "turns trading back on"),
  });
}

export function dailyLossCap(c: Ctx, equity: number, dayStart: number): string {
  return render({
    title: "SAFETY LIMIT · Trading paused for today",
    happened: `we lost ${plainPct((dayStart - equity) / dayStart)} of our money today. that's our daily loss limit.`,
    mood: "careful",
    why: `the bot buys nothing new until ${midnight(c)}. open trades still sell normally.`,
    todo: `nothing, trading comes back by itself at ${midnight(c)}.`,
  });
}

export function startupBlocked(c: Ctx, why: string): string {
  if (why === "helius_key_missing") {
    return render({
      title: "BOT HEALTH · The trading part cannot start",
      happened: "the trading brain needs a key (a password) for our data provider, and it's missing.",
      mood: "bad",
      why: "without it the bot can't check coins, so it can't trade.",
      todo: "add HELIUS_API_KEY to the .env settings file, then on the bot's computer type: make restart.",
    });
  }
  if (why === "live_not_ready") {
    return render({
      title: "BOT HEALTH · The trading part cannot start",
      happened: "the settings say LIVE (real money), but real-money trading isn't built yet.",
      mood: "bad",
      why: "the bot refuses to start, so no real money gets used by accident.",
      todo: "remove the line LIVE_TRADING=true from the .env settings file, then type: make restart.",
    });
  }
  return render({
    title: "BOT HEALTH · The trading part cannot start",
    happened: "a setting the trading brain needs is missing or wrong.",
    mood: "bad",
    why: "the bot can't trade until this is fixed.",
    todo: onComputer("make logs S=trader", "shows which setting"),
  });
}

// ---------------------------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------------------------

export function guide(c: Ctx, dailyAt: string): string {
  return render({
    title: "HOW TO READ MY MESSAGES",
    happened: "hey, i'm your trading bot. i'll tell you what i'm doing, no cap.",
    mood: "normal",
    why: "every text says: what happened, if it's good or bad, and what you should do.",
    extra: ["only 🚨 texts need you. everything else is just fyi."],
    todo: NOTHING,
    details: [
      "✅ W, good news.",
      "⚠️ lowkey sus. read it, but usually you don't have to do anything.",
      "🚨 not good fr. something's broken. do what \"your move\" says.",
      "😐 mid. just info.",
      "[PAPER] means practice (no real money). that's how the bot runs rn.",
      "[LIVE] means real money. it's off. only you can turn it on.",
      `you get: a text for every trade, a summary every hour, a daily report at ${dailyAt}, and a weekly report.`,
      "reply to any text with /explain and i'll break it down more simply.",
      "send /words to see what my words mean. send /help for all commands.",
    ],
  });
}

export function hello(c: Ctx, _dailyAt: string): string {
  return render({
    title: "BOT STARTED",
    happened: `the message bot just started. we're running in ${c.mode === "live" ? "LIVE mode (real money)" : "PAPER mode (practice, no real money)"}.`,
    mood: "normal",
    why: "this happens after an update or a restart.",
    todo: NOTHING,
    details: ["send /help to see what i can do."],
  });
}

export function help(): string {
  return render({
    title: "COMMANDS",
    happened: "here's what you can send me.",
    mood: "normal",
    why: "just info.",
    todo: NOTHING,
    details: [
      "/status: is every part of the bot working?",
      "/pnl: our Ws and Ls today, this week and in total.",
      "/explain: reply to one of my texts with this and i'll explain it simpler.",
      "/words: what my words mean.",
      "/why MOON: what the bot did with a coin, and why.",
      "/brain: what the learning brain figured out and remembers.",
      "/quiet: no texts for 8 hours, except 🚨 ones. /quiet off ends it.",
      "/stop: emergency stop. sells everything and stops trading. i'll ask you first.",
    ],
  });
}

export function words(): string {
  return render({
    title: "WORDS I USE",
    happened: "here's my vocab and what it means.",
    mood: "normal",
    why: "just info.",
    todo: NOTHING,
    details: WORDS.map(([w, m]) => `${w}: ${m}`),
    noExplain: true,
  });
}

export function explainHowTo(): string {
  return render({
    title: "EXPLAIN",
    happened: "you sent /explain, but not as a reply to one of my texts.",
    mood: "normal",
    why: "i need to know which text you mean.",
    todo: "press and hold one of my texts, tap Reply, and send /explain.",
  });
}

interface Explainer {
  match: RegExp;
  simple: (title: string) => string;
  example: string;
}

const EXPLAINERS: Explainer[] = [
  { match: /LEARNING BRAIN/, simple: () => "after every trade the learning brain studies again every trade we could've copied and what it would've made. it can only skip trades, and only after passing a test.",
    example: "like a friend who has to pass a quiz before they're allowed to give you advice, and retakes it after every lesson." },
  { match: /TRADE OPENED/, simple: () => "we saw a good trader buy a coin, so we bought the same coin.", example: "copying the friend who's cracked at the game: they move, we move." },
  { match: /TRADE CLOSED/, simple: () => "we sold a coin we had. the text says if it was a W or an L.", example: "buy a skin for 10, sell it for 12: +2 W. sell it for 8: −2 L." },
  { match: /TRADE NOT DONE/, simple: () => "we wanted to buy a coin, but the buy didn't work, so we bought nothing.", example: "you go to cop the drop, but the price went up while you were in line, so you skip." },
  { match: /SKIPPED CHANCE/, simple: () => "one of our traders bought a coin and we chose not to copy it, to stay safe.", example: "your friend jumps in the pool, you see there's no water. you don't jump." },
  { match: /HOURLY SUMMARY/, simple: () => "every hour i count what our traders did and what we copied.", example: "50 buys, we copied 2: only the ones that pass every safety check." },
  { match: /DAILY REPORT/, simple: () => "the results of one whole day: how many trades, and our Ws and Ls.", example: "like a report card for one day." },
  { match: /WEEKLY REPORT/, simple: () => "the last 7 days, and whether the bot is actually working yet.", example: "like a report card for the whole week." },
  { match: /restarted by itself/, simple: () => "a part of the bot crashed for a sec and turned itself back on.", example: "like your phone restarting itself. works fine after." },
  { match: /cannot start/, simple: () => "a part of the bot won't turn on cuz a setting is missing or wrong.", example: "like a car that won't start cuz the key is missing." },
  { match: /is down|is not answering|is switched off/, simple: () => "a part of the bot isn't working rn.", example: "like a game server that went down. it needs a restart." },
  { match: /is working again/, simple: () => "a part of the bot was broken and now it's back.", example: "like the wifi coming back after an outage." },
  { match: /has many errors|planned job failed/, simple: () => "something in the bot didn't go great, but the bot still runs.", example: "like a low battery warning: still works, but check it." },
  { match: /^SETTINGS/, simple: () => "someone changed one of the bot's daily limits on the dashboard. the text says which and how to undo it.", example: "like turning the volume up: louder now, turn it back down whenever." },
  { match: /DATA HELPER/, simple: () => "MadeOnSol is an extra helper that tells us how a coin's creator did before. we get a few free asks a day.", example: "like a free library card: a few books a day, then you come back tomorrow." },
  { match: /DATA ·/, simple: () => "this is about the market info the bot reads to trade.", example: "like a weather app with no internet: it can't show the weather." },
  { match: /EMERGENCY STOP/, simple: () => "all trading is stopped. the bot sold everything and buys nothing new.", example: "like hitting the big red button." },
  { match: /SAFETY LIMIT/, simple: () => "we lost too much today, so the bot takes a break till tomorrow.", example: "like a rule: lose 5 games today, you're done till tomorrow." },
  { match: /^STATUS/, simple: () => "a check of every part of the bot: working or not?", example: "like checking all the lights in the house are on." },
  { match: /PROFIT OR LOSS/, simple: () => "how much we made or lost: today, this week, and since the start.", example: "started with 1 SOL, now 1.01 SOL: +0.01 SOL W." },
  { match: /HOW TO READ/, simple: () => "this is the guide for my texts. every text has the same 3 parts.", example: "\"the tea\" is the news. the emoji says W or L. \"your move\" is your job, usually nothing." },
  { match: /COMMANDS|WORDS I USE/, simple: () => "a list to help you use the bot.", example: "send /status to check the bot works." },
  { match: /BOT STARTED/, simple: () => "the bot just turned on again.", example: "like your phone after a restart. works normal after." },
  { match: /QUIET MODE/, simple: () => "quiet mode means fewer texts for a while. only 🚨 ones still come through.", example: "like do not disturb, but alarms still ring." },
  { match: /^WHY/, simple: () => "what the bot did with one coin, and why.", example: "like asking: bro why did you buy that?" },
  { match: /SORRY|^EXPLAIN$/, simple: () => "i couldn't do what you asked. the text says what to try.", example: "like a shop that's closed: come back later." },
];

export function explain(original: string): string {
  const title = original.split("\n")[0] ?? "";
  const ex = EXPLAINERS.find((e) => e.match.test(title));
  const lower = original.toLowerCase();
  const used = WORDS.filter(([w]) => lower.includes(w.toLowerCase().split(" (")[0]!));
  return render({
    title: `EXPLAINED · ${title.replace(/^\[(PAPER|LIVE)\] /, "").slice(0, 40)}`,
    happened: ex ? ex.simple(title) : "this is one of my texts about the bot.",
    mood: "normal",
    why: original.includes("🚨") ? "this one needs you. do what \"your move\" says." : "this one doesn't need you.",
    todo: NOTHING,
    details: [ex && `it's like: ${ex.example}`, used.length > 0 && "words in that text:", ...used.map(([w, m]) => `  - ${w}: ${m}`)],
    noExplain: true,
  });
}

export function commandFailed(): string {
  return render({ title: "SORRY", happened: "something broke when i tried to answer.", mood: "careful", why: "the bot itself is probably fine.", todo: "send the command again in a minute." });
}

export function unknownCommand(): string {
  return render({ title: "SORRY", happened: "i don't know that command.", mood: "normal", why: "nothing's wrong.", todo: "send /help to see the ones i know." });
}

const killWho = (reason: string | null) =>
  reason?.startsWith("telegram") ? "you used /stop" : reason?.startsWith("max drawdown") ? "our money dropped too far" : "someone hit the emergency stop on the bot's computer";

export function status(c: Ctx, s: StatusFacts): string {
  const rows: { ok: boolean; text: string; urgent?: boolean; step?: string }[] = [];
  for (const p of s.parts) {
    const ok = p.health === "up" || p.health === "starting";
    const state = p.health === "up" ? "working" : p.health === "starting" ? "starting" : p.health === "frozen" ? "ghosting us"
      : p.health === "off" ? "switched off" : p.health === "down" ? "down" : "no news yet";
    rows.push({ ok, text: `${cap(partName(p.service).replace(/^the /, ""))}: ${state}`, urgent: !ok && p.service !== "dashboard", step: ok ? undefined : RESTART });
  }
  if (s.streams) {
    const w = s.streams;
    rows.push(w.watching === "on" ? { ok: true, text: "watching our traders: yes" }
      : w.watching === "capped" ? { ok: false, text: `watching our traders: no, today's free data is gone until ${midnight(c)}` }
      : w.watching === "reconnecting" ? { ok: false, text: "watching our traders: reconnecting", step: "wait 10 minutes and send /status again." }
      : { ok: false, text: "watching our traders: switched off in the settings" });
    rows.push({ ok: w.mbToday < w.capMb, text: `free data used today: ${Math.round((w.mbToday / w.capMb) * 100)}%` });
  }
  if (s.tracked === 0) rows.push({ ok: false, text: "our traders: none yet (the bot needs a few days of data)" });
  rows.push(s.killed ? { ok: false, text: `trading: stopped, cuz ${killWho(s.killed.reason)}`, step: onComputer("make unkill", "turns trading back on") }
    : s.halted ? { ok: false, text: `trading: paused until ${midnight(c)} (daily loss limit)` }
    : { ok: true, text: `trading: on, ${c.mode === "live" ? "LIVE (real money)" : "PAPER (practice, no real money)"}` });
  const bad = rows.filter((r) => !r.ok);
  const urgent = bad.some((r) => r.urgent);
  return render({
    title: "STATUS",
    happened: bad.length === 0 ? "i vibe checked every part of the bot. all good." : `i vibe checked every part of the bot. ${plural(bad.length, "thing needs", "things need")} attention.`,
    mood: bad.length === 0 ? "good" : urgent ? "bad" : "careful",
    why: bad.length === 0 ? "the bot is running normal, we're chillin." : bad.length === 1 ? `${bad[0]!.text}.` : `${plural(bad.length, "thing isn't", "things aren't")} right. check the ❌ lines below.`,
    todo: bad.find((r) => r.step)?.step ?? (bad.length ? "nothing rn. it should fix itself. send /status again later." : NOTHING),
    details: [
      ...rows.map((r) => `${r.ok ? "✅" : "❌"} ${r.text}`),
      s.tracked && `we copy ${plural(s.tracked, "trader")}. ${plural(s.open, "trade is", "trades are")} open rn.`,
      s.lastTradeAt && `last market data: ${duration(c.now - s.lastTradeAt)} ago.`,
      s.quietUntil && `quiet mode is on until ${clock(c, s.quietUntil)}.`,
    ],
  });
}

const periodLine = (c: Ctx, label: string, r: PeriodResult, start: number) =>
  r.closed === 0 ? `${label}: no trades.` : `${label}: ${plural(r.closed, "trade")}, ${r.wins} Ws. ${gainWords(c, r.pnl, start)}.`;

export function pnl(c: Ctx, p: PnlFacts): string {
  const total = p.equity - p.start;
  return render({
    title: "PROFIT OR LOSS",
    happened: `${moneyWords(c)} went from ${p.start} SOL at the start to ${sol(c, p.equity)} now.`,
    mood: Math.abs(total) < 0.0005 ? "normal" : total > 0 ? "good" : size(total, p.start) === "small" ? "normal" : "careful",
    why: `in total: ${moneySentence(c, total, p.start)}`,
    todo: NOTHING,
    details: [
      periodLine(c, "today", p.today, p.start),
      periodLine(c, "last 7 days", p.week, p.start),
      periodLine(c, "since the start", p.all, p.start),
      `${plural(p.open, "trade is", "trades are")} open rn.`,
      c.mode === "paper" && "these are practice trades (no real money).",
    ],
  });
}

export function stopConfirm(_c: Ctx, open: number): string {
  return render({
    title: "EMERGENCY STOP · Are you sure?",
    happened: "you asked me to stop all trading.",
    mood: "careful",
    why: open ? `the bot will sell the ${plural(open, "trade")} it has open and buy nothing new.` : "the bot will buy nothing new.",
    extra: ["only you can turn trading back on, on the bot's computer."],
    todo: `tap "Yes, stop trading" to stop, or "No, cancel".`,
  });
}

export function stopDone(_c: Ctx, open: number): string {
  return render({
    title: "EMERGENCY STOP · Trading stopped",
    happened: open ? `trading is stopped. the bot is selling the ${plural(open, "trade")} it had open.` : "trading is stopped. nothing was open.",
    mood: "careful",
    why: "the bot won't trade until you turn it back on.",
    todo: `nothing rn. when you wanna trade again: ${onComputer("make unkill", "turns trading back on")}`,
  });
}

export function stopCancelled(): string {
  return render({ title: "EMERGENCY STOP · Cancelled", happened: "you cancelled the emergency stop.", mood: "good", why: "trading keeps going like before.", todo: NOTHING });
}

export function stopExpired(): string {
  return render({ title: "EMERGENCY STOP · Too late", happened: "that button is too old to use.", mood: "normal", why: "nothing changed.", todo: "send /stop again if you still wanna stop trading." });
}

export function alreadyHalted(c: Ctx, reason: string | null, _at: number | null): string {
  return render({
    title: "EMERGENCY STOP · Already stopped",
    happened: `trading is already stopped, cuz ${killWho(reason)}.`,
    mood: "careful",
    why: "the bot isn't trading.",
    todo: onComputer("make unkill", "turns trading back on"),
  });
}

export function quietOn(c: Ctx, until: number): string {
  return render({
    title: "QUIET MODE · On",
    happened: `going quiet until ${clock(c, until)}.`,
    mood: "normal",
    why: "you'll still get 🚨 texts. reports wait till quiet mode ends.",
    todo: "nothing. send /quiet off to end it early.",
  });
}

export function quietOver(c: Ctx, closed: number, pnlSol: number, missedOther: number): string {
  return render({
    title: "QUIET MODE · Over",
    happened: closed ? `quiet mode is over. ${plural(closed, "trade")} closed while i was quiet.` : "quiet mode is over. no trades closed while i was quiet.",
    mood: "normal",
    why: closed ? `all together: ${moneySentence(c, pnlSol, 1)}` : "nothing big happened.",
    todo: NOTHING,
    details: [missedOther > 0 && `i held back ${plural(missedOther, "text")}. send /pnl to see the results.`],
  });
}

export function quietWasOff(): string {
  return render({ title: "QUIET MODE · Was not on", happened: "quiet mode wasn't on.", mood: "normal", why: "you get all texts.", todo: NOTHING });
}

export function whyNoArg(): string {
  return render({ title: "WHY", happened: "you didn't say which coin.", mood: "normal", why: "nothing's wrong.", todo: "send /why and the coin's name, like: /why MOON." });
}

export function whyNotFound(query: string): string {
  return render({
    title: "WHY",
    happened: `i don't know a coin called "${query.slice(0, 20)}".`,
    mood: "normal",
    why: "i only know coins our traders bought.",
    todo: "check the spelling and send it again.",
  });
}

export function whyNothing(t: TokenRef): string {
  return render({ title: `WHY · ${token(t)}`, happened: `the bot never looked at ${token(t)}.`, mood: "normal", why: "none of our traders bought it.", todo: NOTHING });
}

export function why(c: Ctx, t: TokenRef, events: WhyEvent[], total: number, _sameName: number, limits: { stopLossPct: number; maxHoldMs: number; maxSlippage: number }): string {
  const copied = events.filter((e) => e.decision === "enter").length;
  return render({
    title: `WHY · ${token(t)}`,
    happened: `our traders bought ${token(t)} ${plural(total, "time")}. we copied ${copied}.`,
    mood: "normal",
    why: "here's what we did each time.",
    todo: NOTHING,
    details: events.map((e) => {
      const when = `${duration(c.now - e.at)} ago`;
      if (e.decision === "reject") return `${when}: skipped, cuz ${explainSkip(e.reasons[0] ?? "").long}.`;
      if (e.decision === "risk_block") return `${when}: skipped by a safety limit: ${explainSkip(e.reasons.find((x) => x.startsWith("risk:")) ?? "").long}.`;
      const p = e.position;
      if (!p || p.status === "pending") return `${when}: copied. the buy was still going through.`;
      if (p.status === "open") return `${when}: copied. we still own it.`;
      if (p.status === "failed") return `${when}: tried to copy, but ${explainMissed(p.exitReason, limits.maxSlippage)}.`;
      return `${when}: copied. sold cuz ${explainExit(p.exitReason, limits.stopLossPct, limits.maxHoldMs)}. ${moneySentence(c, p.pnlSol ?? 0, 1)}`;
    }),
  });
}

// ---------------------------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------------------------

export function verdict(v: Verdict): string {
  if (v.closedAllTime < TRADES_TO_JUDGE) return `too early to tell. we've got ${plural(v.closedAllTime, "trade")}, need at least ${TRADES_TO_JUDGE} to know.`;
  if (v.pnlAllTime > 0 && v.pnlLast7d >= 0) return `looking good so far after ${v.closedAllTime} trades. keep watching before real money tho.`;
  if (v.pnlAllTime > 0) return "mixed. up in total, but down the last 7 days. keep watching.";
  return `not yet. after ${v.closedAllTime} trades we're down. not ready for real money.`;
}

const exitLabel = (r: string) =>
  ({ leader_exit: "our trader sold", stop_loss: "auto-sell to stop a big L", time_exit: "held for our max time", kill_switch: "emergency stop" })[r] ?? "other";

function reportDetails(c: Ctx, r: ReportFacts): Line[] {
  const p = r.period;
  return [
    p.best && p.worst && p.closed > 1 && `best trade: ${token(p.best)}, ${gainWords(c, p.best.pnl, r.start)}. worst: ${token(p.worst)}, ${gainWords(c, p.worst.pnl, r.start)}.`,
    r.exits.length > 0 && `why we sold: ${r.exits.map((e) => `${exitLabel(e.text)} (${times(e.n)})`).join(", ")}.`,
    p.avgSlippage !== null && Math.abs(p.avgSlippage) >= 0.001 && `on average the price ran ${plainPct(p.avgSlippage)} before our buys landed.`,
    p.missed > 0 && `${plural(p.missed, "buy")} didn't go through.`,
    r.buys > 0 ? `our traders made ${plural(r.buys, "buy")}. we copied ${r.copied} and skipped ${r.skippedTotal + r.blockedTotal}.` : "our traders didn't buy anything.",
    ...r.skipped.map((s: Counted) => `  - skipped ${times(s.n)}: ${s.text}.`),
    r.wallets && `we copy ${plural(r.wallets.tracked, "trader")}${r.wallets.added || r.wallets.removed ? ` (${r.wallets.added} new, ${r.wallets.removed} removed)` : ""}.`,
    r.data && `free data used: ${Math.round((r.data.mb / r.data.capMb) * 100)}% of the daily amount.`,
    ...r.trouble.map((t) => `${partName(t.service)} restarted ${times(t.restarts)} and threw ${plural(t.errors, "error")}.`),
    r.trouble.length === 0 && "no part of the bot had problems, clean run.",
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
    happened: p.closed ? `that day we did ${plural(p.closed, "practice trade")} (no real money). ${p.wins} Ws, ${p.closed - p.wins} Ls.` : "that day we did zero trades.",
    mood: reportMood(r),
    why: p.closed ? `${moneySentence(c, p.pnl, r.start)}${p.pnl < 0 && reportMood(r) === "normal" ? " small Ls are normal." : ""}` : "nothing to judge.",
    extra: [`is the bot working yet? ${verdict(r.verdict)}`],
    todo: r.killed ? onComputer("make unkill", "trading is stopped; this turns it back on") : NOTHING,
    details: [`${moneyWords(c)} now: ${sol(c, r.equity)}. we started with ${r.start} SOL.`, ...reportDetails(c, r)],
  });
}

export function weeklyReport(c: Ctx, r: ReportFacts, attached: boolean): string {
  const p = r.period;
  return render({
    title: `WEEKLY REPORT · ${shortDay(c, r.from)} to ${shortDay(c, r.to)}`,
    happened: p.closed ? `this week we did ${plural(p.closed, "practice trade")} (no real money). ${p.wins} Ws, ${p.closed - p.wins} Ls.` : "this week we did zero trades.",
    mood: reportMood(r),
    why: p.closed ? moneySentence(c, p.pnl, r.start) : "nothing to judge.",
    extra: [`is the bot working yet? ${verdict(r.verdict)}`],
    todo: r.killed ? onComputer("make unkill", "trading is stopped; this turns it back on") : NOTHING,
    details: [`${moneyWords(c)} now: ${sol(c, r.equity)}. we started with ${r.start} SOL.`, ...reportDetails(c, r), attached && "the full report is in the file below."],
  });
}

export const weeklyFileCaption: string = "WEEKLY REPORT · the full report as a file (with tables) 📎";
