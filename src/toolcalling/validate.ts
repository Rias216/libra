/**
 * Validate tool args against OpenAI-style JSON Schema parameters.
 * Coerces common model mistakes (string numbers, "true"/"false") and
 * returns structured recovery errors — OpenCode/Zod spirit without Zod.
 */

import type { OpenAITool } from "./schema.js";
import { OPENAI_TOOLS } from "./schema.js";
import { CATALOG_TOOLS } from "./catalog.js";

export interface ValidationIssue {
  path: string;
  message: string;
  /** Suggested fix for the model */
  hint?: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Coerced/cleaned args when ok (or best-effort when not) */
  args: Record<string, unknown>;
  issues: ValidationIssue[];
}

const SCHEMA_BY_NAME = new Map<string, OpenAITool>();
// Catalog first, then native OPENAI_TOOLS win for overlapping names
// (read_file/list_dir etc. share names but different param shapes).
for (const t of CATALOG_TOOLS) {
  SCHEMA_BY_NAME.set(t.function.name, t);
}
for (const t of OPENAI_TOOLS) {
  SCHEMA_BY_NAME.set(t.function.name, t);
}

/** Register extra tool schemas (MCP / dynamic). */
export function registerToolSchema(tool: OpenAITool): void {
  SCHEMA_BY_NAME.set(tool.function.name, tool);
}

export function getToolSchema(name: string): OpenAITool | undefined {
  return SCHEMA_BY_NAME.get(name);
}

function isBlockingIssue(i: ValidationIssue): boolean {
  const m = i.message;
  return (
    m.startsWith("missing required") ||
    m.includes("expected") ||
    m.includes("must ") ||
    m.includes("identical") ||
    m.includes("non-empty") ||
    m.includes("requires session_id") ||
    m.includes("must start with")
  );
}

/**
 * Validate and coerce args for a known tool.
 * Unknown tools pass through (executor rejects if unsupported).
 */
export function validateToolArgs(
  name: string,
  raw: Record<string, unknown>,
): ValidationResult {
  const schema = SCHEMA_BY_NAME.get(name);
  if (!schema) {
    return {
      ok: true,
      args: { ...raw },
      issues: [],
    };
  }

  const params = schema.function.parameters ?? {};
  const properties = (params.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = (params.required ?? []) as string[];
  const issues: ValidationIssue[] = [];
  const args: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    args[k] = v;
  }

  for (const [key, prop] of Object.entries(properties)) {
    if (!(key in args)) continue;
    const coerced = coerceValue(args[key], prop, key, issues);
    if (coerced !== undefined) {
      args[key] = coerced;
    }
  }

  for (const key of required) {
    const v = args[key];
    if (v === undefined || v === null) {
      issues.push({
        path: key,
        message: `missing required parameter "${key}"`,
        hint: hintForMissing(name, key, properties[key]),
      });
      continue;
    }
    // Empty string is missing for paths/ids/commands, but valid for body fields
    // (write content="", search_replace new_string="" to clear text).
    if (v === "" && !allowsEmptyString(name, key)) {
      issues.push({
        path: key,
        message: `missing required parameter "${key}"`,
        hint: hintForMissing(name, key, properties[key]),
      });
    }
  }

  extraInvariants(name, args, issues);

  return {
    ok: !issues.some(isBlockingIssue),
    args,
    issues,
  };
}

/** Alias — same as validateToolArgs (strict blocking issues). */
export const validateToolArgsStrict = validateToolArgs;

function extraInvariants(
  name: string,
  args: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  if (name === "read_file") {
    const hasSingle =
      args.target_file != null && String(args.target_file) !== "";
    const hasBatch =
      Array.isArray(args.target_files) &&
      (args.target_files as unknown[]).length > 0;
    const hasPath = args.path != null && String(args.path) !== "";
    if (!hasSingle && !hasBatch && !hasPath) {
      issues.push({
        path: "target_file",
        message:
          'must provide "target_file", "target_files", or "path"',
        hint: 'Example: {"target_file":"src/index.ts"} or {"target_files":["a.ts","b.ts"]}',
      });
    }
  }

  if (name === "search_replace" || name === "edit_file") {
    if (args.old_string != null && args.new_string != null) {
      if (String(args.old_string) === String(args.new_string)) {
        issues.push({
          path: "new_string",
          message: "old_string and new_string are identical — no-op edit",
          hint: "Provide a different new_string, or skip the edit.",
        });
      }
    }
  }

  if (name === "run_terminal_command" || name === "run_shell") {
    if (!String(args.command ?? "").trim()) {
      issues.push({
        path: "command",
        message: "command must be a non-empty string",
        hint: 'Example: {"command":"npm test","description":"Run unit tests"}',
      });
    }
  }

  if (name === "web_fetch") {
    const url = String(args.url ?? "").trim();
    if (!url) {
      issues.push({
        path: "url",
        message: "url is required",
        hint: "Provide a fully-formed https URL or bare domain.",
      });
    } else if (
      !/^https?:\/\//i.test(url) &&
      !/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(url)
    ) {
      issues.push({
        path: "url",
        message: "url must be http(s) or a bare domain",
        hint: "Example: https://example.com/docs or example.com",
      });
    }
  }

  if (name === "web_search") {
    const q = String(
      args.query ??
        args.q ??
        args.search ??
        args.pattern ??
        args.keywords ??
        args.keyword ??
        "",
    ).trim();
    if (!q) {
      issues.push({
        path: "query",
        message: "query is required",
        hint: 'Example: {"query":"Node.js fetch API documentation"}',
      });
    } else if (args.pattern != null && args.query == null) {
      // Coerce common mis-name so execution can proceed after soft normalize
      args.query = q;
      delete args.pattern;
    }
  }

  if (name === "process") {
    const action = String(args.action ?? "");
    const needsId = ["poll", "wait", "log", "kill", "write"].includes(action);
    if (needsId && !args.session_id) {
      issues.push({
        path: "session_id",
        message: `action "${action}" requires session_id`,
        hint: 'Use process(action="list") to see running sessions.',
      });
    }
  }
}

function coerceValue(
  value: unknown,
  prop: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): unknown {
  const type = prop.type as string | string[] | undefined;
  const types = Array.isArray(type) ? type : type ? [type] : [];

  if (value === null || value === undefined) return value;

  if (types.includes("integer") || types.includes("number")) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return types.includes("integer") ? Math.trunc(value) : value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (Number.isFinite(n)) {
        return types.includes("integer") ? Math.trunc(n) : n;
      }
    }
    issues.push({
      path,
      message: `expected number for "${path}", got ${typeof value}`,
      hint: `Pass a numeric value for ${path}.`,
    });
    return value;
  }

  if (types.includes("boolean")) {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1" || value === 1) return true;
    if (value === "false" || value === "0" || value === 0) return false;
    issues.push({
      path,
      message: `expected boolean for "${path}"`,
      hint: `Use true or false for ${path}.`,
    });
    return value;
  }

  if (types.includes("array")) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return [value];
    issues.push({
      path,
      message: `expected array for "${path}"`,
    });
    return value;
  }

  if (types.includes("string")) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    issues.push({
      path,
      message: `expected string for "${path}", got ${typeof value}`,
    });
    return value;
  }

  if (types.includes("object")) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
    issues.push({
      path,
      message: `expected object for "${path}"`,
    });
  }

  return value;
}

/**
 * Required params that may legally be empty string after normalize.
 * Path/command fields still treat "" as missing.
 */
function allowsEmptyString(tool: string, key: string): boolean {
  const t = tool === "write_file" ? "write" : tool === "edit_file" ? "search_replace" : tool;
  if ((t === "write" || t === "write_file") && (key === "content" || key === "contents")) {
    return true;
  }
  if (
    (t === "search_replace" || t === "edit_file") &&
    key === "new_string"
  ) {
    return true;
  }
  return false;
}

function hintForMissing(
  tool: string,
  key: string,
  prop?: Record<string, unknown>,
): string {
  if ((tool === "write" || tool === "write_file") && key === "content") {
    return 'Provide full file contents: {"file_path":"…","content":"…"}. Use content:"" only to create an empty file.';
  }
  if (tool === "search_replace" && key === "old_string") {
    return "Read the file first so old_string matches exactly.";
  }
  if (tool === "search_replace" && key === "new_string") {
    return 'Provide replacement text (use "" to delete the matched old_string).';
  }
  if (prop?.description) return String(prop.description);
  return `Include "${key}" in the tool arguments.`;
}

/** Format validation failure for the model (tool result content). */
export function formatValidationError(
  name: string,
  result: ValidationResult,
): string {
  const lines = [
    `Invalid arguments for tool "${name}" (code=invalid_args).`,
    ...result.issues.map((i) => {
      const loc = i.path ? `${i.path}: ` : "";
      return `- ${loc}${i.message}${i.hint ? ` — ${i.hint}` : ""}`;
    }),
    "Fix the arguments and retry. Do not invent parameters not in the schema.",
  ];
  return lines.join("\n");
}
