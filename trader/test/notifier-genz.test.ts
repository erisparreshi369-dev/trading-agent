import { afterEach, describe, expect, it } from "vitest";
import * as genz from "../src/notifier/messages-genz.js";
import * as plain from "../src/notifier/messages.js";
import { M, setVoice, VOICES } from "../src/notifier/voice.js";
import { testConfig } from "./helpers.js";
import { samples } from "./message-samples.js";

/** Same words the owner asked us never to use, in either voice. */
const JARGON = /\b(leader|tracked|wallets?|slippage|stop[- ]?loss|paper trade|pnl|drawdown|rugs?|signals?|rejected|notifier|services?|tokens?|mint|bps|equity|positions?|holders?|devs?|developer|roi|kill switch|exit|pump\.fun|helius|pid|null|undefined|nan)\b/i;

describe("Gen Z voice: every message keeps the house rules", () => {
  const all = samples(genz);

  it("covers every message the plain voice has", () => {
    expect(all.map((s) => s.name)).toEqual(samples(plain).map((s) => s.name));
    for (const s of all) expect(s.text, s.name).not.toBe(samples(plain).find((p) => p.name === s.name)!.text); // actually reworded
  });

  it.each(all.map((s) => [s.name, s.text]))("%s", (_name, text) => {
    const lines = text.split("\n");
    const detailsAt = lines.indexOf("the deets:");
    const head = detailsAt === -1 ? lines : lines.slice(0, detailsAt);
    // 1. same shape: title, the tea, W / lowkey sus / not good fr / mid, (≤2 more), your move
    expect(lines[0]).toMatch(/^(\[(PAPER|LIVE)\] )?[A-Z][A-Z ']+( · .+)?$/);
    expect(lines[1]).toMatch(/^the tea: \S/);
    expect(lines[2]).toMatch(/^(✅ W|⚠️ lowkey sus|🚨 not good fr|😐 mid): \S/u);
    expect(head[head.length - 1]).toMatch(/^your move: \S/);
    expect(text.match(/^your move:/gm)).toHaveLength(1);
    expect(head.length).toBeLessThanOrEqual(6);
    // 2. slang yes, jargon no
    expect(text.replace(/data collector/g, "").replace(/\/\w+/g, "")).not.toMatch(JARGON);
    // 3. SOL still explained the first time
    if (/\bSOL\b/.test(text) && !/^(WORDS I USE|EXPLAINED)/.test(lines[0]!)) expect(text.match(/\bSOL\b.*/)![0]).toMatch(/^SOL \(the coin we trade with\)/);
    expect(text).not.toMatch(/\) \(|\([^()]*\([^()]*\)[^()]*\)/);
    expect(text).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{25,}|\d\.\d{4,}|"level"|\{"|SIG[A-Z]+|trading-\w+/);
    expect(lines[0]).not.toMatch(/[✅⚠️🚨😐]/u);
  });

  it("🚨 messages still say exactly what to type", () => {
    for (const s of all.filter((x) => x.text.split("\n")[2]!.startsWith("🚨"))) {
      expect(s.text, s.name).toMatch(/^your move: .*(type: make \w+|make restart|HELIUS_API_KEY|LIVE_TRADING|df -h)/m);
    }
  });

  it("money still comes with its size: a small/medium/big W or L", () => {
    expect(all.find((s) => s.name === "paper win")!.text).toMatch(/we made [\d.]+ SOL \(the coin we trade with\)\. that's a (small|medium|big) W\./);
    expect(all.find((s) => s.name === "paper loss")!.text).toMatch(/we lost [\d.]+ SOL \(the coin we trade with\)\. that's a (small|medium|big) L\./);
  });

  it("every reason the trading part writes has a Gen Z explanation, with the same groups as plain", () => {
    const reasons = [
      "venue amm not enabled", "leader buy 0.040 < 0.1 SOL", "token launch not seen (no creator/age data)", "token age 2s outside [3, 1800]",
      "token age 2400s outside [3, 1800]", "mayhem mode token", "dev launched 9 tokens in 24h", "leader is the token's dev",
      "curve SOL 0.40 outside [1, 75]", "curve SOL 80.12 outside [1, 75]", "1 tracked buyers < 2", "re-entry cooldown", "top10 holders 61.2% > 40%",
      "dev holds 12.5% > 10%", "dev sold 80% of launch buy", "on-chain check failed: Error: 429", "score -0.012 < 0", "model expects -8.0% follower ROI < 2.0% threshold",
      "risk: kill switch: make kill", "risk: daily loss cap reached", "risk: max open positions (5)", "risk: max entries per day (40)",
      "risk: leader has 5 of our last 20 entries (max 5)", "risk: position size 0.0080 below minimum 0.01", "risk: free balance would drop below reserve",
      "risk: already in this token",
    ];
    for (const r of reasons) {
      const g = genz.explainSkip(r);
      expect(g.key, r).toBe(plain.explainSkip(r).key); // scam / safety-limit grouping works the same
      expect(`${g.short} ${g.long}`, r).not.toMatch(JARGON);
    }
    expect(genz.explainSkip("bad creator: 558 launches, 0% filled their curve").key).toBe("bad_creator");
  });

  it("/explain recognises every Gen Z title and /words lists every word", () => {
    for (const s of all.filter((x) => !/^EXPLAINED/.test(x.text))) {
      const e = genz.explain(s.text);
      expect(e, s.name).not.toMatch(/this is one of my texts about the bot/);
      expect(e, s.name).toMatch(/it's like: /);
    }
    const w = genz.words();
    for (const [word] of genz.WORDS) expect(w).toContain(`• ${word}: `);
  });
});

describe("the voice switch", () => {
  afterEach(() => setVoice("plain"));

  it("ships Gen Z (one line per message), and switching changes every message at once (summaries included)", () => {
    expect(testConfig().notifier.voice).toBe("genz-short");
    expect(M).toBe(VOICES.plain); // until the notifier service sets it
    setVoice("genz");
    expect(M.unknownCommand()).toMatch(/^SORRY\nthe tea: /);
    expect(M.explainSkip("re-entry cooldown").short).toBe("we traded this coin less than an hour ago");
    setVoice("plain");
    expect(M.unknownCommand()).toMatch(/^SORRY\nWhat happened: /);
  });
});
