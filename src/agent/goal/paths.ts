/**
 * Goal session + private scratch paths.
 * Session artifacts live under <sessionDir>/goal/;
 * private evidence under <tmpdir>/grok-goal-<verifierId>/.
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { isCanonicalVerifierId } from "./types.js";

export function defaultSessionsRoot(): string {
  return (
    process.env.LIBRA_SESSIONS_DIR ?? join(homedir(), ".libra", "sessions")
  );
}

/** Per-session goal dir: <sessions>/<sessionId>/goal or <sessionDir>/goal */
export function goalDir(sessionDir: string): string {
  return join(sessionDir, "goal");
}

export function planPath(sessionDir: string): string {
  return join(goalDir(sessionDir), "plan.md");
}

export function planBaselinePath(sessionDir: string): string {
  return join(goalDir(sessionDir), "plan.baseline.md");
}

export function strategyPath(sessionDir: string): string {
  return join(goalDir(sessionDir), "strategy.md");
}

export function orchestrationSnapshotPath(sessionDir: string): string {
  return join(goalDir(sessionDir), "orchestration.json");
}

export function goalScratchRoot(verifierId: string): string {
  return join(tmpdir(), `grok-goal-${verifierId}`);
}

export function implementerScratchDir(verifierId: string): string {
  return join(goalScratchRoot(verifierId), "implementer");
}

export function skepticScratchDir(verifierId: string, idx: number): string {
  return join(goalScratchRoot(verifierId), `skeptic-${idx}`);
}

/**
 * Ensure goal session dir exists.
 */
export function ensureGoalDir(sessionDir: string): string {
  const dir = goalDir(sessionDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create/verify private scratch root + implementer subdir.
 * Returns whether implementer scratch is ready.
 */
export function ensureGoalScratch(verifierId: string): boolean {
  if (!isCanonicalVerifierId(verifierId)) return false;
  try {
    const root = goalScratchRoot(verifierId);
    mkdirSync(root, { recursive: true });
    const impl = implementerScratchDir(verifierId);
    mkdirSync(impl, { recursive: true });
    return existsSync(impl);
  } catch {
    return false;
  }
}

export function ensureSkepticScratch(
  verifierId: string,
  idx: number,
): string | null {
  if (!isCanonicalVerifierId(verifierId)) return null;
  try {
    const dir = skepticScratchDir(verifierId, idx);
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

export function removeGoalScratch(verifierId: string): void {
  if (!isCanonicalVerifierId(verifierId)) return;
  try {
    rmSync(goalScratchRoot(verifierId), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Rescue classifier details out of scratch before root removal.
 * Copies to <sessionDir>/goal/last-verifier-details.md when present.
 */
export function rescueClassifierDetails(
  sessionDir: string,
  detailsPath: string | null | undefined,
): string | null {
  if (!detailsPath || !existsSync(detailsPath)) return null;
  try {
    ensureGoalDir(sessionDir);
    const dest = join(goalDir(sessionDir), "last-verifier-details.md");
    copyFileSync(detailsPath, dest);
    return dest;
  } catch {
    return null;
  }
}

export function writeTextFile(path: string, body: string): void {
  const parent = join(path, "..");
  mkdirSync(parent, { recursive: true });
  writeFileSync(path, body, "utf8");
}

export function readTextFile(path: string, maxBytes = 64 * 1024): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path);
    const slice = raw.subarray(0, maxBytes);
    return slice.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Snapshot plan.md → plan.baseline.md once (never overwrite).
 */
export function snapshotPlanBaseline(
  sessionDir: string,
  planFile: string,
): string | null {
  const baseline = planBaselinePath(sessionDir);
  if (existsSync(baseline)) return baseline;
  try {
    if (!existsSync(planFile)) return null;
    ensureGoalDir(sessionDir);
    copyFileSync(planFile, baseline);
    return baseline;
  } catch {
    return null;
  }
}

/**
 * Session dir for a harness session id under ~/.libra/sessions/<id>/.
 */
export function sessionDirForId(sessionId: string): string {
  // URL-encode path-ish ids like the goal harness does
  const safe = encodeURIComponent(sessionId).replace(/%/g, "%");
  return join(defaultSessionsRoot(), safe);
}
