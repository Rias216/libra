/**
 * OpenAI-compatible chat client (OpenRouter, xAI, OpenAI, custom).
 * Streaming + tool_calls for fast agent loops.
 */

import type { ProviderId } from "../auth/types.js";
import { getProvider } from "../auth/types.js";
import { resolveTokenFresh } from "../auth/api-key.js";
import { getCredential } from "../auth/store.js";
import type { OpenAITool } from "../toolcalling/schema.js";
import { buildReasoningApiFields } from "../agent/reasoning.js";
import { dbg, dbgTrace, modelTag, span } from "../agent/debug.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /**
   * In-turn reasoning / CoT to replay on the next model call (tool loop).
   * OpenRouter-style field; mirrored to reasoning_content for DeepSeek-like APIs.
   * Matches codex (reasoning persists across tool rounds) + opencode interleaved replay.
   */
  reasoning?: string;
  /** OpenAI-compatible alias used by DeepSeek / some gateways */
  reasoning_content?: string;
}

/**
 * Attach mid-turn reasoning so tool-loop follow-ups keep CoT context.
 * Codex: reasoning persists across in-turn tool rounds.
 * OpenCode: interleaved providers re-send reasoning_content / reasoning on assistant msgs.
 * Empty / whitespace reasoning is omitted (no empty fields).
 */
export function attachInTurnReasoning(
  msg: ChatMessage,
  reasoning: string | null | undefined,
): ChatMessage {
  const r = (reasoning ?? "").trim();
  if (!r) return msg;
  return {
    ...msg,
    reasoning: r,
    reasoning_content: r,
  };
}

/**
 * Build the assistant message for a tool-call round of the agent loop.
 * Content may be empty/null when the model only planned + called tools.
 */
export function buildAssistantToolRoundMessage(opts: {
  content?: string | null;
  tool_calls: ToolCall[];
  reasoning?: string | null;
}): ChatMessage {
  return attachInTurnReasoning(
    {
      role: "assistant",
      content: opts.content?.trim() ? opts.content : null,
      tool_calls: opts.tool_calls,
    },
    opts.reasoning,
  );
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface StreamHandlers {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCallDelta?: (index: number, partial: Partial<ToolCall>) => void;
  /** First token (text, reasoning, or tool) */
  onFirstToken?: (kind: "text" | "reasoning" | "tool", ms: number) => void;
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  tool_calls: ToolCall[];
  finish_reason: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
  };
  /** Wall time to first token (stream) or first content */
  ttftMs?: number;
  /** Total request wall time */
  durationMs?: number;
}

export interface ChatRequest {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /**
   * @deprecated Prefer native fields from buildReasoningApiFields.
   * Still accepted for callers that pass an explicit override.
   */
  reasoning_effort?: string;
  /** When true (default), apply per-model native reasoning API fields */
  applyNativeReasoning?: boolean;
  /** Optional abort */
  signal?: AbortSignal;
  /** Debug label (fusion main, fusion peer, execute, …) */
  label?: string;
}

/**
 * Libra does NOT set completion max_tokens by default.
 * Reasoning / answer length is unlimited from our side — only the provider
 * or an explicit ChatRequest.max_tokens may cap output.
 *
 * Anthropic Messages API still requires a max_tokens field; use this only there.
 */
export const ANTHROPIC_REQUIRED_MAX_TOKENS = 200_000;
/** @deprecated No longer applied — max_tokens omitted by default. */
export const OUTPUT_TOKEN_MAX = ANTHROPIC_REQUIRED_MAX_TOKENS;
/** @deprecated No longer applied. */
export const OUTPUT_TOKEN_TOOLS = ANTHROPIC_REQUIRED_MAX_TOKENS;
/** @deprecated No longer applied. */
export const OUTPUT_TOKEN_FREE = ANTHROPIC_REQUIRED_MAX_TOKENS;
/** @deprecated No longer applied. */
export const OUTPUT_TOKEN_CHAT = ANTHROPIC_REQUIRED_MAX_TOKENS;
/** Max auto-continuations after finish_reason=length (provider hit its own cap). */
export const MAX_LENGTH_CONTINUATIONS = 2;

export function isFreeModelId(model: string): boolean {
  return /:free$/i.test(model) || /\/free$/i.test(model);
}

/**
 * Only returns a value when the caller explicitly requested one.
 * Default is undefined → do not send max_tokens (unlimited from Libra).
 */
export function resolveMaxOutputTokens(opts: {
  model?: string;
  tools?: boolean;
  explicit?: number;
  lengthContinuation?: boolean;
}): number | undefined {
  if (opts.explicit != null && opts.explicit > 0) return opts.explicit;
  return undefined;
}

/** True when the provider hit the output token cap mid-response. */
export function isLengthFinish(finish: string | null | undefined): boolean {
  if (!finish) return false;
  const f = finish.toLowerCase();
  return f === "length" || f === "max_tokens" || f === "max_output_tokens";
}

/**
 * User-side continuation nudge after a length cut-off.
 * OpenCode/Codex keep the loop alive; we ask the model to resume speaking
 * without redoing tools when the prior content is already partial.
 */
export function lengthContinuationNudge(partialContent: string): string {
  const tail = partialContent.trim().slice(-200);
  if (tail) {
    return (
      "Your previous response was cut off by the output token limit. " +
      "Continue EXACTLY from where you left off — do not restart, do not repeat prior text, " +
      "do not call tools unless essential. Last visible tail:\n" +
      `"""${tail}"""`
    );
  }
  return (
    "Your previous response was cut off by the output token limit " +
    "(often because reasoning used the whole budget). " +
    "Continue with the final user-facing answer now. Prefer brief reasoning. Do not call tools unless essential."
  );
}

/**
 * True when tool_call.function.arguments is empty or not valid JSON.
 * Common when finish_reason=length mid-stream before the arg object closed.
 */
export function isIncompleteToolArguments(
  args: string | null | undefined,
): boolean {
  const a = (args ?? "").trim();
  if (!a) return true;
  try {
    JSON.parse(a);
    return false;
  } catch {
    return true;
  }
}

/** Any tool call in the batch has incomplete/truncated arguments. */
export function hasBrokenToolCallArgs(
  toolCalls: Array<{ function?: { arguments?: string } }>,
): boolean {
  return toolCalls.some((tc) =>
    isIncompleteToolArguments(tc.function?.arguments),
  );
}

let toolIdSeq = 0;
function ensureToolId(id: string | undefined, index: number): string {
  if (id && id.length > 0) return id;
  toolIdSeq += 1;
  return `call_${Date.now().toString(36)}_${index}_${toolIdSeq}`;
}

/** Normalize provider tool_calls (fill missing ids, coerce type). */
export function normalizeToolCalls(
  raw: Array<Partial<ToolCall> & { function?: { name?: string; arguments?: string } }> | undefined,
): ToolCall[] {
  if (!raw?.length) return [];
  return raw
    .map((tc, i) => {
      const name = tc.function?.name ?? "";
      if (!name) return null;
      return {
        id: ensureToolId(tc.id, i),
        type: "function" as const,
        function: {
          name,
          arguments: tc.function?.arguments ?? "{}",
        },
      };
    })
    .filter((x): x is ToolCall => x != null);
}

/**
 * Merge content + reasoning into one plan string.
 * Reasoning models (hy3, etc.) often put the real plan in `reasoning`
 * and leave content empty or short.
 */
export function mergeReasoningText(
  content: string | null | undefined,
  reasoning: string | null | undefined,
): string {
  const partitioned = partitionModelOutput(content, reasoning);
  const c = partitioned.content.trim();
  const r = partitioned.reasoning.trim();
  if (r && c) {
    // Prefer longer substantive text; include both when distinct
    if (c.includes(r) || r.includes(c)) return r.length >= c.length ? r : c;
    return `${r}\n\n${c}`;
  }
  return r || c || "";
}

/** Known thinking / CoT wrappers models sometimes dump into content. */
const THINK_TAG_PAIRS: Array<{ open: RegExp; close: RegExp; closeLen: number }> =
  [
    { open: /<think>/i, close: /<\/think>/i, closeLen: 8 },
    { open: /<thinking>/i, close: /<\/thinking>/i, closeLen: 12 },
    { open: /<reasoning>/i, close: /<\/reasoning>/i, closeLen: 12 },
    { open: /<reason>/i, close: /<\/reason>/i, closeLen: 9 },
    // DeepSeek-style fullwidth markers
    { open: /◁think▷/, close: /◁\/think▷/, closeLen: 8 },
  ];

/**
 * Peel fenced think/reasoning tags out of model content so they never
 * render as the user-visible answer.
 */
export function peelThinkTags(raw: string): {
  content: string;
  reasoning: string;
} {
  if (!raw) return { content: "", reasoning: "" };
  let content = raw;
  const reasoningParts: string[] = [];

  // Multi-pass: tags may nest or repeat
  let guard = 0;
  while (guard++ < 16) {
    let matched = false;
    for (const pair of THINK_TAG_PAIRS) {
      const openMatch = content.match(pair.open);
      if (!openMatch || openMatch.index == null) continue;
      const openAt = openMatch.index;
      const afterOpen = openAt + openMatch[0].length;
      const rest = content.slice(afterOpen);
      const closeMatch = rest.match(pair.close);
      if (!closeMatch || closeMatch.index == null) {
        // Unclosed think block: treat remainder as reasoning
        const leaked = rest.trim();
        if (leaked) reasoningParts.push(leaked);
        content = content.slice(0, openAt);
        matched = true;
        break;
      }
      const inner = rest.slice(0, closeMatch.index).trim();
      if (inner) reasoningParts.push(inner);
      const afterClose = afterOpen + closeMatch.index + closeMatch[0].length;
      content = content.slice(0, openAt) + content.slice(afterClose);
      matched = true;
      break;
    }
    if (!matched) break;
  }

  return {
    content: content.replace(/^\s*\n+/, "").replace(/\n+\s*$/, "").trimEnd(),
    reasoning: reasoningParts.join("\n\n").trim(),
  };
}

function joinReasoningChunks(...parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Keep reasoning out of the final answer channel.
 * - Strips think tags from content into reasoning
 * - Drops content that is an exact copy of reasoning
 * - Drops pure plan-speak ("The user wants…") so it never stays as the answer
 * - Keeps short/answer-like content that merely appears inside longer CoT
 */
export function partitionModelOutput(
  content: string | null | undefined,
  reasoning: string | null | undefined,
  opts?: { preservePartialAnswer?: boolean },
): { content: string; reasoning: string } {
  const peeled = peelThinkTags(content ?? "");
  let c = peeled.content;
  let r = joinReasoningChunks(reasoning ?? "", peeled.reasoning);

  let ct = c.trim();
  let rt = r.trim();

  // Exact duplicate: model echoed CoT into content
  if (ct && rt && ct === rt) {
    // Plan-speak echo is never a "partial answer" — always strip from answer channel
    if (isAllPlanSpeak(ct)) {
      return { content: "", reasoning: rt };
    }
    // When the stream was cut mid-answer, keep text visible (better than empty)
    if (opts?.preservePartialAnswer) {
      return { content: c, reasoning: rt };
    }
    return { content: "", reasoning: rt };
  }

  // Content fully contained in longer reasoning + plan-speak = CoT leak
  if (
    !opts?.preservePartialAnswer &&
    ct.length > 40 &&
    rt.length > ct.length &&
    rt.includes(ct) &&
    (looksLikePlanSpeak(ct) || isAllPlanSpeak(ct))
  ) {
    return { content: "", reasoning: rt };
  }

  // Drop leading plan-speak lines when a real answer follows
  if (ct) {
    const afterPeel = peelLeadingPlanSpeak(c, { dropPurePlanSpeak: true });
    if (afterPeel !== c) {
      const leaked = c
        .slice(0, Math.max(0, c.length - afterPeel.length))
        .trim();
      if (leaked) r = joinReasoningChunks(r, leaked);
      c = afterPeel;
      ct = c.trim();
      rt = r.trim();
    }
  }

  // Entire remaining content is plan-speak → answer channel empty
  if (ct && isAllPlanSpeak(ct)) {
    // Preserve real partial answers mid length-cut only when not plan-speak
    if (!(opts?.preservePartialAnswer && !looksLikePlanSpeak(ct))) {
      r = joinReasoningChunks(r, ct);
      c = "";
    }
  }

  return { content: c, reasoning: r };
}

/** Heuristic: internal planning prose vs user-facing answer. */
export function looksLikePlanSpeak(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  return /^(i (should|will|need|am going|am going to)|let me|first[, ]|okay[, ]|ok[, ]|the user|so i|plan:|steps?:|i'll |i am |i'm )/i.test(
    t,
  );
}

/** True when every non-empty line is plan-speak (no user-facing answer). */
export function isAllPlanSpeak(text: string): boolean {
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every(
    (line) =>
      looksLikePlanSpeak(line) ||
      /^(let me|i will|i need to|i'll|okay|ok[,.])/i.test(line),
  );
}

/** User-facing answer worth keeping on the text part (not pure CoT). */
export function isMeaningfulAnswer(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (isAllPlanSpeak(t)) return false;
  return true;
}

/**
 * Remove leading plan-speak lines from content, keeping the spoken answer.
 * When every line is plan-speak and dropPurePlanSpeak, returns "" (answer channel empty).
 */
export function peelLeadingPlanSpeak(
  content: string,
  opts?: { dropPurePlanSpeak?: boolean },
): string {
  const raw = content ?? "";
  if (!raw.trim()) return raw;
  const lines = raw.split(/\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line) {
      i++;
      continue;
    }
    if (
      looksLikePlanSpeak(line) ||
      /^(let me|i will|i need to|i'll)\b/i.test(line)
    ) {
      i++;
      continue;
    }
    break;
  }
  if (i === 0) {
    // No leading peel, but whole blob may still be one plan-speak paragraph
    if (opts?.dropPurePlanSpeak !== false && isAllPlanSpeak(raw)) return "";
    return raw;
  }
  const rest = lines.slice(i).join("\n").replace(/^\s+/, "");
  if (rest.trim()) return rest;
  // Ate everything
  return opts?.dropPurePlanSpeak === false ? raw : "";
}

/**
 * Free / reasoning-first models (e.g. hy3:free) often spend the whole
 * completion budget on the reasoning channel and never emit `content`.
 * Promote reasoning → content only when the model never produced any
 * content channel text (raw empty). Do NOT re-promote after
 * partitionModelOutput stripped a CoT echo (content===reasoning), or
 * we put the CoT back into the answer.
 *
 * Pass `rawContentEmpty: true` only when the pre-partition content
 * buffer was empty. Default false keeps partitioned empty content.
 */
/**
 * When promoting a pure-reasoning completion, prefer a short likely answer
 * (last quoted phrase / last non-meta line) over dumping the whole CoT.
 */
export function extractLikelyAnswer(reasoning: string): string {
  const r = reasoning.trim();
  if (!r) return "";
  // Single short token / phrase — already the answer
  if (r.length <= 40 && !/\n/.test(r)) return r;

  // Prefer last short quoted phrase (common CoT: output "Hi there")
  const quotes = [...r.matchAll(/["“]([^"”\n]{1,48})["”]/g)].map((m) => m[1]!.trim());
  if (quotes.length) {
    const last = quotes[quotes.length - 1]!;
    if (last && !/^(the user|i should|so i|let me|reply with)/i.test(last)) {
      return last;
    }
  }

  const lines = r
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.length > 80) continue;
    if (/^(the user|i should|so i|let me|okay|ok[,.]|first|then|because)/i.test(line)) {
      continue;
    }
    // strip leading list markers
    const cleaned = line.replace(/^[-*•]\s+/, "").replace(/^[`"']|[`"']$/g, "");
    if (cleaned.length > 0 && cleaned.length <= 60) return cleaned;
  }

  // Fall back to full reasoning (better than empty answer channel)
  return r;
}

export function ensureAnswerChannel(
  content: string | null | undefined,
  reasoning: string | null | undefined,
  opts?: {
    rawContentEmpty?: boolean;
    /** finish_reason=length / max_tokens — promote a usable answer from CoT */
    lengthCut?: boolean;
  },
): { content: string; reasoning: string } {
  const c = (content ?? "").trimEnd();
  const r = (reasoning ?? "").trim();
  if (c.trim()) return { content: c, reasoning: r };
  if (!r) return { content: "", reasoning: "" };
  // After a hard length cut with empty answer channel, surface best of CoT
  // so the UI is not blank and the next continuation has something to extend.
  if (opts?.lengthCut || opts?.rawContentEmpty) {
    return { content: extractLikelyAnswer(r), reasoning: r };
  }
  return { content: "", reasoning: r };
}

/**
 * Streaming content filter: extract think-tag bodies into the reasoning
 * channel so partial tags across chunk boundaries do not escape.
 */
export class ContentReasoningSplitter {
  private buf = "";
  private mode: "text" | "think" = "text";
  private activeClose: RegExp | null = null;
  private activeCloseLen = 0;

  push(delta: string): { text: string; reasoning: string } {
    if (!delta) return { text: "", reasoning: "" };
    this.buf += delta;
    let text = "";
    let reasoning = "";

    // Bound work per push (pathological streams)
    let steps = 0;
    while (this.buf.length > 0 && steps++ < 10_000) {
      if (this.mode === "text") {
        const found = findEarliestOpenTag(this.buf);
        if (!found) {
          // Hold back a short tail so split tags ("<thi" + "nk>") still match
          const hold = 12;
          if (this.buf.length > hold) {
            text += this.buf.slice(0, this.buf.length - hold);
            this.buf = this.buf.slice(this.buf.length - hold);
          }
          break;
        }
        if (found.index > 0) {
          text += this.buf.slice(0, found.index);
        }
        this.buf = this.buf.slice(found.index + found.openLen);
        this.mode = "think";
        this.activeClose = found.close;
        this.activeCloseLen = found.closeLen;
      } else {
        const closeRe = this.activeClose!;
        const m = this.buf.match(closeRe);
        if (!m || m.index == null) {
          // Emit safe prefix; keep tail that might be start of close tag
          const hold = Math.max(this.activeCloseLen, 12);
          if (this.buf.length > hold) {
            reasoning += this.buf.slice(0, this.buf.length - hold);
            this.buf = this.buf.slice(this.buf.length - hold);
          }
          break;
        }
        reasoning += this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index + m[0].length);
        this.mode = "text";
        this.activeClose = null;
        this.activeCloseLen = 0;
      }
    }

    return { text, reasoning };
  }

  /** Flush remaining buffer at stream end. */
  flush(): { text: string; reasoning: string } {
    const left = this.buf;
    this.buf = "";
    if (!left) return { text: "", reasoning: "" };
    if (this.mode === "think") {
      this.mode = "text";
      this.activeClose = null;
      this.activeCloseLen = 0;
      return { text: "", reasoning: left };
    }
    return { text: left, reasoning: "" };
  }
}

function findEarliestOpenTag(s: string): {
  index: number;
  openLen: number;
  close: RegExp;
  closeLen: number;
} | null {
  let best: {
    index: number;
    openLen: number;
    close: RegExp;
    closeLen: number;
  } | null = null;
  for (const pair of THINK_TAG_PAIRS) {
    const m = s.match(pair.open);
    if (!m || m.index == null) continue;
    if (!best || m.index < best.index) {
      best = {
        index: m.index,
        openLen: m[0].length,
        close: pair.close,
        closeLen: pair.closeLen,
      };
    }
  }
  return best;
}

/** Extract reasoning text from OpenRouter-style message fields. */
export function extractReasoningFromMessage(msg: {
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: Array<{ type?: string; text?: string; content?: string }>;
} | null | undefined): string {
  if (!msg) return "";
  if (typeof msg.reasoning === "string" && msg.reasoning) return msg.reasoning;
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
    return msg.reasoning_content;
  }
  if (Array.isArray(msg.reasoning_details)) {
    return msg.reasoning_details
      .map((d) => d.text ?? d.content ?? "")
      .filter(Boolean)
      .join("");
  }
  return "";
}

export async function chatComplete(
  req: ChatRequest,
  handlers?: StreamHandlers,
): Promise<ChatResult> {
  const tag = modelTag(req.provider, req.model);
  const label = req.label ?? "chat";
  const s = span("llm", label, {
    model: tag,
    stream: req.stream !== false,
    tools: req.tools?.length ?? 0,
    tool_choice: req.tool_choice,
    msgs: req.messages.length,
  });

  try {
    const def = getProvider(req.provider);
    if (!def) throw new Error(`unknown provider ${req.provider}`);
    const token = await resolveTokenFresh(req.provider);
    if (!token) {
      throw new Error(
        `${req.provider} not authenticated — /login ${req.provider}`,
      );
    }
    const cred = getCredential(req.provider);
    const base = (cred?.meta?.baseUrl || def.baseUrl || "").replace(/\/$/, "");
    if (!base) throw new Error("missing base URL");

    let result: ChatResult;
    if (def.modelsStyle === "gemini") {
      result = await chatGemini(base, token, req, handlers);
    } else if (def.modelsStyle === "anthropic") {
      result = await chatAnthropic(base, token, req, handlers);
    } else {
      result = await chatOpenAI(base, token, req.provider, req, handlers);
    }

    s.end({
      finish: result.finish_reason,
      ttftMs: result.ttftMs,
      contentLen: result.content.length,
      reasoningLen: result.reasoning?.length ?? 0,
      tools: result.tool_calls.map((t) => t.function.name),
      usage: result.usage,
    });
    return result;
  } catch (err) {
    s.end({
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function chatOpenAI(
  base: string,
  token: string,
  provider: ProviderId,
  req: ChatRequest,
  handlers?: StreamHandlers,
): Promise<ChatResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/libra-tui";
    headers["X-Title"] = "Libra";
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.2,
    stream: req.stream !== false,
  };
  if (req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = req.tool_choice ?? "auto";
  }
  // Never impose a max_tokens ceiling — omit unless the caller set one explicitly.
  // Reasoning depth is controlled only via native effort API fields.
  if (req.max_tokens != null && req.max_tokens > 0) {
    body.max_tokens = req.max_tokens;
  }

  // Native reasoning control (per-model capabilities) — not prompt text.
  if (req.applyNativeReasoning !== false) {
    const native = buildReasoningApiFields(provider, req.model);
    Object.assign(body, native);
  }
  // Explicit override wins (still sent as native API fields, not prompt)
  if (req.reasoning_effort && req.reasoning_effort !== "default") {
    if (provider === "openrouter") {
      body.reasoning = { effort: req.reasoning_effort };
    } else if (provider === "xai") {
      body.reasoning_effort = req.reasoning_effort;
      body.reasoning = { effort: req.reasoning_effort };
    } else {
      body.reasoning_effort = req.reasoning_effort;
    }
  }

  // stream_options for usage on OpenAI/OpenRouter when streaming
  if (body.stream) {
    body.stream_options = { include_usage: true };
  }

  dbg("llm", "request", {
    label: req.label,
    model: modelTag(provider, req.model),
    stream: body.stream,
    max_tokens: body.max_tokens,
    tool_choice: body.tool_choice,
    tools: req.tools?.map((t) => t.function.name),
    reasoning: body.reasoning ?? body.reasoning_effort,
    messageRoles: req.messages.map((m) => m.role),
  });
  dbgTrace("llm", "request.body", {
    messages: req.messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content.slice(0, 300)
          : m.content,
      tool_calls: m.tool_calls?.map((t) => t.function.name),
      tool_call_id: m.tool_call_id,
    })),
  });

  const t0 = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const onAbort = () => controller.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    req.signal?.removeEventListener("abort", onAbort);
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    dbg("llm", "http.error", {
      status: res.status,
      body: t.slice(0, 400),
      model: modelTag(provider, req.model),
    });
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 400)}`);
  }

  if (body.stream) {
    const result = await consumeOpenAIStream(res, handlers, t0);
    result.durationMs = Date.now() - t0;
    return result;
  }

  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: ToolCall[];
        reasoning?: string;
        reasoning_content?: string;
        reasoning_details?: Array<{ type?: string; text?: string }>;
      };
      finish_reason?: string;
    }>;
    usage?: ChatResult["usage"] & {
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const msg = json.choices?.[0]?.message;
  const finishReason = json.choices?.[0]?.finish_reason ?? "stop";
  const rawContent = typeof msg?.content === "string" ? msg.content : "";
  const rawReasoning = extractReasoningFromMessage(msg);
  const lengthCut = isLengthFinish(finishReason);
  const partitioned = partitionModelOutput(rawContent, rawReasoning, {
    preservePartialAnswer: lengthCut,
  });
  const { content, reasoning } = ensureAnswerChannel(
    partitioned.content,
    partitioned.reasoning,
    { rawContentEmpty: !rawContent.trim(), lengthCut },
  );
  if (content && handlers?.onText) handlers.onText(content);
  if (reasoning && handlers?.onReasoning) handlers.onReasoning(reasoning);

  const tool_calls = normalizeToolCalls(msg?.tool_calls);
  const usage = json.usage
    ? {
        ...json.usage,
        reasoning_tokens:
          json.usage.completion_tokens_details?.reasoning_tokens ??
          json.usage.reasoning_tokens,
      }
    : undefined;

  const durationMs = Date.now() - t0;
  dbg("llm", "response.nonstream", {
    finish: json.choices?.[0]?.finish_reason,
    contentLen: content.length,
    reasoningLen: reasoning.length,
    tools: tool_calls.map((t) => ({
      id: t.id,
      name: t.function.name,
      argsLen: t.function.arguments.length,
    })),
    usage,
    durationMs,
  });

  return {
    content: content ?? "",
    reasoning: reasoning || undefined,
    tool_calls,
    finish_reason: finishReason,
    usage,
    ttftMs: durationMs,
    durationMs,
  };
}

async function consumeOpenAIStream(
  res: Response,
  handlers?: StreamHandlers,
  t0: number = Date.now(),
): Promise<ChatResult> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no response body");
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  let finish = "stop";
  let usage: ChatResult["usage"];
  let ttftMs: number | undefined;
  let firstKind: "text" | "reasoning" | "tool" | undefined;
  let chunkCount = 0;
  /** Strip think-tags from content deltas so CoT never hits the text channel */
  const contentSplit = new ContentReasoningSplitter();

  const markFirst = (kind: "text" | "reasoning" | "tool") => {
    if (ttftMs != null) return;
    ttftMs = Date.now() - t0;
    firstKind = kind;
    handlers?.onFirstToken?.(kind, ttftMs);
    dbg("llm", "ttft", { ttftMs, kind });
  };

  const emitText = (d: string) => {
    if (!d) return;
    markFirst("text");
    content += d;
    handlers?.onText?.(d);
  };
  const emitReasoning = (d: string) => {
    if (!d) return;
    markFirst("reasoning");
    reasoning += d;
    handlers?.onReasoning?.(d);
  };
  const emitContentDelta = (raw: string) => {
    const split = contentSplit.push(raw);
    emitText(split.text);
    emitReasoning(split.reasoning);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const sLine = line.trim();
      if (!sLine.startsWith("data:")) continue;
      const data = sLine.slice(5).trim();
      if (data === "[DONE]") continue;
      let json: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning?: string;
            reasoning_content?: string;
            reasoning_details?: Array<{ type?: string; text?: string }>;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          // Some providers send full message mid-stream
          message?: {
            content?: string | null;
            reasoning?: string;
            reasoning_content?: string;
            reasoning_details?: Array<{ type?: string; text?: string }>;
            tool_calls?: ToolCall[];
          };
          finish_reason?: string | null;
        }>;
        usage?: ChatResult["usage"] & {
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };
      try {
        json = JSON.parse(data);
      } catch {
        dbgTrace("llm", "sse.parse_error", { data: data.slice(0, 200) });
        continue;
      }
      chunkCount++;
      dbgTrace("llm", "sse.chunk", { n: chunkCount, data: data.slice(0, 300) });

      if (json.usage) {
        usage = {
          prompt_tokens: json.usage.prompt_tokens,
          completion_tokens: json.usage.completion_tokens,
          total_tokens: json.usage.total_tokens,
          reasoning_tokens:
            json.usage.completion_tokens_details?.reasoning_tokens ??
            json.usage.reasoning_tokens,
        };
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;

      const delta = choice.delta;
      if (delta) {
        if (delta.content) {
          emitContentDelta(delta.content);
        }
        const r =
          delta.reasoning ??
          delta.reasoning_content ??
          (Array.isArray(delta.reasoning_details)
            ? delta.reasoning_details
                .map((d) => d.text ?? "")
                .filter(Boolean)
                .join("")
            : "");
        if (r) {
          emitReasoning(r);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            while (toolCalls.length <= idx) {
              toolCalls.push({
                id: "",
                type: "function",
                function: { name: "", arguments: "" },
              });
            }
            const cur = toolCalls[idx]!;
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) {
              cur.function.arguments += tc.function.arguments;
            }
            if (cur.function.name) {
              markFirst("tool");
              handlers?.onToolCallDelta?.(idx, {
                ...cur,
                id: cur.id || ensureToolId(cur.id, idx),
              });
            }
          }
        }
      }

      // Fallback: full message object in stream
      if (choice.message) {
        const m = choice.message;
        if (m.content && !content) {
          emitContentDelta(m.content);
        }
        const mr = extractReasoningFromMessage(m);
        if (mr && !reasoning) {
          emitReasoning(mr);
        }
        if (m.tool_calls?.length && toolCalls.length === 0) {
          for (let i = 0; i < m.tool_calls.length; i++) {
            const tc = m.tool_calls[i]!;
            toolCalls.push({
              id: ensureToolId(tc.id, i),
              type: "function",
              function: {
                name: tc.function?.name ?? "",
                arguments: tc.function?.arguments ?? "{}",
              },
            });
            markFirst("tool");
          }
        }
      }
    }
  }

  // Flush held content (possible partial open-tag tail)
  const tail = contentSplit.flush();
  emitText(tail.text);
  emitReasoning(tail.reasoning);

  // Final partition: drop pure CoT echoes, but keep partial answers on length cuts
  const rawContentEmpty = !content.trim();
  const lengthCut = isLengthFinish(finish);
  const partitioned = partitionModelOutput(content, reasoning, {
    preservePartialAnswer: lengthCut,
  });
  content = partitioned.content;
  reasoning = partitioned.reasoning;
  // Reasoning-only / length-cut completions → fill answer from CoT when needed
  const ensured = ensureAnswerChannel(content, reasoning, {
    rawContentEmpty,
    lengthCut,
  });
  if (
    (rawContentEmpty || lengthCut) &&
    ensured.content.trim() &&
    ensured.content !== content &&
    handlers?.onText
  ) {
    handlers.onText(ensured.content);
  }
  content = ensured.content;
  reasoning = ensured.reasoning;

  // Ensure tool IDs always present for the next round
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    tc.id = ensureToolId(tc.id, i);
  }

  const normalized = toolCalls.filter((t) => t.function.name);
  dbg("llm", "stream.done", {
    finish,
    ttftMs,
    firstKind,
    chunks: chunkCount,
    contentLen: content.length,
    reasoningLen: reasoning.length,
    tools: normalized.map((t) => ({
      id: t.id,
      name: t.function.name,
      argsPreview: t.function.arguments.slice(0, 120),
    })),
    usage,
    durationMs: Date.now() - t0,
  });

  return {
    content,
    reasoning: reasoning || undefined,
    tool_calls: normalized,
    finish_reason: finish,
    usage,
    ttftMs,
    durationMs: Date.now() - t0,
  };
}

async function chatGemini(
  base: string,
  token: string,
  req: ChatRequest,
  handlers?: StreamHandlers,
): Promise<ChatResult> {
  // Fail closed: Gemini adapter does not implement function calling yet.
  // Silent tool drop was a hard agent-loop bug (tools appeared to "work" but never ran).
  if (req.tools?.length && req.tool_choice !== "none") {
    throw new Error(
      "Gemini tool calling is not implemented in this client — pick an OpenAI-compatible provider (OpenRouter/xAI/OpenAI) for agent tools",
    );
  }
  const id = req.model.replace(/^models\//, "");
  const url = `${base}/models/${id}:generateContent?key=${encodeURIComponent(token)}`;
  const system = req.messages.find((m) => m.role === "system")?.content ?? "";
  const contents = req.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content ?? "" }],
    }));
  const native = buildReasoningApiFields(req.provider, req.model);
  const genCfg = native.generationConfig as Record<string, unknown> | undefined;
  const t0 = Date.now();

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      ...(genCfg ? { generationConfig: genCfg } : {}),
    }),
    signal: req.signal ?? AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(
      `Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text =
    json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
    "";
  handlers?.onText?.(text);
  return {
    content: text,
    tool_calls: [],
    finish_reason: "stop",
    durationMs: Date.now() - t0,
    ttftMs: Date.now() - t0,
  };
}

async function chatAnthropic(
  base: string,
  token: string,
  req: ChatRequest,
  handlers?: StreamHandlers,
): Promise<ChatResult> {
  // Fail closed: Anthropic adapter does not implement tools/tool_use yet.
  if (req.tools?.length && req.tool_choice !== "none") {
    throw new Error(
      "Anthropic tool calling is not implemented in this client — pick an OpenAI-compatible provider (OpenRouter/xAI/OpenAI) for agent tools",
    );
  }
  const system =
    req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n") || undefined;
  const messages = req.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content ?? "" }));
  const native = buildReasoningApiFields(req.provider, req.model);
  const thinking = native.thinking as
    | { type: string; budget_tokens: number }
    | undefined;
  const t0 = Date.now();

  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: req.model,
      // Anthropic requires this field; use explicit value or a non-capping default.
      max_tokens:
        req.max_tokens != null && req.max_tokens > 0
          ? req.max_tokens
          : ANTHROPIC_REQUIRED_MAX_TOKENS,
      system,
      messages,
      ...(thinking ? { thinking } : {}),
    }),
    signal: req.signal ?? AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(
      `Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = (json.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  handlers?.onText?.(text);
  return {
    content: text,
    tool_calls: [],
    finish_reason: "end_turn",
    durationMs: Date.now() - t0,
    ttftMs: Date.now() - t0,
  };
}
