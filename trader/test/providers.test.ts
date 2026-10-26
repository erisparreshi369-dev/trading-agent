import { describe, expect, it } from "vitest";
import { log, scrubSecrets } from "../src/lib/log.js";
import { JobRouter, ProviderHealth, type Switch } from "../src/providers/health.js";
import { candidates, providersFrom } from "../src/providers/registry.js";
import { clock, testConfig } from "./helpers.js";

const cfg = testConfig().providers;
const H = cfg.health; // 3 errors, 10s timeout, 60s silence, 90% budget, 120s switch back

function setup(order = ["helius", "drpc", "ankr", "quicknode", "alchemy", "shyft", "triton", "chainstack", "public"] as ProviderName[]) {
  const c = clock();
  const health = new ProviderHealth(H, c.now);
  const switches: Switch[] = [];
  const r = new JobRouter("following", order, health, H, (s) => switches.push(s), c.now);
  for (const p of order) health.state(p); // known, healthy since start
  c.advance(H.switch_back_after_healthy_s * 1000); // everyone has been healthy for a while
  return { c, health, r, switches };
}
const fail = (h: ProviderHealth, p: ProviderName, n = H.errors_in_a_row) => {
  for (let i = 0; i < n; i++) h.error(p, "boom");
};

describe("provider registry", () => {
  it("uses only providers whose key is in .env, fills the address, and hides the key from logs", () => {
    const env = { HELIUS_API_KEY: "hel-SECRET-1234", DRPC_API_KEY: "dRPC/sec+ret=99" };
    const p = providersFrom(cfg, env);
    expect([...p.keys()]).toEqual(["helius", "drpc"]); // no Ankr key, so no Ankr
    expect(p.get("drpc")!.ws).toBe(`wss://lb.drpc.org/ogws?network=solana&dkey=${encodeURIComponent("dRPC/sec+ret=99")}`);
    expect(candidates(cfg, "lookups", p)).toEqual(["helius", "drpc"]);
    expect(candidates(cfg, "history", p)).toEqual(["helius"]);
    // any key, any shape, anywhere in a message
    expect(scrubSecrets(`failed: ${p.get("helius")!.http} with key hel-SECRET-1234 and dRPC/sec+ret=99`)).not.toMatch(/SECRET|sec\+ret/);
  });

  it("the logger itself scrubs registered keys from every line it writes", () => {
    providersFrom(cfg, { ANKR_API_KEY: "ankr-key-ZZZZ9999" });
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => (lines.push(String(s)), true);
    try {
      log.warn({ url: "https://rpc.ankr.com/solana/ankr-key-ZZZZ9999" }, "ankr-key-ZZZZ9999 failed");
    } finally {
      (process.stdout as any).write = orig;
    }
    expect(lines.join("")).not.toContain("ankr-key-ZZZZ9999");
  });
});

describe("provider health", () => {
  it("failures in a row, slow answers and a used-up budget each make a provider unhealthy", () => {
    const { health } = setup();
    fail(health, "helius", 2);
    health.evaluate();
    expect(health.state("helius").healthy).toBe(true);
    health.error("helius", "socket closed");
    expect(health.state("helius")).toMatchObject({ healthy: false, reason: "3 failures in a row: socket closed" });
    for (let i = 0; i < 3; i++) health.request("drpc", true, 11_000); // answered, but too slowly
    expect(health.state("drpc")).toMatchObject({ healthy: false, reason: expect.stringMatching(/slow answer \(11s\)/) });
    health.budget("ankr", 90);
    health.evaluate();
    expect(health.state("ankr")).toMatchObject({ healthy: false, reason: "daily budget 90% used" });
  });

  it("silence only counts while steady traffic is expected", () => {
    const { c, health } = setup();
    health.message("helius");
    c.advance(10 * 60_000); // quiet for 10 minutes while not expected to be busy (off-hours)
    health.evaluate();
    expect(health.state("helius").healthy).toBe(true);
    health.expectTraffic("helius", true); // the busy stream starts now: silence is measured from here
    c.advance(59_000);
    health.evaluate();
    expect(health.state("helius").healthy).toBe(true);
    c.advance(2_000);
    health.evaluate();
    expect(health.state("helius")).toMatchObject({ healthy: false, reason: "silent for 61s" });
    health.message("helius");
    health.evaluate();
    expect(health.state("helius").healthy).toBe(true);
  });

  it("a burst of failures is caught even if a success follows before the next check", () => {
    const { health } = setup();
    fail(health, "helius");
    health.request("helius", true, 100);
    expect(health.state("helius").healthy).toBe(false); // flipped at the 3rd failure
    health.evaluate();
    expect(health.state("helius")).toMatchObject({ healthy: true }); // recovered, but its 2-minute clock restarted
    expect(health.state("helius").healthySince).not.toBeNull();
  });
});

describe("failover routing", () => {
  it("switches away at once, to the next healthy provider in order, and logs why", () => {
    const { health, r, switches } = setup();
    expect(r.active).toBe("helius");
    fail(health, "helius");
    expect(r.evaluate()).toMatchObject({ from: "helius", to: "drpc", reason: "helius: 3 failures in a row: boom" });
    fail(health, "drpc");
    expect(r.evaluate()).toMatchObject({ from: "drpc", to: "ankr" });
    expect(switches).toHaveLength(2);
  });

  it("switches back only after the better provider has been healthy for 2 minutes without a break", () => {
    const { c, health, r } = setup();
    fail(health, "helius");
    r.evaluate();
    expect(r.active).toBe("drpc");
    health.request("helius", true, 50); // helius recovers
    r.evaluate();
    expect(r.active).toBe("drpc");
    c.advance(100_000);
    fail(health, "helius"); // ...flaps again before the 2 minutes are up
    health.request("helius", true, 50);
    c.advance(100_000); // 200s since first recovery, but only 100s since the flap
    expect(r.evaluate()).toBeNull();
    expect(r.active).toBe("drpc");
    c.advance(20_000); // 120s since the flap
    expect(r.evaluate()).toMatchObject({ from: "drpc", to: "helius", reason: "helius healthy for 120s" });
  });

  it("all providers down: no provider, then back as soon as any recovers", () => {
    const { health, r } = setup(["helius", "drpc"]);
    fail(health, "helius");
    fail(health, "drpc");
    r.evaluate(); // helius -> drpc is skipped: drpc is down too
    expect(r.active).toBeNull();
    expect(r.evaluate()).toBeNull(); // logged once, not every check
    health.request("drpc", true, 50);
    expect(r.evaluate()).toMatchObject({ from: null, to: "drpc", reason: "drpc is usable again" });
  });

  it("a job with a single provider never switches anywhere else", () => {
    const { health, r } = setup(["helius"]);
    fail(health, "helius");
    expect(r.evaluate()).toMatchObject({ from: "helius", to: null, reason: expect.stringMatching(/^no usable provider \(helius: 3 failures/) });
  });
});
