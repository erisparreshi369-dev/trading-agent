import type { SignalsConfig } from "../lib/config.js";
import type { DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import { bondingCurve, canonicalPool } from "../collector/pools.js";
import type { PaperEngine, TradeRow } from "../paper/engine.js";
import { TOKEN_2022, type TokenInfoSource } from "./token-info.js";

export interface LeaderTrade extends TradeRow {
  signature: string;
  real_sol_reserves: number | null;
}

interface TokenRow {
  mint: string;
  creator: string | null;
  created_at: number;
  initial_buy_tokens: number | null;
  is_mayhem_mode: number | null;
  token_program: string | null;
  migrated_at: number | null;
}

export type Features = Record<string, number | string | boolean | null>;

/**
 * Optional hook for the Phase 4 model: may scale the signal score, nothing else. It never sees
 * or returns position sizes, and risk checks run after it regardless of what it says.
 */
export type ScoreAdjuster = (features: Features) => number;

export interface SignalResult {
  signalId: number;
  decision: "enter" | "reject" | "risk_block";
  reasons: string[];
  score: number | null;
}

export class SignalEngine {
  private adjust: ScoreAdjuster = () => 1;

  constructor(
    private db: DB,
    private cfg: SignalsConfig,
    private info: TokenInfoSource,
    private paper: PaperEngine,
    private now: () => number = Date.now,
  ) {}

  setScoreAdjuster(fn: ScoreAdjuster): void {
    this.adjust = fn;
  }

  /** A tracked wallet bought. Decide whether to follow, record why, and hand accepted ones to paper. */
  async evaluate(t: LeaderTrade): Promise<SignalResult> {
    const c = this.cfg;
    const reasons: string[] = [];
    const f: Features = { venue: t.venue, leader: t.wallet, leader_buy_sol: t.sol_lamports / 1e9, price: t.price_sol };
    const tok = this.db.prepare("SELECT mint, creator, created_at, initial_buy_tokens, is_mayhem_mode, token_program, migrated_at FROM tokens WHERE mint = ?")
      .get(t.mint) as TokenRow | undefined;
    const wallet = this.db.prepare("SELECT score FROM tracked_wallets WHERE wallet = ?").get(t.wallet) as { score: number | null } | undefined;
    f.wallet_score = wallet?.score ?? null;

    // ---- cheap checks (database only) ----
    if (!c.venues.includes(t.venue as "curve" | "amm")) reasons.push(`venue ${t.venue} not enabled`);
    if ((f.leader_buy_sol as number) < c.min_leader_buy_sol) reasons.push(`leader buy ${(f.leader_buy_sol as number).toFixed(3)} < ${c.min_leader_buy_sol} SOL`);
    if (!tok) {
      reasons.push("token launch not seen (no creator/age data)");
    } else {
      const age = (t.received_at - tok.created_at) / 1000;
      f.token_age_s = Math.round(age);
      if (age < c.token_age_s[0] || age > c.token_age_s[1]) reasons.push(`token age ${Math.round(age)}s outside [${c.token_age_s.join(", ")}]`);
      f.mayhem = !!tok.is_mayhem_mode;
      if (c.exclude_mayhem && tok.is_mayhem_mode) reasons.push("mayhem mode token");
      if (tok.creator) {
        f.dev_tokens_24h = (this.db.prepare("SELECT count(*) n FROM tokens WHERE creator = ? AND created_at > ?")
          .get(tok.creator, this.now() - 86_400_000) as { n: number }).n;
        if ((f.dev_tokens_24h as number) > c.max_dev_tokens_24h) reasons.push(`dev launched ${f.dev_tokens_24h} tokens in 24h`);
      }
      if (tok.creator === t.wallet) reasons.push("leader is the token's dev");
    }
    const liquidity = t.venue === "curve" ? (t.real_sol_reserves ?? 0) / 1e9 : (t.v_sol_reserves ?? 0) / 1e9;
    f.liquidity_sol = +liquidity.toFixed(3);
    if (t.venue === "curve" && (liquidity < c.min_real_sol || liquidity > c.max_real_sol)) {
      reasons.push(`curve SOL ${liquidity.toFixed(2)} outside [${c.min_real_sol}, ${c.max_real_sol}]`);
    }
    const since = t.received_at - c.confirmation_window_s * 1000;
    f.confirmations = (this.db.prepare(`SELECT count(DISTINCT t.wallet) n FROM trades t JOIN tracked_wallets w ON w.wallet = t.wallet AND w.active = 1
      WHERE t.mint = ? AND t.is_buy = 1 AND t.received_at BETWEEN ? AND ?`).get(t.mint, since, t.received_at) as { n: number }).n;
    if ((f.confirmations as number) < c.min_confirmations) reasons.push(`${f.confirmations} tracked buyers < ${c.min_confirmations}`);
    const lastExit = this.db.prepare("SELECT max(COALESCE(closed_at, entry_due_at)) ts FROM paper_positions WHERE mint = ?").get(t.mint) as { ts: number | null };
    if (lastExit.ts && t.received_at - lastExit.ts < c.reentry_cooldown_s * 1000) reasons.push("re-entry cooldown");

    // ---- on-chain checks, only when everything cheap passed (saves RPC credits) ----
    if (reasons.length === 0 && tok) {
      try {
        const program = tok.token_program ?? TOKEN_2022;
        const owner = t.venue === "amm" ? canonicalPool(t.mint) : bondingCurve(t.mint);
        const [top10, devBal] = await Promise.all([
          this.info.top10Pct(t.mint, owner, program),
          tok.creator ? this.info.walletBalance(tok.creator, t.mint) : Promise.resolve(0),
        ]);
        f.top10_pct = +top10.toFixed(2);
        f.dev_hold_pct = +((devBal / 1e15) * 100).toFixed(3);
        f.dev_sold_frac = tok.initial_buy_tokens ? +Math.max(0, 1 - devBal / tok.initial_buy_tokens).toFixed(3) : null;
        if (top10 > c.max_top10_pct) reasons.push(`top10 holders ${top10.toFixed(1)}% > ${c.max_top10_pct}%`);
        if ((f.dev_hold_pct as number) > c.max_dev_hold_pct) reasons.push(`dev holds ${f.dev_hold_pct}% > ${c.max_dev_hold_pct}%`);
        if (f.dev_sold_frac !== null && (f.dev_sold_frac as number) > c.max_dev_sold_frac) reasons.push(`dev sold ${Math.round((f.dev_sold_frac as number) * 100)}% of launch buy`);
      } catch (err) {
        reasons.push(`on-chain check failed: ${String(err).slice(0, 80)}`); // fail closed
      }
    }

    const base = (wallet?.score ?? 0) + 0.05 * Math.max(0, (f.confirmations as number) - 1);
    const score = base * this.adjust(f);
    f.score = +score.toFixed(4);
    if (reasons.length === 0 && score < c.min_score) reasons.push(`score ${score.toFixed(3)} < ${c.min_score}`);

    let decision: SignalResult["decision"] = reasons.length ? "reject" : "enter";
    const signalId = Number(this.db.prepare(`INSERT INTO signals (ts, wallet, mint, leader_trade_id, venue, score, decision, reasons, features)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(this.now(), t.wallet, t.mint, t.id, t.venue, score, decision, JSON.stringify(reasons), JSON.stringify(f)).lastInsertRowid);

    if (decision === "enter") {
      const risk = this.paper.enter(signalId, { mint: t.mint, wallet: t.wallet, venue: t.venue, received_at: t.received_at, price_sol: t.price_sol! });
      if (!risk.ok) {
        decision = "risk_block";
        reasons.push(`risk: ${risk.reason}`);
        this.db.prepare("UPDATE signals SET decision = ?, reasons = ? WHERE id = ?").run(decision, JSON.stringify(reasons), signalId);
      }
    }
    log.info({ signal: signalId, mint: t.mint, leader: t.wallet, decision, reasons, score: f.score }, "signal");
    return { signalId, decision, reasons, score };
  }
}
