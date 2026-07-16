/**
 * check — run tsc / eslint and parse into structured diagnostics.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface CheckDiagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  diagnostics: CheckDiagnostic[];
  commands: string[];
  raw?: string;
  error?: string;
}

/** Parse `tsc --pretty false` output lines. */
export function parseTscOutput(text: string): CheckDiagnostic[] {
  const out: CheckDiagnostic[] = [];
  // path(line,col): error TSxxxx: message
  // path(line,col): error TS1234: message
  const re =
    /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+):\s*(.*)$/i;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    out.push({
      file: m[1]!.trim(),
      line: Number(m[2]),
      col: Number(m[3]),
      severity: (m[4]!.toLowerCase() as CheckDiagnostic["severity"]) || "error",
      code: m[5]!,
      message: (m[6] ?? "").trim(),
    });
  }
  return out;
}

/** Parse eslint stylish / unix output. */
export function parseEslintOutput(text: string): CheckDiagnostic[] {
  const out: CheckDiagnostic[] = [];
  // path:line:col: message [Error/Warning/rule]
  const unix =
    /^(.+?):(\d+):(\d+):\s*(.+?)\s*\[(Error|Warning|error|warning)\/([^\]]+)\]\s*$/;
  // stylish: multi-line blocks — also try:
  //   path
  //     line:col  error  message  rule
  const stylish = /^\s+(\d+):(\d+)\s+(error|warning|info)\s+(.+?)\s{2,}(\S+)\s*$/i;
  let currentFile = "";
  for (const line of text.split(/\r?\n/)) {
    const u = line.match(unix);
    if (u) {
      out.push({
        file: u[1]!,
        line: Number(u[2]),
        col: Number(u[3]),
        severity: u[5]!.toLowerCase().startsWith("warn")
          ? "warning"
          : u[5]!.toLowerCase().startsWith("info")
            ? "info"
            : "error",
        code: u[6]!,
        message: u[4]!.trim(),
      });
      continue;
    }
    if (/^[^:\s].+\.[a-zA-Z0-9]+$/.test(line.trim()) && !line.includes(" error")) {
      currentFile = line.trim();
      continue;
    }
    const s = line.match(stylish);
    if (s && currentFile) {
      out.push({
        file: currentFile,
        line: Number(s[1]),
        col: Number(s[2]),
        severity: s[3]!.toLowerCase() as CheckDiagnostic["severity"],
        code: s[5]!,
        message: s[4]!.trim(),
      });
    }
  }
  return out;
}

function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "aborted" });
      return;
    }
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32",
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
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
    signal?.addEventListener("abort", () => {
      child.kill();
    });
  });
}

function hasEslintConfig(cwd: string): boolean {
  const names = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml",
  ];
  return names.some((n) => existsSync(join(cwd, n)));
}

function hasTsconfig(cwd: string): boolean {
  return existsSync(join(cwd, "tsconfig.json"));
}

/** Run structured check (tsc + optional eslint). */
export async function runCheck(
  cwd: string,
  opts?: {
    tsc?: boolean;
    eslint?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<CheckResult> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const doTsc = opts?.tsc !== false;
  const doEslint = opts?.eslint === true || (opts?.eslint !== false && hasEslintConfig(cwd));
  const diagnostics: CheckDiagnostic[] = [];
  const commands: string[] = [];
  const rawParts: string[] = [];

  if (doTsc && hasTsconfig(cwd)) {
    const cmd = "npx";
    const args = ["--yes", "tsc", "--noEmit", "--pretty", "false"];
    commands.push(`${cmd} ${args.join(" ")}`);
    try {
      const r = await runCmd(cmd, args, cwd, timeoutMs, opts?.signal);
      const text = `${r.stdout}\n${r.stderr}`;
      rawParts.push(text);
      diagnostics.push(...parseTscOutput(text));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        diagnostics,
        commands,
        error: `tsc failed to start: ${msg}`,
      };
    }
  } else if (doTsc && !hasTsconfig(cwd)) {
    rawParts.push("(no tsconfig.json — skipped tsc)");
  }

  if (doEslint && hasEslintConfig(cwd)) {
    const cmd = "npx";
    const args = ["--yes", "eslint", ".", "-f", "unix"];
    commands.push(`${cmd} ${args.join(" ")}`);
    try {
      const r = await runCmd(cmd, args, cwd, timeoutMs, opts?.signal);
      const text = `${r.stdout}\n${r.stderr}`;
      rawParts.push(text);
      diagnostics.push(...parseEslintOutput(text));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rawParts.push(`eslint failed: ${msg}`);
    }
  }

  const errors = diagnostics.filter((d) => d.severity === "error");
  return {
    ok: errors.length === 0,
    diagnostics,
    commands,
    raw: rawParts.join("\n---\n").slice(0, 50_000),
  };
}
