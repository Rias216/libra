/**
 * Fast local tool executor — no LLM, pure Node I/O.
 * Results are truncated for context efficiency.
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

export interface ToolExecResult {
  ok: boolean;
  output: string;
  durationMs: number;
}

export class ToolExecutor {
  constructor(private cwd: string = process.cwd()) {}

  async run(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecResult> {
    const t0 = Date.now();
    try {
      const output = await this.dispatch(name, args);
      return {
        ok: true,
        output: truncate(output, MAX_RESULT),
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      };
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
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
        return this.write(str(args.file_path), str(args.content));
      case "search_replace":
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
        return this.shell(str(args.command), num(args.timeout_ms, 30_000) ?? 30_000);
      case "web_fetch":
        return this.webFetch(str(args.url));
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  private resolveSafe(p: string): string {
    const abs = resolve(this.cwd, p);
    const root = resolve(this.cwd);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`path escapes workspace: ${p}`);
    }
    return abs;
  }

  private listDir(dir: string): string {
    const abs = this.resolveSafe(dir);
    if (!existsSync(abs)) throw new Error(`not found: ${dir}`);
    const entries = readdirSync(abs, { withFileTypes: true });
    const lines = entries
      .filter((e) => !IGNORE.has(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return lines.join("\n") || "(empty)";
  }

  private readFile(path: string, offset?: number, limit?: number): string {
    const abs = this.resolveSafe(path);
    if (!existsSync(abs)) throw new Error(`not found: ${path}`);
    const raw = readFileSync(abs, "utf8");
    const lines = raw.split(/\r?\n/);
    const start = Math.max(0, (offset ?? 1) - 1);
    const end = limit != null ? start + limit : lines.length;
    const slice = lines.slice(start, end);
    return slice
      .map((l, i) => `${String(start + i + 1).padStart(4)}|${l}`)
      .join("\n");
  }

  private write(path: string, content: string): string {
    const abs = this.resolveSafe(path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return `wrote ${content.length} bytes → ${path}`;
  }

  private searchReplace(
    path: string,
    oldStr: string,
    newStr: string,
    replaceAll: boolean,
  ): string {
    const abs = this.resolveSafe(path);
    const raw = readFileSync(abs, "utf8");
    if (!raw.includes(oldStr)) throw new Error("old_string not found");
    const next = replaceAll
      ? raw.split(oldStr).join(newStr)
      : raw.replace(oldStr, newStr);
    writeFileSync(abs, next, "utf8");
    const count = replaceAll
      ? raw.split(oldStr).length - 1
      : 1;
    return `replaced ${count} occurrence(s) in ${path}`;
  }

  private grep(
    pattern: string,
    path: string,
    glob?: string,
    caseInsensitive?: boolean,
  ): string {
    const abs = this.resolveSafe(path);
    const re = new RegExp(pattern, caseInsensitive ? "i" : "");
    const files = collectFiles(abs, glob);
    const hits: string[] = [];
    for (const f of files) {
      if (hits.length > 80) break;
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          const rel = relative(this.cwd, f);
          hits.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 200)}`);
          if (hits.length > 80) break;
        }
      }
    }
    return hits.join("\n") || "(no matches)";
  }

  private glob(pattern: string): string {
    const files = collectFiles(this.cwd, pattern);
    return (
      files
        .slice(0, 200)
        .map((f) => relative(this.cwd, f))
        .join("\n") || "(no matches)"
    );
  }

  private shell(command: string, timeoutMs: number): Promise<string> {
    return new Promise((resolveP, reject) => {
      const child = spawn(command, {
        cwd: this.cwd,
        shell: true,
        windowsHide: true,
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        err += d.toString("utf8");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const body = [out, err].filter(Boolean).join("\n").trim();
        resolveP(
          truncate(
            `exit ${code ?? "?"}\n${body || "(no output)"}`,
            MAX_RESULT,
          ),
        );
      });
    });
  }

  private async webFetch(url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url)) throw new Error("url must be http(s)");
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "libra-harness/0.1" },
    });
    const text = await res.text();
    return `HTTP ${res.status}\n${truncate(text.replace(/<[^>]+>/g, " "), MAX_RESULT)}`;
  }
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
      else if (!globPat || matchGlob(relative(root, full).replace(/\\/g, "/"), globPat)) {
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
  // **/*.ts style
  const re = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/<<<GLOBSTAR>>>/g, ".*");
  return new RegExp(`^${re}$`, "i").test(path.replace(/\\/g, "/"));
}
