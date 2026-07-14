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
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  tool_calls: ToolCall[];
  finish_reason: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
}

export async function chatComplete(
  req: ChatRequest,
  handlers?: StreamHandlers,
): Promise<ChatResult> {
  const def = getProvider(req.provider);
  if (!def) throw new Error(`unknown provider ${req.provider}`);
  const token = await resolveTokenFresh(req.provider);
  if (!token) throw new Error(`${req.provider} not authenticated — /login ${req.provider}`);
  const cred = getCredential(req.provider);
  const base = (cred?.meta?.baseUrl || def.baseUrl || "").replace(/\/$/, "");
  if (!base) throw new Error("missing base URL");

  if (def.modelsStyle === "gemini") {
    return chatGemini(base, token, req, handlers);
  }
  if (def.modelsStyle === "anthropic") {
    return chatAnthropic(base, token, req, handlers);
  }
  return chatOpenAI(base, token, req.provider, req, handlers);
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
  if (req.max_tokens) body.max_tokens = req.max_tokens;

  // Native reasoning control (per-model capabilities) — not prompt text.
  // buildReasoningApiFields clamps to what this model supports (e.g. hy3: none/low/high only).
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

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 400)}`);
  }

  if (body.stream) {
    return consumeOpenAIStream(res, handlers);
  }
  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: ToolCall[];
        reasoning?: string;
      };
      finish_reason?: string;
    }>;
    usage?: ChatResult["usage"];
  };
  const msg = json.choices?.[0]?.message;
  const content = msg?.content ?? "";
  if (content && handlers?.onText) handlers.onText(content);
  return {
    content: content ?? "",
    reasoning: msg?.reasoning,
    tool_calls: msg?.tool_calls ?? [],
    finish_reason: json.choices?.[0]?.finish_reason ?? "stop",
    usage: json.usage,
  };
}

async function consumeOpenAIStream(
  res: Response,
  handlers?: StreamHandlers,
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
            content?: string;
            reasoning?: string;
            reasoning_content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: ChatResult["usage"];
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        handlers?.onText?.(delta.content);
      }
      const r = delta.reasoning ?? delta.reasoning_content;
      if (r) {
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
          handlers?.onToolCallDelta?.(idx, cur);
        }
      }
    }
  }

  return {
    content,
    reasoning: reasoning || undefined,
    tool_calls: toolCalls.filter((t) => t.function.name),
    finish_reason: finish,
    usage,
  };
}

async function chatGemini(
  base: string,
  token: string,
  req: ChatRequest,
  handlers?: StreamHandlers,
): Promise<ChatResult> {
  // Non-stream fallback for Gemini (tools limited)
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

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      ...(genCfg ? { generationConfig: genCfg } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text =
    json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
    "";
  handlers?.onText?.(text);
  return { content: text, tool_calls: [], finish_reason: "stop" };
}

async function chatAnthropic(
  base: string,
  token: string,
  req: ChatRequest,
  handlers?: StreamHandlers,
): Promise<ChatResult> {
  const system =
    req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n") ||
    undefined;
  const messages = req.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content ?? "" }));
  const native = buildReasoningApiFields(req.provider, req.model);
  const thinking = native.thinking as
    | { type: string; budget_tokens: number }
    | undefined;

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
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = (json.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  handlers?.onText?.(text);
  return { content: text, tool_calls: [], finish_reason: "end_turn" };
}
