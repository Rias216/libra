/**
 * Context compaction — soft digests + full session rollover at 80% of the
 * model's fetched context window (OpenCode-style overflow handling).
 *
 * Soft compact: shrink old tool/assistant payloads in-place (tool pairing safe).
 * Session compact: build a condensed transcript, then start a **new session**
 * seeded with that compacted context.
 */

import type { ChatMessage } from "../llm/client.js";
import type { Message } from "../core/types.js";
import { newId } from "../core/types.js";
import type { ProviderId } from "../auth/types.js";
import { getModelContextWindow } from "../auth/models.js";
import { approxTokensFromMessages } from "./history.js";

/** Fallback when the catalog has no context figure for the model. */
export const DEFAULT_COMPACT_TOKEN_BUDGET = 90_000;
/** Fraction of the model context window that triggers auto-compact. */
export const COMPACT_CONTEXT_RATIO = 0.8;
/** Keep this many most-recent messages fully intact. */
export const DEFAULT_KEEP_RECENT = 16;

export interface CompactOptions {
  tokenBudget?: number;
  keepRecent?: number;
  /** Digest length for collapsed tool results */
  digestChars?: number;
}

/**
 * Soft budget for a model: 80% of its fetched context window, or the
 * static fallback when the catalog has no figure.
 */
export function compactBudgetForModel(
  provider: ProviderId | string,
  model: string,
  fallback: number = DEFAULT_COMPACT_TOKEN_BUDGET,
): number {
  const ctx = getModelContextWindow(provider, model);
  if (ctx != null && ctx > 1024) {
    return Math.max(4_096, Math.floor(ctx * COMPACT_CONTEXT_RATIO));
  }
  return fallback;
}

export function shouldAutoCompact(
  messages: ChatMessage[],
  budget: number,
): boolean {
  if (budget <= 0) return false;
  return approxTokensFromMessages(messages) >= budget;
}

/**
 * Snap a "keep last N" cut so we never bisect an assistant tool_calls
 * message and its following tool-role results (Codex pairing invariant).
 * Returns the index of the first message in the "recent / keep intact" region.
 */
export function alignKeepRecentStart(
  messages: ChatMessage[],
  keepRecent: number,
  bodyStart = 0,
): number {
  const keep = Math.max(1, keepRecent);
  let cut = Math.max(bodyStart, messages.length - keep);
  // Walk back across any tool-role rows so the cut never starts mid-results.
  while (cut > bodyStart && messages[cut]?.role === "tool") {
    cut--;
  }
  // If we landed on the assistant that owns those tools, cut is correct
  // (assistant + following tools stay together in recent).
  // If the previous message is still a tool (shouldn't after loop), keep walking.
  while (cut > bodyStart && messages[cut - 1]?.role === "tool") {
    cut--;
  }
  if (
    cut > bodyStart &&
    messages[cut]?.role === "tool" &&
    messages[cut - 1]?.role === "assistant"
  ) {
    cut--;
  }
  return cut;
}

/**
 * In-place soft compact of a live messages array (system first).
 * Digests old tool results / long assistant text without breaking
 * tool_call pairing. Returns true if anything changed.
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
  const cutEnd = alignKeepRecentStart(messages, keep, start);
  let changed = false;

  for (let i = start; i < cutEnd; i++) {
    const m = messages[i]!;
    if (
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.length > digest
    ) {
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
    } else if (
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.length > 4000
    ) {
      messages[i] = {
        ...m,
        content: m.content.slice(0, 2500) + "\n…[compacted]",
      };
      changed = true;
    }
  }

  return changed;
}

export interface CompactedSession {
  /** Wire messages for the LLM (includes system if present in input). */
  wire: ChatMessage[];
  /** UI messages to seed the new session (no empty assistant shell). */
  uiMessages: Message[];
  beforeTokens: number;
  afterTokens: number;
  contextWindow: number | null;
  budget: number;
  /** Human summary line for status UI */
  summary: string;
}

/**
 * Build a compacted transcript suitable for seeding a **new session**.
 *
 * - Soft-digests older tool/assistant payloads
 * - Folds the middle of the conversation into one summary user turn
 * - Keeps the most recent messages intact (including the latest user prompt)
 */
export function buildCompactedSession(
  messages: ChatMessage[],
  opts: CompactOptions & {
    contextWindow?: number | null;
    budget?: number;
  } = {},
): CompactedSession {
  const budget = opts.budget ?? opts.tokenBudget ?? DEFAULT_COMPACT_TOKEN_BUDGET;
  const keep = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
  const contextWindow = opts.contextWindow ?? null;
  const beforeTokens = approxTokensFromMessages(messages);

  // Work on a copy
  const copy: ChatMessage[] = messages.map((m) => ({
    ...m,
    tool_calls: m.tool_calls?.map((tc) => ({
      ...tc,
      function: { ...tc.function },
    })),
  }));

  // Pass 1–3: progressive soft digests
  let digest = opts.digestChars ?? 200;
  let keepN = keep;
  for (let pass = 0; pass < 4; pass++) {
    if (approxTokensFromMessages(copy) <= budget) break;
    softCompactMessages(copy, {
      tokenBudget: budget,
      keepRecent: keepN,
      digestChars: digest,
    });
    digest = Math.max(60, Math.floor(digest * 0.55));
    keepN = Math.max(6, keepN - 2);
  }

  // Pass 4: fold older turns into a single summary if still over budget
  const hasSystem = copy[0]?.role === "system";
  const sys = hasSystem ? copy[0]! : null;
  const body = hasSystem ? copy.slice(1) : copy.slice();
  const keepRecent = Math.min(
    Math.max(4, keepN),
    Math.max(1, body.length),
  );
  // Pairing-safe cut: never start `recent` mid tool-result block
  const full = hasSystem ? copy : body;
  const bodyStart = hasSystem ? 1 : 0;
  const cut = alignKeepRecentStart(full, keepRecent, bodyStart);
  const recent = full.slice(cut);
  const older = full.slice(bodyStart, cut);

  let wire: ChatMessage[];
  if (
    older.length > 0 &&
    approxTokensFromMessages([...(sys ? [sys] : []), ...body]) > budget
  ) {
    const summaryText = foldOlderMessages(older);
    wire = [
      ...(sys ? [sys] : []),
      {
        role: "user",
        content:
          "[Compacted earlier context — prior turns were auto-summarized to free the context window]\n\n" +
          summaryText,
      },
      {
        role: "assistant",
        content:
          "Understood. I have the compacted earlier context and will continue from the recent turns below.",
      },
      ...recent,
    ];
  } else {
    wire = [...(sys ? [sys] : []), ...body];
  }

  // Final soft pass on wire if still slightly over
  softCompactMessages(wire, {
    tokenBudget: budget,
    keepRecent: Math.min(8, keepRecent),
    digestChars: 80,
  });

  const afterTokens = approxTokensFromMessages(wire);
  const uiMessages = wireToUiMessages(wire, {
    beforeTokens,
    afterTokens,
    contextWindow,
    budget,
  });

  const ctxLabel =
    contextWindow != null
      ? `${contextWindow.toLocaleString()} tok window`
      : "context window";
  const summary =
    `Context compacted · new session · ${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()} tok` +
    ` (budget ${budget.toLocaleString()} = 80% of ${ctxLabel})`;

  return {
    wire,
    uiMessages,
    beforeTokens,
    afterTokens,
    contextWindow,
    budget,
    summary,
  };
}

/** Flatten older turns into a short digest for the summary user message. */
function foldOlderMessages(older: ChatMessage[]): string {
  const lines: string[] = [];
  const maxLines = 80;
  const maxLine = 240;

  for (const m of older) {
    if (lines.length >= maxLines) {
      lines.push("…(additional earlier turns omitted)");
      break;
    }
    if (m.role === "system") continue;

    if (m.role === "user" && typeof m.content === "string") {
      const t = m.content.replace(/\s+/g, " ").trim();
      if (!t) continue;
      lines.push(`User: ${clip(t, maxLine)}`);
      continue;
    }

    if (m.role === "assistant") {
      const bits: string[] = [];
      if (typeof m.content === "string" && m.content.trim()) {
        bits.push(clip(m.content.replace(/\s+/g, " ").trim(), maxLine));
      }
      if (m.tool_calls?.length) {
        const names = m.tool_calls
          .map((tc) => tc.function?.name)
          .filter(Boolean)
          .join(", ");
        if (names) bits.push(`tools: ${names}`);
      }
      if (m.reasoning?.trim()) {
        bits.push(`thinking: ${clip(m.reasoning.replace(/\s+/g, " ").trim(), 120)}`);
      }
      if (bits.length) lines.push(`Assistant: ${bits.join(" · ")}`);
      continue;
    }

    if (m.role === "tool" && typeof m.content === "string") {
      const t = m.content.replace(/\s+/g, " ").trim();
      if (t) lines.push(`Tool: ${clip(t, 160)}`);
    }
  }

  return lines.join("\n");
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

/**
 * Convert compacted wire messages into UI Message[] for session seed.
 * Skips system (injected per turn). Adds a leading status banner.
 */
function wireToUiMessages(
  wire: ChatMessage[],
  meta: {
    beforeTokens: number;
    afterTokens: number;
    contextWindow: number | null;
    budget: number;
  },
): Message[] {
  const out: Message[] = [];

  const ctx =
    meta.contextWindow != null
      ? `${formatK(meta.contextWindow)} context`
      : "context";
  out.push({
    id: newId("m"),
    role: "assistant",
    createdAt: Date.now(),
    parts: [
      {
        id: newId("p"),
        type: "status",
        level: "info",
        message:
          `Context auto-compacted at 80% of ${ctx} ` +
          `(${formatK(meta.beforeTokens)} → ${formatK(meta.afterTokens)} tok). ` +
          `New session started with compacted history.`,
      },
    ],
  });

  // Pair tool results under assistant when possible — simplified UI seed
  let i = 0;
  while (i < wire.length) {
    const m = wire[i]!;
    if (m.role === "system") {
      i++;
      continue;
    }

    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text.trim()) {
        out.push({
          id: newId("m"),
          role: "user",
          createdAt: Date.now(),
          parts: [{ id: newId("p"), type: "text", content: text }],
        });
      }
      i++;
      continue;
    }

    if (m.role === "assistant") {
      const parts: Message["parts"] = [];
      if (m.reasoning?.trim()) {
        parts.push({
          id: newId("p"),
          type: "reasoning",
          content: m.reasoning.trim(),
          collapsed: true,
        });
      }
      if (typeof m.content === "string" && m.content.trim()) {
        parts.push({
          id: newId("p"),
          type: "text",
          content: m.content,
        });
      }
      // Attach following tool messages as tool parts when call ids match
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          let result: string | undefined;
          let status: "completed" | "error" = "completed";
          // Look ahead for tool role with this id
          for (let j = i + 1; j < wire.length; j++) {
            const t = wire[j]!;
            if (t.role === "tool" && t.tool_call_id === tc.id) {
              result =
                typeof t.content === "string" ? t.content : String(t.content ?? "");
              break;
            }
            if (t.role === "user" || t.role === "assistant") break;
          }
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}") as Record<
              string,
              unknown
            >;
          } catch {
            args = {};
          }
          parts.push({
            id: newId("p"),
            type: "tool",
            toolName: tc.function.name,
            args,
            callId: tc.id,
            status,
            result,
            collapsed: true,
          });
        }
      }
      if (parts.length) {
        out.push({
          id: newId("m"),
          role: "assistant",
          createdAt: Date.now(),
          parts,
        });
      }
      i++;
      continue;
    }

    // Standalone tool rows (orphans) — skip; should be attached above
    i++;
  }

  return out;
}

function formatK(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) {
    const s = (n / 1000).toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}k`;
  }
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
