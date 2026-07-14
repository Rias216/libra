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
  const c = (content ?? "").trim();
  const r = (reasoning ?? "").trim();
  if (r && c) {
    // Prefer longer substantive text; include both when distinct
    if (c.includes(r) || r.includes(c)) return r.length >= c.length ? r : c;
    return `${r}\n\n${c}`;
  }
  return r || c || "";
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
  // Free / small models often default to tiny completions; give room for tools
  if (req.max_tokens != null) {
    body.max_tokens = req.max_tokens;
  } else if (req.tools?.length) {
    body.max_tokens = 4096;
  } else {
    body.max_tokens = 2048;
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
  const content = typeof msg?.content === "string" ? msg.content : "";
  const reasoning = extractReasoningFromMessage(msg);
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
    finish_reason: json.choices?.[0]?.finish_reason ?? "stop",
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

  const markFirst = (kind: "text" | "reasoning" | "tool") => {
    if (ttftMs != null) return;
    ttftMs = Date.now() - t0;
    firstKind = kind;
    handlers?.onFirstToken?.(kind, ttftMs);
    dbg("llm", "ttft", { ttftMs, kind });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
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
          markFirst("text");
          content += delta.content;
          handlers?.onText?.(delta.content);
        }
        const r =
          delta.reasoning ??
          delta.reasoning_content ??
          (Array.isArray(delta.reasoning_details)
            ? delta.reasoning_details.map((d) => d.text ?? "").join("")
            : "");
        if (r) {
          markFirst("reasoning");
          reasoning += r;
          handlers?.onReasoning?.(r);
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
          markFirst("text");
          content = m.content;
          handlers?.onText?.(m.content);
        }
        const mr = extractReasoningFromMessage(m);
        if (mr && !reasoning) {
          markFirst("reasoning");
          reasoning = mr;
          handlers?.onReasoning?.(mr);
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
      max_tokens: req.max_tokens ?? 8192,
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
