/**
 * Agent runtime config — reasoning modes + subagent + fusion orchestration.
 *
 * Layers:
 * 1. Provider effort (off/low/medium/high/max) — API thinking budget
 * 2. Libra harness profiles (ultra / ultra-fusion) — not provider effort enums
 *
 * ultra-fusion: main + secondary both reason; main compares traces + executes.
 */

import { loadConfig, saveConfig, type LibraConfig } from "../config/store.js";

/** Provider-native reasoning effort (when the model supports it). */
export type ProviderReasoningEffort =
  | "off"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "default";

/**
 * Libra harness profiles (not official model efforts like low/high).
 * Order: none < ultra < ultra-fusion
 */
export type CustomReasoningMode = "none" | "ultra" | "ultra-fusion";

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

/**
 * Multi-model fusion: main + secondaries all reason first;
 * then main compares both reasonings and executes with tools.
 */
export interface FusionConfig {
  /** Secondary reasoner model keys (provider/model). Main is always the session model. */
  modelKeys: string[];
  /** Optional preferred secondary (legacy field) */
  judgeModelKey?: string;
  /** Minimum secondary reasoners (default 1) */
  minModels: number;
  maxParallel: number;
  /**
   * Phase-1 reasoners use no tools. Main phase-2 always has tools.
   */
  reasoningOnly: boolean;
  /** Instructions for the shared phase-1 reasoning pass */
  analysisInstructions: string;
  /** Instructions for main when comparing both reasonings before execute */
  fuseInstructions: string;
}

export interface ReasoningConfig {
  /**
   * Global fallback effort when a model has no per-model override.
   * Actual API value is clamped to what the active model supports.
   */
  effort: ProviderReasoningEffort;
  /**
   * Per-model effort: key = "provider/model" → effort level.
   * This is the source of truth for which models use which native setting.
   */
  perModelEffort?: Record<string, string>;
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

/** Hard cap: one peer reasoner + main (never more). */
export const FUSION_MAX_SECONDARIES = 1;

export const DEFAULT_FUSION: FusionConfig = {
  modelKeys: [],
  judgeModelKey: undefined,
  minModels: 1,
  maxParallel: FUSION_MAX_SECONDARIES,
  reasoningOnly: true, // phase-1 reasoners only
  analysisInstructions:
    "Reason step-by-step. Cover risks, alternatives, and a concrete executable plan. No tool use in this pass.",
  fuseInstructions:
    "Compare your first-pass reasoning with the peer trace. Keep only what is correct, valuable, and actionable. Merge into one plan, then execute with tools.",
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
  // Migrate removed harness modes (deep/swarm were never provider-native)
  let custom = a.reasoning?.custom as string | undefined;
  if (custom === "deep" || custom === "swarm") custom = "none";
  if (
    custom !== "none" &&
    custom !== "ultra" &&
    custom !== "ultra-fusion"
  ) {
    custom = DEFAULT_AGENT_SETTINGS.reasoning.custom;
  }
  return {
    reasoning: {
      ...DEFAULT_AGENT_SETTINGS.reasoning,
      ...a.reasoning,
      custom: (custom ?? DEFAULT_AGENT_SETTINGS.reasoning.custom) as CustomReasoningMode,
      perModelEffort: {
        ...(DEFAULT_AGENT_SETTINGS.reasoning.perModelEffort ?? {}),
        ...(a.reasoning?.perModelEffort ?? {}),
      },
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
      perModelEffort:
        partial.reasoning?.perModelEffort ?? cur.reasoning.perModelEffort,
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
    // Prefer highest native effort; "max" is clamped per-model at request time
    if (
      next.reasoning.effort === "default" ||
      next.reasoning.effort === "off" ||
      next.reasoning.effort === "none" ||
      next.reasoning.effort === "low" ||
      next.reasoning.effort === "minimal"
    ) {
      next.reasoning.effort = "max";
    }
  }
  // Fusion: peer reasoners only in phase 1; hard-cap one additional agent
  next.reasoning.fusion.reasoningOnly = true;
  next.reasoning.fusion.maxParallel = FUSION_MAX_SECONDARIES;
  next.reasoning.fusion.minModels = 1;
  if (next.reasoning.fusion.modelKeys.length > FUSION_MAX_SECONDARIES) {
    next.reasoning.fusion.modelKeys = next.reasoning.fusion.modelKeys.slice(
      0,
      FUSION_MAX_SECONDARIES,
    );
  }

  saveConfig({ agent: next } as Partial<LibraConfig>);
  return next;
}

/** Full catalog — UI should filter via getCachedReasoningCaps for the active model. */
export const PROVIDER_EFFORT_OPTIONS: {
  value: ProviderReasoningEffort;
  label: string;
  description: string;
}[] = [
  { value: "default", label: "Model default", description: "Omit API reasoning field" },
  { value: "off", label: "Off", description: "Map to none/minimal when supported" },
  { value: "none", label: "None", description: "API: no reasoning tokens" },
  { value: "minimal", label: "Minimal", description: "API: minimal reasoning" },
  { value: "low", label: "Low", description: "API: low effort" },
  { value: "medium", label: "Medium", description: "API: medium effort" },
  { value: "high", label: "High", description: "API: high effort" },
  { value: "xhigh", label: "XHigh", description: "API: xhigh (not all models)" },
  { value: "max", label: "Max", description: "API: max (not all models)" },
];

export const CUSTOM_REASONING_OPTIONS: {
  value: CustomReasoningMode;
  label: string;
  description: string;
}[] = [
  {
    value: "none",
    label: "None",
    description: "No Libra harness profile",
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
      "Main + secondary both reason; main compares both and executes with tools",
  },
];

function structuredClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
