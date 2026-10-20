import pino from "pino";
import { env } from "./config.js";

// Anything that could carry a secret is redacted, and URLs are scrubbed of api-key params.
export const log = pino({
  level: env.logLevel,
  redact: {
    paths: ["*.apiKey", "*.api_key", "*.privateKey", "*.private_key", "*.secret", "*.token", "*.botToken"],
    censor: "[redacted]",
  },
});

export function scrubUrl(url: string): string {
  return url.replace(/(api[-_]?key=)[^&]+/gi, "$1***");
}
