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
