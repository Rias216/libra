/**
 * ToolCallRuntime — parallel-safe dispatch + cancel + doom-loop v2.
 * Codex tools/parallel.rs + OpenCode doom-loop threshold, hardened:
 * count-based fingerprints, A↔B oscillation, escalation flags.
 */

import { runInWaves } from "./concurrency.js";
import type { ToolRunner, RunCallResult } from "./runner.js";
import {
  truncateToolOutput,
  TOOL_OUTPUT_LIVE_MAX,
} from "./truncate.js";
import type { DispatchCall } from "./router.js";

/** Same fingerprint this many times this turn (anywhere) → doom-loop. */
export const DOOM_LOOP_THRESHOLD = 3;

/** A-B-A-B oscillation over this many recent fingerprints → doom. */
export const DOOM_OSCILLATION_WINDOW = 4;

export interface DispatchResult {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  fingerprint: string;
  ok: boolean;
  output: string;
  durationMs: number;
  cached: boolean;
  denied?: boolean;
  invalid?: boolean;
  aborted?: boolean;
  doomLoop?: boolean;
  /** Why doom fired (for tests / status). */
  doomReason?: "repeat" | "oscillation";
}

export interface RuntimeHandlers {
  /** Multi-agent or other non-runner tools */
  customDispatch?: (
    call: DispatchCall,
  ) => Promise<{ ok: boolean; output: string; durationMs?: number }>;
  isCustomTool?: (name: string) => boolean;
  signal?: AbortSignal;
}

type WaveCall = DispatchCall & { id: string };

export class ToolCallRuntime {
  /** Ordered fingerprints this turn (including doom-blocked). */
  private recent: string[] = [];
  /** Count of times each fingerprint was seen this turn. */
  private counts = new Map<string, number>();
  /** How many doom blocks fired this turn (for force-answer escalation). */
  private doomHits = 0;

  constructor(
    private runner: ToolRunner,
    private outputMax: number = TOOL_OUTPUT_LIVE_MAX,
  ) {}

  get recentFingerprints(): string[] {
    return [...this.recent];
  }

  get doomHitCount(): number {
    return this.doomHits;
  }

  seedFingerprints(fps: string[]): void {
    for (const fp of fps) {
      this.recordFingerprint(fp);
    }
  }

  /**
   * Dispatch all tool calls. Results are in the same order as `calls`.
   * Every call always gets an output (errors / abort included).
   */
  async dispatchAll(
    calls: DispatchCall[],
    handlers: RuntimeHandlers = {},
  ): Promise<DispatchResult[]> {
    if (!calls.length) return [];

    const prepared: WaveCall[] = calls.map((c) => ({
      ...c,
      id: c.callId,
    }));

    return runInWaves(prepared, async (call) => {
      if (handlers.signal?.aborted) {
        return this.abortedResult(call);
      }

      const doom = this.checkDoom(call.fingerprint);
      if (doom) {
        this.doomHits++;
        // Still record so oscillation / counts stay consistent
        this.recordFingerprint(call.fingerprint);
        return {
          callId: call.callId,
          name: call.name,
          args: call.args,
          fingerprint: call.fingerprint,
          ok: false,
          output:
            `Doom-loop (${doom}): tool "${call.name}" with the same or alternating ` +
            `arguments was already executed ${DOOM_LOOP_THRESHOLD}+ times this turn. ` +
            `Use the prior results and answer the user now. Do not re-call this tool with identical args.`,
          durationMs: 0,
          cached: false,
          doomLoop: true,
          doomReason: doom,
        } satisfies DispatchResult;
      }

      try {
        let result: DispatchResult;
        if (handlers.isCustomTool?.(call.name) && handlers.customDispatch) {
          const t0 = Date.now();
          const r = await handlers.customDispatch(call);
          result = {
            callId: call.callId,
            name: call.name,
            args: call.args,
            fingerprint: call.fingerprint,
            ok: r.ok,
            output: truncateToolOutput(
              r.output || "(empty)",
              this.outputMax,
            ),
            durationMs: r.durationMs ?? Date.now() - t0,
            cached: false,
          };
        } else {
          const exec = await this.runner.run(call.name, call.args);
          result = fromRunResult(call, exec, this.outputMax);
        }

        this.recordFingerprint(call.fingerprint);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.recordFingerprint(call.fingerprint);
        return {
          callId: call.callId,
          name: call.name,
          args: call.args,
          fingerprint: call.fingerprint,
          ok: false,
          output: `Tool execution failed: ${msg}`,
          durationMs: 0,
          cached: false,
        } satisfies DispatchResult;
      }
    });
  }

  /**
   * Count-based repeat OR A-B-A-B oscillation.
   * Check *before* recording the current fingerprint.
   */
  checkDoom(fp: string): "repeat" | "oscillation" | null {
    const prev = this.counts.get(fp) ?? 0;
    // Already seen threshold times → next call is doom
    if (prev >= DOOM_LOOP_THRESHOLD) return "repeat";

    // A-B-A-B: last window is alternating pair and current continues it
    if (this.recent.length >= DOOM_OSCILLATION_WINDOW - 1) {
      const tail = this.recent.slice(-(DOOM_OSCILLATION_WINDOW - 1));
      // With current as next: [a,b,a,b]
      const a = tail[0];
      const b = tail[1];
      if (
        a &&
        b &&
        a !== b &&
        tail.length === 3 &&
        tail[0] === a &&
        tail[1] === b &&
        tail[2] === a &&
        fp === b
      ) {
        return "oscillation";
      }
      // Also catch already-complete A-B-A-B in recent where current matches a again
      if (this.recent.length >= DOOM_OSCILLATION_WINDOW) {
        const w = this.recent.slice(-DOOM_OSCILLATION_WINDOW);
        if (
          w[0] !== w[1] &&
          w[0] === w[2] &&
          w[1] === w[3] &&
          (fp === w[0] || fp === w[1])
        ) {
          return "oscillation";
        }
      }
    }
    return null;
  }

  private recordFingerprint(fp: string): void {
    this.recent.push(fp);
    this.counts.set(fp, (this.counts.get(fp) ?? 0) + 1);
    if (this.recent.length > 64) {
      this.recent = this.recent.slice(-64);
    }
  }

  private abortedResult(call: DispatchCall): DispatchResult {
    return {
      callId: call.callId,
      name: call.name,
      args: call.args,
      fingerprint: call.fingerprint,
      ok: false,
      output: "aborted by user",
      durationMs: 0,
      cached: false,
      aborted: true,
    };
  }
}

function fromRunResult(
  call: DispatchCall,
  exec: RunCallResult,
  max: number,
): DispatchResult {
  return {
    callId: call.callId,
    name: call.name,
    args: call.args,
    fingerprint: call.fingerprint,
    ok: exec.ok,
    output: truncateToolOutput(
      exec.output || (exec.ok ? "(empty)" : "error"),
      max,
    ),
    durationMs: exec.durationMs,
    cached: exec.cached,
    denied: exec.denied,
    invalid: exec.invalid,
  };
}
