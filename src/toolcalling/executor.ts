/**
 * Fast local tool executor — no LLM, pure Node I/O.
 * Supports Libra-native tools and Fusion catalog aliases.
 *
 * Hardening (OpenCode / Hermes inspired):
 *  - path sandbox + similar-path suggestions on ENOENT
 *  - binary / huge-file guards on read
 *  - default read limit + "more lines" footer
 *  - ambiguous search_replace fails without replace_all
 *  - AbortSignal + background shell (process tool)
 *  - structured error codes + recovery hints
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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { normalizeToolArgs } from "./normalize.js";
import { processAction, startBackground } from "./process.js";
import {
  prepareShellCommand,
  resolveShellHost,
} from "./shell-win.js";
import { formatShellOutputForModel } from "./truncate.js";
import {
  formatWebFetchForModel,
  formatWebSearchForModel,
  webFetchUrl,
  webSearch,
} from "./web.js";

const MAX_RESULT = 24_000;
/** OpenCode default — avoid blowing context */
const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_FILE_BYTES = 5_000_000;
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
  /** Abort in-flight shell / fetch */
  signal?: AbortSignal;
  /** Default max lines for read_file when limit omitted (default 2000) */
  defaultReadLimit?: number;
}

export interface ToolExecResult {
  ok: boolean;
  output: string;
  /** Structured payload when available (especially json style) */
  data?: Record<string, unknown>;
  durationMs: number;
  /** Machine code when ok=false */
  code?: string;
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

  /** Update abort signal mid-session (agent cancel). */
  setSignal(signal: AbortSignal | undefined): void {
    this.opts.signal = signal;
  }

  async run(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecResult> {
    const t0 = Date.now();
    try {
      if (this.opts.signal?.aborted) {
        return {
          ok: false,
          output: "cancelled",
          data: { ok: false, error: "cancelled", code: "cancelled" },
          durationMs: Date.now() - t0,
          code: "cancelled",
        };
      }
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
        code: data.ok === false ? String(data.code ?? "error") : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = classifyError(msg);
      const hint = hintForError(code, msg);
      const data: Record<string, unknown> = {
        ok: false,
        error: msg,
        code,
        ...(hint ? { hint } : {}),
      };
      const text = hint ? `${msg}\nHint: ${hint}` : msg;
      return {
        ok: false,
        output:
          this.resultStyle === "json" ? JSON.stringify(data) : text,
        data,
        durationMs: Date.now() - t0,
        code,
      };
    }
  }

  private formatText(
    name: string,
    data: Record<string, unknown>,
  ): string {
    if (name === "run_terminal_command" || name === "run_shell") {
      return formatShellOutput(data);
    }
    if (name === "process") {
      return JSON.stringify(data, null, 0);
    }
    if (data.ok === false) {
      const base = String(data.error ?? "error");
      return data.hint ? `${base}\nHint: ${data.hint}` : base;
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
      case "read_file": {
        if (Array.isArray(data.files)) {
          const files = data.files as Array<{
            path: string;
            ok?: boolean;
            content?: string;
            error?: string;
          }>;
          return files
            .map((f) =>
              f.ok === false
                ? `===== ${f.path} ERROR =====\n${f.error ?? "error"}`
                : `===== ${f.path} =====\n${f.content ?? ""}`,
            )
            .join("\n");
        }
        let body = String(data.content ?? "");
        if (data.truncated || data.has_more) {
          body += `\n\n(File has more lines. Use offset=${data.next_offset ?? "?"} to continue; total_lines=${data.total_lines ?? "?"})`;
        }
        return body;
      }
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
      case "calc":
        return String(data.value ?? "");
      case "todo_write":
        return `todos: ${JSON.stringify(data.items ?? [])}`;
      case "finish":
        return `finished: ${String(data.answer ?? "").slice(0, 200)}`;
      case "web_fetch":
        return formatWebFetchForModel({
          ok: data.ok !== false,
          status: Number(data.status ?? 0),
          url: String(data.url ?? ""),
          finalUrl:
            data.finalUrl != null ? String(data.finalUrl) : undefined,
          contentType:
            data.contentType != null ? String(data.contentType) : undefined,
          title: data.title != null ? String(data.title) : undefined,
          content: String(data.content ?? ""),
          truncated: Boolean(data.truncated),
          error: data.error != null ? String(data.error) : undefined,
        });
      case "web_search":
        return formatWebSearchForModel({
          ok: data.ok !== false,
          query: String(data.query ?? ""),
          results: (Array.isArray(data.results)
            ? data.results
            : []) as never,
          provider: String(data.provider ?? ""),
          error: data.error != null ? String(data.error) : undefined,
        });
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
      case "read_file": {
        const batch = args.target_files;
        if (Array.isArray(batch) && batch.length > 0) {
          return this.readFiles(
            batch.map((p) => String(p ?? "")).filter(Boolean),
          );
        }
        const single = str(args.target_file);
        if (!single) {
          throw Object.assign(
            new Error(
              "read_file requires target_file or non-empty target_files",
            ),
            { code: "invalid_args" },
          );
        }
        return this.readFile(single, num(args.offset), num(args.limit));
      }
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
          Boolean(args.background),
          args.description ? str(args.description) : undefined,
        );
      case "process":
        return processAction(str(args.action, "list"), {
          session_id: args.session_id ? str(args.session_id) : undefined,
          data: args.data != null ? str(args.data) : undefined,
          timeout_ms: num(args.timeout_ms),
          offset: num(args.offset),
          limit: num(args.limit),
        });
      case "web_fetch":
        return this.webFetch(str(args.url));
      case "web_search":
        return this.webSearch(
          str(
            args.query ??
              args.q ??
              args.search ??
              // Models often confuse web_search with grep and pass `pattern`
              args.pattern ??
              args.keywords ??
              args.keyword,
          ),
          num(args.max_results ?? args.maxResults, 8) ?? 8,
        );
      case "calc":
        return this.calc(str(args.expression));
      case "todo_write":
        return this.todoWrite(args.items ?? args.todos, Boolean(args.merge));
      case "finish":
        return {
          ok: true,
          finished: true,
          answer: str(args.answer),
          success: args.success !== false,
        };
      default:
        throw Object.assign(new Error(`unknown tool: ${name}`), {
          code: "unknown_tool",
        });
    }
  }

  private resolveSafe(p: string): string {
    let rel = p.replace(/\\/g, "/");
    if (rel.startsWith("./")) rel = rel.slice(2);
    if (rel === "workspace" || rel.startsWith("workspace/")) {
      rel = rel === "workspace" ? "." : rel.slice("workspace/".length);
    }
    const abs = resolve(this.cwd, rel);
    const root = resolve(this.cwd);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw Object.assign(new Error(`path escapes workspace: ${p}`), {
        code: "path_escape",
      });
    }
    return abs;
  }

  private listDir(dir: string): Record<string, unknown> {
    const abs = this.resolveSafe(dir);
    if (!existsSync(abs)) {
      const sug = suggestPaths(this.cwd, dir);
      throw Object.assign(
        new Error(
          `not found: ${dir}${sug.length ? ` (did you mean: ${sug.join(", ")})` : ""}`,
        ),
        { code: "not_found" },
      );
    }
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

  private readFiles(paths: string[]): Record<string, unknown> {
    const files: Array<Record<string, unknown>> = [];
    let anyOk = false;
    for (const p of paths) {
      try {
        const one = this.readFile(p);
        files.push({ path: p, ok: true, content: one.content });
        anyOk = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        files.push({ path: p, ok: false, error: msg });
      }
    }
    return {
      ok: anyOk,
      files,
      count: files.length,
      error: anyOk ? undefined : "all reads failed",
    };
  }

  private readFile(
    path: string,
    offset?: number,
    limit?: number,
  ): Record<string, unknown> {
    const abs = this.resolveSafe(path);
    if (!existsSync(abs)) {
      const sug = suggestPaths(this.cwd, path);
      const err = new Error(
        `ENOENT: path not found: ${path}${sug.length ? ` (did you mean: ${sug.join(", ")})` : ""}`,
      );
      (err as Error & { code?: string }).code = "not_found";
      throw err;
    }

    const st = statSync(abs);
    if (st.isDirectory()) {
      throw Object.assign(new Error(`is a directory: ${path}`), {
        code: "is_directory",
      });
    }
    if (st.size > MAX_FILE_BYTES) {
      throw Object.assign(
        new Error(
          `file too large (${st.size} bytes > ${MAX_FILE_BYTES}): ${path}. Use offset/limit or grep.`,
        ),
        { code: "too_large" },
      );
    }

    // Binary sniff (first 8k)
    const probe = readFileSync(abs).subarray(0, 8192);
    if (isBinaryBuffer(probe)) {
      throw Object.assign(
        new Error(
          `Cannot read binary file: ${path}. Use a specialized tool for images/binaries.`,
        ),
        { code: "binary" },
      );
    }

    const raw = probe.length === st.size
      ? probe.toString("utf8")
      : readFileSync(abs, "utf8");

    // Catalog / json style: full raw content when no range (fixtures)
    if (this.resultStyle === "json" && offset == null && limit == null) {
      return { ok: true, content: raw };
    }

    const lines = raw.split(/\r?\n/);
    const defaultLimit = this.opts.defaultReadLimit ?? DEFAULT_READ_LIMIT;
    const start = Math.max(0, (offset ?? 1) - 1);
    const maxLines = limit ?? defaultLimit;
    const end = Math.min(lines.length, start + maxLines);
    const slice = lines.slice(start, end).map((l) =>
      l.length > MAX_LINE_LENGTH
        ? l.slice(0, MAX_LINE_LENGTH) + "…"
        : l,
    );
    const hasMore = end < lines.length;

    if (this.resultStyle === "json") {
      return {
        ok: true,
        content: slice.join("\n"),
        offset: start + 1,
        lines: slice.length,
        total_lines: lines.length,
        has_more: hasMore,
        next_offset: hasMore ? end + 1 : undefined,
      };
    }

    const numbered = slice
      .map((l, i) => `${String(start + i + 1).padStart(4)}|${l}`)
      .join("\n");
    return {
      ok: true,
      content: numbered,
      total_lines: lines.length,
      has_more: hasMore,
      truncated: hasMore,
      next_offset: hasMore ? end + 1 : undefined,
    };
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
    if (!existsSync(abs)) {
      const sug = suggestPaths(this.cwd, path);
      throw Object.assign(
        new Error(
          `not found: ${path}${sug.length ? ` (did you mean: ${sug.join(", ")})` : ""}`,
        ),
        { code: "not_found" },
      );
    }
    const raw = readFileSync(abs, "utf8");
    if (!raw.includes(oldStr)) {
      // Soft hint: whitespace-only mismatch
      const soft = findSoftMatchHint(raw, oldStr);
      throw Object.assign(
        new Error(
          soft
            ? `old_string not found. ${soft}`
            : "old_string not found — read the file and copy the exact text (including whitespace).",
        ),
        { code: "not_found" },
      );
    }

    const count = countOccurrences(raw, oldStr);
    // OpenCode: fail when multiple matches without replace_all
    if (count > 1 && !replaceAll) {
      throw Object.assign(
        new Error(
          `old_string matched ${count} times; set replace_all=true or include more surrounding context to make it unique.`,
        ),
        { code: "ambiguous" },
      );
    }

    const next = replaceAll
      ? raw.split(oldStr).join(newStr)
      : raw.replace(oldStr, newStr);
    writeFileSync(abs, next, "utf8");
    return { ok: true, replacements: replaceAll ? count : 1, path };
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
        const buf = readFileSync(f);
        if (isBinaryBuffer(buf.subarray(0, 4096))) continue;
        text = buf.toString("utf8");
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
    background?: boolean,
    description?: string,
  ): Promise<Record<string, unknown>> {
    if (!command.trim()) {
      return Promise.resolve({
        ok: false,
        error: "empty command",
        code: "error",
        stdout: "",
        stderr: "empty command",
        exit_code: 1,
      });
    }
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

    const { host, shellOption: shellOpt } = resolveShellHost();
    // Rewrite bash-isms / npm.ps1 pitfalls before spawn (Windows coding agents).
    const prepared = prepareShellCommand(command, host);

    if (background) {
      const session = startBackground(prepared, this.cwd, shellOpt);
      return Promise.resolve({
        ok: true,
        background: true,
        session_id: session.id,
        pid: session.pid,
        description: description ?? prepared.slice(0, 80),
        hint: 'Use process(action="poll"|"log"|"wait"|"kill", session_id=...) to manage.',
      });
    }

    return new Promise((resolveP) => {
      const t0 = Date.now();
      const child = spawn(prepared, {
        cwd: this.cwd,
        shell: shellOpt,
        windowsHide: true,
        env: {
          ...process.env,
          NO_PROXY: "*",
        },
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (payload: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.opts.signal?.removeEventListener("abort", onAbort);
        resolveP({ ...payload, duration_ms: Date.now() - t0 });
      };
      const onAbort = () => {
        try {
          child.kill();
        } catch {
          /* */
        }
        finish({
          ok: false,
          error: "cancelled",
          code: "cancelled",
          stdout: truncate(stdout, MAX_RESULT / 2),
          stderr: truncate(stderr, MAX_RESULT / 4),
          exit_code: 130,
          description,
        });
      };
      if (this.opts.signal) {
        if (this.opts.signal.aborted) {
          onAbort();
          return;
        }
        this.opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* */
        }
        finish({
          ok: false,
          error: `timeout after ${timeoutMs}ms`,
          code: "timeout",
          timed_out: true,
          stdout: truncate(stdout, MAX_RESULT / 2),
          stderr: truncate(
            (stderr ? stderr + "\n" : "") + `timeout after ${timeoutMs}ms`,
            MAX_RESULT / 4,
          ),
          exit_code: 124,
          description,
        });
      }, timeoutMs);
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (e) => {
        finish({
          ok: false,
          error: e.message,
          code: "spawn_error",
          stdout: truncate(stdout, MAX_RESULT / 2),
          stderr: truncate(stderr || e.message, MAX_RESULT / 4),
          exit_code: 1,
          description,
        });
      });
      child.on("close", (code, signal) => {
        const exit = code ?? (signal ? 1 : 0);
        const out = truncate(stdout, MAX_RESULT / 2);
        const err = truncate(stderr, MAX_RESULT / 4);
        const ok = exit === 0;
        finish({
          ok,
          stdout: out,
          stderr: err,
          exit_code: exit,
          description,
          error: ok
            ? undefined
            : (
                err.trim() ||
                out.trim() ||
                (signal ? `killed by signal ${signal}` : `exit code ${exit}`)
              ).slice(0, 800),
          code: ok ? undefined : "exit",
        });
      });
    });
  }

  private async webFetch(url: string): Promise<Record<string, unknown>> {
    const r = await webFetchUrl(url, {
      signal: this.opts.signal,
      maxChars: MAX_RESULT,
    });
    if (!r.ok && !r.content) {
      throw Object.assign(new Error(r.error ?? "web_fetch failed"), {
        code: r.status === 0 ? "network" : "http_error",
      });
    }
    return {
      ok: r.ok,
      status: r.status,
      url: r.url,
      finalUrl: r.finalUrl,
      contentType: r.contentType,
      title: r.title,
      content: r.content,
      truncated: r.truncated,
      error: r.error,
    };
  }

  private async webSearch(
    query: string,
    maxResults: number,
  ): Promise<Record<string, unknown>> {
    const r = await webSearch(query, {
      maxResults: Math.min(12, Math.max(1, maxResults || 8)),
      signal: this.opts.signal,
    });
    if (!r.ok && r.results.length === 0) {
      throw Object.assign(new Error(r.error ?? "web_search failed"), {
        code: "network",
      });
    }
    return {
      ok: r.ok,
      query: r.query,
      provider: r.provider,
      results: r.results,
      count: r.results.length,
    };
  }

  private calc(expression: string): Record<string, unknown> {
    const value = evalMath(expression);
    return { ok: true, value };
  }

  private todoWrite(
    items: unknown,
    merge?: boolean,
  ): Record<string, unknown> {
    if (items == null && merge) {
      return { ok: true, items: this.todos };
    }
    const list = coerceTodoItems(items);
    if (!list) {
      throw new Error(
        'todo_write requires items (or todos) as an array of {id?, content, status}. ' +
          'Example: items:[{id:"1",content:"Implement",status:"in_progress"}]',
      );
    }
    const mapped = list.map((it, i) => {
      const o = it as Record<string, unknown>;
      const content = String(
        o.content ?? o.title ?? o.task ?? o.text ?? "",
      );
      const status = String(
        o.status ?? o.state ?? "pending",
      );
      const id = String(o.id ?? o.key ?? `t${i + 1}`);
      return { id, content, status };
    });
    if (merge) {
      const byId = new Map(this.todos.map((t) => [t.id, t]));
      for (const t of mapped) {
        if (!t.id) continue;
        const prev = byId.get(t.id);
        byId.set(t.id, prev ? { ...prev, ...t } : t);
      }
      this.todos = [...byId.values()];
    } else {
      this.todos = mapped;
    }
    return { ok: true, items: this.todos };
  }
}

/** Accept array, JSON string, or { items: [...] } shapes models emit. */
export function coerceTodoItems(raw: unknown): unknown[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    try {
      return coerceTodoItems(JSON.parse(s));
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.items)) return o.items;
    if (Array.isArray(o.todos)) return o.todos;
  }
  return null;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while (true) {
    const j = haystack.indexOf(needle, i);
    if (j < 0) break;
    count++;
    i = j + needle.length;
  }
  return count;
}

/** Hint when exact match fails but collapsed-whitespace would match. */
function findSoftMatchHint(raw: string, oldStr: string): string | null {
  if (!oldStr.trim()) return null;
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = collapse(oldStr);
  if (!target) return null;
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (collapse(lines[i]!).includes(target.slice(0, Math.min(40, target.length)))) {
      return `Nearby line ${i + 1} looks similar after whitespace collapse — re-read and copy exact text.`;
    }
  }
  return null;
}

function isBinaryBuffer(buf: Buffer): boolean {
  if (!buf.length) return false;
  // NUL byte is a strong signal
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  // High ratio of non-text control chars
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i]!;
    if (c < 7 || (c > 14 && c < 32 && c !== 27)) ctrl++;
  }
  return ctrl / n > 0.3;
}

/** Suggest similar relative paths under cwd (Hermes-style). */
function suggestPaths(cwd: string, wanted: string, max = 3): string[] {
  const base = basename(wanted).toLowerCase();
  if (!base || base === "." || base === "..") return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || found.length >= 20) return;
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
        e.name.toLowerCase().includes(base) ||
        base.includes(e.name.toLowerCase().replace(/\.[^.]+$/, ""))
      ) {
        found.push(relative(cwd, full).replace(/\\/g, "/"));
      }
    }
  };
  try {
    walk(cwd, 0);
  } catch {
    /* */
  }
  return found.slice(0, max);
}

function firstBinary(command: string): string | null {
  const t = command.trim();
  if (!t) return null;
  const m = t.match(/^["']?([A-Za-z0-9_.+-]+)/);
  return m?.[1] ?? null;
}

function formatShellOutput(data: Record<string, unknown>): string {
  if (data.background) {
    return `background session ${data.session_id} (pid ${data.pid ?? "?"})\n${data.hint ?? ""}`;
  }
  const exitRaw = data.exit_code;
  const exitCode =
    typeof exitRaw === "number"
      ? exitRaw
      : exitRaw != null && Number.isFinite(Number(exitRaw))
        ? Number(exitRaw)
        : null;
  const durationMs =
    typeof data.duration_ms === "number"
      ? data.duration_ms
      : typeof data.durationMs === "number"
        ? data.durationMs
        : 0;
  const body = [data.stdout, data.stderr]
    .map((x) => (typeof x === "string" ? x : ""))
    .filter((s) => s.length > 0)
    .join("\n")
    .trim();
  const errExtra =
    data.ok === false && data.error && !body.includes(String(data.error))
      ? String(data.error)
      : "";
  let output = [errExtra, body || "(no output)"].filter(Boolean).join("\n");
  // Recovery hints for common agent shell failures (Windows + package managers)
  if (data.ok === false) {
    const hint = shellFailureHint(output);
    if (hint) output = `${output}\n\n[libra:shell-hint] ${hint}`;
  }
  // Codex-style framing for the model
  return formatShellOutputForModel({
    exitCode,
    durationMs,
    output,
    timedOut: Boolean(data.timed_out ?? data.timeout),
  });
}

/** Actionable recovery lines appended to failed shell results. */
export function shellFailureHint(combinedOutput: string): string | null {
  const o = combinedOutput;
  if (/not a valid statement separator|token '&&'/i.test(o)) {
    return (
      "This host rejects bash-style &&. Prefer a single command, or rely on " +
      "the harness cmd.exe default which supports &&. Do not spend steps probing shells."
    );
  }
  if (/npm\.ps1|running scripts is disabled|ExecutionPolicy/i.test(o)) {
    return (
      "npm.ps1 is blocked by ExecutionPolicy. Use npm.cmd / npx.cmd (harness rewrites " +
      "these automatically on Windows). Retry once with the package manager only."
    );
  }
  if (/'tail' is not recognized|'head' is not recognized/i.test(o)) {
    return (
      "head/tail are not available on Windows cmd. Do not pipe through them — " +
      "the harness strips these pipes when possible. Re-run the left-hand command alone."
    );
  }
  if (/ENOENT|not recognized as an internal or external command/i.test(o)) {
    return (
      "Command not found. Check spelling; for package scripts use npm.cmd run <script> " +
      "after npm.cmd install."
    );
  }
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(o)) {
    return (
      "Missing dependency or wrong entry. Run bun install (or npm.cmd install), check package.json " +
      "type/module, and prefer bun for TypeScript tests/scripts."
    );
  }
  if (/\bEADDRINUSE\b|address already in use/i.test(o)) {
    return "Port in use. Bind to port 0 in tests and close the server in after() hooks.";
  }
  return null;
}

/** @deprecated use resolveShellHost().shellOption — kept for any external callers. */
function resolveShellOption(): string | true | boolean {
  return resolveShellHost().shellOption;
}

function classifyError(msg: string): string {
  if (/not found|ENOENT/i.test(msg)) return "not_found";
  if (/escapes workspace/i.test(msg)) return "path_escape";
  if (/old_string not found/i.test(msg)) return "not_found";
  if (/matched \d+ times|ambiguous/i.test(msg)) return "ambiguous";
  if (/timeout/i.test(msg)) return "timeout";
  if (/unknown tool/i.test(msg)) return "unknown_tool";
  if (/binary/i.test(msg)) return "binary";
  if (/too large/i.test(msg)) return "too_large";
  if (/cancelled/i.test(msg)) return "cancelled";
  if (/not allowlisted|not_allowed/i.test(msg)) return "not_allowed";
  return "error";
}

function hintForError(code: string, _msg: string): string | undefined {
  switch (code) {
    case "not_found":
      return "Check the path with list_dir/glob, or use a suggested path if provided.";
    case "ambiguous":
      return "Widen old_string context or set replace_all=true.";
    case "path_escape":
      return "Use paths relative to the workspace root only.";
    case "binary":
      return "Skip binary files; use shell/file tools designed for that type.";
    case "too_large":
      return "Read with offset/limit or search with grep.";
    case "unknown_tool":
      return "Use only tools listed in the schema.";
    default:
      return undefined;
  }
}

/**
 * Safe arithmetic evaluator: numbers, + - * / % ** ( ), whitespace.
 * Rejects identifiers and function calls.
 */
export function evalMath(expression: string): number {
  const expr = expression.trim();
  if (!expr) throw new Error("empty expression");
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
