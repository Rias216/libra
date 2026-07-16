/**
 * Codex multi-agent v1–style thread types.
 * @see https://learn.chatgpt.com/docs/agent-configuration/subagents
 */

import type { ProviderId } from "../../auth/types.js";

export type AgentThreadStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "closed";

/** Grok-style capability modes mapped onto Libra toolsets/permissions. */
export type CapabilityMode = "read-only" | "read-write" | "execute" | "all";

export interface AgentThread {
  id: string;
  /** Role id (agent_type): explorer, worker, review, … */
  agentType: string;
  nickname: string;
  status: AgentThreadStatus;
  depth: number;
  provider: ProviderId;
  model: string;
  /** Initial task message */
  message: string;
  /** Accumulated conversation for resume / send_input */
  history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /** Final summary returned to parent */
  result?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  rounds?: number;
  toolsUsed?: string[];
  /** In-flight work */
  promise?: Promise<void>;
  /** Parent turn / prompt id — cancel only matches this turn */
  turnId?: string;
  /** Effective reasoning effort applied to child chat */
  reasoningEffort?: string;
  /** Effective capability mode (role default or spawn override) */
  capabilityMode?: CapabilityMode;
  /**
   * Peer/parent messages queued while running (Codex multi-agent v2).
   * Delivered on idle resume or auto-chained after the current run ends.
   */
  inbox?: Array<{ from: string; message: string; at: number }>;
  /** Cap auto-resume chains from peer inbox (prevent loops). */
  peerChainCount?: number;
  /**
   * Effective cwd for child tools (worktree path when isolated, else parent cwd).
   */
  cwd?: string;
  /** Git worktree path when isolation engaged (manual review/merge — no auto-merge). */
  worktreePath?: string;
  /** Branch created for the worktree (if any). */
  worktreeBranch?: string;
  /** Item key when spawned via batch fan-out (exactly-once assignment). */
  batchItem?: string;
  /** Accumulated child token usage (from runChildLoop). */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  /** Parsed ### Summary handoff (when child followed structured contract). */
  handoffSummary?: string;
  /** How many automatic retries were used for transient failures. */
  retries?: number;
}

/**
 * Extract a structured ### Summary handoff block from child result text.
 * Returns undefined when the child did not include the convention.
 */
export function extractHandoffSummary(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined;
  const m = text.match(
    /###\s*Summary\s*\r?\n([\s\S]*?)(?=\r?\n###\s|\r?\nTo continue this agent|$)/i,
  );
  const body = m?.[1]?.trim();
  if (!body) return undefined;
  return body.slice(0, 1200);
}

export interface MessageAgentArgs {
  agent_id: string;
  message: string;
}

export interface SpawnAgentArgs {
  /** Role / agent_type (Codex: explorer, worker, default, or custom) */
  agent_type?: string;
  /** Initial task for the subagent */
  message: string;
  /** Optional model key provider/model or bare model id */
  model?: string;
  /** Optional reasoning effort override */
  reasoning_effort?: string;
  /**
   * When true, include a short parent-context summary in the child system
   * prompt (Codex fork_context). Default false = fresh spawn.
   */
  fork_context?: boolean;
  /** Short UI label (3–5 words) */
  description?: string;
  /**
   * Override role sandbox tool permissions:
   * read-only | read-write | execute | all
   */
  capability_mode?: CapabilityMode | string;
  /**
   * Resume a completed same-session agent: continue prior history with
   * message as the new user turn. Soft-ignores model override on resume.
   */
  resume_from?: string;
  /**
   * Opt-in: run this workspace-write child in a fresh git worktree.
   * Also auto-triggers when ≥2 concurrent workspace-write children share cwd.
   * Path is reported for manual review/merge — never auto-merged.
   */
  isolate_worktree?: boolean;
}

/** Uniform per-item fan-out (spawn_agents_on_csv spirit). */
export interface SpawnAgentsBatchArgs {
  /**
   * Items to assign exactly once — array of strings, or a single CSV /
   * newline-separated string. Each item becomes one child.
   */
  items?: string[] | string;
  /** Alias for items as raw CSV / newline text. */
  csv_text?: string;
  /**
   * Task template. Use `{{item}}` (or `{item}`) as the per-item placeholder.
   * If omitted, the item string is the full message.
   */
  message?: string;
  message_template?: string;
  agent_type?: string;
  description?: string;
  model?: string;
  reasoning_effort?: string;
  capability_mode?: CapabilityMode | string;
  isolate_worktree?: boolean;
  fork_context?: boolean;
}

export interface GetAgentResultArgs {
  agent_id: string;
}

export interface WaitAgentArgs {
  /** Wait for these agents; omit = all open non-closed */
  agent_ids?: string[];
  /** Max wait ms (default from config) */
  timeout_ms?: number;
}

export interface SendInputArgs {
  agent_id: string;
  message: string;
}

export interface CloseAgentArgs {
  agent_id: string;
}

export interface ListAgentsArgs {
  /** Include closed threads */
  include_closed?: boolean;
}

export interface ChildRunResult {
  text: string;
  rounds: number;
  toolsUsed: string[];
  error?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/**
 * Canonical addresses for the root/parent agent mailbox (Codex multi-agent v2).
 * Children message any of these to reach the coordinating parent.
 */
export const PARENT_AGENT_IDS = ["parent", "root"] as const;

export type ParentAgentId = (typeof PARENT_AGENT_IDS)[number];

/** True when agent_id addresses the root/parent mailbox (not a child thread). */
export function isParentAgentId(id: string): boolean {
  const k = id.trim().toLowerCase();
  return (PARENT_AGENT_IDS as readonly string[]).includes(k);
}

/** Normalize parent aliases to the canonical id used in list_agents / notices. */
export function canonicalParentAgentId(id: string): ParentAgentId {
  const k = id.trim().toLowerCase();
  if (k === "root") return "root";
  return "parent";
}

export interface ParentInboxEntry {
  from: string;
  message: string;
  at: number;
}

/** Footer on completed agent results (Grok format_resume_footer spirit). */
export function formatResumeFooter(agentId: string): string {
  return `To continue this agent, spawn_agent with resume_from="${agentId}" and a new message (or use send_input).`;
}

/** Format completion notices for the parent wire transcript. */
export function formatCompletionNotices(
  items: Array<{
    id: string;
    agentType: string;
    status: AgentThreadStatus;
    resultPreview?: string;
  }>,
): string {
  if (!items.length) return "";
  return items
    .map((it) => {
      const preview = (it.resultPreview ?? "").slice(0, 400);
      return [
        `<subagent_completed id="${it.id}" type="${it.agentType}" status="${it.status}">`,
        preview,
        `</subagent_completed>`,
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * Build the mid-turn subagent notice message for the parent wire.
 * Always uses role **system** — never user — so completions are not
 * mistaken for user turns (session friction B2).
 */
export function buildSubagentNoticeMessage(rawDrainText: string): {
  role: "system";
  content: string;
} | null {
  const text = rawDrainText?.trim();
  if (!text) return null;
  const hasMail = text.includes("<agent_message");
  const hasDone = text.includes("<subagent_completed");
  const label =
    hasMail && hasDone
      ? "Subagent updates since last notice (completions + parent mailbox):"
      : hasMail
        ? "Parent mailbox messages since last notice:"
        : "Subagent(s) finished since last notice:";
  return {
    role: "system",
    content: `<system-reminder>\n${label}\n\n${text}\n</system-reminder>`,
  };
}

/**
 * Format child→root mailbox messages for the parent wire (same mid-turn
 * injection path as completion notices).
 */
export function formatParentMailboxNotices(
  items: ParentInboxEntry[],
): string {
  if (!items.length) return "";
  return items
    .map((it) => {
      const body = (it.message ?? "").slice(0, 2000);
      return [
        `<agent_message from="${it.from}" to="parent">`,
        body,
        `</agent_message>`,
      ].join("\n");
    })
    .join("\n\n");
}
