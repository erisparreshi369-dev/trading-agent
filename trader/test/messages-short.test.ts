import { describe, expect, it } from "vitest";
import * as plain from "../src/notifier/messages.js";
import { shorten } from "../src/notifier/messages-short.js";
import { M, setVoice, VOICES } from "../src/notifier/voice.js";
import { samples } from "./message-samples.js";

/** Answers to commands stay full: the owner asked for them. */
const FULL = /^(guide|words|explain how-to|brain memory|help$|unknown command|command failed|status|pnl|stop |already halted|quiet on|quiet was off|why)/;

describe.each(["plain", "genz"] as const)("short messages (%s)", (voice) => {
  const long = VOICES[voice];
  const all = samples(shorten(long));

  it.each(all.filter((s) => !FULL.test(s.name)).map((s) => [s.name, s.text]))("%s: one line or nothing", (_name, text) => {
    expect(text).not.toMatch(/\n/);
    if (text) expect(text).toMatch(/^(✅|⚠️|🚨|😐|🟢|🔻) \S/u);
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it("command answers are unchanged", () => {
    for (const s of all.filter((x) => FULL.test(x.name))) expect(s.text, s.name).toBe(samples(long).find((p) => p.name === s.name)!.text);
  });

  it("skipped chances and the hourly summary are not sent (the daily report counts them)", () => {
    for (const name of ["skipped: scam check", "skipped: other", "activity"]) expect(all.find((s) => s.name === name)!.text).toBe("");
  });

  it("🚨 messages still say exactly what to type", () => {
    for (const s of all.filter((x) => x.text.startsWith("🚨"))) expect(s.text, s.name).toMatch(/ → .*(type|add|remove)/);
  });

  it("trades and reports carry the numbers", () => {
    const by = (n: string) => all.find((s) => s.name === n)!.text;
    expect(by("paper buy")).toBe("🟢 bought MOON 0.020 SOL");
    expect(by("paper win")).toBe("✅ sold MOON +0.004 SOL (+21%) · bag 1.008 SOL");
    expect(by("paper loss")).toBe("🔻 sold FROG −0.006 SOL (−31%) · bag 1.002 SOL");
    expect(by("live buy")).toMatch(/^🟢 \[LIVE\] bought /);
    expect(by("daily report")).toBe("✅ day Tue 20 Oct: 7 trades, 4W 3L, +0.008 SOL · bag 1.012 SOL · too early to judge (12/50 trades)");
  });

  it("/explain still recognises a short message", () => {
    const ex = shorten(long).explain;
    expect(ex("✅ sold MOON +0.004 SOL (+21%) · bag 1.008 SOL")).toBe(long.explain("TRADE CLOSED"));
    expect(ex("🚨 BOT HEALTH · The data collector is down → type make restart")).toBe(long.explain("BOT HEALTH · The data collector is down"));
    expect(ex("✅ day Tue 20 Oct: 7 trades")).toBe(long.explain("DAILY REPORT"));
  });
});

describe("notifier.voice", () => {
  it("genz-short = Gen Z words, one line", () => {
    setVoice("genz-short");
    expect(M.help()).toBe(VOICES.genz.help());
    expect(M.skipped({ mode: "paper", tz: "UTC", usd: null, now: 0 }, { token: { mint: "x", symbol: "A" }, reason: "r" })).toBe("");
    setVoice("plain");
    expect(M).toBe(plain);
  });
});
