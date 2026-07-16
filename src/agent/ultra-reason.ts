/**
 * Ultra forced multi-agent reasoning extension.
 *
 * When harness mode is `ultra`, the parent does not rely on the model
 * voluntarily calling spawn_agent. Before the main sample loop we:
 *   1. spawn parallel high-effort reason/explorer subagents
 *   2. wait for their briefs
 *   3. inject those briefs into the parent system + Thought UI
 *
 * This heavily extends reasoning via subagents by construction.
 */

import type { SubagentRuntime } from "./subagent/runtime.js";
import { formatResumeFooter } from "./subagent/types.js";
import { dbg, span } from "./debug.js";

/** Parallel angles forced on every Ultra turn. */
export const ULTRA_REASON_ANGLES = [
  {
    id: "primary",
    agent_type: "reason",
    description: "Deep reason",
    effort: "max",
    buildMessage: (userPrompt: string) =>
      [
        "ULTRA REASONING EXTENSION — primary deep pass.",
        "",
        "User request:",
        userPrompt,
        "",
        "Think thoroughly from first principles. Cover:",
        "- Restated goal and constraints",
        "- Multiple viable approaches (not just one)",
        "- Risks, edge cases, and unknowns",
        "- Concrete recommended plan with ordered steps",
        "",
        "Note: a sibling adversarial pass will challenge this plan.",
        "Prefer checkable steps; do not assume the shortest path is best.",
        "",
        "Use read/search tools when evidence would strengthen the plan.",
        "Do NOT implement or edit files.",
        "Return a structured brief:",
        "  Findings | Approaches | Recommended plan | Risks | Open questions",
      ].join("\n"),
  },
  {
    id: "adversarial",
    agent_type: "reason",
    description: "Adversarial reason",
    effort: "max",
    buildMessage: (userPrompt: string) =>
      [
        "ULTRA REASONING EXTENSION — adversarial critique.",
        "",
        "User request:",
        userPrompt,
        "",
        "Your brief is BINDING review for the parent — not optional color commentary.",
        "The parent MUST dispose of every deal-breaker and fold stronger-plan steps",
        "that still fit the user's explicit constraints.",
        "",
        "Assume the obvious / minimal plan is incomplete or wrong.",
        "Attack assumptions, missing requirements, security/perf traps,",
        "and coordination hazards.",
        "",
        "If the user asked for minimal scope: still propose the strongest plan",
        "compatible with that constraint (cheap verifications, missing checks,",
        "safety nets) — do NOT invent unrelated product scope.",
        "",
        "Prefer concrete, checkable steps over abstract philosophy.",
        "Use read/search only if needed for evidence. Do NOT implement.",
        "",
        "Return a structured brief with ALL sections:",
        "  Critiques | Stronger plan (ordered steps) | Deal-breakers | Mitigations",
      ].join("\n"),
  },
  {
    id: "evidence",
    agent_type: "explorer",
    description: "Evidence map",
    effort: "high",
    buildMessage: (userPrompt: string) =>
      [
        "ULTRA REASONING EXTENSION — evidence map.",
        "",
        "User request:",
        userPrompt,
        "",
        "Map relevant code paths, files, symbols, and prior art in this repo.",
        "Cite path:line. Prefer targeted search over dumping whole files.",
        "Do NOT edit files or run mutating shell.",
        "Flag evidence that supports or weakens the obvious plan.",
        "Return a structured brief:",
        "  Key files | Call paths / symbols | Gaps | Implications for the plan",
      ].join("\n"),
  },
] as const;

/**
 * Parent-facing instructions that make adversarial briefs binding.
 * Exported for tests / fusion-style reuse.
 */
export function buildUltraSystemAddon(body: string): string {
  return [
    "# Ultra forced reasoning extension (subagents)",
    "The harness already ran parallel high-effort reasoning subagents on the user request.",
    "Their briefs are below and in Thought blocks.",
    "",
    "## Binding execution rules (do not skip)",
    "1. **PRIMARY** = baseline plan only — not the final plan by default.",
    "2. **ADVERSARIAL** is binding review. You MUST:",
    "   - Address **every Deal-breaker**: Accept, Mitigate, or Reject.",
    "   - Reject only with a concrete reason tied to an **explicit user constraint**",
    "     (e.g. \"no refactors\", \"minimal change\") — never because the primary plan was shorter.",
    "   - Fold **Stronger plan** / **Mitigations** into execution when they still satisfy",
    "     the user request (cheap checks, missing requirements, safety).",
    "   - **Ignoring adversarial content is a failure mode.** Do not silently drop Critiques.",
    "3. **EVIDENCE**: prefer cited paths over re-exploring from scratch when the map is adequate;",
    "   only re-fetch when evidence is missing, stale, or contradicted.",
    "4. \"Minimal\" / \"keep scope tight\" does **not** license ignoring risk — apply low-cost",
    "   adversarial mitigations; only reject scope-expanding steps that violate the ask.",
    "5. **Before the first tool call**, in your reasoning, write a short disposition table:",
    "   `| Adversarial item | Accept / Mitigate / Reject | Why | Action |`",
    "   covering deal-breakers and the top stronger-plan steps. Then execute the merged plan.",
    "6. Continue using multi-agent tools for independent parallel execution when useful",
    "   (spawn N in background, keep working, wait_agent only when you need results).",
    "7. Do not re-derive the whole plan solo; build on these briefs after disposition.",
    "",
    body,
  ].join("\n");
}

/** Label a forced-angle body so the parent can tell primary vs adversarial. */
export function formatUltraAngleSection(part: {
  title: string;
  content: string;
  agentId?: string;
  angle: string;
}): string {
  const angle = part.angle.toLowerCase();
  const binding =
    angle === "adversarial"
      ? "\n> **BINDING REVIEW** — dispose every deal-breaker; fold stronger-plan steps that fit the ask."
      : angle === "primary"
        ? "\n> Baseline plan only — must be reconciled with adversarial before execute."
        : angle === "evidence"
          ? "\n> Prefer these citations over blind re-exploration."
          : "";
  return `### ${part.title} [${part.angle}] (${part.agentId ?? "?"})${binding}\n${part.content}`;
}

export interface UltraReasonPart {
  title: string;
  content: string;
  agentId?: string;
  agentType: string;
  angle: string;
}

export interface UltraReasonExtensionResult {
  /** Inject into parent system prompt */
  systemAddon: string;
  /** Single block body for seedReasoning / history CoT */
  displayReasoning: string;
  /** Per-angle Thought parts for the TUI */
  parts: UltraReasonPart[];
  agentIds: string[];
  /** Wall time for the forced wait */
  ms: number;
  /** How many angles produced usable text */
  okCount: number;
}

function stripResumeFooter(text: string, agentId: string): string {
  const footer = formatResumeFooter(agentId);
  return text.replace(footer, "").trim();
}

/**
 * Force-spawn Ultra reasoning subagents, wait, and format briefs for the parent.
 * Safe no-op when runtime cannot spawn or the prompt is empty.
 */
export async function forceUltraReasoningExtension(
  runtime: SubagentRuntime,
  userPrompt: string,
  opts?: {
    signal?: AbortSignal;
    onPhase?: (label: string) => void;
    /** Override default angles (tests) */
    angles?: typeof ULTRA_REASON_ANGLES | readonly (typeof ULTRA_REASON_ANGLES)[number][];
    /** Wait timeout ms (default: runtime job timeout) */
    timeoutMs?: number;
  },
): Promise<UltraReasonExtensionResult> {
  const empty: UltraReasonExtensionResult = {
    systemAddon: "",
    displayReasoning: "",
    parts: [],
    agentIds: [],
    ms: 0,
    okCount: 0,
  };

  const prompt = userPrompt.trim();
  if (!prompt) return empty;
  if (!runtime.canSpawn) {
    dbg("ultra", "force_reason.skip", { reason: "cannot_spawn" });
    return empty;
  }
  if (opts?.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const angles = opts?.angles ?? ULTRA_REASON_ANGLES;
  opts?.onPhase?.("ultra · forcing reasoning subagents…");
  const phase = span("ultra", "force_reason", {
    angles: angles.length,
    promptLen: prompt.length,
  });
  const t0 = Date.now();

  const spawned: Array<{
    angle: (typeof angles)[number];
    agentId: string;
  }> = [];

  for (const angle of angles) {
    if (opts?.signal?.aborted) break;
    const r = await runtime.spawn({
      agent_type: angle.agent_type,
      message: angle.buildMessage(prompt),
      description: angle.description,
      reasoning_effort: angle.effort,
      capability_mode: "read-only",
      fork_context: true,
    });
    if (r.ok && r.agent_id) {
      spawned.push({ angle, agentId: String(r.agent_id) });
      dbg("ultra", "force_reason.spawned", {
        angle: angle.id,
        agentId: r.agent_id,
        type: angle.agent_type,
      });
    } else {
      dbg("ultra", "force_reason.spawn_failed", {
        angle: angle.id,
        error: r.error,
      });
    }
  }

  if (spawned.length === 0) {
    phase.end({ ok: false, reason: "no_spawns" });
    return empty;
  }

  opts?.onPhase?.(
    `ultra · waiting on ${spawned.length} reasoning subagent${spawned.length === 1 ? "" : "s"}…`,
  );

  const wait = await runtime.wait({
    agent_ids: spawned.map((s) => s.agentId),
    timeout_ms: opts?.timeoutMs,
  });

  const agentResults = new Map<string, { result?: string; status?: string; error?: string }>();
  const agents = Array.isArray(wait.agents) ? wait.agents : [];
  for (const a of agents) {
    const row = a as {
      agent_id?: string;
      result?: string;
      status?: string;
      error?: string;
    };
    if (row.agent_id) {
      agentResults.set(String(row.agent_id), {
        result: row.result,
        status: row.status,
        error: row.error,
      });
    }
  }

  const parts: UltraReasonPart[] = [];
  for (const s of spawned) {
    const row = agentResults.get(s.agentId);
    const raw =
      (row?.result ?? row?.error ?? "").toString().trim() ||
      "(no result from subagent)";
    const content = stripResumeFooter(raw, s.agentId);
    parts.push({
      title: `Ultra · ${s.angle.description}`,
      content: content.slice(0, 24_000),
      agentId: s.agentId,
      agentType: s.angle.agent_type,
      angle: s.angle.id,
    });
  }

  const okCount = parts.filter(
    (p) => p.content && !p.content.startsWith("(no result"),
  ).length;
  const ms = Date.now() - t0;

  // Prefer adversarial last among reason briefs so binding review is fresh
  // before the parent executes; evidence after for citation support.
  const orderRank = (angle: string): number => {
    const a = angle.toLowerCase();
    if (a === "primary") return 0;
    if (a === "evidence") return 1;
    if (a === "adversarial") return 2;
    return 3;
  };
  const ordered = [...parts].sort(
    (a, b) => orderRank(a.angle) - orderRank(b.angle),
  );

  const body = ordered.map((p) => formatUltraAngleSection(p)).join("\n\n");
  const systemAddon = buildUltraSystemAddon(body);

  const displayReasoning = [
    "Ultra forced multi-agent reasoning",
    "Adversarial review is binding — disposition required before execute.",
    "",
    body,
  ].join("\n");

  dbg("ultra", "force_reason.done", {
    agents: spawned.length,
    okCount,
    ms,
    chars: body.length,
  });
  phase.end({ ok: okCount > 0, agents: spawned.length, okCount, ms });

  return {
    systemAddon,
    displayReasoning,
    parts,
    agentIds: spawned.map((s) => s.agentId),
    ms,
    okCount,
  };
}
