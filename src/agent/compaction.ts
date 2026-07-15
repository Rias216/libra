/**
 * Soft context compaction (OpenCode overflow-light).
 * Collapses old tool results without breaking tool_call pairing.
 */

import type { ChatMessage } from "../llm/client.js";
import { approxTokensFromMessages } from "./history.js";

/** Soft budget before we digests older tool outputs (~100k tokens-ish of chars). */
export const DEFAULT_COMPACT_TOKEN_BUDGET = 90_000;
/** Keep this many most-recent messages fully intact. */
export const DEFAULT_KEEP_RECENT = 16;

export interface CompactOptions {
  tokenBudget?: number;
  keepRecent?: number;
  /** Digest length for collapsed tool results */
  digestChars?: number;
}

/**
 * In-place soft compact of a live messages array (system first).
 * Returns true if anything changed.
 */
export function softCompactMessages(
  messages: ChatMessage[],
  opts: CompactOptions = {},
): boolean {
  const budget = opts.tokenBudget ?? DEFAULT_COMPACT_TOKEN_BUDGET;
  const keep = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
  const digest = opts.digestChars ?? 200;

  if (approxTokensFromMessages(messages) <= budget) return false;
  if (messages.length <= keep + 1) return false;

  // Keep system (index 0 if present) + last `keep` messages fully
  const hasSystem = messages[0]?.role === "system";
  const start = hasSystem ? 1 : 0;
  const cutEnd = Math.max(start, messages.length - keep);
  let changed = false;

  for (let i = start; i < cutEnd; i++) {
    const m = messages[i]!;
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > digest) {
      const preview = m.content.slice(0, digest).replace(/\s+/g, " ").trim();
      messages[i] = {
        ...m,
        content: `[tool result compacted: ${m.content.length} chars] ${preview}…`,
      };
      changed = true;
    } else if (
      m.role === "assistant" &&
      typeof m.content === "string" &&
      m.content.length > 2000 &&
      !m.tool_calls?.length
    ) {
      messages[i] = {
        ...m,
        content: m.content.slice(0, 1500) + "\n…[compacted]",
      };
      changed = true;
    }
  }

  return changed;
}
