import { PublicKey } from "@solana/web3.js";
import type { DB } from "../lib/db.js";
import { log } from "../lib/log.js";

const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOTAL_SUPPLY_UI = 1_000_000_000;

interface Pending {
  mint: string;
  bondingCurve: string;
  tokenProgram: string;
  createdAt: number;
  ages: number[]; // seconds, ascending, still to run
}

export interface HolderCheckConfig {
  enabled: boolean;
  min_trades: number;
  ages_s: number[];
  max_per_minute: number;
}

/**
 * At fixed ages after launch, fetch the 20 largest token accounts over RPC. This sees what
 * trade-derived balances can't: tokens moved by plain transfers (bundled/split dev wallets).
 */
export class HolderChecker {
  private pending = new Map<string, Pending>();
  private sentThisMinute = 0;
  private minuteStart = 0;
  private timer?: NodeJS.Timeout;
  stats = { checks: 0, errors: 0, skippedQuiet: 0, rateLimited: 0 };

  constructor(
    private db: DB,
    private rpcUrl: string,
    private cfg: HolderCheckConfig,
    private tradeCount: (mint: string) => number,
  ) {}

  track(mint: string, bondingCurve: string, tokenProgram: string | null, createdAt: number): void {
    if (!this.cfg.enabled || this.pending.has(mint)) return;
    this.pending.set(mint, {
      mint, bondingCurve, createdAt,
      tokenProgram: tokenProgram ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      ages: [...this.cfg.ages_s].sort((a, b) => a - b),
    });
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 2_000);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    if (now - this.minuteStart >= 60_000) {
      this.minuteStart = now;
      this.sentThisMinute = 0;
    }
    for (const p of this.pending.values()) {
      const age = (now - p.createdAt) / 1000;
      while (p.ages.length && age >= p.ages[0]! + 120) p.ages.shift(); // too late to be meaningful
      if (!p.ages.length) {
        this.pending.delete(p.mint);
        continue;
      }
      if (age < p.ages[0]!) continue;
      const target = p.ages.shift()!;
      if (this.tradeCount(p.mint) < this.cfg.min_trades) {
        this.stats.skippedQuiet++;
        continue;
      }
      if (this.sentThisMinute >= this.cfg.max_per_minute) {
        this.stats.rateLimited++;
        continue;
      }
      this.sentThisMinute++;
      void this.check(p, target).catch((err) => {
        this.stats.errors++;
        log.debug({ mint: p.mint, err: String(err) }, "holder check failed");
      });
    }
  }

  private async check(p: Pending, ageS: number): Promise<void> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [p.mint, { commitment: "confirmed" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const body = (await res.json()) as { result?: { value: { address: string; uiAmount: number | null }[] }; error?: unknown };
    if (!body.result) throw new Error(`rpc error ${JSON.stringify(body.error)}`);
    const curveAta = ata(p.bondingCurve, p.mint, p.tokenProgram);
    const accounts = body.result.value.map((a) => [a.address, a.uiAmount ?? 0] as const);
    const top10 = accounts.filter(([addr]) => addr !== curveAta).slice(0, 10).reduce((s, [, amt]) => s + amt, 0);
    this.db.prepare("INSERT OR REPLACE INTO holder_snapshots (mint, ts, age_s, top_accounts, top10_pct) VALUES (?, ?, ?, ?, ?)")
      .run(p.mint, Date.now(), ageS, JSON.stringify(accounts), (top10 / TOTAL_SUPPLY_UI) * 100);
    this.stats.checks++;
  }
}

export function ata(owner: string, mint: string, tokenProgram: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    ATA_PROGRAM,
  )[0].toBase58();
}
