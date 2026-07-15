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
  /** When to use this role (surfaced in spawn_agent schema) */
  description?: string;
  instructions: string;
  modelKey?: string;
  /** Optional effort override for this role */
  reasoningEffort?: string;
  /**
   * Tool surface: read-only blocks write/shell (Codex sandbox_mode).
   * Default inferred from role id (explorer/review/security → read-only).
   */
  sandbox?: "read-only" | "workspace-write";
  enabled: boolean;
}

/**
 * Multi-agent settings (Codex multi_agent_v1 compatible).
 * - maxConcurrent ≈ agents.max_threads (default 6 in Codex)
 * - maxDepth ≈ agents.max_depth (default 1 — children cannot spawn)
 */
export interface SubagentConfig {
  enabled: boolean;
  /** Concurrent open agent threads (Codex agents.max_threads) */
  maxConcurrent: number;
  /**
   * Spawn nesting depth. Root=0; maxDepth=1 means root can spawn
   * children but children cannot spawn (Codex default).
   */
  maxDepth: number;
  /** Per-child wall-clock timeout in seconds (Codex job_max_runtime) */
  jobMaxRuntimeSeconds: number;
  /**
   * When true (Ultra / ultra-fusion), system prompt encourages proactive
   * spawn without an explicit user request.
   */
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
    description:
      "Read-only codebase explorer (Codex explorer). Gather evidence before changes.",
    instructions:
      "You are a read-only explore agent. Search the codebase, summarize findings with path:line refs, do not edit files.",
    sandbox: "read-only",
    enabled: true,
  },
  {
    id: "implement",
    name: "Implement",
    description:
      "Execution-focused worker (Codex worker). Small diffs + optional tests.",
    instructions:
      "You implement focused code changes. Prefer small diffs, run tests when possible. Summarize what changed for the parent.",
    sandbox: "workspace-write",
    enabled: true,
  },
  {
    id: "review",
    name: "Review",
    description: "Read-only PR/code review for correctness and risks.",
    instructions:
      "You review code for bugs, security, and style. Produce a structured findings list with path:line. Do not edit.",
    sandbox: "read-only",
    enabled: true,
  },
  {
    id: "test",
    name: "Test",
    description: "Write and run tests for the assigned scope.",
    instructions:
      "You write and run tests. Prefer failing tests first, then fix until green. Summarize coverage gaps.",
    sandbox: "workspace-write",
    enabled: true,
  },
  {
    id: "security",
    name: "Security",
    description: "Security audit: injection, secrets, auth, unsafe shell/file use.",
    instructions:
      "You audit for injection, secrets, auth flaws, and unsafe shell/file use. Report severity-ordered findings. Do not edit unless asked.",
    sandbox: "read-only",
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
    "Reason step-by-step about the USER request only. Cover risks, alternatives, and a concrete plan for what they asked. Do not invent a different project. No tool use in this pass.",
  fuseInstructions:
    "Compare traces against the user request. Keep what helps fulfill it; drop digressions. Execute that plan with tools. Use spawn_agent/wait_agent only for independent parallel work the user needs.",
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
    maxConcurrent: 6, // Codex agents.max_threads default
    maxDepth: 1, // Codex agents.max_depth default
    jobMaxRuntimeSeconds: 600,
    autoSpawn: false,
    roles: DEFAULT_SUBAGENT_ROLES.map((r) => ({ ...r })),
  },
};

/** Parsed agent settings cache (keyed by config.agent identity). */
let agentSettingsCache: { src: unknown; value: AgentSettings } | null = null;

export function loadAgentSettings(): AgentSettings {
  const cfg = loadConfig();
  const a = cfg.agent;
  if (agentSettingsCache && agentSettingsCache.src === a) {
    return agentSettingsCache.value;
  }
  if (!a) {
    const empty = structuredClone(DEFAULT_AGENT_SETTINGS);
    agentSettingsCache = { src: a, value: empty };
    return empty;
  }
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
  const value: AgentSettings = {
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
      maxDepth:
        a.subagents?.maxDepth ?? DEFAULT_AGENT_SETTINGS.subagents.maxDepth,
      jobMaxRuntimeSeconds:
        a.subagents?.jobMaxRuntimeSeconds ??
        DEFAULT_AGENT_SETTINGS.subagents.jobMaxRuntimeSeconds,
      maxConcurrent:
        a.subagents?.maxConcurrent ??
        DEFAULT_AGENT_SETTINGS.subagents.maxConcurrent,
      roles:
        a.subagents?.roles?.length
          ? a.subagents.roles
          : DEFAULT_SUBAGENT_ROLES.map((r) => ({ ...r })),
    },
  };
  agentSettingsCache = { src: a, value };
  return value;
}

export function saveAgentSettings(partial: {
  reasoning?: Partial<ReasoningConfig> & {
    fusion?: Partial<FusionConfig>;
  };
  subagents?: Partial<SubagentConfig>;
}): AgentSettings {
  agentSettingsCache = null;
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
  agentSettingsCache = { src: next, value: next };
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
    description:
      "No Libra harness profile — status bar uses native model effort only",
  },
  {
    value: "ultra",
    label: "Ultra",
    description:
      "Max effort + Codex-style multi-agent (spawn/wait) with proactive delegation",
  },
  {
    value: "ultra-fusion",
    label: "Ultra + Fusion",
    description:
      "Peer reasons first; main compares, then executes with multi-agent tools",
  },
];

function structuredClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
