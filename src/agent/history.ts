/**
 * Store / message history → OpenAI chat wire format.
 * OpenCode message-v2 + Codex tool pairing spirit:
 * strict tool_calls ↔ tool-role results with real callIds.
 */

import type { HarnessStore } from "../core/store.js";
import type { Message, Part, ToolPart } from "../core/types.js";
import {
  attachInTurnReasoning,
  type ChatMessage,
  type ToolCall,
} from "../llm/client.js";
import {
  TOOL_OUTPUT_HISTORY_MAX,
  truncateToolOutput,
} from "../toolcalling/truncate.js";

export interface HistoryOptions {
  /** Max messages from store tail (default 48). */
  maxMessages?: number;
  /** Cap tool result chars in cross-turn history. */
  toolOutputMaxChars?: number;
  /** Attach reasoning parts to assistant wire msgs (default true for in-context CoT). */
  includeReasoning?: boolean;
}

/**
 * Convert store messages to OpenAI chat messages.
 * Skips trailing empty assistant shell (current turn).
 * Incomplete tool parts (no callId + no result) are dropped — never invent ids.
 */
export function historyToMessages(
  store: HarnessStore,
  opts: HistoryOptions = {},
): ChatMessage[] {
  return messagesToWire(store.state.messages, {
    ...opts,
    skipTrailingEmptyAssistant: true,
  });
}

export function messagesToWire(
  messages: Message[],
  opts: HistoryOptions & { skipTrailingEmptyAssistant?: boolean } = {},
): ChatMessage[] {
  const max = opts.maxMessages ?? 48;
  const toolMax = opts.toolOutputMaxChars ?? TOOL_OUTPUT_HISTORY_MAX;
  const includeReasoning = opts.includeReasoning !== false;
  const msgs = messages.slice(-max);
  const out: ChatMessage[] = [];

  for (let mi = 0; mi < msgs.length; mi++) {
    const m = msgs[mi]!;
    if (
      opts.skipTrailingEmptyAssistant &&
      m.role === "assistant" &&
      m.parts.length === 0 &&
      mi === msgs.length - 1
    ) {
      continue;
    }

    if (m.role === "user") {
      const text = textFromParts(m.parts);
      if (text) out.push({ role: "user", content: text });
      continue;
    }

    if (m.role === "assistant") {
      const text = textFromParts(m.parts);
      const reasoning = includeReasoning ? reasoningFromParts(m.parts) : "";
      const tools = m.parts.filter(
        (p): p is ToolPart => p.type === "tool",
      );

      // Only include tools that have a real callId (completed wire round)
      const wireable = tools.filter(
        (p) =>
          p.callId &&
          p.callId.length > 0 &&
          (p.status === "completed" ||
            p.status === "error" ||
            p.status === "cancelled"),
      );

      if (wireable.length) {
        const toolCalls: ToolCall[] = wireable.map((p) => ({
          id: p.callId!,
          type: "function" as const,
          function: {
            name: p.toolName,
            arguments: JSON.stringify(p.args ?? {}),
          },
        }));

        out.push(
          attachInTurnReasoning(
            {
              role: "assistant",
              content: text.trim() ? text : null,
              tool_calls: toolCalls,
            },
            reasoning,
          ),
        );

        for (let i = 0; i < wireable.length; i++) {
          const p = wireable[i]!;
          const tc = toolCalls[i]!;
          out.push({
            role: "tool",
            tool_call_id: tc.id,
            content: toolPartBody(p, toolMax),
          });
        }
      } else if (text || reasoning) {
        out.push(
          attachInTurnReasoning(
            { role: "assistant", content: text || null },
            reasoning,
          ),
        );
      }
    }
  }

  return out;
}

function textFromParts(parts: Part[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.content : ""))
    .join("\n");
}

function reasoningFromParts(parts: Part[]): string {
  return parts
    .filter((p) => p.type === "reasoning")
    .map((p) => (p.type === "reasoning" ? p.content : ""))
    .filter(Boolean)
    .join("\n\n");
}

function toolPartBody(p: ToolPart, max: number): string {
  if (p.status === "completed" && p.result != null) {
    return truncateToolOutput(String(p.result), max) || "(empty result)";
  }
  if (p.status === "error" && p.error) {
    return truncateToolOutput(`ERROR: ${String(p.error)}`, max);
  }
  if (p.status === "cancelled") {
    return "aborted by user";
  }
  return `[${p.status}]`;
}

/** Rough token estimate (chars/4) for soft compaction. */
export function approxTokensFromMessages(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") n += m.content.length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        n += tc.function.name.length + (tc.function.arguments?.length ?? 0);
      }
    }
  }
  return Math.ceil(n / 4);
}
