/**
 * Deterministic hard checks for fusion suite cases.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HardCheck } from "./parse.js";

export interface ToolTraceEntry {
  turn: number;
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
  duration_ms: number;
}

export interface CheckResult {
  type: string;
  passed: boolean;
  detail: string;
  name?: string;
  contains?: string;
  path?: string;
  pattern?: string;
  n?: number;
}

export interface HardChecksResult {
  passed: boolean;
  checks: CheckResult[];
}

export function runHardChecks(
  checks: HardCheck[],
  trace: ToolTraceEntry[],
  finalAnswer: string,
  workspace: string,
): HardChecksResult {
  const results: CheckResult[] = checks.map((c) =>
    evalCheck(c, trace, finalAnswer, workspace),
  );
  return {
    passed: results.every((r) => r.passed),
    checks: results,
  };
}

function evalCheck(
  c: HardCheck,
  trace: ToolTraceEntry[],
  finalAnswer: string,
  workspace: string,
): CheckResult {
  const type = c.type;
  try {
    switch (type) {
      case "tool_called": {
        const name = String(c.name ?? "");
        const min = Number(c.min_count ?? 1);
        const count = trace.filter((t) => t.name === name).length;
        return {
          type,
          name,
          passed: count >= min,
          detail: `count=${count} min=${min}`,
        };
      }
      case "tool_not_called": {
        const name = String(c.name ?? "");
        const count = trace.filter((t) => t.name === name).length;
        return {
          type,
          name,
          passed: count === 0,
          detail: count === 0 ? "never called" : `count=${count}`,
        };
      }
      case "tool_args_contains": {
        const name = String(c.name ?? "");
        const path = String(c.path ?? "");
        const expected = c.value;
        const hits = trace.filter((t) => t.name === name);
        let matched = false;
        let detail = "no matching call";
        for (const t of hits) {
          const v = getPath(t.arguments, path);
          // Allow minor whitespace differences for expression strings
          if (looseEq(v, expected)) {
            matched = true;
            detail = `matched ${path}=${JSON.stringify(v)}`;
            break;
          }
          detail = `saw ${JSON.stringify(v)} want ${JSON.stringify(expected)}`;
        }
        return { type, name, path, passed: matched, detail };
      }
      case "file_exists": {
        const rel = stripWorkspacePrefix(String(c.path ?? ""));
        const abs = join(workspace, rel);
        const ok = existsSync(abs);
        return {
          type,
          path: rel,
          passed: ok,
          detail: ok ? "exists" : "missing",
        };
      }
      case "file_equals": {
        const rel = stripWorkspacePrefix(String(c.path ?? ""));
        const abs = join(workspace, rel);
        if (!existsSync(abs)) {
          return { type, path: rel, passed: false, detail: "missing" };
        }
        const got = readFileSync(abs, "utf8");
        const want =
          c.equals != null
            ? String(c.equals)
            : c.equals_file
              ? readFileSync(join(workspace, String(c.equals_file)), "utf8")
              : "";
        const ok = got.trim() === want.trim();
        return {
          type,
          path: rel,
          passed: ok,
          detail: ok ? "equal" : `got=${JSON.stringify(got.slice(0, 80))}`,
        };
      }
      case "file_contains": {
        const rel = stripWorkspacePrefix(String(c.path ?? ""));
        const abs = join(workspace, rel);
        if (!existsSync(abs)) {
          return {
            type,
            path: rel,
            contains: String(c.contains ?? ""),
            passed: false,
            detail: "missing",
          };
        }
        const got = readFileSync(abs, "utf8");
        const needle = String(c.contains ?? "");
        const ok = got.includes(needle);
        return {
          type,
          path: rel,
          contains: needle,
          passed: ok,
          detail: ok ? "matched" : "not found",
        };
      }
      case "final_contains": {
        const needle = String(c.contains ?? "");
        const ok = finalAnswer.includes(needle);
        return {
          type,
          contains: needle,
          passed: ok,
          detail: ok ? "matched" : `final=${JSON.stringify(finalAnswer.slice(0, 120))}`,
        };
      }
      case "final_regex": {
        const pattern = String(c.pattern ?? "");
        const re = new RegExp(pattern);
        const ok = re.test(finalAnswer);
        return {
          type,
          pattern,
          passed: ok,
          detail: ok
            ? "matched"
            : `final=${JSON.stringify(finalAnswer.slice(0, 120))}`,
        };
      }
      case "max_tool_calls": {
        const n = Number(c.n ?? 0);
        const count = trace.length;
        return {
          type,
          n,
          passed: count <= n,
          detail: `count=${count} max=${n}`,
        };
      }
      case "json_valid": {
        const src = resolveJsonSource(c, finalAnswer, workspace);
        try {
          JSON.parse(src);
          return { type, passed: true, detail: "valid json" };
        } catch (e) {
          return {
            type,
            passed: false,
            detail: e instanceof Error ? e.message : "invalid",
          };
        }
      }
      case "json_path_equals": {
        const src = resolveJsonSource(c, finalAnswer, workspace);
        let obj: unknown;
        try {
          obj = JSON.parse(src);
        } catch {
          return { type, passed: false, detail: "invalid json" };
        }
        const path = String(c.path ?? "");
        const got = getPath(obj, path);
        const ok = looseEq(got, c.value);
        return {
          type,
          path,
          passed: ok,
          detail: ok
            ? `matched ${path}`
            : `${path}=${JSON.stringify(got)} want ${JSON.stringify(c.value)}`,
        };
      }
      default:
        return {
          type,
          passed: false,
          detail: `unknown hard check type: ${type}`,
        };
    }
  } catch (e) {
    return {
      type,
      passed: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

function stripWorkspacePrefix(p: string): string {
  let rel = p.replace(/\\/g, "/");
  if (rel.startsWith("workspace/")) rel = rel.slice("workspace/".length);
  if (rel.startsWith("./")) rel = rel.slice(2);
  return rel;
}

function resolveJsonSource(
  c: HardCheck,
  finalAnswer: string,
  workspace: string,
): string {
  const from = String(c.from ?? "final_answer");
  if (from === "final_answer") {
    // Strip markdown fences if model wrapped JSON
    const fenced = finalAnswer.match(/```(?:json)?\s*([\s\S]*?)```/);
    return (fenced?.[1] ?? finalAnswer).trim();
  }
  if (from.startsWith("file:") || c.path) {
    const rel = stripWorkspacePrefix(
      from.startsWith("file:") ? from.slice(5) : String(c.path),
    );
    return readFileSync(join(workspace, rel), "utf8");
  }
  return finalAnswer;
}

function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.replace(/^\//, "").split(/\.|\//).filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") {
    return a.trim() === b.trim() || a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
  }
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
}
