/**
 * Package version — resolved at runtime for src/dist, frozen correctly
 * when embedded by `bun build --compile`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fallback when package.json is not adjacent (unusual layouts). */
export const VERSION_FALLBACK = "0.1.0";

/**
 * Resolve libra's package version relative to this module.
 * Works for:
 * - `bun src/cli.ts`  → src/version.ts → ../package.json
 * - `bun dist/cli.js` → dist/version.js → ../package.json
 * - compiled binary   → may embed file contents if present at compile time;
 *   otherwise falls back to VERSION_FALLBACK (keep in sync with package.json)
 */
export function getVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      join(here, "..", "package.json"),
      join(here, "..", "..", "package.json"),
    ]) {
      if (!existsSync(candidate)) continue;
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (parsed.version) return parsed.version;
    }
  } catch {
    /* compiled / stripped layout */
  }
  return VERSION_FALLBACK;
}
