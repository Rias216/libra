/**
 * Git worktree isolation for concurrent workspace-write subagents.
 * Creates a detached worktree per child; never auto-merges.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunGitFn = (
  args: string[],
  opts: { cwd: string },
) => Promise<GitRunResult>;

/** Default: spawn real `git` (Windows-safe via shell:false). */
export async function defaultRunGit(
  args: string[],
  opts: { cwd: string },
): Promise<GitRunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer | string) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      resolvePromise({
        code: 127,
        stdout,
        stderr: err instanceof Error ? err.message : String(err),
      });
    });
    child.on("close", (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

export interface CreateWorktreeOpts {
  /** Parent / main checkout root */
  baseCwd: string;
  /** Unique agent id (used in branch + directory name) */
  agentId: string;
  /** Injectable git runner (tests) */
  runGit?: RunGitFn;
  /**
   * Optional parent directory for worktrees.
   * Default: `{tmpdir}/libra-worktrees/{safeAgentId}`
   */
  worktreeParent?: string;
}

export type CreateWorktreeResult =
  | {
      ok: true;
      worktreePath: string;
      branch: string;
      baseCwd: string;
    }
  | { ok: false; error: string };

function safeSlug(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
}

/**
 * Create a new git worktree checked out to a fresh branch from HEAD.
 * Path is reported for manual review/merge — callers must not auto-merge.
 */
export async function createAgentWorktree(
  opts: CreateWorktreeOpts,
): Promise<CreateWorktreeResult> {
  const baseCwd = resolve(opts.baseCwd);
  const runGit = opts.runGit ?? defaultRunGit;
  const slug = safeSlug(opts.agentId);
  const branch = `libra-agent/${slug}`;
  const worktreePath = resolve(
    opts.worktreeParent ?? join(tmpdir(), "libra-worktrees", slug),
  );

  try {
    mkdirSync(resolve(worktreePath, ".."), { recursive: true });
  } catch {
    /* parent may already exist */
  }

  // Confirm we're inside a git work tree
  const rev = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: baseCwd,
  });
  if (rev.code !== 0 || !/true/i.test(rev.stdout.trim())) {
    return {
      ok: false,
      error: `not a git repository: ${baseCwd} (${rev.stderr.trim() || rev.stdout.trim() || "git rev-parse failed"})`,
    };
  }

  // Prefer starting from HEAD; fall back to orphan branch if empty repo
  const head = await runGit(["rev-parse", "--verify", "HEAD"], { cwd: baseCwd });
  if (head.code !== 0) {
    return {
      ok: false,
      error: `git HEAD missing — commit once before worktree isolation (${head.stderr.trim() || "no HEAD"})`,
    };
  }

  const add = await runGit(
    ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
    { cwd: baseCwd },
  );
  if (add.code !== 0) {
    // Branch may already exist from a prior failed run — try without -b
    const retry = await runGit(
      ["worktree", "add", worktreePath, branch],
      { cwd: baseCwd },
    );
    if (retry.code !== 0) {
      return {
        ok: false,
        error: `git worktree add failed: ${(add.stderr || retry.stderr || add.stdout || retry.stdout).trim()}`,
      };
    }
  }

  return {
    ok: true,
    worktreePath,
    branch,
    baseCwd,
  };
}

/**
 * Best-effort remove of a worktree (no merge). Safe to call on close.
 */
export async function removeAgentWorktree(opts: {
  baseCwd: string;
  worktreePath: string;
  branch?: string;
  runGit?: RunGitFn;
  deleteBranch?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const runGit = opts.runGit ?? defaultRunGit;
  const baseCwd = resolve(opts.baseCwd);
  const wt = resolve(opts.worktreePath);
  const rm = await runGit(["worktree", "remove", "--force", wt], {
    cwd: baseCwd,
  });
  if (rm.code !== 0) {
    return {
      ok: false,
      error: (rm.stderr || rm.stdout).trim() || "worktree remove failed",
    };
  }
  if (opts.deleteBranch && opts.branch) {
    await runGit(["branch", "-D", opts.branch], { cwd: baseCwd });
  }
  return { ok: true };
}

/**
 * Decide whether this spawn should isolate into a worktree.
 * - Explicit isolate_worktree
 * - Or workspace-write child when ≥1 other open workspace-write already exists
 *   (so the second concurrent writer triggers isolation for the new child)
 */
export function shouldIsolateWorktree(opts: {
  isolateFlag?: boolean | null;
  sandbox: "read-only" | "workspace-write";
  openWorkspaceWriteCount: number;
}): boolean {
  if (opts.sandbox !== "workspace-write") return false;
  if (opts.isolateFlag === true) return true;
  if (opts.isolateFlag === false) return false;
  // Auto when this spawn would make ≥2 concurrent WW children
  return opts.openWorkspaceWriteCount >= 1;
}
