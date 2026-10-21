import type { DB } from "../lib/db.js";
import { log } from "../lib/log.js";
import type { Features } from "../signals/filters.js";

/**
 * The learning brain's newest model (learner/brain.py writes one per night into brain_models).
 * The trader only predicts with it: the signal filters decide (filters.ts), and all the brain can
 * do there is add one more reason to skip. Same feature math as brain.py: keep them in step.
 */
interface FeatureSpec {
  name: string;
  kind: "num" | "log" | "bool" | "eq" | "missing";
  value?: string;
  of?: string;
  mean: number;
  std: number;
}

export interface BrainModel {
  version: string;
  active: boolean;
  threshold: number;
  features: FeatureSpec[];
  weights: number[];
  intercept: number;
}

/** Same cap as brain.py ROI_CAP. */
const ROI_CAP = 1;
const RELOAD_MS = 60_000;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function raw(f: Features, s: FeatureSpec): number | null {
  const v = f[s.kind === "missing" ? s.of! : s.name];
  switch (s.kind) {
    case "missing": return isNum(v) ? 0 : 1;
    case "bool": return v ? 1 : 0;
    case "eq": return v === s.value ? 1 : 0;
    case "log": return isNum(v) ? Math.log1p(Math.max(0, v)) : null;
    default: return isNum(v) ? v : null;
  }
}

/** Predicted follower ROI for these features. */
export function predict(m: BrainModel, f: Features): number {
  let s = m.intercept;
  m.features.forEach((spec, i) => {
    const x = raw(f, spec);
    if (x !== null && spec.std >= 1e-9) s += m.weights[i]! * ((x - spec.mean) / spec.std);
  });
  return Math.max(-1, Math.min(ROI_CAP, s));
}

export class Brain {
  private model: BrainModel | null = null;
  private modelId = 0;
  private checkedAt = -Infinity;

  constructor(private db: DB, private now: () => number = Date.now) {}

  /** The newest model, re-read at most once a minute. A broken row is ignored (the brain then just doesn't vote). */
  current(): BrainModel | null {
    if (this.now() - this.checkedAt < RELOAD_MS) return this.model;
    this.checkedAt = this.now();
    try {
      const row = this.db.prepare("SELECT id, model FROM brain_models ORDER BY id DESC LIMIT 1").get() as { id: number; model: string } | undefined;
      if (row && row.id !== this.modelId) {
        const m = JSON.parse(row.model) as BrainModel;
        if (!Array.isArray(m.features) || !Array.isArray(m.weights) || m.features.length !== m.weights.length || !isNum(m.intercept)) throw new Error("bad model shape");
        this.model = m;
        this.modelId = row.id;
        log.info({ version: m.version, active: m.active }, "learning brain model loaded");
      }
    } catch (err) {
      log.warn({ err: String(err) }, "learning brain model unreadable, ignoring it");
      this.model = null;
    }
    return this.model;
  }

  /** Features to store with the signal: what the brain predicts, and whether it may act on it. */
  features(f: Features): Features {
    const m = this.current();
    if (!m) return { brain_version: null };
    return { brain_version: m.version, brain_active: !!m.active, brain_pred: +predict(m, f).toFixed(4), brain_threshold: m.threshold };
  }
}
