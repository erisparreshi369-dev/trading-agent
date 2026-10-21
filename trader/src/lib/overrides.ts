import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigSchema, ROOT, type Config } from "./config.js";
import { log } from "./log.js";

/**
 * THE OWNER'S LIMITS FROM THE DASHBOARD. shared/editable-settings.json lists every limit the
 * dashboard may change (Limits tab); a change is stored in kv under the setting's `key` until set
 * back. This applies the config.yaml ones (risk.* ones are read by risk/limits.ts, inside its walls).
 *
 * A stored value is used only if it is the right type and inside the setting's range, if it keeps
 * every pair rule (e.g. min below max), and if the whole config still passes the config checks;
 * otherwise the config.yaml value applies. So a bad row in the database can never stop the bot or
 * set a value the dashboard wouldn't have accepted.
 */
export interface EditableSetting {
  key: string;
  path: string;
  group: string;
  type: "number" | "int" | "bool";
  min?: number;
  max?: number;
  label: string;
}

export const EDITABLE = JSON.parse(readFileSync(resolve(ROOT, "shared/editable-settings.json"), "utf8")) as {
  settings: EditableSetting[];
  rules: [string, string][];
};

/** The settings that live in config.yaml (risk.* are the code's, see risk/limits.ts). */
export const CONFIG_SETTINGS = EDITABLE.settings.filter((s) => !s.path.startsWith("risk."));

type Value = number | boolean;

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

function setPath(obj: unknown, path: string, v: Value): void {
  const keys = path.split(".");
  const parent = keys.slice(0, -1).reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj) as Record<string, unknown>;
  parent[keys[keys.length - 1]!] = v;
}

/** A stored kv string as this setting's value, or undefined if it isn't a valid one. */
export function parseStored(s: EditableSetting, raw: string | undefined): Value | undefined {
  if (raw === undefined) return undefined;
  if (s.type === "bool") return raw === "1" || raw === "true" ? true : raw === "0" || raw === "false" ? false : undefined;
  if (raw.trim() === "") return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < s.min! || v > s.max! || (s.type === "int" && !Number.isInteger(v))) return undefined;
  return v;
}

export interface Resolved {
  values: Map<string, Value>; // path -> value in force (config.yaml's, or the owner's)
  applied: string[]; // paths where the owner's value is used
  ignored: string[]; // paths with a stored value that couldn't be used
}

/** What every editable config setting should be right now, from `base` (config.yaml) and the stored overrides. */
export function resolveOverrides(db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } }, base: Config): Resolved {
  const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'override.%'").all() as { key: string; value: string }[];
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const values = new Map<string, Value>();
  const applied = new Set<string>();
  const ignored: string[] = [];
  for (const s of CONFIG_SETTINGS) {
    values.set(s.path, getPath(base, s.path) as Value);
    if (!stored.has(s.key)) continue;
    const v = parseStored(s, stored.get(s.key));
    if (v === undefined) ignored.push(s.path);
    else {
      values.set(s.path, v);
      applied.add(s.path);
    }
  }
  const backToNormal = (path: string) => {
    if (!applied.delete(path)) return;
    values.set(path, getPath(base, path) as Value);
    ignored.push(path);
  };
  for (const [a, b] of EDITABLE.rules) {
    if (!values.has(a) || !values.has(b)) continue; // risk.* pairs: limits.ts checks those
    if (!((values.get(a) as number) < (values.get(b) as number))) {
      backToNormal(a);
      backToNormal(b);
    }
  }
  if (applied.size) {
    const candidate = structuredClone(base);
    for (const p of applied) setPath(candidate, p, values.get(p)!);
    if (!ConfigSchema.safeParse(candidate).success) for (const p of [...applied]) backToNormal(p);
  }
  return { values, applied: [...applied], ignored };
}

/**
 * Keep `cfg` (the object every part of the service already holds) in step with the dashboard:
 * applies the overrides now and every `everyMs`, changing only the editable fields, in place.
 * `onChange` runs after a change, for parts that copied a value at start.
 */
export function followOverrides(cfg: Config, db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } },
  opts: { everyMs?: number; onChange?: () => void } = {}): { refresh(): boolean; stop(): void } {
  const base = structuredClone(cfg);
  let last = "";
  const refresh = (): boolean => {
    let r: Resolved;
    try {
      r = resolveOverrides(db, base);
    } catch (err) {
      log.warn({ err: String(err) }, "could not read the dashboard's limits; keeping the current ones");
      return false;
    }
    let changed = false;
    for (const [p, v] of r.values) {
      if (getPath(cfg, p) !== v) {
        setPath(cfg, p, v);
        changed = true;
      }
    }
    const sig = JSON.stringify([r.applied, r.ignored]);
    if (sig !== last) {
      last = sig;
      const now = Object.fromEntries(r.applied.map((p) => [p, r.values.get(p)]));
      if (r.ignored.length) log.warn({ ignored: r.ignored }, "some dashboard limits can't be used (out of range or contradicting each other): config.yaml values apply");
      log.info({ owner: now }, r.applied.length ? "dashboard limits in force" : "no dashboard limits: config.yaml values");
    }
    if (changed) opts.onChange?.();
    return changed;
  };
  refresh();
  const timer = opts.everyMs === 0 ? null : setInterval(refresh, opts.everyMs ?? 5_000);
  timer?.unref();
  return { refresh, stop: () => timer && clearInterval(timer) };
}
