/**
 * Parse fusion suite.yaml + case markdown (minimal YAML frontmatter).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface SuiteDefaults {
  max_turns: number;
  timeout_s: number;
  pass_threshold: number;
  judge_model: string;
  workspace_mode: "copy" | "empty" | "overlay";
  hard_weight: number;
  judge_weight: number;
}

export interface HardCheck {
  type: string;
  name?: string;
  min_count?: number;
  path?: string;
  value?: unknown;
  contains?: string;
  equals?: string;
  equals_file?: string;
  pattern?: string;
  from?: string;
  n?: number;
  [key: string]: unknown;
}

export interface CaseDef {
  id: string;
  title: string;
  category: string;
  difficulty: string;
  tags: string[];
  max_turns: number;
  timeout_s: number;
  pass_threshold: number;
  tools: string[];
  fixtures?: string;
  workspace_mode: "copy" | "empty" | "overlay";
  hard_checks: HardCheck[];
  sourcePath: string;
  task: string;
  context: string;
  constraints: string;
  success_criteria: string;
  expected_tool_pattern: string;
  judge_rubric: string;
  notes: string;
}

export interface SuiteDef {
  suite: string;
  version: number | string;
  defaults: SuiteDefaults;
  casePaths: string[];
  root: string;
}

const DEFAULTS: SuiteDefaults = {
  max_turns: 12,
  timeout_s: 120,
  pass_threshold: 7,
  judge_model: "grok",
  workspace_mode: "copy",
  hard_weight: 0.4,
  judge_weight: 0.6,
};

export function loadSuite(suitePath: string): SuiteDef {
  const abs = resolve(suitePath);
  const root = dirname(abs);
  const text = readFileSync(abs, "utf8");
  const suite = matchStr(text, /^suite:\s*(.+)$/m) ?? "fusion-local";
  const version = matchStr(text, /^version:\s*(.+)$/m) ?? "1";

  const defaults: SuiteDefaults = { ...DEFAULTS };
  const maxTurns = matchNum(text, /max_turns:\s*(\d+)/);
  if (maxTurns != null) defaults.max_turns = maxTurns;
  const timeout = matchNum(text, /timeout_s:\s*(\d+)/);
  if (timeout != null) defaults.timeout_s = timeout;
  const thresh = matchNum(text, /pass_threshold:\s*(\d+)/);
  if (thresh != null) defaults.pass_threshold = thresh;
  const wm = matchStr(text, /workspace_mode:\s*(\w+)/);
  if (wm === "copy" || wm === "empty" || wm === "overlay") {
    defaults.workspace_mode = wm;
  }
  const hw = matchNum(text, /hard_weight:\s*([\d.]+)/);
  if (hw != null) defaults.hard_weight = hw;
  const jw = matchNum(text, /judge_weight:\s*([\d.]+)/);
  if (jw != null) defaults.judge_weight = jw;

  const casePaths: string[] = [];
  const casesBlock = text.match(/cases:\s*\n((?:\s*-\s+.+\n?)+)/);
  if (casesBlock) {
    for (const line of casesBlock[1]!.split("\n")) {
      const m = line.match(/^\s*-\s+(.+)$/);
      if (m) casePaths.push(m[1]!.trim().replace(/^["']|["']$/g, ""));
    }
  }

  return { suite, version, defaults, casePaths, root };
}

export function loadCase(casePath: string, defaults: SuiteDefaults): CaseDef {
  const abs = resolve(casePath);
  const raw = readFileSync(abs, "utf8");
  const { meta, body } = splitFrontmatter(raw);

  const sections = parseSections(body);
  const tools = asStringArray(meta.tools);
  const hard_checks = asHardChecks(meta.hard_checks);

  const workspace_mode =
    (meta.workspace_mode as CaseDef["workspace_mode"]) ||
    defaults.workspace_mode;

  return {
    id: String(meta.id ?? basenameId(abs)),
    title: String(meta.title ?? ""),
    category: String(meta.category ?? ""),
    difficulty: String(meta.difficulty ?? "medium"),
    tags: asStringArray(meta.tags),
    max_turns: num(meta.max_turns, defaults.max_turns),
    timeout_s: num(meta.timeout_s, defaults.timeout_s),
    pass_threshold: num(meta.pass_threshold, defaults.pass_threshold),
    tools,
    fixtures: meta.fixtures != null ? String(meta.fixtures) : undefined,
    workspace_mode,
    hard_checks,
    sourcePath: abs,
    task: sections["task"] ?? "",
    context: sections["context"] ?? "",
    constraints: sections["constraints"] ?? "",
    success_criteria: sections["success criteria"] ?? "",
    expected_tool_pattern: sections["expected tool pattern"] ?? "",
    judge_rubric: sections["judge rubric"] ?? "",
    notes: sections["notes"] ?? "",
  };
}

function splitFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  if (!raw.startsWith("---")) {
    return { meta: {}, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: raw };
  const yaml = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  return { meta: parseSimpleYaml(yaml), body };
}

/** Minimal YAML for our case frontmatter (maps, lists, scalars). */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = text.replace(/\t/g, "  ").split(/\r?\n/);
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> | unknown[] }> =
    [{ indent: -1, obj: root }];

  const currentContainer = () => stack[stack.length - 1]!;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    const trimmed = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const parent = currentContainer().obj;

    if (trimmed.startsWith("- ")) {
      const itemRaw = trimmed.slice(2);
      if (!Array.isArray(parent)) {
        // Shouldn't happen if YAML well-formed
        continue;
      }
      if (itemRaw.includes(":") && !itemRaw.startsWith('"') && !itemRaw.startsWith("'")) {
        // inline map or key-only start of map
        const obj: Record<string, unknown> = {};
        const m = itemRaw.match(/^([\w_]+):\s*(.*)$/);
        if (m) {
          const key = m[1]!;
          const val = m[2]!;
          if (val === "" || val === "|" || val === ">") {
            obj[key] = val === "" ? null : val;
          } else {
            obj[key] = parseScalar(val);
          }
          parent.push(obj);
          stack.push({ indent, obj });
        } else {
          parent.push(parseScalar(itemRaw));
        }
      } else {
        parent.push(parseScalar(itemRaw));
      }
      continue;
    }

    const km = trimmed.match(/^([\w_]+):\s*(.*)$/);
    if (!km || Array.isArray(parent)) continue;
    const key = km[1]!;
    const rest = km[2]!;

    if (rest === "" || rest === "|" || rest === ">") {
      // Lookahead: list or nested map?
      const next = peekNext(lines, i + 1);
      if (next && next.trim().startsWith("- ")) {
        const arr: unknown[] = [];
        parent[key] = arr;
        stack.push({ indent, obj: arr });
      } else if (next && (next.match(/^ */)?.[0].length ?? 0) > indent) {
        const obj: Record<string, unknown> = {};
        parent[key] = obj;
        stack.push({ indent, obj });
      } else {
        parent[key] = null;
      }
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      parent[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => parseScalar(s.trim()))
        .filter((x) => x !== "");
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

function peekNext(lines: string[], from: number): string | null {
  for (let i = from; i < lines.length; i++) {
    if (lines[i]!.trim() && !lines[i]!.trim().startsWith("#")) return lines[i]!;
  }
  return null;
}

function parseScalar(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    // Double-quoted YAML: unescape \\ \" \n \t \r \/ and \xHH-style not needed
    return s
      .slice(1, -1)
      .replace(/\\([\\"/nrt])/g, (_, ch: string) => {
        switch (ch) {
          case "\\":
            return "\\";
          case '"':
            return '"';
          case "/":
            return "/";
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "\t";
          default:
            return ch;
        }
      });
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    // Single-quoted YAML: only '' → '
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

function parseSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^##\s+(.+)\s*$/gm;
  const matches: Array<{ title: string; contentStart: number; headingStart: number }> =
    [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    matches.push({
      title: m[1]!.trim().toLowerCase(),
      contentStart: m.index + m[0].length,
      headingStart: m.index,
    });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.contentStart;
    const end =
      i + 1 < matches.length ? matches[i + 1]!.headingStart : body.length;
    out[matches[i]!.title] = body.slice(start, end).trim();
  }
  return out;
}

function asStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

function asHardChecks(v: unknown): HardCheck[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => {
    if (item && typeof item === "object") return item as HardCheck;
    return { type: String(item) };
  });
}

function num(v: unknown, fallback: number): number {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function matchStr(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m?.[1]?.trim() ?? null;
}

function matchNum(text: string, re: RegExp): number | null {
  const m = text.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function basenameId(p: string): string {
  const base = p.replace(/\\/g, "/").split("/").pop() ?? "case";
  return base.replace(/\.md$/, "");
}

export function resolveFixturesDir(
  suiteRoot: string,
  caseDef: CaseDef,
): string | null {
  if (!caseDef.fixtures) return null;
  const p = join(suiteRoot, caseDef.fixtures);
  return existsSync(p) ? p : null;
}

export function extractAgentSystemPrompt(headlessAgentMd: string): string {
  // Prefer fenced block after "## System prompt"
  const m = headlessAgentMd.match(
    /##\s+System prompt\s*```(?:text)?\s*([\s\S]*?)```/i,
  );
  if (m) return m[1]!.trim();
  // Fallback: first large fence
  const m2 = headlessAgentMd.match(/```(?:text)?\s*([\s\S]*?)```/);
  return (m2?.[1] ?? headlessAgentMd).trim();
}

export function extractJudgeSystem(judgeMd: string): string {
  // Drop leading title-only; use whole file body without first H1 if present
  return judgeMd.replace(/^#\s+.*\n+/, "").trim();
}
