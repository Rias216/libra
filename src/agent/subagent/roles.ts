/**
 * Built-in agent roles — Codex ships default / explorer / worker;
 * Libra maps those plus project roles (review, test, security).
 */

import {
  REASON_ROLE_INSTRUCTIONS,
  type SubagentRole,
} from "../config.js";
import type { ToolsetId } from "../../toolcalling/registry.js";
import type { PermissionRules } from "../../toolcalling/permissions.js";
import type { CapabilityMode } from "./types.js";

export type RoleSandbox = "read-only" | "workspace-write";

export interface ResolvedRole {
  id: string;
  name: string;
  description: string;
  instructions: string;
  modelKey?: string;
  reasoningEffort?: string;
  sandbox: RoleSandbox;
  /** Toolsets exposed to this role */
  toolsets: ToolsetId[];
  permissions: PermissionRules;
  /** Per-role child round budget (undefined → child-loop default). */
  maxRounds?: number;
  /**
   * Per-role wall-clock timeout seconds.
   * Always resolved (role override or defaultJobMaxRuntimeSecondsForRole).
   */
  jobMaxRuntimeSeconds: number;
}

/** Default maxRounds by role id when not configured. */
export function defaultMaxRoundsForRole(id: string): number {
  const k = id.trim().toLowerCase();
  if (k === "reason" || k === "think") return 6;
  if (k === "worker" || k === "implement") return 16;
  if (k === "explorer" || k === "explore") return 12;
  if (k === "review" || k === "test" || k === "security") return 10;
  if (k === "plan-writer" || k === "planner") return 12;
  if (k === "skeptic" || k === "verifier") return 10;
  if (k === "strategist") return 8;
  return 10; // default / general-purpose
}

/**
 * Default per-role wall-clock budget (seconds) when not configured.
 * Reason/explorer are short thinking/evidence passes; workers get longer
 * implementation time — must not all collapse to the global 600s default.
 */
export function defaultJobMaxRuntimeSecondsForRole(id: string): number {
  const k = id.trim().toLowerCase();
  if (k === "reason" || k === "think") return 180; // 3 min
  if (k === "explorer" || k === "explore") return 240; // 4 min
  if (k === "review" || k === "security") return 300; // 5 min
  if (k === "test") return 420; // 7 min
  if (k === "worker" || k === "implement") return 600; // 10 min
  if (k === "plan-writer" || k === "planner") return 300;
  if (k === "skeptic" || k === "verifier") return 360;
  if (k === "strategist") return 240;
  return 480; // default / general-purpose — 8 min
}

const DENY_WRITE: PermissionRules = {
  "*": "allow",
  write: "deny",
  write_file: "deny",
  search_replace: "deny",
  edit_file: "deny",
  run_terminal_command: "deny",
  run_shell: "deny",
  process: "deny",
};

const DENY_SHELL_ONLY: PermissionRules = {
  "*": "allow",
  run_terminal_command: "deny",
  run_shell: "deny",
  process: "deny",
};

const FULL_WRITE: PermissionRules = {
  "*": "allow",
  run_terminal_command: {
    "*": "allow",
    "rm -rf *": "deny",
    "git push --force *": "deny",
  },
};

/**
 * Map Grok capability_mode onto toolsets + permissions.
 * Explicit spawn override wins over role sandbox.
 */
export function applyCapabilityMode(
  role: ResolvedRole,
  mode?: CapabilityMode | string | null,
): ResolvedRole {
  const m = normalizeCapabilityMode(mode);
  if (!m) return role;

  switch (m) {
    case "read-only":
      return {
        ...role,
        sandbox: "read-only",
        toolsets: ["fs", "search", "web", "meta"],
        permissions: { ...DENY_WRITE },
      };
    case "read-write":
      return {
        ...role,
        sandbox: "workspace-write",
        toolsets: ["fs", "search", "web", "meta"],
        permissions: { ...DENY_SHELL_ONLY },
      };
    case "execute":
    case "all":
      return {
        ...role,
        sandbox: "workspace-write",
        toolsets: ["fs", "search", "shell", "web", "meta", "process"],
        permissions: { ...FULL_WRITE },
      };
    default:
      return role;
  }
}

export function normalizeCapabilityMode(
  mode?: string | null,
): CapabilityMode | undefined {
  if (!mode || typeof mode !== "string") return undefined;
  const k = mode.trim().toLowerCase().replace(/_/g, "-");
  if (
    k === "read-only" ||
    k === "read-write" ||
    k === "execute" ||
    k === "all"
  ) {
    return k;
  }
  return undefined;
}

/** Default capability label for role (for tool descriptions). */
export function defaultCapabilityForRole(role: ResolvedRole): CapabilityMode {
  return role.sandbox === "read-only" ? "read-only" : "execute";
}

/** Codex-compatible built-ins (always available when multi-agent is on). */
export const CODEX_BUILTIN_ROLES: Array<
  SubagentRole & {
    description: string;
    sandbox: RoleSandbox;
    reasoningEffort?: string;
  }
> = [
  {
    id: "default",
    name: "Default",
    description:
      "General-purpose subagent for mixed research and implementation.",
    instructions:
      "You are a general-purpose coding subagent. Complete the assigned task thoroughly. Prefer specialized file tools over shell. Return a concise summary of findings and changes for the parent agent.",
    sandbox: "workspace-write",
    enabled: true,
  },
  {
    id: "reason",
    name: "Reason",
    description:
      "Deep multi-angle reasoning specialist (read-only). Extends parent thinking.",
    instructions: REASON_ROLE_INSTRUCTIONS,
    sandbox: "read-only",
    reasoningEffort: "max",
    enabled: true,
  },
  {
    id: "explorer",
    name: "Explorer",
    description:
      "Read-only codebase explorer for gathering evidence before changes.",
    instructions:
      "Stay in exploration mode. Trace real execution paths, cite files and symbols, and avoid proposing large rewrites unless asked. Prefer search and targeted reads over broad scans. Do not edit files or run destructive commands. Return a distilled evidence summary for the parent.",
    sandbox: "read-only",
    enabled: true,
  },
  {
    id: "worker",
    name: "Worker",
    description:
      "Execution-focused agent for implementation, fixes, and validation.",
    instructions:
      "Own the assigned implementation task. Make the smallest defensible change, keep unrelated files untouched, and validate when practical (tests/typecheck). Return a concise summary of what you changed and how to verify.",
    sandbox: "workspace-write",
    enabled: true,
  },
  {
    id: "plan-writer",
    name: "Plan Writer",
    description:
      "Goal-mode plan writer: fail-closed structured plan (criteria + verification + checklist).",
    instructions:
      "You write a single structured goal plan (outcomes not architecture). Include Acceptance criteria, Verification plan, Non-goals, and Task checklist. Write only the plan file; do not implement. Fail-closed: never return an empty plan.",
    sandbox: "workspace-write",
    enabled: true,
  },
  {
    id: "skeptic",
    name: "Skeptic",
    description:
      "Adversarial goal verifier: default to refute; audit implementer evidence.",
    instructions:
      "You are an adversarial verifier. Default to refuted:true if uncertain. Audit tests and captured evidence; do not author a parallel suite. Write verdict with refuted: true|false and ## Gaps. Do not modify product code.",
    sandbox: "read-only",
    enabled: true,
  },
  {
    id: "strategist",
    name: "Strategist",
    description:
      "Goal-mode strategist: advisory restructure after repeated NotAchieved.",
    instructions:
      "Write an advisory strategy note after repeated verification failures. Do NOT rewrite frozen acceptance criteria. Suggest a different approach that still satisfies the same criteria.",
    sandbox: "workspace-write",
    enabled: true,
  },
];

/** Map Libra role ids ↔ Codex aliases. */
const ALIASES: Record<string, string> = {
  explore: "explorer",
  implement: "worker",
  explorer: "explorer",
  worker: "worker",
  default: "default",
  reason: "reason",
  think: "reason",
  planner: "plan-writer",
  "plan_writer": "plan-writer",
  verifier: "skeptic",
  "goal-strategist": "strategist",
};

export function canonicalRoleId(id: string): string {
  const k = id.trim().toLowerCase().replace(/\s+/g, "_");
  return ALIASES[k] ?? k;
}

export function resolveRole(
  agentType: string | undefined,
  configRoles: SubagentRole[],
): ResolvedRole {
  const id = canonicalRoleId(agentType || "default");

  // Prefer user-configured role with matching id
  const custom = configRoles.find(
    (r) => r.enabled && canonicalRoleId(r.id) === id,
  );
  if (custom) {
    return fromConfigRole(custom);
  }

  // Codex builtins
  const builtin = CODEX_BUILTIN_ROLES.find((r) => r.id === id);
  if (builtin) {
    return fromConfigRole(builtin);
  }

  // Fallback: any config role by name
  const byName = configRoles.find(
    (r) =>
      r.enabled &&
      r.name.toLowerCase().replace(/\s+/g, "_") === id,
  );
  if (byName) return fromConfigRole(byName);

  // Default general-purpose
  return fromConfigRole(CODEX_BUILTIN_ROLES[0]!);
}

function fromConfigRole(
  r: SubagentRole & { description?: string; sandbox?: RoleSandbox },
): ResolvedRole {
  const id = canonicalRoleId(r.id);
  const sandbox: RoleSandbox =
    r.sandbox ??
    (id === "explorer" ||
    id === "explore" ||
    id === "reason" ||
    id === "review" ||
    id === "security" ||
    id === "skeptic" ||
    id === "verifier"
      ? "read-only"
      : "workspace-write");

  const toolsets: ToolsetId[] =
    sandbox === "read-only"
      ? ["fs", "search", "web", "meta"]
      : ["fs", "search", "shell", "web", "meta", "process"];

  const permissions: PermissionRules =
    sandbox === "read-only" ? { ...DENY_WRITE } : { ...FULL_WRITE };

  const maxRounds =
    typeof r.maxRounds === "number" && r.maxRounds > 0
      ? Math.floor(r.maxRounds)
      : defaultMaxRoundsForRole(id);
  const jobMaxRuntimeSeconds =
    typeof r.jobMaxRuntimeSeconds === "number" && r.jobMaxRuntimeSeconds > 0
      ? Math.floor(r.jobMaxRuntimeSeconds)
      : defaultJobMaxRuntimeSecondsForRole(id);

  return {
    id,
    name: r.name,
    description:
      r.description ??
      (r.instructions.slice(0, 120) || `Role ${r.name}`),
    instructions: r.instructions,
    modelKey: r.modelKey,
    reasoningEffort: (r as { reasoningEffort?: string }).reasoningEffort,
    sandbox,
    toolsets,
    permissions,
    maxRounds,
    jobMaxRuntimeSeconds,
  };
}

/** Roles advertised in spawn_agent schema enum / description. */
export function listSpawnableRoles(configRoles: SubagentRole[]): ResolvedRole[] {
  const out: ResolvedRole[] = [];
  const seen = new Set<string>();

  for (const b of CODEX_BUILTIN_ROLES) {
    if (!b.enabled) continue;
    // User override wins if same id
    const override = configRoles.find(
      (r) => r.enabled && canonicalRoleId(r.id) === b.id,
    );
    const resolved = fromConfigRole(override ?? b);
    out.push(resolved);
    seen.add(resolved.id);
  }

  for (const r of configRoles) {
    if (!r.enabled) continue;
    const id = canonicalRoleId(r.id);
    if (seen.has(id)) continue;
    out.push(fromConfigRole(r));
    seen.add(id);
  }

  return out;
}

export function roleCatalogText(roles: ResolvedRole[]): string {
  return roles
    .map((r) => `- ${r.id}: ${r.description} [${r.sandbox}]`)
    .join("\n");
}
