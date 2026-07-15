/**
 * ToolRunner — compose validation, permissions, hooks, cache, concurrency.
 * AgentLoop and headless harnesses should prefer this over bare ToolExecutor.
 */

import { ToolExecutor, type ToolExecResult, type ToolExecutorOptions } from "./executor.js";
import {
  PermissionChecker,
  deniedToolOutput,
  type PermissionAskFn,
  type PermissionRules,
  DEFAULT_PERMISSIONS,
  HEADLESS_PERMISSIONS,
} from "./permissions.js";
import {
  validateToolArgs,
  formatValidationError,
} from "./validate.js";
import {
  ToolRegistry,
  createDefaultRegistry,
  type ToolsetId,
} from "./registry.js";
import { runInWaves } from "./concurrency.js";
import {
  normalizeToolArgs,
  parseToolArgs,
  toolFingerprint,
} from "./normalize.js";
import { resolveToolName } from "./tool.js";

export interface ToolRunnerOptions extends ToolExecutorOptions {
  permissions?: PermissionRules;
  /** Headless: never ask, use HEADLESS_PERMISSIONS unless permissions set */
  headless?: boolean;
  autoApprove?: boolean;
  ask?: PermissionAskFn;
  toolsets?: ToolsetId[];
  registry?: ToolRegistry;
  /** In-turn result cache (fingerprint → output) */
  cache?: Map<string, string>;
}

export interface PreparedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  fingerprint: string;
}

export interface RunCallResult extends ToolExecResult {
  name: string;
  args: Record<string, unknown>;
  fingerprint: string;
  cached: boolean;
  denied?: boolean;
  invalid?: boolean;
}

export class ToolRunner {
  readonly executor: ToolExecutor;
  readonly permissions: PermissionChecker;
  readonly registry: ToolRegistry;
  readonly cache: Map<string, string>;

  constructor(
    cwd: string = process.cwd(),
    private opts: ToolRunnerOptions = {},
  ) {
    this.executor = new ToolExecutor(cwd, opts);
    this.permissions = new PermissionChecker(
      opts.permissions ??
        (opts.headless ? HEADLESS_PERMISSIONS : DEFAULT_PERMISSIONS),
      opts.ask,
      opts.autoApprove ?? opts.headless === true,
    );
    this.registry = opts.registry ?? createDefaultRegistry(opts.toolsets);
    this.cache = opts.cache ?? new Map();
  }

  setSignal(signal: AbortSignal | undefined): void {
    this.executor.setSignal(signal);
  }

  setAsk(fn: PermissionAskFn | undefined): void {
    this.permissions.setAskFn(fn);
  }

  /**
   * Prepare + execute a single tool call (validate → permission → hooks → exec).
   */
  async run(
    name: string,
    rawArgs: Record<string, unknown> | string | undefined,
  ): Promise<RunCallResult> {
    const t0 = Date.now();
    name = resolveToolName(name);
    const parsed =
      typeof rawArgs === "string" || rawArgs === undefined
        ? parseToolArgs(rawArgs)
        : rawArgs;
    const normalized = normalizeToolArgs(name, parsed);
    const fp = toolFingerprint(name, normalized);

    // Cache hit
    const cached = this.cache.get(fp);
    if (cached != null) {
      return {
        ok: true,
        output:
          cached +
          "\n\n[cache] Same tool+args already ran this turn — use this result; do not re-request.",
        durationMs: Date.now() - t0,
        name,
        args: normalized,
        fingerprint: fp,
        cached: true,
      };
    }

    // Registry gate
    if (!this.registry.isEnabled(name) && name !== "finish") {
      // Allow catalog aliases that map to enabled tools
      const entry = this.registry.getEntry(name);
      if (!entry || !this.registry.isEnabled(entry.name)) {
        return {
          ok: false,
          output: `Tool "${name}" is disabled for this agent (code=disabled).`,
          durationMs: Date.now() - t0,
          name,
          args: normalized,
          fingerprint: fp,
          cached: false,
          denied: true,
          code: "disabled",
        };
      }
    }

    // Schema validation
    const validation = validateToolArgs(name, normalized);
    if (!validation.ok) {
      return {
        ok: false,
        output: formatValidationError(name, validation),
        durationMs: Date.now() - t0,
        name,
        args: validation.args,
        fingerprint: fp,
        cached: false,
        invalid: true,
        code: "invalid_args",
      };
    }
    const args = validation.args;

    // Permissions
    const decision = await this.permissions.resolveAndMaybeAsk(name, args);
    if (decision.action === "deny") {
      return {
        ok: false,
        output: deniedToolOutput(decision),
        durationMs: Date.now() - t0,
        name,
        args,
        fingerprint: fp,
        cached: false,
        denied: true,
        code: "permission_denied",
      };
    }

    // Hooks before
    const hookCtx = await this.registry.runHooks("before", {
      name,
      args,
    });
    if (hookCtx.cancel) {
      return {
        ok: false,
        output: hookCtx.cancelReason ?? "cancelled by hook",
        durationMs: Date.now() - t0,
        name,
        args,
        fingerprint: fp,
        cached: false,
        denied: true,
        code: "cancelled",
      };
    }

    const exec = await this.executor.run(name, args);

    await this.registry.runHooks("after", {
      name,
      args,
      result: {
        ok: exec.ok,
        output: exec.output,
        durationMs: exec.durationMs,
      },
    });

    if (exec.ok) {
      this.cache.set(fp, exec.output);
    }

    return {
      ...exec,
      name,
      args,
      fingerprint: fp,
      cached: false,
    };
  }

  /**
   * Run many calls with path-aware concurrency waves.
   * Results are in the same order as `calls`.
   */
  async runMany(
    calls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown> | string | undefined;
    }>,
  ): Promise<RunCallResult[]> {
    const prepared = calls.map((c) => {
      const parsed =
        typeof c.args === "string" || c.args === undefined
          ? parseToolArgs(c.args)
          : c.args;
      const args = normalizeToolArgs(c.name, parsed);
      return { id: c.id, name: c.name, args };
    });

    return runInWaves(prepared, async (call) =>
      this.run(call.name, call.args),
    );
  }
}
