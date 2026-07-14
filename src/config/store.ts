/**
 * Persistent user config — theme, font, active model, agent settings.
 * Stored at ~/.libra/config.json
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

function configPath(): string {
  return (
    process.env.LIBRA_CONFIG ?? join(homedir(), ".libra", "config.json")
  );
}

export function loadConfig(): LibraConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return { ...DEFAULTS };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<LibraConfig>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(partial: Partial<LibraConfig>): LibraConfig {
  const next = { ...loadConfig(), ...partial };
  try {
    const p = configPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    // best-effort
  }
  return next;
}
