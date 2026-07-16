/**
 * git tool — structured status/diff/log/blame.
 */

import { spawn } from "node:child_process";
import type { DiffHunk, DiffLine } from "../core/types.js";

export type GitAction = "status" | "diff" | "log" | "blame";

export interface GitToolResult {
  ok: boolean;
  action: GitAction;
  /** Structured payload */
  data?: Record<string, unknown>;
  error?: string;
}

function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
    });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr: stderr + "\n(timeout)" });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Parse unified diff into DiffHunk[] (core/types). */
export function parseDiffToHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  let cur: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    const hm = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hm) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
      oldNo = Number(hm[1]);
      newNo = Number(hm[2]);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("diff ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      cur = null;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      cur.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      cur.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith(" ") || line === "") {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      cur.lines.push({
        kind: "context",
        text,
        oldNo: oldNo++,
        newNo: newNo++,
      });
    } else if (line.startsWith("\\")) {
      // no newline marker — skip
    }
  }
  return hunks;
}

/** Parse porcelain v1 status. */
export function parseGitStatusPorcelain(text: string): Array<{
  xy: string;
  path: string;
  origPath?: string;
}> {
  const out: Array<{ xy: string; path: string; origPath?: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    if (rest.includes(" -> ")) {
      const [a, b] = rest.split(" -> ");
      out.push({ xy, path: (b ?? "").trim(), origPath: (a ?? "").trim() });
    } else {
      out.push({ xy, path: rest.trim() });
    }
  }
  return out;
}

/** Parse short log lines. */
export function parseGitLog(text: string): Array<{
  hash: string;
  subject: string;
  author?: string;
  date?: string;
}> {
  const out: Array<{
    hash: string;
    subject: string;
    author?: string;
    date?: string;
  }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // hash\x1fauthor\x1fdate\x1fsubject
    if (line.includes("\x1f")) {
      const [hash, author, date, ...rest] = line.split("\x1f");
      out.push({
        hash: hash ?? "",
        author,
        date,
        subject: rest.join("\x1f"),
      });
    } else {
      const m = line.match(/^([0-9a-f]+)\s+(.*)$/i);
      if (m) out.push({ hash: m[1]!, subject: m[2]! });
    }
  }
  return out;
}

/** Parse blame porcelain-ish or default blame. */
export function parseGitBlame(text: string): Array<{
  line: number;
  hash: string;
  author: string;
  text: string;
}> {
  const out: Array<{
    line: number;
    hash: string;
    author: string;
    text: string;
  }> = [];
  // default: hash (author date line) text
  const re =
    /^([0-9a-f]+)\s+\((.+?)\s+(\d{4}-\d{2}-\d{2}[^\)]*)\s+(\d+)\)\s?(.*)$/i;
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    n += 1;
    const m = line.match(re);
    if (m) {
      out.push({
        line: Number(m[4]),
        hash: m[1]!,
        author: m[2]!.trim(),
        text: m[5] ?? "",
      });
    } else if (line.trim()) {
      out.push({ line: n, hash: "", author: "", text: line });
    }
  }
  return out;
}

export async function runGitTool(
  cwd: string,
  action: GitAction,
  args: Record<string, unknown> = {},
): Promise<GitToolResult> {
  try {
    switch (action) {
      case "status": {
        const r = await runGit(cwd, ["status", "--porcelain=v1", "-b"]);
        if (r.code !== 0 && r.code != null) {
          return {
            ok: false,
            action,
            error: r.stderr || r.stdout || `git status exit ${r.code}`,
          };
        }
        const branchLine = r.stdout.split(/\r?\n/).find((l) => l.startsWith("## "));
        const files = parseGitStatusPorcelain(
          r.stdout
            .split(/\r?\n/)
            .filter((l) => l && !l.startsWith("## "))
            .join("\n"),
        );
        return {
          ok: true,
          action,
          data: {
            branch: branchLine?.slice(3) ?? "",
            files,
            raw: r.stdout,
          },
        };
      }
      case "diff": {
        const path = args.path != null ? String(args.path) : undefined;
        const staged = Boolean(args.staged);
        const gitArgs = ["diff", "--no-color", "--no-ext-diff"];
        if (staged) gitArgs.push("--cached");
        if (path) gitArgs.push("--", path);
        const r = await runGit(cwd, gitArgs);
        const hunks = parseDiffToHunks(r.stdout);
        let additions = 0;
        let deletions = 0;
        for (const h of hunks) {
          for (const ln of h.lines) {
            if (ln.kind === "add") additions++;
            if (ln.kind === "del") deletions++;
          }
        }
        return {
          ok: true,
          action,
          data: {
            path: path ?? null,
            staged,
            hunks,
            additions,
            deletions,
            raw: r.stdout,
          },
        };
      }
      case "log": {
        const n = Math.min(Number(args.limit ?? args.n ?? 10) || 10, 50);
        const r = await runGit(cwd, [
          "log",
          `-n${n}`,
          "--format=%H%x1f%an%x1f%ad%x1f%s",
          "--date=short",
        ]);
        if (r.code !== 0 && r.code != null) {
          return {
            ok: false,
            action,
            error: r.stderr || `git log exit ${r.code}`,
          };
        }
        return {
          ok: true,
          action,
          data: { commits: parseGitLog(r.stdout) },
        };
      }
      case "blame": {
        const path = String(args.path ?? args.file ?? "");
        if (!path) {
          return { ok: false, action, error: "blame requires path" };
        }
        const gitArgs = ["blame", "--date=short", "--", path];
        const r = await runGit(cwd, gitArgs);
        if (r.code !== 0 && r.code != null) {
          return {
            ok: false,
            action,
            error: r.stderr || `git blame exit ${r.code}`,
          };
        }
        return {
          ok: true,
          action,
          data: { path, lines: parseGitBlame(r.stdout) },
        };
      }
      default:
        return {
          ok: false,
          action,
          error: `unknown git action: ${action}`,
        };
    }
  } catch (err) {
    return {
      ok: false,
      action,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// silence unused import lint if DiffLine only used via DiffHunk
export type { DiffLine };
