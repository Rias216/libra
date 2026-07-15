/**
 * Cross-model tool-calling compatibility.
 *
 * Goals:
 * - One OpenAI-shaped tool schema internally
 * - Convert to Anthropic / Gemini wire formats
 * - Repair common model arg mistakes so every family can call tools reliably
 * - Advertise capabilities (parallel, strict, max tools) per model
 */

import type { OpenAITool } from "./schema.js";
import { resolveToolName } from "./tool.js";

export type ToolApiStyle = "openai" | "anthropic" | "gemini";

export interface ModelToolCaps {
  api: ToolApiStyle;
  /** Model reliably emits multiple tool calls in one step */
  parallel: boolean;
  /** Prefer strict JSON schema if provider supports it */
  strictJson: boolean;
  /** Soft max tools per step (hint for prompts / truncation) */
  maxToolsPerStep: number;
  /** Free / weak tool models that need extra arg repair */
  fragileArgs: boolean;
  /** Provider prefers absolute paths in prompts (Gemini) */
  preferAbsolutePaths: boolean;
}

export function resolveToolApiStyle(
  provider?: string,
  modelsStyle?: string,
): ToolApiStyle {
  if (modelsStyle === "anthropic" || provider === "anthropic") return "anthropic";
  if (modelsStyle === "gemini" || provider === "gemini") return "gemini";
  return "openai";
}

export function resolveModelToolCaps(opts: {
  provider?: string;
  model?: string;
  modelsStyle?: string;
}): ModelToolCaps {
  const provider = (opts.provider ?? "").toLowerCase();
  const model = (opts.model ?? "").toLowerCase();
  const api = resolveToolApiStyle(provider, opts.modelsStyle);
  const free =
    /:free$/i.test(model) ||
    model.includes("hy3") ||
    model.includes("tiny") ||
    model.includes("mini-");

  // Conservative defaults per family
  if (api === "gemini") {
    return {
      api,
      parallel: true,
      strictJson: true,
      maxToolsPerStep: free ? 4 : 16,
      fragileArgs: free,
      preferAbsolutePaths: true,
    };
  }
  if (api === "anthropic") {
    return {
      api,
      parallel: true,
      strictJson: true,
      maxToolsPerStep: 16,
      fragileArgs: false,
      preferAbsolutePaths: false,
    };
  }

  // OpenAI-compatible (OpenAI, xAI, OpenRouter, custom)
  const weakParallel =
    free ||
    model.includes("llama-3.1-8b") ||
    model.includes("gemma-2-9b") ||
    model.includes("phi-3");
  return {
    api: "openai",
    parallel: !weakParallel,
    strictJson: model.includes("gpt-4o") || model.includes("gpt-5") || model.includes("o3"),
    maxToolsPerStep: weakParallel ? 4 : 24,
    fragileArgs: free || weakParallel,
    preferAbsolutePaths: false,
  };
}

/** Anthropic Messages API tool definition. */
export function toAnthropicTools(
  tools: OpenAITool[],
): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters ?? {
      type: "object",
      properties: {},
    },
  }));
}

/** Gemini functionDeclarations list. */
export function toGeminiFunctionDeclarations(
  tools: OpenAITool[],
): Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return tools.map((t) => {
    // Gemini dislikes some JSON Schema keywords — strip $schema / additionalProperties noise
    const params = sanitizeGeminiParameters(
      (t.function.parameters ?? { type: "object", properties: {} }) as Record<
        string,
        unknown
      >,
    );
    return {
      name: t.function.name,
      description: t.function.description.slice(0, 1024),
      parameters: params,
    };
  });
}

function sanitizeGeminiParameters(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema" || k === "additionalProperties") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = sanitizeGeminiParameters(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  // Gemini wants type at top level
  if (!out.type) out.type = "object";
  return out;
}

/**
 * Repair tool-call argument JSON from sloppy models.
 * Handles: trailing commas, single quotes, unquoted keys, markdown fences,
 * double-encoded JSON strings, truncated closing braces (best-effort).
 */
export function repairToolArgumentsJson(raw: string | null | undefined): string {
  let s = (raw ?? "").trim();
  if (!s) return "{}";

  // Strip markdown fences
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence) s = fence[1]!.trim();

  // Already valid
  if (tryParseObject(s)) return normalizeParsed(s);

  // Double-encoded JSON string
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    try {
      const inner = JSON.parse(s.replace(/^'/, '"').replace(/'$/, '"'));
      if (typeof inner === "string") {
        if (tryParseObject(inner)) return normalizeParsed(inner);
        s = inner;
      }
    } catch {
      /* continue */
    }
  }

  // Single quotes → double quotes (naive but helps many models)
  let t = s;
  // trailing commas
  t = t.replace(/,\s*([}\]])/g, "$1");
  // unquoted keys: {foo: 1} → {"foo": 1}
  t = t.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  // single-quoted strings
  t = t.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, body: string) => {
    return `"${body.replace(/"/g, '\\"')}"`;
  });

  if (tryParseObject(t)) return normalizeParsed(t);

  // Truncation: balance braces/brackets
  const balanced = balanceJson(t);
  if (tryParseObject(balanced)) return normalizeParsed(balanced);

  // Last resort: empty object (validator will surface required fields)
  return "{}";
}

function tryParseObject(s: string): boolean {
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

function normalizeParsed(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s));
  } catch {
    return s;
  }
}

function balanceJson(s: string): string {
  let out = s.trim();
  // If starts without {, wrap
  if (!out.startsWith("{") && !out.startsWith("[")) {
    out = `{${out}}`;
  }
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of out) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch);
    if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) out += '"';
  while (stack.length) {
    const open = stack.pop();
    out += open === "{" ? "}" : "]";
  }
  out = out.replace(/,\s*([}\]])/g, "$1");
  return out;
}

export function parseToolArgumentsLoose(
  raw: string | null | undefined,
): Record<string, unknown> {
  if (raw == null || !String(raw).trim()) return {};
  const original = String(raw);
  try {
    const v = JSON.parse(original);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return { _value: v };
  } catch {
    /* repair */
  }
  const fixed = repairToolArgumentsJson(original);
  try {
    const v = JSON.parse(fixed);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      // Repair collapsed unrecoverable junk → keep evidence for validators/debug
      if (
        Object.keys(v).length === 0 &&
        fixed === "{}" &&
        original.trim() !== "{}"
      ) {
        return { _raw: original };
      }
      return v as Record<string, unknown>;
    }
    return { _value: v };
  } catch {
    return { _raw: original };
  }
}

/**
 * Normalize wire tool call names (aliases) after model output.
 */
export function normalizeWireToolName(name: string): string {
  return resolveToolName(name);
}

/** Cap tool list for fragile models (keep highest-priority specialized tools). */
export function limitToolsForModel(
  tools: OpenAITool[],
  caps: ModelToolCaps,
): OpenAITool[] {
  if (tools.length <= caps.maxToolsPerStep * 2) return tools;
  // Prefer fs/search over meta for small models
  const priority = [
    "read_file",
    "list_dir",
    "grep",
    "glob",
    "search_replace",
    "write",
    "run_terminal_command",
  ];
  const ranked = [...tools].sort((a, b) => {
    const ia = priority.indexOf(a.function.name);
    const ib = priority.indexOf(b.function.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return ranked.slice(0, Math.max(8, caps.maxToolsPerStep * 2));
}
