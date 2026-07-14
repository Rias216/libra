/**
 * Persistent user config — theme, font, active model, agent settings.
 * Stored at ~/.libra/config.json
 *
 * Hot path: loadConfig() is called from paint / agent settings frequently.
 * Results are cached in memory and invalidated on saveConfig().
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentSettings } from "../agent/config.js";

export interface LibraConfig {
  theme: string;
  font: string;
  /** Active LLM provider id */
  provider?: string;
  /** Preferred model id for active provider */
  model?: string;
  /** Full key provider/model for multi-provider selection */
  modelKey?: string;
  /** Reasoning + subagent harness settings */
  agent?: AgentSettings;
}

const DEFAULTS: LibraConfig = {
  theme: "libra-night",
  font: "default",
};

/** In-memory cache — avoids sync disk I/O on every TUI paint */
let cached: LibraConfig | null = null;

function configPath(): string {
  return (
    process.env.LIBRA_CONFIG ?? join(homedir(), ".libra", "config.json")
  );
}

function readFromDisk(): LibraConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return { ...DEFAULTS };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<LibraConfig>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function loadConfig(): LibraConfig {
  if (cached) return cached;
  cached = readFromDisk();
  return cached;
}

export function saveConfig(partial: Partial<LibraConfig>): LibraConfig {
  const next = { ...loadConfig(), ...partial };
  cached = next;
  try {
    const p = configPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    // best-effort
  }
  return next;
}

/** Drop cache (tests / external config edits). */
export function invalidateConfigCache(): void {
  cached = null;
}
