/**
 * Self-review handoff + external relaunch supervisor.
 *
 * Spawns scripts/self-review-relaunch.mjs (copied under ~/.libra/self-review/)
 * so verify / restore / relaunch run **outside** the agent loop and survive
 * a broken install after self-upgrade.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

export interface SelfReviewHandoff {
  version: 1;
  handoffId: string;
  libraRoot: string;
  backupId: string;
  backupDir: string;
  sessionPath: string;
  sessionId: string;
  parentPid: number;
  userCwd: string;
  theme?: string;
  bunPath: string;
  statusPath: string;
  logPath: string;
  handoffPath: string;
  maxWaitMs: number;
  createdAt: string;
}

export interface SelfReviewStatus {
  phase:
    | "agent_running"
    | "agent_done"
    | "agent_failed"
    | "request_relaunch"
    | "supervisor_waiting"
    | "verifying"
    | "restoring"
    | "launching"
    | "launched"
    | string;
  at: string;
  error?: string;
  restored?: boolean;
  childPid?: number;
  pid?: number;
  failedStep?: string;
}

function selfReviewHome(): string {
  return join(homedir(), ".libra", "self-review");
}

export function getSelfReviewHome(): string {
  return selfReviewHome();
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

/** Locate relaunch script in the repo (source of truth). */
export function findRepoRelaunchScript(libraRoot: string): string | null {
  const candidates = [
    join(libraRoot, "scripts", "self-review-relaunch.mjs"),
    // When this module is under dist/agent/
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "self-review-relaunch.mjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Copy the supervisor into ~/.libra so it still runs if the live tree
 * is temporarily unusable after a bad self-upgrade.
 */
export function installRelaunchSupervisor(libraRoot: string): string {
  const home = selfReviewHome();
  ensureDir(home);
  const dest = join(home, "relaunch.mjs");
  const src = findRepoRelaunchScript(libraRoot);
  if (src) {
    copyFileSync(src, dest);
  } else if (!existsSync(dest)) {
    throw new Error(
      "self-review-relaunch.mjs not found — cannot install external supervisor",
    );
  }
  return dest;
}

export function writeHandoff(h: SelfReviewHandoff): string {
  ensureDir(dirname(h.handoffPath));
  writeFileSync(h.handoffPath, JSON.stringify(h, null, 2) + "\n", "utf8");
  return h.handoffPath;
}

export function writeHandoffStatus(
  statusPath: string,
  status: SelfReviewStatus,
): void {
  ensureDir(dirname(statusPath));
  writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n", "utf8");
}

export function readHandoffStatus(statusPath: string): SelfReviewStatus | null {
  try {
    if (!existsSync(statusPath)) return null;
    return JSON.parse(readFileSync(statusPath, "utf8")) as SelfReviewStatus;
  } catch {
    return null;
  }
}

export function readLastRelaunchNotice(): {
  ok?: boolean;
  restored?: boolean;
  notice?: string;
  backupId?: string;
  at?: string;
} | null {
  try {
    const p = join(selfReviewHome(), "last-relaunch.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as {
      ok?: boolean;
      restored?: boolean;
      notice?: string;
      backupId?: string;
      at?: string;
    };
  } catch {
    return null;
  }
}

export function createHandoff(opts: {
  libraRoot: string;
  backupId: string;
  backupDir: string;
  sessionPath: string;
  sessionId: string;
  userCwd: string;
  theme?: string;
}): SelfReviewHandoff {
  const handoffId = new Date().toISOString().replace(/[:.]/g, "-");
  const home = selfReviewHome();
  ensureDir(home);
  const handoffPath = join(home, `handoff-${handoffId}.json`);
  const statusPath = join(home, `status-${handoffId}.json`);
  const logPath = join(home, `relaunch-${handoffId}.log`);
  const bunPath = process.execPath;

  return {
    version: 1,
    handoffId,
    libraRoot: opts.libraRoot,
    backupId: opts.backupId,
    backupDir: opts.backupDir,
    sessionPath: opts.sessionPath,
    sessionId: opts.sessionId,
    parentPid: process.pid,
    userCwd: opts.userCwd,
    theme: opts.theme,
    bunPath,
    statusPath,
    logPath,
    handoffPath,
    maxWaitMs: 3 * 60 * 60 * 1000,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Start the external supervisor (detached). Returns supervisor pid.
 */
export function spawnRelaunchSupervisor(
  handoff: SelfReviewHandoff,
  supervisorScript: string,
): number {
  writeHandoff(handoff);
  writeHandoffStatus(handoff.statusPath, {
    phase: "agent_running",
    at: new Date().toISOString(),
  });

  const child = spawn(
    handoff.bunPath,
    [supervisorScript, "--handoff", handoff.handoffPath],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: handoff.libraRoot,
      env: { ...process.env },
    },
  );
  child.unref();
  return child.pid ?? 0;
}

/** Signal supervisor that the agent finished and we want relaunch. */
export function signalRelaunch(
  handoff: SelfReviewHandoff,
  result: "agent_done" | "agent_failed",
  error?: string,
): void {
  writeHandoffStatus(handoff.statusPath, {
    phase: result === "agent_done" ? "request_relaunch" : "agent_failed",
    at: new Date().toISOString(),
    error,
  });
  // Also stamp agent_done for the happy path after a beat — supervisor
  // accepts request_relaunch | agent_done | agent_failed.
  if (result === "agent_done") {
    writeHandoffStatus(handoff.statusPath, {
      phase: "agent_done",
      at: new Date().toISOString(),
    });
  }
}
