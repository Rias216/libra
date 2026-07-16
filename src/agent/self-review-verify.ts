/**
 * In-process Libra install verification for self-review.
 * Mirrors scripts/self-review-relaunch.mjs verifyInstall so the live agent
 * session can fix failures BEFORE exiting for external relaunch.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type VerifyStep = "typecheck" | "build" | "smoke" | "ok";

export interface VerifyStepResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string | null;
}

export interface LibraVerifyResult {
  ok: boolean;
  step: VerifyStep;
  typecheck?: VerifyStepResult;
  build?: VerifyStepResult;
  smoke?: VerifyStepResult;
  version?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): VerifyStepResult {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
    windowsHide: true,
    shell: false,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").slice(-6000),
    stderr: (r.stderr || "").slice(-6000),
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

function bunExe(): string {
  // Prefer the running Bun binary when available
  if (process.execPath && /bun/i.test(process.execPath)) {
    return process.execPath;
  }
  return "bun";
}

/**
 * Run typecheck → build → smoke (`--version`) against a Libra install root.
 * Same gate the external supervisor uses before relaunch.
 */
export function verifyLibraInstall(
  libraRoot: string,
  opts?: { bunPath?: string; timeoutMs?: number },
): LibraVerifyResult {
  const bun = opts?.bunPath || bunExe();
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const typecheck = run(bun, ["run", "typecheck"], libraRoot, timeout);
  if (!typecheck.ok) {
    return { ok: false, step: "typecheck", typecheck };
  }

  const build = run(bun, ["run", "build"], libraRoot, timeout);
  if (!build.ok) {
    return { ok: false, step: "build", typecheck, build };
  }

  const cliJs = join(libraRoot, "dist", "cli.js");
  const cliTs = join(libraRoot, "src", "cli.ts");
  let smoke: VerifyStepResult;
  if (existsSync(cliJs)) {
    smoke = run(bun, [cliJs, "--version"], libraRoot, 30_000);
  } else if (existsSync(cliTs)) {
    smoke = run(bun, [cliTs, "--version"], libraRoot, 30_000);
  } else {
    smoke = {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error: "no dist/cli.js or src/cli.ts",
    };
  }
  if (!smoke.ok) {
    return { ok: false, step: "smoke", typecheck, build, smoke };
  }

  const version = String(smoke.stdout || "").trim().split(/\r?\n/)[0] ?? "";
  return {
    ok: true,
    step: "ok",
    typecheck,
    build,
    smoke,
    version,
  };
}

/** Compact failure text for agent fix turns. */
export function formatVerifyFailure(v: LibraVerifyResult): string {
  if (v.ok) return "verify ok";
  const step = v.step;
  const detail =
    step === "typecheck"
      ? v.typecheck
      : step === "build"
        ? v.build
        : v.smoke;
  const body = [
    detail?.stderr?.trim(),
    detail?.stdout?.trim(),
    detail?.error?.trim(),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 5000);
  return [
    `Failed step: **${step}** (exit ${detail?.status ?? "?"})`,
    "",
    "```",
    body || "(no output)",
    "```",
    "",
    "Required green checks before self-review may exit:",
    "1. `bun run typecheck`",
    "2. `bun run build`",
    "3. `bun dist/cli.js --version` (or `bun src/cli.ts --version`)",
  ].join("\n");
}

/** Max fix-and-reverify loops after the first agent pass (total verify attempts = 1 + this). */
export const SELF_REVIEW_MAX_FIX_ROUNDS = 3;

/**
 * Pure ship-gate for self-review exit signaling.
 * When verify is red, must NOT emit agent_done / success finished path.
 */
export type SelfReviewShipDecision = {
  maySignalAgentDone: boolean;
  exitResult: "agent_done" | "agent_failed";
  userStatusLevel: "success" | "warn";
  userMessage: string;
};

export function decideSelfReviewShipGate(opts: {
  verifyOk: boolean;
  backupId?: string;
}): SelfReviewShipDecision {
  if (opts.verifyOk) {
    return {
      maySignalAgentDone: true,
      exitResult: "agent_done",
      userStatusLevel: "success",
      userMessage:
        "Self-review ship gate passed — handing off to supervisor for relaunch…",
    };
  }
  const backup = opts.backupId?.trim()
    ? ` (may auto-restore backup \`${opts.backupId}\`)`
    : "";
  return {
    maySignalAgentDone: false,
    exitResult: "agent_failed",
    userStatusLevel: "warn",
    userMessage: `Self-review ship gate still red — exiting for supervisor${backup}…`,
  };
}
