import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../src/lib/config.js";
import { migrate, openDb } from "../src/lib/db.js";
import { Store, type TradeRow } from "../src/collector/store.js";

function row(over: Partial<TradeRow> = {}): TradeRow {
  return {
    signature: "sig1", ev_index: 0, slot: 1, block_time: 1000, received_at: 1000, mint: "M", wallet: "W", is_buy: 1,
    sol_lamports: 1_000_000_000n, token_amount: 5_000_000n, v_sol_reserves: 31n, v_token_reserves: 1000n, real_sol_reserves: 1n,
    real_token_reserves: 1n, fee_lamports: 1n, creator_fee_lamports: 0n, price_sol: 1e-8, is_dev: 0, ix_name: "buy", source: "test",
    ...over,
  };
}

describe("migrations", () => {
  it("are idempotent", () => {
    const db = openDb(":memory:");
    expect(migrate(db)).toEqual([]);
    expect(db.prepare("SELECT count(*) n FROM schema_migrations").get()).toEqual({ n: 1 });
  });

  it("python and TS runners agree on the same database", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    const path = join(dir, "t.db");
    const py = resolve(ROOT, ".venv/bin/python");
    const out = execFileSync(py, [resolve(ROOT, "shared/migrate.py"), path], { encoding: "utf8" });
    expect(out).toMatch(/applied: \['001_init.sql'\]/);
    const db = openDb(path); // TS runner sees nothing left to do
    expect(migrate(db)).toEqual([]);
    expect(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'trades'").get()).toEqual({ n: 1 });
    db.close();
  });
});

describe("Store", () => {
  it("dedupes trades by (signature, ev_index) and counts holder deltas once", () => {
    const db = openDb(":memory:");
    const s = new Store(db);
    s.addTrade(row());
    s.addTrade(row()); // duplicate delivery
    s.addTrade(row({ ev_index: 1, token_amount: 2_000_000n, is_buy: 0 }));
    s.flush();
    s.addTrade(row()); // redelivered after reconnect
    s.flush();
    expect(db.prepare("SELECT count(*) n FROM trades").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT balance FROM token_holders WHERE mint='M' AND wallet='W'").get()).toEqual({ balance: 3_000_000 });
  });

  it("never lets a trade-derived balance go negative", () => {
    const db = openDb(":memory:");
    const s = new Store(db);
    s.addTrade(row({ is_buy: 0, token_amount: 9n }));
    s.flush();
    expect(db.prepare("SELECT balance FROM token_holders").get()).toEqual({ balance: 0 });
  });

  it("merges token info from two sources without overwriting known fields", () => {
    const db = openDb(":memory:");
    const s = new Store(db);
    s.addToken({ mint: "M", name: "PP", creator: "DEV", created_at: 2000, first_seen_at: 2000, initial_buy_lamports: 5n, source: "pumpportal" });
    s.flush();
    s.addToken({ mint: "M", name: "Helius", creator: "DEV", created_slot: 77, created_at: 1500, first_seen_at: 2100, source: "helius" });
    s.flush();
    expect(db.prepare("SELECT name, created_slot, created_at, first_seen_at, initial_buy_lamports, source FROM tokens").get())
      .toEqual({ name: "PP", created_slot: 77, created_at: 1500, first_seen_at: 2000, initial_buy_lamports: 5, source: "pumpportal" });
  });
});
