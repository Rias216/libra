/**
 * Headless child agent loop — isolated context, no parent store pollution.
 * Children never receive multi-agent tools (max_depth / no recursion).
 */

import type { ProviderId } from "../../auth/types.js";
import {
  chatComplete,
  type ChatMessage,
} from "../../llm/client.js";
import { ToolRunner } from "../../toolcalling/runner.js";
import type { PermissionRules } from "../../toolcalling/permissions.js";
import type { ToolsetId } from "../../toolcalling/registry.js";
import { parseToolArgs } from "../../toolcalling/normalize.js";
import { dbg, span } from "../debug.js";
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
  maxTokens?: number;
  lightReasoning?: boolean;
}

export async function runChildLoop(
  opts: ChildLoopOptions,
): Promise<ChildRunResult> {
  const label = opts.label ?? "subagent";
  const maxRounds = opts.maxRounds ?? MAX_CHILD_ROUNDS;
  const toolsUsed: string[] = [];
  let promptTok = 0;
  let completionTok = 0;

  const runner = new ToolRunner(opts.cwd, {
    headless: true,
    autoApprove: true,
    permissions: opts.permissions,
    toolsets: opts.toolsets,
  });
  runner.setSignal(opts.signal);

  const messages: ChatMessage[] = [...opts.messages];
  // Ensure system is first
  if (!messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: opts.system });
  } else {
    // Replace first system with ours
    const idx = messages.findIndex((m) => m.role === "system");
    if (idx >= 0) messages[idx] = { role: "system", content: opts.system };
  }

  const isFree = /:free$/i.test(opts.model) || /\/free$/i.test(opts.model);
  const turn = span("subagent", `${label}.run`, {
    model: `${opts.provider}/${opts.model}`,
  });

  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (opts.signal?.aborted) {
        return {
          text: "(subagent cancelled)",
          rounds: round - 1,
          toolsUsed,
          error: "cancelled",
          usage: {
            prompt_tokens: promptTok,
            completion_tokens: completionTok,
          },
        };
      }

      dbg("subagent", `${label}.round`, { round });
      const result = await chatComplete(
        {
          provider: opts.provider,
          model: opts.model,
          messages,
          tools: runner.registry.schemas(),
          tool_choice: "auto",
          temperature: 0.2,
          stream: true,
          applyNativeReasoning: !(opts.lightReasoning || isFree),
          reasoning_effort: opts.lightReasoning || isFree ? "low" : undefined,
          max_tokens:
            opts.maxTokens ??
            (isFree ? 8_192 : 16_384),
          signal: opts.signal,
          label: `${label}.r${round}`,
        },
        {},
      );

      if (result.usage) {
        promptTok += result.usage.prompt_tokens ?? 0;
        completionTok += result.usage.completion_tokens ?? 0;
      }

      if (!result.tool_calls.length) {
        const text =
          result.content?.trim() ||
          result.reasoning?.trim() ||
          "(subagent produced no text)";
        turn.end({ rounds: round, tools: toolsUsed.length });
        return {
          text,
          rounds: round,
          toolsUsed,
          usage: {
            prompt_tokens: promptTok,
            completion_tokens: completionTok,
          },
        };
      }

      messages.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.tool_calls,
      });

      const batch = await runner.runMany(
        result.tool_calls.map((tc, i) => ({
          id: tc.id || `c${i}`,
          name: tc.function.name,
          args: parseToolArgs(tc.function.arguments),
        })),
      );

      for (let i = 0; i < batch.length; i++) {
        const exec = batch[i]!;
        const tc = result.tool_calls[i]!;
        toolsUsed.push(tc.function.name);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: truncateChildTool(exec.output),
        });
      }
    }

    turn.end({ rounds: maxRounds, truncated: true });
    return {
      text: "(subagent hit max rounds — partial work may exist in the workspace)",
      rounds: maxRounds,
      toolsUsed,
      error: "max_rounds",
      usage: {
        prompt_tokens: promptTok,
        completion_tokens: completionTok,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    turn.end({ error: msg });
    return {
      text: `Subagent error: ${msg}`,
      rounds: 0,
      toolsUsed,
      error: msg,
      usage: {
        prompt_tokens: promptTok,
        completion_tokens: completionTok,
      },
    };
  }
}

function truncateChildTool(s: string, max = 12_000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated ${s.length - max} chars]`;
}
