/**
 * Fast local tool executor — no LLM, pure Node I/O.
 * Supports Libra-native tools and Fusion catalog aliases.
 *
 * resultStyle:
 *   "text"  — human-readable lines (default, interactive TUI)
 *   "json"  — catalog-shaped {ok, ...} JSON strings for headless evals
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { normalizeToolArgs } from "./normalize.js";

const MAX_RESULT = 24_000;
const IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
]);

/** Conservative shell allowlist for sandboxed evals (basename match). */
const SHELL_ALLOW = new Set([
  "echo",
  "dir",
  "ls",
  "type",
  "cat",
  "wc",
  "find",
  "head",
  "tail",
  "sort",
  "uniq",
  "python",
  "python3",
  "py",
  "node",
  "powershell",
  "pwsh",
  "cmd",
  "where",
  "which",
  "git",
]);

export type ToolResultStyle = "text" | "json";

export interface ToolExecutorOptions {
  resultStyle?: ToolResultStyle;
  /** When true, only allowlisted shell binaries may run */
  shellAllowlist?: boolean;
}

export interface ToolExecResult {
  ok: boolean;
  output: string;
  /** Structured payload when available (especially json style) */
  data?: Record<string, unknown>;
  durationMs: number;
}

export class ToolExecutor {
  private todos: Array<{
    id: string;
    content: string;
    status: string;
  }> = [];

  constructor(
    private cwd: string = process.cwd(),
    private opts: ToolExecutorOptions = {},
  ) {}

  get resultStyle(): ToolResultStyle {
    return this.opts.resultStyle ?? "text";
  }

  async run(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecResult> {
    const t0 = Date.now();
    try {
      const normalized = normalizeToolArgs(name, args);
      const data = await this.dispatch(name, normalized);
      const output =
        this.resultStyle === "json"
          ? truncate(JSON.stringify(data), MAX_RESULT)
          : truncate(this.formatText(name, data), MAX_RESULT);
      return {
        ok: data.ok !== false,
        output,
        data,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = classifyError(msg);
      const data: Record<string, unknown> = {
        ok: false,
        error: msg,
        code,
      };
      return {
        ok: false,
        output:
          this.resultStyle === "json"
            ? JSON.stringify(data)
            : msg,
        data,
        durationMs: Date.now() - t0,
      };
    }
  }

  private formatText(
    name: string,
    data: Record<string, unknown>,
  ): string {
    if (data.ok === false) {
      return String(data.error ?? "error");
    }
    switch (name) {
      case "list_dir": {
        const entries = data.entries as
          | Array<{ name: string; type: string }>
          | undefined;
        if (!entries?.length) return "(empty)";
        return entries
          .map((e) => (e.type === "dir" ? `${e.name}/` : e.name))
          .join("\n");
      }
      case "read_file":
        return String(data.content ?? "");
      case "write":
      case "write_file":
        return `wrote ${data.bytes ?? "?"} bytes → ${data.path ?? ""}`;
      case "search_replace":
      case "edit_file":
        return `replaced ${data.replacements ?? 0} occurrence(s) in ${data.path ?? ""}`;
      case "grep": {
        const matches = data.matches as
          | Array<{ path: string; line: number; text: string }>
          | undefined;
        if (!matches?.length) return "(no matches)";
        return matches
          .map((m) => `${m.path}:${m.line}:${m.text}`)
          .join("\n");
      }
      case "glob": {
        const files = data.files as string[] | undefined;
        return files?.join("\n") || "(no matches)";
      }
      case "run_terminal_command":
      case "run_shell": {
        const body = [data.stdout, data.stderr].filter(Boolean).join("\n").trim();
        return `exit ${data.exit_code ?? "?"}\n${body || "(no output)"}`;
      }
      case "calc":
        return String(data.value ?? "");
      case "todo_write":
        return `todos: ${JSON.stringify(data.items ?? [])}`;
      case "finish":
        return `finished: ${String(data.answer ?? "").slice(0, 200)}`;
      case "web_fetch":
        return `HTTP ${data.status}\n${data.content ?? ""}`;
      default:
        return JSON.stringify(data);
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case "list_dir":
        return this.listDir(str(args.target_directory, "."));
      case "read_file":
        return this.readFile(
          str(args.target_file),
          num(args.offset),
          num(args.limit),
        );
      case "write":
      case "write_file":
        return this.write(str(args.file_path), str(args.content));
      case "search_replace":
      case "edit_file":
        return this.searchReplace(
          str(args.file_path),
          str(args.old_string),
          str(args.new_string),
          Boolean(args.replace_all),
        );
      case "grep":
        return this.grep(
          str(args.pattern),
          str(args.path, "."),
          args.glob ? str(args.glob) : undefined,
          Boolean(args.case_insensitive),
        );
      case "glob":
        return this.glob(str(args.pattern));
      case "run_terminal_command":
      case "run_shell":
        return this.shell(
          str(args.command),
          num(args.timeout_ms, 30_000) ?? 30_000,
        );
      case "web_fetch":
        return this.webFetch(str(args.url));
      case "calc":
        return this.calc(str(args.expression));
      case "todo_write":
        return this.todoWrite(args.items);
      case "finish":
        return {
          ok: true,
          finished: true,
          answer: str(args.answer),
          success: args.success !== false,
        };
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  private resolveSafe(p: string): string {
    // Strip leading ./ and workspace/ prefixes agents sometimes add
    let rel = p.replace(/\\/g, "/");
    if (rel.startsWith("./")) rel = rel.slice(2);
    if (rel === "workspace" || rel.startsWith("workspace/")) {
      rel = rel === "workspace" ? "." : rel.slice("workspace/".length);
    }
    const abs = resolve(this.cwd, rel);
    const root = resolve(this.cwd);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`path escapes workspace: ${p}`);
    }
    return abs;
  }

  private listDir(dir: string): Record<string, unknown> {
    const abs = this.resolveSafe(dir);
    if (!existsSync(abs)) throw new Error(`not found: ${dir}`);
    const entries = readdirSync(abs, { withFileTypes: true });
    const list = entries
      .filter((e) => !IGNORE.has(e.name))
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      )
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
      }));
    return { ok: true, entries: list };
  }

  private readFile(
    path: string,
    offset?: number,
    limit?: number,
  ): Record<string, unknown> {
    const abs = this.resolveSafe(path);
    if (!existsSync(abs)) {
      const err = new Error(`ENOENT: path not found: ${path}`);
      (err as Error & { code?: string }).code = "not_found";
      throw err;
    }
    const raw = readFileSync(abs, "utf8");
    // Catalog / json style: raw content (no line prefixes) for faithful fixtures
    if (this.resultStyle === "json" && offset == null && limit == null) {
      return { ok: true, content: raw };
    }
    const lines = raw.split(/\r?\n/);
    const start = Math.max(0, (offset ?? 1) - 1);
    const end = limit != null ? start + limit : lines.length;
    const slice = lines.slice(start, end);
    if (this.resultStyle === "json") {
      return {
        ok: true,
        content: slice.join("\n"),
        offset: start + 1,
        lines: slice.length,
      };
    }
    // Text style: line-numbered for TUI readability
    const numbered = slice
      .map((l, i) => `${String(start + i + 1).padStart(4)}|${l}`)
      .join("\n");
    return { ok: true, content: numbered };
  }

  private write(path: string, content: string): Record<string, unknown> {
    const abs = this.resolveSafe(path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return { ok: true, bytes: Buffer.byteLength(content, "utf8"), path };
  }

  private searchReplace(
    path: string,
    oldStr: string,
    newStr: string,
    replaceAll: boolean,
  ): Record<string, unknown> {
    const abs = this.resolveSafe(path);
    if (!existsSync(abs)) throw new Error(`not found: ${path}`);
    const raw = readFileSync(abs, "utf8");
    if (!raw.includes(oldStr)) throw new Error("old_string not found");
    const count = replaceAll
      ? raw.split(oldStr).length - 1
      : 1;
    const next = replaceAll
      ? raw.split(oldStr).join(newStr)
      : raw.replace(oldStr, newStr);
    writeFileSync(abs, next, "utf8");
    return { ok: true, replacements: count, path };
  }

  private grep(
    pattern: string,
    path: string,
    glob?: string,
    caseInsensitive?: boolean,
  ): Record<string, unknown> {
    const abs = this.resolveSafe(path);
    const re = new RegExp(pattern, caseInsensitive ? "i" : "");
    const files = collectFiles(abs, glob);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const f of files) {
      if (matches.length > 80) break;
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          matches.push({
            path: relative(this.cwd, f).replace(/\\/g, "/"),
            line: i + 1,
            text: lines[i]!.slice(0, 200),
          });
          if (matches.length > 80) break;
        }
      }
    }
    return { ok: true, matches };
  }

  private glob(pattern: string): Record<string, unknown> {
    const files = collectFiles(this.cwd, pattern)
      .slice(0, 200)
      .map((f) => relative(this.cwd, f).replace(/\\/g, "/"));
    return { ok: true, files };
  }

  private shell(
    command: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (this.opts.shellAllowlist !== false && this.opts.shellAllowlist) {
      const bin = firstBinary(command);
      if (bin && !SHELL_ALLOW.has(bin.toLowerCase())) {
        return Promise.resolve({
          ok: false,
          error: `shell binary not allowlisted: ${bin}`,
          code: "not_allowed",
          stdout: "",
          stderr: `shell binary not allowlisted: ${bin}`,
          exit_code: 126,
        });
      }
    }
    return new Promise((resolveP) => {
      const child = spawn(command, {
        cwd: this.cwd,
        shell: true,
        windowsHide: true,
        env: {
          ...process.env,
          // Discourage network-ish tools; cannot fully block
          NO_PROXY: "*",
        },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        resolveP({
          ok: false,
          error: `timeout after ${timeoutMs}ms`,
          code: "timeout",
          stdout,
          stderr: stderr + `\ntimeout after ${timeoutMs}ms`,
          exit_code: 124,
        });
      }, timeoutMs);
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolveP({
          ok: false,
          error: e.message,
          code: "spawn_error",
          stdout,
          stderr: stderr || e.message,
          exit_code: 1,
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const exit = code ?? 1;
        resolveP({
          ok: exit === 0,
          stdout: truncate(stdout, MAX_RESULT / 2),
          stderr: truncate(stderr, MAX_RESULT / 4),
          exit_code: exit,
        });
      });
    });
  }

  private async webFetch(url: string): Promise<Record<string, unknown>> {
    if (!/^https?:\/\//i.test(url)) throw new Error("url must be http(s)");
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "libra-harness/0.1" },
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      content: truncate(text.replace(/<[^>]+>/g, " "), MAX_RESULT),
    };
  }

  private calc(expression: string): Record<string, unknown> {
    const value = evalMath(expression);
    return { ok: true, value };
  }

  private todoWrite(items: unknown): Record<string, unknown> {
    if (!Array.isArray(items)) {
      throw new Error("items must be an array");
    }
    this.todos = items.map((it) => {
      const o = it as Record<string, unknown>;
      return {
        id: String(o.id ?? ""),
        content: String(o.content ?? ""),
        status: String(o.status ?? "pending"),
      };
    });
    return { ok: true, items: this.todos };
  }
}

function firstBinary(command: string): string | null {
  const t = command.trim();
  if (!t) return null;
  // python -c "..." / node -e
  const m = t.match(/^["']?([A-Za-z0-9_.+-]+)/);
  return m?.[1] ?? null;
}

function classifyError(msg: string): string {
  if (/not found|ENOENT/i.test(msg)) return "not_found";
  if (/escapes workspace/i.test(msg)) return "path_escape";
  if (/old_string not found/i.test(msg)) return "not_found";
  if (/timeout/i.test(msg)) return "timeout";
  if (/unknown tool/i.test(msg)) return "unknown_tool";
  return "error";
}

/**
 * Safe arithmetic evaluator: numbers, + - * / % ** ( ), whitespace.
 * Rejects identifiers and function calls.
 */
export function evalMath(expression: string): number {
  const expr = expression.trim();
  if (!expr) throw new Error("empty expression");
  // Digits, whitespace, + - * / % ( ) . and scientific e/E — no identifiers
  if (!/^[\d\s+\-*/%().eE]+$/.test(expr)) {
    throw new Error(`invalid expression: ${expression}`);
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function(`"use strict"; return (${expr});`);
  const v = fn();
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`expression did not yield a finite number: ${expression}`);
  }
  return v;
}

function str(v: unknown, fallback = ""): string {
  if (v == null) return fallback;
  return String(v);
}

function num(v: unknown, fallback?: number): number | undefined {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated ${s.length - max} chars]`;
}

function collectFiles(root: string, globPat?: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 14 || out.length > 2000) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (
        !globPat ||
        matchGlob(relative(root, full).replace(/\\/g, "/"), globPat)
      ) {
        out.push(full);
      }
    }
  };
  try {
    if (statSync(root).isFile()) return [root];
  } catch {
    return [];
  }
  walk(root, 0);
  return out;
}

/** Minimal glob: supports *, **, ? */
function matchGlob(path: string, pattern: string): boolean {
  const p = pattern.replace(/\\/g, "/");
  const re = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/<<<GLOBSTAR>>>/g, ".*");
  return new RegExp(`^${re}$`, "i").test(path.replace(/\\/g, "/"));
}
