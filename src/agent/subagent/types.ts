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
