import { ata } from "../collector/holder-checks.js";

export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOTAL_SUPPLY_RAW = 1e15;

/** On-chain lookups the signal engine needs when the firehose isn't covering a token. */
export interface TokenInfoSource {
  /** % of total supply in the 10 largest accounts, excluding the account owned by `excludeOwner` (curve or pool). */
  top10Pct(mint: string, excludeOwner: string, tokenProgram: string): Promise<number>;
  /** Raw token balance a wallet holds of `mint` (0 if none). */
  walletBalance(owner: string, mint: string): Promise<number>;
}

export class RpcTokenInfo implements TokenInfoSource {
  constructor(private rpcUrl: string) {}

  async top10Pct(mint: string, excludeOwner: string, tokenProgram: string): Promise<number> {
    const r = await this.call<{ value: { address: string; amount: string }[] }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    const skip = ata(excludeOwner, mint, tokenProgram);
    const top = r.value.filter((a) => a.address !== skip).slice(0, 10);
    return (top.reduce((s, a) => s + Number(a.amount), 0) / TOTAL_SUPPLY_RAW) * 100;
  }

  async walletBalance(owner: string, mint: string): Promise<number> {
    const r = await this.call<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(
      "getTokenAccountsByOwner",
      [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
    );
    return r.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.amount), 0);
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`${method}: http ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? "no result"}`);
    return body.result;
  }
}
