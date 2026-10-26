import type { JobName, ProviderName, ProvidersConfig } from "../lib/config.js";
import { registerSecret } from "../lib/log.js";

export interface Provider {
  name: ProviderName;
  ws: string;
  http: string;
}

/**
 * The providers we can actually use: those listed in config whose key is set in .env. Keys are
 * registered with the log scrubber here, before any address containing them can be logged.
 */
export function providersFrom(cfg: ProvidersConfig, env: NodeJS.ProcessEnv = process.env): Map<ProviderName, Provider> {
  const out = new Map<ProviderName, Provider>();
  const list = cfg.list as Record<ProviderName, ProvidersConfig["list"][ProviderName]>;
  for (const name of Object.keys(list) as ProviderName[]) {
    const p = list[name];
    if (!p) continue;
    const key = env[p.key_env]?.trim();
    if (!key) continue;
    registerSecret(key);
    const fill = (t: string) => t.split("{key}").join(encodeURIComponent(key));
    out.set(name, { name, ws: fill(p.ws), http: fill(p.http) });
  }
  return out;
}

/** The providers a job may use, best first, limited to those with a key. */
export function candidates(cfg: ProvidersConfig, job: JobName, available: Map<ProviderName, Provider>): ProviderName[] {
  return cfg.jobs[job].use.filter((n) => available.has(n));
}
