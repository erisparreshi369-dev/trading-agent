"use strict";
// Wording for the dashboard: GZ is the Gen Z voice (same as the Telegram texts, trader/src/notifier/messages-genz.ts), PLAIN the plain one.
// app.js picks plain or Gen Z with g(plain, genz); this file holds the longer rewordings.
// Uses app.js helpers (dur, amt, esc) at call time.

const GZ = {
  state: { running: "vibing", active: "vibing", scheduled: "on schedule", stale: "lowkey sus", failed: "down bad", stopped: "off", inactive: "off", dead: "down bad" },
  svc: { collector: "data collector", trader: "trader", notifier: "texter", learner: "the brain" },

  // why a trade was skipped (signal reasons), shortened from messages-genz.ts SKIP_RULES
  skip(r) {
    const rules = [
      [/^venue (\S+) not enabled/, () => "the coin was on a market we don't use yet"],
      [/^leader buy ([\d.]+) < ([\d.]+) SOL/, (m) => `our trader only bought ${(+m[1]).toFixed(3)} SOL, we wait for ${m[2]}+`],
      [/^token launch not seen/, () => "we didn't catch the coin being made, so no vibe check"],
      [/^token age (\d+)s outside \[(\d+), (\d+)\]/, (m) => (+m[1] < +m[2] ? "the coin was literally seconds old" : `the coin was ${dur(+m[1])} old, we only copy in its first ${dur(+m[3])}`)],
      [/^mayhem mode token/, () => "chaos-mode coin with unhinged prices, we stay away"],
      [/^dev launched (\d+) tokens in 24h/, (m) => `the creator made ${m[1]} coins in a day, that's giving scam`],
      [/^leader is the token's dev/, () => "our trader made this coin themselves, usually a trick"],
      [/^curve SOL ([\d.]+) outside \[([\d.]+), ([\d.]+)\]/, (m) => (+m[1] < +m[2] ? "barely any money in the coin yet" : "the coin was about to move to a bigger market, prices go crazy then")],
      [/^(\d+) tracked buyers < (\d+)/, (m) => `only ${m[1]} of our traders bought it, we wait for ${m[2]}`],
      [/^re-entry cooldown/, () => "we traded this coin less than an hour ago"],
      [/^top10 holders ([\d.]+)% > ([\d.]+)%/, (m) => `the 10 biggest owners had ${Math.round(+m[1])}% (limit ${m[2]}%), they could crash it`],
      [/^dev holds ([\d.]+)% > ([\d.]+)%/, () => "the creator still owned a lot and could dump it"],
      [/^dev sold (\d+)% of launch buy/, () => "the creator already sold, that's giving scam"],
      [/^on-chain check failed/, () => "our safety check got ghosted, so we stayed out"],
      [/^score (-?[\d.]+) < (-?[\d.]+)/, () => "our trader hasn't been doing great lately"],
      [/^model expects/, () => "the brain thinks this one would lose money"],
      [/^bad creator/, () => "the creator's past coins basically all flopped"],
      [/^creator rated/, () => "the creator's past coins mostly went nowhere"],
      [/^risk: kill switch/, () => "the emergency stop is on"],
      [/^risk: daily loss cap/, () => "we hit today's loss limit"],
      [/^risk: max open positions \((\d+)\)/, (m) => `we already had ${m[1]} trades open, our max`],
      [/^risk: max entries per day \((\d+)\)/, (m) => `we already did ${m[1]} trades today, our max`],
      [/^risk: leader has/, () => "we copied this trader a lot lately, spreading it out"],
      [/^risk: position size/, () => "too little money left for a trade"],
      [/^risk: free balance/, () => "we keep some money aside for fees"],
      [/^risk: already in this token/, () => "we already own this coin"],
      [/^risk: data budget/, () => "today's free data is almost gone, no new trades till reset"],
    ];
    for (const [re, f] of rules) {
      const m = String(r).match(re);
      if (m) return f(m);
    }
    return r;
  },

  // why we sold
  exit(r) {
    return { leader_exit: "our trader sold, so we did", stop_loss: "price tanked, auto-sold to stop a big L", trailing_stop: "dropped 20% off its peak, so we dipped", time_exit: "held 30m, our max",
      kill_switch: "the emergency stop sold it" }[r] || r || "one of our selling rules";
  },

  // why a buy or sell didn't go through
  missed(r) {
    const slip = r?.match(/slippage (-?\d+)bps/);
    if (slip) return `the price ran ${(+slip[1] / 100).toFixed(1)}% before our buy landed, too much`;
    return { "no market data": "we couldn't see a price right then", "curve completed": "the coin moved to a bigger market right then",
      "size too small after fixed costs": "too small to be worth the fees", "kill switch": "the emergency stop was on" }[r] || r || "it just didn't go through";
  },

  // a brain lesson, from its data (brain.py lessons())
  lessonWords(key, plain) {
    return { two_traders: "2+ of our traders aped in", dev_sold: "the creator already dipped (sold half+)", very_new: "the coin was under a minute old",
      older: "the coin was 10+ minutes old", big_buy: "our trader went big (0.5+ SOL)", small_buy: "our trader bought tiny (under 0.1 SOL)",
      concentrated: "the 10 biggest owners had 40%+", serial_creator: "the creator spammed 5+ coins that day", thin: "under 5 SOL was in the coin",
      deep: "30+ SOL was in the coin", good_trader: "the trader had a good grade", launch_unseen: "we missed the coin's launch",
      bad_creator: "the creator's coins basically never took off" }[key] || plain;
  },
  lesson(l) {
    const w = GZ.lessonWords(l.key, l.words);
    const p = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
    return `when ${esc(w)}: ${p(l.with_avg)} avg (${l.with_n}) vs ${p(l.without_avg)} otherwise (${l.without_n}). that's ${Math.abs(l.diff * 100).toFixed(1)} pts ${l.diff > 0 ? "better 📈" : "worse 📉"}`;
  },

  // one feed line; anything without a rewording keeps the server's plain text
  feed(i) {
    const s = esc(i.sym || "a coin");
    switch (i.kind) {
      case "launch": return `${s} just dropped${i.dev >= 0.005 ? ` · creator aped ${i.dev.toFixed(2)} SOL` : ""}`;
      case "wallet_buy": return `${esc(i.who)} aped ${i.sol.toFixed(3)} SOL into ${s}`;
      case "wallet_sell": return `${esc(i.who)} dumped ${i.sol.toFixed(3)} SOL of ${s}`;
      case "enter": return `copying ${short(i.wallet)} on ${s} 🫡`;
      case "reject": return `skipped ${short(i.wallet)} on ${s}`;
      case "risk_block": return `safety limit said no: ${short(i.wallet)} on ${s}`;
      case "paper_buy": return `we bought ${s} for ${amt(i.sol)} SOL${isNum(i.slip) && Math.abs(i.slip) >= 10 ? ` · paid ${(Math.abs(i.slip) / 100).toFixed(1)}% ${i.slip > 0 ? "more" : "less"} than our trader` : ""}`;
      case "paper_sell": return `we sold ${s} for ${amt(i.sol)} SOL (${esc(GZ.exit(i.reason))})`;
      case "fill_failed": return `missed the ${i.side === "sell" ? "sell" : "buy"} on ${s}: ${esc(GZ.missed(i.reason))}`;
      case "gap": return `${esc(i.src)} feed ${i.expected ? "taking a break" : "is down bad"}: ${esc(i.reason || "?")}`;
      default: return esc(i.text);
    }
  },
};

// Plain wording for the same things: no trader codes (leader_exit, PnL, px, signal) in either voice.
const PLAIN = {
  skip(r) {
    const rules = [
      [/^venue (\S+) not enabled/, () => "the coin was on a market we don't use yet"],
      [/^leader buy ([\d.]+) < ([\d.]+) SOL/, (m) => `the trader only bought ${(+m[1]).toFixed(3)} SOL; we wait for ${m[2]} SOL or more`],
      [/^token launch not seen/, () => "we didn't see the coin being created, so we couldn't check it"],
      [/^token age (\d+)s outside \[(\d+), (\d+)\]/, (m) => (+m[1] < +m[2] ? "the coin was only seconds old" : `the coin was ${dur(+m[1])} old; we only copy in its first ${dur(+m[3])}`)],
      [/^mayhem mode token/, () => "a chaos-mode coin with wild prices"],
      [/^dev launched (\d+) tokens in 24h/, (m) => `the creator made ${m[1]} coins in one day, which looks like a scam`],
      [/^leader is the token's dev/, () => "the trader made this coin themselves, usually a trick"],
      [/^curve SOL ([\d.]+) outside \[([\d.]+), ([\d.]+)\]/, (m) => (+m[1] < +m[2] ? "hardly any money was in the coin yet" : "the coin was about to move to a bigger market, when prices swing wildly")],
      [/^(\d+) tracked buyers < (\d+)/, (m) => `only ${m[1]} of our traders bought it; we wait for ${m[2]}`],
      [/^re-entry cooldown/, () => "we traded this coin less than an hour ago"],
      [/^top10 holders ([\d.]+)% > ([\d.]+)%/, (m) => `the 10 biggest owners had ${Math.round(+m[1])}% (our limit is ${m[2]}%) and could crash the price`],
      [/^dev holds ([\d.]+)% > ([\d.]+)%/, () => "the creator still owned a lot and could sell it all at once"],
      [/^dev sold (\d+)% of launch buy/, () => "the creator had already sold, which looks like a scam"],
      [/^on-chain check failed/, () => "our safety check got no answer, so we stayed out"],
      [/^score (-?[\d.]+) < (-?[\d.]+)/, () => "this trader hasn't done well lately"],
      [/^model expects/, () => "the learning brain expects this trade to lose money"],
      [/^bad creator/, () => "the creator's earlier coins almost never took off"],
      [/^creator rated/, () => "the creator's earlier coins mostly went nowhere"],
      [/^risk: kill switch/, () => "the emergency stop is on"],
      [/^risk: daily loss cap/, () => "today's loss limit was reached"],
      [/^risk: max open positions \((\d+)\)/, (m) => `${m[1]} trades were already open, the most allowed`],
      [/^risk: max entries per day \((\d+)\)/, (m) => `${m[1]} trades were already made today, the most allowed`],
      [/^risk: leader has/, () => "we copied this trader a lot lately, so we spread it out"],
      [/^risk: position size/, () => "too little money was left for a trade"],
      [/^risk: free balance/, () => "we keep some money aside for fees"],
      [/^risk: already in this token/, () => "we already own this coin"],
      [/^risk: data budget/, () => "today's free data is almost used up, so no new trades until it resets"],
    ];
    for (const [re, f] of rules) {
      const m = String(r).match(re);
      if (m) return f(m);
    }
    return r;
  },

  exit(r) {
    return { leader_exit: "the trader we copy sold, so we sold", stop_loss: "the price fell too far, so it sold automatically", trailing_stop: "the price fell 20% from its best, so it sold",
      time_exit: "held for the 30-minute maximum", kill_switch: "the emergency stop sold it" }[r] || r || "one of our selling rules";
  },

  missed(r) {
    const slip = r?.match(/slippage (-?\d+)bps/);
    if (slip) return `the price rose ${(+slip[1] / 100).toFixed(1)}% before our buy went through, more than we allow`;
    return { "no market data": "we couldn't see a price at that moment", "curve completed": "the coin moved to a bigger market at that moment",
      "size too small after fixed costs": "too small to be worth the fees", "kill switch": "the emergency stop was on" }[r] || r || "it didn't go through";
  },

  feed(i) {
    const s = esc(i.sym || "a coin");
    switch (i.kind) {
      case "launch": return `${s} was created${i.dev >= 0.005 ? ` · its creator bought ${i.dev.toFixed(2)} SOL` : ""}`;
      case "wallet_buy": return `${esc(i.who)} bought ${i.sol.toFixed(3)} SOL of ${s}`;
      case "wallet_sell": return `${esc(i.who)} sold ${i.sol.toFixed(3)} SOL of ${s}`;
      case "enter": return `copying ${short(i.wallet)} on ${s}`;
      case "reject": return `skipped ${short(i.wallet)} on ${s}`;
      case "risk_block": return `a safety limit stopped copying ${short(i.wallet)} on ${s}`;
      case "paper_buy": return `we bought ${s} for ${amt(i.sol)} SOL${isNum(i.slip) && Math.abs(i.slip) >= 10 ? ` · paid ${(Math.abs(i.slip) / 100).toFixed(1)}% ${i.slip > 0 ? "more" : "less"} than the trader` : ""}`;
      case "paper_sell": return `we sold ${s} for ${amt(i.sol)} SOL (${esc(PLAIN.exit(i.reason))})`;
      case "fill_failed": return `missed the ${i.side === "sell" ? "sell" : "buy"} on ${s}: ${esc(PLAIN.missed(i.reason))}`;
      case "gap": return `${esc(i.src)} data feed ${i.expected ? "paused" : "down"}: ${esc(i.reason || "?")}`;
      default: return esc(i.text);
    }
  },
};
