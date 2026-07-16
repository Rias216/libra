/**
 * System prompts — per provider/model style packs + env injection.
 *
 * Routing (see prompts/packs.ts):
 *   claude → anthropic, gpt-4/o1/o3 → beast, codex-model → codex style pack,
 *   gpt → gpt, gemini → gemini, kimi → kimi, grok/xai → grok, else → default
 *
 * Product identity: Libra (shared LIBRA_IDENTITY in packs).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getPromptPack,
  listPromptPackIds,
  selectPromptPackId,
  type PromptPackId,
} from "./prompts/packs.js";
import { shellEnvHint } from "../toolcalling/shell-win.js";

export type PromptProfile = "full" | "slim";

export type SystemPromptOptions = {
  /** User/custom reasoning instructions appended at the end */
  extra?: string;
  model?: string;
  provider?: string;
  cwd?: string;
  /** Skip loading AGENTS.md / .libra/instructions (tests). Default false. */
  skipProjectInstructions?: boolean;
  /**
   * full = provider-routed pack (default).
   * slim = short system for light turns / benches.
   */
  profile?: PromptProfile;
  /**
   * Force a specific pack (tests / advanced). When set, skips auto-routing
   * unless profile is slim (slim always wins).
   */
  pack?: PromptPackId;
};

/** Max chars of project instruction files injected into the system prompt. */
const PROJECT_INSTRUCTIONS_MAX = 12_000;

export {
  selectPromptPackId,
  listPromptPackIds,
  getPromptPack,
  type PromptPackId,
};

/**
 * Load optional project instructions (OpenCode instruction.ts spirit).
 * Prefers AGENTS.md, then .libra/instructions, then .libra/INSTRUCTIONS.md.
 */
export function loadProjectInstructions(cwd: string): string | undefined {
  const candidates = [
    join(cwd, "AGENTS.md"),
    join(cwd, ".libra", "instructions"),
    join(cwd, ".libra", "INSTRUCTIONS.md"),
    join(cwd, ".libra", "instructions.md"),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8").trim();
      if (!raw) continue;
      const body =
        raw.length > PROJECT_INSTRUCTIONS_MAX
          ? raw.slice(0, PROJECT_INSTRUCTIONS_MAX) +
            `\n\n…[truncated ${raw.length - PROJECT_INSTRUCTIONS_MAX} chars]`
          : raw;
      return `# Project instructions\n(from ${p.replace(/\\/g, "/")})\n\n${body}`;
    } catch {
      /* ignore unreadable */
    }
  }
  return undefined;
}

function buildEnvBlock(
  o: SystemPromptOptions,
  cwd: string,
  isGit: boolean,
): string {
  const modelLine = o.model?.trim()
    ? o.provider?.trim()
      ? `Active model: ${o.model} (${o.provider}/${o.model})`
      : `Active model: ${o.model}`
    : undefined;
  return [
    modelLine,
    `Here is some useful information about the environment you are running in:`,
    `<env>`,
    `  Working directory: ${cwd}`,
    `  Is directory a git repo: ${isGit ? "yes" : "no"}`,
    `  Platform: ${process.platform}`,
    shellEnvHint(),
    `  Today's date: ${new Date().toDateString()}`,
    `</env>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function resolvePromptPackId(o: SystemPromptOptions): PromptPackId {
  if ((o.profile ?? "full") === "slim") return "slim";
  if (o.pack) return o.pack;
  return selectPromptPackId(o.provider, o.model);
}

/** Short system for light turns, subagents, and cheap benches. */
export function buildSlimSystemPrompt(o: SystemPromptOptions = {}): string {
  return buildSystemPrompt({ ...o, profile: "slim" });
}

export function buildSystemPrompt(
  opts?: string | SystemPromptOptions,
): string {
  const o: SystemPromptOptions =
    typeof opts === "string" ? { extra: opts } : (opts ?? {});

  const cwd = o.cwd?.trim() || process.cwd();
  let isGit = false;
  try {
    isGit = existsSync(join(cwd, ".git"));
  } catch {
    isGit = false;
  }

  const packId = resolvePromptPackId(o);
  const base = getPromptPack(packId);
  const env = buildEnvBlock(o, cwd, isGit);

  const parts = [base, env];
  if (!o.skipProjectInstructions) {
    const project = loadProjectInstructions(cwd);
    if (project) parts.push(project);
  }
  if (o.extra?.trim()) {
    parts.push(`# Additional instructions\n${o.extra.trim()}`);
  }
  return parts.join("\n\n");
}

/** Rough size helper for benches / debug. */
export function promptProfileStats(
  profile: PromptProfile = "full",
  opts?: SystemPromptOptions,
): { profile: PromptProfile; pack: PromptPackId; chars: number; approxTokens: number } {
  const pack = resolvePromptPackId({ ...opts, profile });
  const text = buildSystemPrompt({
    ...opts,
    profile,
    skipProjectInstructions: true,
  });
  return {
    profile,
    pack,
    chars: text.length,
    approxTokens: Math.ceil(text.length / 4),
  };
}

/** Debug helper: which pack a provider/model would get. */
export function explainPromptRouting(
  provider?: string,
  model?: string,
): { pack: PromptPackId; provider?: string; model?: string } {
  return {
    pack: selectPromptPackId(provider, model),
    provider,
    model,
  };
}
