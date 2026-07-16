/**
 * Path-aware tool scheduling.
 *
 * Models often emit parallel write/edit on the same file (or write+read races).
 * OpenCode/Hermes effectively serialize conflicting mutations; we do the same
 * while keeping independent tools fully parallel.
 *
 * Multi-agent: wait_agent is a barrier — always scheduled after non-wait tools
 * in the same step so spawn_agent can register threads first, and so the parent
 * can run productive tools in the same response as spawn without blocking them.
 */

import { canonicalToolName } from "./normalize.js";

export interface SchedulableCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Tools that mutate workspace state. */
const WRITE_TOOLS = new Set([
  "write",
  "write_file",
  "search_replace",
  "edit_file",
]);

/** Tools that read files (conflict with writes to same path). */
const READ_TOOLS = new Set(["read_file"]);

function isWaitAgent(name: string): boolean {
  return canonicalToolName(name) === "wait_agent";
}

function pathsOf(name: string, args: Record<string, unknown>): string[] {
  const canon = canonicalToolName(name);
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

  if (WRITE_TOOLS.has(name) || WRITE_TOOLS.has(canon)) {
    const p = String(args.file_path ?? args.path ?? "");
    return p ? [norm(p)] : [];
  }
  if (READ_TOOLS.has(name) || READ_TOOLS.has(canon)) {
    if (Array.isArray(args.target_files)) {
      return (args.target_files as unknown[])
        .map((x) => norm(String(x ?? "")))
        .filter(Boolean);
    }
    const p = String(args.target_file ?? args.path ?? "");
    return p ? [norm(p)] : [];
  }
  // Shell can touch anything — treat as global exclusive among writes
  if (canon === "run_terminal_command") {
    return ["*"];
  }
  return [];
}

function isWrite(name: string): boolean {
  const c = canonicalToolName(name);
  return WRITE_TOOLS.has(name) || WRITE_TOOLS.has(c) || c === "run_terminal_command";
}

function isRead(name: string): boolean {
  const c = canonicalToolName(name);
  return READ_TOOLS.has(name) || READ_TOOLS.has(c);
}

/**
 * Path-conflict scheduling for a homogeneous batch (no wait_agent barriers).
 */
function schedulePathWaves<T extends SchedulableCall>(calls: T[]): T[][] {
  if (calls.length <= 1) return calls.length ? [calls] : [];

  const waves: T[][] = [];
  const remaining = [...calls];

  while (remaining.length) {
    const wave: T[] = [];
    const waveWrites = new Set<string>();
    const waveReads = new Set<string>();
    const waveHasGlobal = { v: false };

    const still: T[] = [];
    for (const call of remaining) {
      const paths = pathsOf(call.name, call.args);
      const write = isWrite(call.name);
      const read = isRead(call.name);

      let conflict = false;
      for (const p of paths) {
        if (p === "*") {
          // Global exclusive: cannot join wave that has any write/read file ops
          if (
            waveWrites.size > 0 ||
            waveReads.size > 0 ||
            waveHasGlobal.v ||
            wave.some((c) => isWrite(c.name) || isRead(c.name))
          ) {
            conflict = true;
          }
          // Also: if wave already has non-empty non-shell tools that touch fs
          break;
        }
        if (write) {
          if (waveWrites.has(p) || waveReads.has(p) || waveHasGlobal.v) {
            conflict = true;
            break;
          }
        } else if (read) {
          if (waveWrites.has(p) || waveHasGlobal.v) {
            conflict = true;
            break;
          }
        }
      }

      // Two global shells cannot share a wave
      if (!conflict && paths.includes("*") && waveHasGlobal.v) {
        conflict = true;
      }

      if (conflict) {
        still.push(call);
        continue;
      }

      wave.push(call);
      for (const p of paths) {
        if (p === "*") waveHasGlobal.v = true;
        else if (write) waveWrites.add(p);
        else if (read) waveReads.add(p);
      }
    }

    // Progress guarantee: if nothing fit, force first remaining alone
    if (wave.length === 0 && still.length) {
      wave.push(still.shift()!);
    }
    waves.push(wave);
    remaining.length = 0;
    remaining.push(...still);
  }

  return waves;
}

/**
 * Partition calls into waves: each wave can run with Promise.all.
 * Later waves wait for earlier ones when paths conflict.
 *
 * wait_agent is always deferred to a final wave so:
 * - spawn_agent in the same step registers threads first
 * - other productive tools are not stuck behind a blocking wait in Promise.all
 */
export function scheduleToolWaves<T extends SchedulableCall>(calls: T[]): T[][] {
  if (calls.length <= 1) return calls.length ? [calls] : [];

  const waits = calls.filter((c) => isWaitAgent(c.name));
  const rest = calls.filter((c) => !isWaitAgent(c.name));

  const waves = schedulePathWaves(rest);
  if (waits.length) {
    // Multiple wait_agent calls can race each other; barrier only vs non-waits
    waves.push(waits);
  }
  return waves;
}

/**
 * Run schedulable async work in path-aware waves.
 */
export async function runInWaves<T extends SchedulableCall, R>(
  calls: T[],
  worker: (call: T) => Promise<R>,
): Promise<R[]> {
  const waves = scheduleToolWaves(calls);
  const byId = new Map<string, R>();
  for (const wave of waves) {
    const results = await Promise.all(
      wave.map(async (c) => {
        const r = await worker(c);
        return { id: c.id, r };
      }),
    );
    for (const { id, r } of results) byId.set(id, r);
  }
  // Preserve original order
  return calls.map((c) => byId.get(c.id)!);
}
