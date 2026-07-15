/**
 * Stream sample → HarnessStore parts (OpenCode processor spirit, slim).
 * Owns text / reasoning / tool part lifecycle for one assistant message.
 * Never wipes text when tools start — parts coexist.
 *
 * Tool cards are deferred until the sample stream ends so the model can
 * finish talking (text/reasoning) before tool UI appears.
 */

import type { HarnessStore } from "../core/store.js";
import { newId } from "../core/types.js";
import type { StreamHandlers, ToolCall } from "../llm/client.js";
import {
  normalizeToolArgs,
  parseToolArgs,
} from "../toolcalling/normalize.js";
import { resolveToolName } from "../toolcalling/tool.js";

const BATCH_MS = 24;

/** Buffered mid-stream tool call (not yet shown in the UI). */
interface PendingToolCall {
  name: string;
  argsJson: string;
  callId?: string;
}

export interface SampleProcessor {
  handlers: StreamHandlers;
  /** Finalize streaming flags after chatComplete returns */
  finish(sample: {
    content: string;
    reasoning?: string;
    tool_calls: ToolCall[];
  }): void;
  /** Map tool index → store part id (for runtime status updates) */
  toolPartId(index: number): string | undefined;
  /** Ensure a tool part exists for a dispatch index; returns part id */
  ensureToolPart(
    index: number,
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): string;
  /**
   * Discard everything buffered/streamed from a failed attempt before
   * withRetry fires the next one. Without this, a transient mid-stream
   * error (dropped connection, 5xx) leaves partial text/reasoning already
   * pushed to the store, and the successful retry's deltas get appended
   * onto that stale content instead of replacing it — corrupting the
   * visible assistant message. Tool cards are never touched here: they
   * are only materialized in `finish()`, well after retries are done.
   */
  resetForRetry(): void;
  readonly textPartId: string;
  readonly reasoningPartId: string;
}

export function createSampleProcessor(
  store: HarnessStore,
  messageId: string,
): SampleProcessor {
  const textPartId = newId("p");
  const reasoningPartId = newId("p");
  let textStarted = false;
  let reasoningStarted = false;
  const toolPartIds = new Map<number, string>();
  /** Accumulate tool deltas silently until stream ends (model still talking). */
  const pendingTools = new Map<number, PendingToolCall>();
  let toolsFlushed = false;

  let textBuf = "";
  let reasonBuf = "";
  let textTimer: ReturnType<typeof setTimeout> | null = null;
  let reasonTimer: ReturnType<typeof setTimeout> | null = null;

  const flushText = () => {
    if (textTimer) {
      clearTimeout(textTimer);
      textTimer = null;
    }
    if (!textBuf) return;
    const d = textBuf;
    textBuf = "";
    if (!textStarted) {
      textStarted = true;
      store.appendPart(messageId, {
        id: textPartId,
        type: "text",
        content: d,
        streaming: true,
      });
    } else {
      store.textDelta(messageId, textPartId, d);
    }
  };

  const flushReason = () => {
    if (reasonTimer) {
      clearTimeout(reasonTimer);
      reasonTimer = null;
    }
    if (!reasonBuf) return;
    const d = reasonBuf;
    reasonBuf = "";
    if (!reasoningStarted) {
      reasoningStarted = true;
      store.appendPart(messageId, {
        id: reasoningPartId,
        type: "reasoning",
        content: d,
        streaming: true,
      });
    } else {
      store.reasoningDelta(messageId, reasoningPartId, d);
    }
  };

  /** Materialize buffered tool cards — only after text/reasoning have finished. */
  const flushPendingTools = () => {
    if (toolsFlushed) return;
    toolsFlushed = true;
    for (const [index, pending] of pendingTools) {
      if (toolPartIds.has(index)) continue;
      if (!pending.name) continue;
      const name = resolveToolName(pending.name);
      const pid = newId("p");
      toolPartIds.set(index, pid);
      const args = normalizeToolArgs(name, parseToolArgs(pending.argsJson));
      store.appendPart(messageId, {
        id: pid,
        type: "tool",
        toolName: name,
        args,
        callId: pending.callId,
        status: "pending",
      });
    }
    pendingTools.clear();
  };

  const handlers: StreamHandlers = {
    onText: (d) => {
      if (!d) return;
      textBuf += d;
      if (textTimer == null) {
        textTimer = setTimeout(flushText, BATCH_MS);
      }
    },
    onReasoning: (d) => {
      if (!d) return;
      reasonBuf += d;
      if (reasonTimer == null) {
        reasonTimer = setTimeout(flushReason, BATCH_MS);
      }
    },
    // Buffer only — do not show tool cards while the model is still talking.
    onToolCallDelta: (index, partial) => {
      if (toolsFlushed) {
        // Late delta after finish: update existing part if any
        const pid = toolPartIds.get(index);
        if (pid && partial.id) {
          store.patchPart(messageId, pid, { callId: partial.id } as never);
        }
        return;
      }
      let pending = pendingTools.get(index);
      if (!pending) {
        pending = { name: "", argsJson: "" };
        pendingTools.set(index, pending);
      }
      // Client (consumeOpenAIStream) sends cumulative name/args each delta.
      if (partial.function?.name) {
        const n = partial.function.name;
        if (n.length >= pending.name.length) pending.name = n;
        else if (!pending.name.includes(n)) pending.name += n;
      }
      if (partial.function?.arguments != null) {
        const a = partial.function.arguments;
        if (a.length >= pending.argsJson.length) pending.argsJson = a;
        else if (!pending.argsJson.includes(a)) pending.argsJson += a;
      }
      if (partial.id) pending.callId = partial.id;
    },
  };

  return {
    handlers,
    textPartId,
    reasoningPartId,
    toolPartId: (index) => toolPartIds.get(index),
    resetForRetry() {
      // Drop unflushed buffers and cancel their batch timers — nothing
      // from the failed attempt should leak into the retried stream.
      if (textTimer) {
        clearTimeout(textTimer);
        textTimer = null;
      }
      if (reasonTimer) {
        clearTimeout(reasonTimer);
        reasonTimer = null;
      }
      textBuf = "";
      reasonBuf = "";
      // Wipe any content already pushed to the store for this attempt.
      // Keep the same part ids / "started" bookkeeping so the next
      // flushText/flushReason call correctly appends (via textDelta)
      // onto a clean slate rather than creating a duplicate part.
      if (textStarted) {
        store.patchPart(messageId, textPartId, { content: "" } as never);
      }
      if (reasoningStarted) {
        store.patchPart(messageId, reasoningPartId, {
          content: "",
        } as never);
      }
      // Tool cards are only ever materialized in finish()/ensureToolPart,
      // which happen after a sample fully succeeds — so there should be
      // nothing to undo here. Clear defensively in case a future change
      // moves tool-call visibility earlier.
      pendingTools.clear();
      toolsFlushed = false;
    },
    ensureToolPart(index, name, args, callId) {
      // Tools are running — surface any still-buffered cards first
      flushPendingTools();
      let pid = toolPartIds.get(index);
      if (!pid) {
        pid = newId("p");
        toolPartIds.set(index, pid);
        store.appendPart(messageId, {
          id: pid,
          type: "tool",
          toolName: name,
          args,
          callId,
          status: "running",
          startedAt: Date.now(),
        });
      } else {
        store.toolStatus(messageId, pid, "running");
        store.patchPart(messageId, pid, {
          args,
          callId,
          toolName: name,
        } as never);
      }
      return pid;
    },
    finish(sample) {
      // 1) Finish talking first — flush all text/reasoning, clear streaming
      flushText();
      flushReason();

      // Reconcile text: use sample content if we never streamed
      const finalText = sample.content ?? "";
      if (textStarted) {
        // Prefer streamed content; if sample has more (e.g. post-process), use longer
        const msg = store.state.messages.find((m) => m.id === messageId);
        const part = msg?.parts.find((p) => p.id === textPartId);
        const cur =
          part && part.type === "text" ? part.content : "";
        if (finalText && finalText.length > cur.length) {
          store.patchPart(messageId, textPartId, {
            content: finalText,
            streaming: false,
          } as never);
        } else {
          store.patchPart(messageId, textPartId, {
            streaming: false,
          } as never);
        }
      } else if (finalText.trim()) {
        store.appendPart(messageId, {
          id: textPartId,
          type: "text",
          content: finalText,
        });
        textStarted = true;
      }

      const reasonText = sample.reasoning ?? "";
      if (reasoningStarted) {
        const msg = store.state.messages.find((m) => m.id === messageId);
        const part = msg?.parts.find((p) => p.id === reasoningPartId);
        const cur =
          part && part.type === "reasoning" ? part.content : "";
        // OpenCode: fold thoughts when the stream ends unless the user
        // explicitly expanded (collapsed === false) mid-stream.
        const keepOpen =
          part &&
          part.type === "reasoning" &&
          part.collapsed === false;
        const patch: {
          streaming: false;
          collapsed?: boolean;
          content?: string;
        } = { streaming: false };
        if (!keepOpen) patch.collapsed = true;
        if (
          reasonText &&
          reasonText.length > cur.length &&
          !cur.includes(reasonText)
        ) {
          patch.content = cur ? `${cur}\n\n${reasonText}` : reasonText;
        }
        store.patchPart(messageId, reasoningPartId, patch as never);
      } else if (reasonText.trim()) {
        store.appendPart(messageId, {
          id: reasoningPartId,
          type: "reasoning",
          content: reasonText,
          collapsed: true,
        });
        reasoningStarted = true;
      }

      // 2) Only after talking finished: surface tool cards
      // Prefer authoritative sample.tool_calls over mid-stream buffer
      for (let i = 0; i < sample.tool_calls.length; i++) {
        const tc = sample.tool_calls[i]!;
        if (!tc.function?.name) continue;
        const existing = pendingTools.get(i);
        pendingTools.set(i, {
          name: tc.function.name,
          argsJson: tc.function.arguments ?? existing?.argsJson ?? "{}",
          callId: tc.id || existing?.callId,
        });
      }
      flushPendingTools();
    },
  };
}
