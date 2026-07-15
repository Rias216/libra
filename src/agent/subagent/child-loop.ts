/**
 * Headless child agent loop — shared runHeadlessTurn (Codex/OpenCode shape).
 * Isolated context, no parent store pollution.
 * Children never receive multi-agent tools (max_depth / no recursion).
 */

import type { ProviderId } from "../../auth/types.js";
import type { ChatMessage } from "../../llm/client.js";
import type { PermissionRules } from "../../toolcalling/permissions.js";
import type { ToolsetId } from "../../toolcalling/registry.js";
import { runHeadlessTurn } from "../turn.js";
import type { ChildRunResult } from "./types.js";

const MAX_CHILD_ROUNDS = 8;

export interface ChildLoopOptions {
  provider: ProviderId;
  model: string;
  cwd: string;
  system: string;
  /** Full history including the new user task as last user message */
  messages: ChatMessage[];
  toolsets: ToolsetId[];
  permissions: PermissionRules;
  signal?: AbortSignal;
  label?: string;
  maxRounds?: number;
  lightReasoning?: boolean;
}

export async function runChildLoop(
  opts: ChildLoopOptions,
): Promise<ChildRunResult> {
  const messages: ChatMessage[] = [...opts.messages];
  // Ensure system is first
  if (!messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: opts.system });
  } else {
    const idx = messages.findIndex((m) => m.role === "system");
    if (idx >= 0) messages[idx] = { role: "system", content: opts.system };
  }

  const result = await runHeadlessTurn({
    provider: opts.provider,
    model: opts.model,
    cwd: opts.cwd,
    tools: true,
    toolsets: opts.toolsets,
    permissions: opts.permissions,
    autoApprove: true,
    abortSignal: opts.signal,
    label: opts.label ?? "subagent",
    maxSteps: opts.maxRounds ?? MAX_CHILD_ROUNDS,
    lightReasoning: opts.lightReasoning,
    headless: true,
    headlessMessages: messages,
  });

  return {
    text: result.finalText,
    rounds: result.rounds,
    toolsUsed: result.toolsUsed,
    error: result.error,
    usage: {
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
    },
  };
}
