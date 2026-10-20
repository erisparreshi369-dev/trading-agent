import pino from "pino";
import { env } from "./config.js";

type Sink = (level: "warn" | "error" | "fatal", obj: Record<string, unknown>, msg: string) => void;
let sink: Sink | null = null;

/**
 * Route errors (and warnings logged with `alert: true`) to the alert outbox. Each service calls
 * this once it has a database. Failures inside the sink are swallowed: logging must never throw.
 */
export function setAlertSink(fn: Sink | null): void {
  sink = fn;
}

// Anything that could carry a secret is redacted, and URLs are scrubbed of api-key params.
export const log = pino({
  level: env.logLevel,
  redact: {
    paths: ["*.apiKey", "*.api_key", "*.privateKey", "*.private_key", "*.secret", "*.token", "*.botToken"],
    censor: "[redacted]",
  },
  hooks: {
    logMethod(args, method, level) {
      if (sink && (level >= 50 || (level === 40 && typeof args[0] === "object" && (args[0] as { alert?: boolean })?.alert))) {
        try {
          const [a, b] = args as unknown[];
          const obj = typeof a === "object" && a !== null ? (a as Record<string, unknown>) : {};
          const msg = typeof a === "string" ? a : typeof b === "string" ? b : "";
          sink(level >= 60 ? "fatal" : level >= 50 ? "error" : "warn", obj, msg);
        } catch {
          // never let alerting break logging
        }
      }
      return method.apply(this, args);
    },
  },
});

export function scrubUrl(url: string): string {
  return url.replace(/(api[-_]?key=)[^&\s"']+/gi, "$1***");
}

/** Remove anything token-shaped from text that is about to leave the machine. */
export function scrubSecrets(text: string): string {
  return scrubUrl(text)
    .replace(/\b(bot)?\d{6,}:[A-Za-z0-9_-]{30,}/g, "***") // Telegram bot tokens, with or without the URL's "bot" prefix
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "***");
}
