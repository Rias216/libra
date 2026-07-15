/**
 * ToolCallRuntime — parallel-safe dispatch + cancel + doom-loop.
 * Codex tools/parallel.rs + OpenCode doom-loop threshold.
 */

import { runInWaves } from "./concurrency.js";
import type { ToolRunner, RunCallResult } from "./runner.js";
import {
  truncateToolOutput,
  TOOL_OUTPUT_LIVE_MAX,
} from "./truncate.js";
import type { DispatchCall } from "./router.js";

/** Same fingerprint this many times already in history → doom-loop. */
export const DOOM_LOOP_THRESHOLD = 3;

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
  private recent: string[] = [];

  constructor(
    private runner: ToolRunner,
    private outputMax: number = TOOL_OUTPUT_LIVE_MAX,
  ) {}

  get recentFingerprints(): string[] {
    return [...this.recent];
  }

  seedFingerprints(fps: string[]): void {
    this.recent.push(...fps);
    if (this.recent.length > 32) {
      this.recent = this.recent.slice(-32);
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

      if (this.isDoomLoop(call.fingerprint)) {
        return {
          callId: call.callId,
          name: call.name,
          args: call.args,
          fingerprint: call.fingerprint,
          ok: false,
          output:
            `Doom-loop: tool "${call.name}" with the same arguments was already executed ${DOOM_LOOP_THRESHOLD} times this turn. ` +
            `Use the prior results and answer the user now. Do not re-call this tool with identical args.`,
          durationMs: 0,
          cached: false,
          doomLoop: true,
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

        if (!result.doomLoop) {
          this.recent.push(call.fingerprint);
          if (this.recent.length > 32) this.recent = this.recent.slice(-32);
        }
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
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

  private isDoomLoop(fp: string): boolean {
    if (this.recent.length < DOOM_LOOP_THRESHOLD) return false;
    const tail = this.recent.slice(-DOOM_LOOP_THRESHOLD);
    return tail.every((x) => x === fp);
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
