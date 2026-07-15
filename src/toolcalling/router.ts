/**
 * ToolRouter — map model tool_calls → dispatchable calls.
 * Codex tools/router.rs spirit (function call → ToolCall payload).
 */

import type { ToolCall } from "../llm/client.js";
import {
  normalizeToolArgs,
  parseToolArgs,
  toolFingerprint,
} from "./normalize.js";
import { resolveToolName } from "./tool.js";

export interface DispatchCall {
  /** Provider tool_call id (wire) */
  callId: string;
  /** Canonical Libra tool name */
  name: string;
  /** Raw name as emitted by the model */
  rawName: string;
  args: Record<string, unknown>;
  fingerprint: string;
  /** Original index in the model tool_calls array */
  index: number;
}

/**
 * Build dispatch list from model tool_calls.
 * Empty-name entries are dropped; args always parsed objects.
 */
export function buildDispatchCalls(toolCalls: ToolCall[]): DispatchCall[] {
  const out: DispatchCall[] = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    const rawName = tc.function?.name?.trim() ?? "";
    if (!rawName) continue;
    const name = resolveToolName(rawName);
    const args = normalizeToolArgs(
      name,
      parseToolArgs(tc.function?.arguments),
    );
    const callId =
      tc.id && tc.id.length > 0 ? tc.id : `call_${i}_${Date.now().toString(36)}`;
    out.push({
      callId,
      name,
      rawName,
      args,
      fingerprint: toolFingerprint(name, args),
      index: i,
    });
  }
  return out;
}

/** Normalize tool_calls for the wire assistant message (canonical names + ids). */
export function normalizeToolCallsForWire(toolCalls: ToolCall[]): ToolCall[] {
  return buildDispatchCalls(toolCalls).map((d) => ({
    id: d.callId,
    type: "function" as const,
    function: {
      name: d.name,
      arguments: JSON.stringify(d.args),
    },
  }));
}
