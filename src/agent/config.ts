/**
 * Agent runtime config — reasoning modes + subagent + fusion orchestration.
 *
 * Layers:
 * 1. Provider effort (off/low/medium/high/max) — API thinking budget
 * 2. Libra custom modes (deep/swarm/ultra/ultra-fusion) — harness behavior
 *    independent of per-model native reasoning flags
 *
 * ultra-fusion: multi-model side-by-side REASONING ONLY, then fuse.
 */

import { loadConfig, saveConfig, type LibraConfig } from "../config/store.js";

/** Provider-native reasoning effort (when the model supports it). */
export type ProviderReasoningEffort =
  | "off"
  | "low"
  | "medium"
  | "high"
  | "max"
  | "default";

/**
 * Libra harness reasoning profiles — custom, not fetched from providers.
 * Order of power: none < deep < swarm < ultra < ultra-fusion
 */
export type CustomReasoningMode =
  | "none"
  | "deep"
  | "swarm"
  | "ultra"
  | "ultra-fusion";

export interface SubagentRole {
  id: string;
  name: string;
  instructions: string;
  modelKey?: string;
  enabled: boolean;
}

export interface SubagentConfig {
  enabled: boolean;
  maxConcurrent: number;
  autoSpawn: boolean;
  preferredModelKey?: string;
  roles: SubagentRole[];
}

/** Multi-model reasoning fusion (REASONING ONLY — no tools/edits). */
export interface FusionConfig {
  /** provider/model keys to run side-by-side */
  modelKeys: string[];
  /** Judge that fuses candidates; empty = highest reasoning model */
  judgeModelKey?: string;
  minModels: number;
  maxParallel: number;
  /** Always true for this product surface */
  reasoningOnly: boolean;
  analysisInstructions: string;
  fuseInstructions: string;
}

export interface ReasoningConfig {
  effort: ProviderReasoningEffort;
  custom: CustomReasoningMode;
  customInstructions: string;
  fusion: FusionConfig;
}

export interface AgentSettings {
  reasoning: ReasoningConfig;
  subagents: SubagentConfig;
}

export const DEFAULT_SUBAGENT_ROLES: SubagentRole[] = [
  {
    id: "explore",
    name: "Explore",
    instructions:
      "You are a read-only explore agent. Search the codebase, summarize findings, do not edit files.",
    enabled: true,
  },
  {
    id: "implement",
    name: "Implement",
    instructions:
      "You implement focused code changes. Prefer small diffs, run tests when possible.",
    enabled: true,
  },
  {
    id: "review",
    name: "Review",
    instructions:
      "You review code for bugs, security, and style. Produce a structured findings list.",
    enabled: true,
  },
  {
    id: "test",
    name: "Test",
    instructions:
      "You write and run tests. Prefer failing tests first, then fix until green.",
    enabled: true,
  },
  {
    id: "security",
    name: "Security",
    instructions:
      "You audit for injection, secrets, auth flaws, and unsafe shell/file use.",
    enabled: false,
  },
];

export const DEFAULT_FUSION: FusionConfig = {
  modelKeys: [],
  judgeModelKey: undefined,
  minModels: 2,
  maxParallel: 4,
  reasoningOnly: true,
  analysisInstructions:
    "Reason step-by-step. Cover risks, alternatives, and a concrete plan. No tool use.",
  fuseInstructions:
    "Compare candidates, pick the strongest arguments, produce one fused analysis and plan. Reasoning only.",
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  reasoning: {
    effort: "default",
    custom: "none",
    customInstructions: "",
    fusion: { ...DEFAULT_FUSION },
  },
  subagents: {
    enabled: true,
    maxConcurrent: 4,
    autoSpawn: false,
    roles: DEFAULT_SUBAGENT_ROLES.map((r) => ({ ...r })),
  },
};

export function loadAgentSettings(): AgentSettings {
  const cfg = loadConfig();
  const a = cfg.agent;
  if (!a) return structuredClone(DEFAULT_AGENT_SETTINGS);
  return {
    reasoning: {
      ...DEFAULT_AGENT_SETTINGS.reasoning,
      ...a.reasoning,
      fusion: {
        ...DEFAULT_FUSION,
        ...a.reasoning?.fusion,
        modelKeys: a.reasoning?.fusion?.modelKeys ?? [],
        reasoningOnly: true,
      },
    },
    subagents: {
      ...DEFAULT_AGENT_SETTINGS.subagents,
      ...a.subagents,
      roles:
        a.subagents?.roles?.length
          ? a.subagents.roles
          : DEFAULT_SUBAGENT_ROLES.map((r) => ({ ...r })),
    },
  };
}

export function saveAgentSettings(partial: {
  reasoning?: Partial<ReasoningConfig> & {
    fusion?: Partial<FusionConfig>;
  };
  subagents?: Partial<SubagentConfig>;
}): AgentSettings {
  const cur = loadAgentSettings();
  const next: AgentSettings = {
    reasoning: {
      ...cur.reasoning,
      ...partial.reasoning,
      fusion: {
        ...cur.reasoning.fusion,
        ...partial.reasoning?.fusion,
        modelKeys:
          partial.reasoning?.fusion?.modelKeys ?? cur.reasoning.fusion.modelKeys,
        reasoningOnly: true,
      },
      customInstructions:
        partial.reasoning?.customInstructions ?? cur.reasoning.customInstructions,
    },
    subagents: {
      ...cur.subagents,
      ...partial.subagents,
      roles: partial.subagents?.roles ?? cur.subagents.roles,
    },
  };

  if (next.reasoning.custom === "ultra" || next.reasoning.custom === "ultra-fusion") {
    next.subagents.enabled = true;
    next.subagents.autoSpawn = true;
    if (next.reasoning.effort === "default" || next.reasoning.effort === "off") {
      next.reasoning.effort = "max";
    }
  }
  // Fusion is reasoning-only by product rule
  next.reasoning.fusion.reasoningOnly = true;

  saveConfig({ agent: next } as Partial<LibraConfig>);
  return next;
}

export const PROVIDER_EFFORT_OPTIONS: {
  value: ProviderReasoningEffort;
  label: string;
  description: string;
}[] = [
  { value: "off", label: "Off", description: "No extended reasoning" },
  { value: "low", label: "Low", description: "Light thinking budget" },
  { value: "medium", label: "Medium", description: "Balanced" },
  { value: "high", label: "High", description: "Deep reasoning" },
  { value: "max", label: "Max", description: "Highest effort the API allows" },
  {
    value: "default",
    label: "Model default",
    description: "Leave effort to the provider",
  },
];

export const CUSTOM_REASONING_OPTIONS: {
  value: CustomReasoningMode;
  label: string;
  description: string;
}[] = [
  {
    value: "none",
    label: "None",
    description: "No Libra harness reasoning profile",
  },
  {
    value: "deep",
    label: "Deep",
    description: "Highest reasoning model + long plan before edits",
  },
  {
    value: "swarm",
    label: "Swarm",
    description: "Manual multi-agent; spawn roles on demand",
  },
  {
    value: "ultra",
    label: "Ultra",
    description:
      "Auto-spawns subagents + max effort on the strongest reasoning model",
  },
  {
    value: "ultra-fusion",
    label: "Ultra + Fusion",
    description:
      "REASONING ONLY — multi-model side-by-side, analyze, fuse best result",
  },
];

function structuredClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
