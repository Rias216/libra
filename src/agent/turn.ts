/**
 * Codex / OpenCode-shaped turn loop — ONE shared core.
 *
 * sample → (tools → sample)* → stop
 * tool_calls always win over finish_reason (OpenCode).
 * Every tool_call_id gets exactly one tool message (Codex).
 *
 * Parent (runStoreTurn) and child (runHeadlessTurn) both call runTurnCore.
 * Stop rules, max-steps nudge, and tool pairing live only in the core.
 */

import type { HarnessStore } from "../core/store.js";
import type { ProviderId } from "../auth/types.js";
import {
  attachInTurnReasoning,
  buildAssistantToolRoundMessage,
  chatComplete,
  ensureToolCallPairing,
  hasBrokenToolCallArgs,
  isLengthFinish,
  lengthContinuationNudge,
  brokenToolArgsNudge,
  salvageBrokenToolCallArgs,
  MAX_LENGTH_CONTINUATIONS,
  type ChatMessage,
  type ChatResult,
  type ChatRequest,
  type StreamHandlers,
  type ToolCall,
} from "../llm/client.js";
import { withRetry } from "../llm/retry.js";
import { ToolRunner } from "../toolcalling/runner.js";
import {
  ToolCallRuntime,
  DOOM_LOOP_THRESHOLD,
  type DispatchResult,
} from "../toolcalling/runtime.js";
import {
  buildDispatchCalls,
  normalizeToolCallsForWire,
  type DispatchCall,
} from "../toolcalling/router.js";
import type {
  PermissionAskFn,
  PermissionRules,
} from "../toolcalling/permissions.js";
import type { ToolsetId } from "../toolcalling/registry.js";
import type { OpenAITool } from "../toolcalling/schema.js";
import {
  buildCompactedSession,
  compactBudgetForModel,
  DEFAULT_COMPACT_TOKEN_BUDGET,
  shouldAutoCompact,
  softCompactMessages,
  type CompactedSession,
} from "./compaction.js";
import { approxTokensFromMessages, historyToMessages } from "./history.js";
import { createSampleProcessor } from "./processor.js";
import { loadAgentSettings } from "./config.js";
import { resolveEffortForModel } from "./reasoning.js";
import { dbg, span } from "./debug.js";
import { buildSystemPrompt } from "./prompt.js";
import { SubagentRuntime } from "./subagent/runtime.js";
import {
  buildMultiAgentSystemAddon,
  isMultiAgentTool,
} from "./subagent/tools.js";
import { forceUltraReasoningExtension } from "./ultra-reason.js";
import { getModelContextWindow } from "../auth/models.js";
import { newId } from "../core/types.js";
import {
  createThoughtLoopState,
  detectThoughtLoop,
  THOUGHT_LOOP_REMINDER,
  DOOM_FORCE_ANSWER_REMINDER,
  STUCK_PROGRESS_REMINDER,
} from "./thought-loop.js";

/** OpenCode-style step cap before max-steps nudge (raised for multi-file coding). */
export const MAX_STEPS = 40;
/** Default child/subagent step cap (still uses same core + MAX_STEPS_PROMPT). */
export const DEFAULT_CHILD_MAX_STEPS = 8;
/** Fallback soft budget when model context is unknown (also 80% target uses model). */
export const COMPACT_TOKEN_BUDGET = DEFAULT_COMPACT_TOKEN_BUDGET;
/** Slightly tighter budget for headless children (same compact fn). */
export const COMPACT_TOKEN_BUDGET_CHILD = 40_000;
/** Doom hits this turn before we force tool_choice none. */
export const DOOM_FORCE_ANSWER_AFTER = 2;
/** Stuck progress waves before force-answer. */
export const STUCK_FORCE_ANSWER_AFTER = 2;

/**
 * Injected on the final step (both parent and child) when tools would
 * otherwise still be enabled — OpenCode max-steps spirit.
 * User-role system-reminder (not fake assistant speech).
 */
export const MAX_STEPS_PROMPT =
  "<system-reminder>\n" +
  "You have used the maximum number of steps for this turn. " +
  "Do not call any more tools. Give the user your best final answer now based on what you already know.\n" +
  "</system-reminder>";

export interface TurnOptions {
  provider: ProviderId;
  model: string;
  cwd?: string;
  systemPrompt?: string;
  tools?: boolean;
  abortSignal?: AbortSignal;
  seedReasoning?: string;
  /**
   * Soft temperature nudge only — never disables or lowers API reasoning effort.
   * Effort is always applied via buildReasoningApiFields / per-model settings.
   */
  lightReasoning?: boolean;
  /**
   * Explicit reasoning effort for this turn (child spawn / role override).
   * Passed as ChatRequest.reasoning_effort so it wins over native defaults.
   */
  reasoningEffort?: string;
  toolChoice?: "auto" | "none" | "required";
  label?: string;
  permissions?: PermissionRules;
  onPermission?: PermissionAskFn;
  autoApprove?: boolean;
  toolsets?: ToolsetId[];
  subagents?: boolean;
  /** Max sampling steps (default MAX_STEPS parent / DEFAULT_CHILD_MAX_STEPS child). */
  maxSteps?: number;
  chatImpl?: (
    req: ChatRequest,
    handlers?: StreamHandlers,
  ) => Promise<ChatResult>;
  headless?: boolean;
  headlessMessages?: ChatMessage[];
  /** full | slim system prompt (ignored when systemPrompt is set). */
  promptProfile?: "full" | "slim";
  /** Short tool descriptions to save prompt tokens. */
  slimTools?: boolean;
  /** Extra tool schemas (e.g. peer multi-agent tools for children). */
  extraTools?: OpenAITool[];
  /** Treat name as custom (peer multi-agent) for headless children. */
  isCustomTool?: (name: string) => boolean;
  /** Dispatch custom tools (peer multi-agent) for headless children. */
  customDispatch?: (
    call: DispatchCall,
  ) => Promise<{ ok: boolean; output: string; durationMs?: number }>;
}

export interface TurnResult {
  rounds: number;
  finalText: string;
  toolsUsed: string[];
  usage: { prompt_tokens: number; completion_tokens: number };
  error?: string;
  messages: ChatMessage[];
}

export interface RunTurnStoreContext {
  store: HarnessStore;
  messageId: string;
  abort: () => boolean;
}

/** Hooks that differ between store UI and headless — not control flow. */
export interface TurnCoreHooks {
  /** Stream handlers for this sample (optional). */
  onSampleStart?: (step: number) => StreamHandlers | undefined;
  /** After sample completes (reconcile UI, etc.). */
  onSampleEnd?: (
    step: number,
    result: ChatResult,
    handlers: StreamHandlers | undefined,
  ) => void;
  onPhase?: (phase: "streaming" | "tool" | "idle", label: string) => void;
  onUsage?: (prompt: number, completion: number) => void;
  /**
   * Fired right before withRetry re-issues a sample after a transient
   * failure (network drop, 5xx, rate limit). Must discard any text/
   * reasoning already streamed to the UI for the failed attempt so the
   * retry doesn't append its output onto stale partial content.
   */
  onSampleReset?: () => void;
  /** Before tools run — mark UI pending/running. */
  onToolsStart?: (calls: DispatchCall[]) => void;
  /** After each tool finishes. */
  onToolDone?: (
    index: number,
    call: DispatchCall,
    result: DispatchResult,
  ) => void;
  isCustomTool?: (name: string) => boolean;
  customDispatch?: (
    call: DispatchCall,
  ) => Promise<{ ok: boolean; output: string; durationMs?: number }>;
  /** Soft compact token budget (same softCompactMessages for both). */
  compactBudget?: number;
  compactKeepRecent?: number;
  /**
   * After a full auto-compact that rolls into a new session.
   * Parent should seed the UI from `compacted.uiMessages` and re-bind
   * the live assistant message id.
   */
  onSessionRollover?: (compacted: CompactedSession) => void;
  /**
   * After a tool wave (and before the next sample): inject completion
   * notices for finished subagents. Return text to append as a user note,
   * or empty/undefined to skip.
   */
  drainSubagentNotices?: () => string | undefined;
  /** Span namespace */
  spanNs?: string;
}

export interface TurnCoreInput {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  toolSchemas?: OpenAITool[];
  runner: ToolRunner;
  runtime: ToolCallRuntime;
  maxSteps: number;
  lightReasoning: boolean;
  /** Explicit effort override → ChatRequest.reasoning_effort */
  reasoningEffort?: string;
  toolChoice?: "auto" | "none" | "required";
  toolsEnabledInitially: boolean;
  abortSignal?: AbortSignal;
  isAborted: () => boolean;
  label: string;
  chat: (
    req: ChatRequest,
    handlers?: StreamHandlers,
  ) => Promise<ChatResult>;
  hooks?: TurnCoreHooks;
}

/**
 * THE shared turn control path. Parent and child must call this — no forks.
 */
export async function runTurnCore(input: TurnCoreInput): Promise<TurnResult> {
  const {
    provider,
    model,
    messages,
    toolSchemas,
    runtime,
    maxSteps,
    lightReasoning,
    reasoningEffort,
    toolChoice,
    toolsEnabledInitially,
    abortSignal,
    isAborted,
    label,
    chat,
    hooks = {},
  } = input;

  const toolsUsed: string[] = [];
  let promptTok = 0;
  let completionTok = 0;
  let finalText = "";
  let step = 0;
  let cancelled = false;
  /** Auto-continues after finish_reason=length / broken mid-stream tool args */
  let lengthContinues = 0;
  /** After doom/stuck — next sample(s) with tools forced off. */
  let forceToolsOff = false;
  let doomWaves = 0;
  let stuckWaves = 0;
  const thoughtLoop = createThoughtLoopState();
  /** Recent failed tool fingerprints for stuck detection. */
  const recentFailFps: string[] = [];
  const recentErrorSnips: string[] = [];
  /** Last known prompt tokens from API usage (honest compact). */
  let lastApiPromptTokens = 0;

  const contextWindow = getModelContextWindow(provider, model);
  const compactBudget =
    hooks.compactBudget ??
    compactBudgetForModel(provider, model, COMPACT_TOKEN_BUDGET);
  const keepRecent = hooks.compactKeepRecent ?? 16;
  const ns = hooks.spanNs ?? "agent";
  /** Only one full session rollover per turn (then soft digests). */
  let didSessionRollover = false;

  const turnSpan = span(ns, `${label}.turn`, {
    model: `${provider}/${model}`,
    tools: Boolean(toolSchemas?.length) && toolsEnabledInitially,
    maxSteps,
    contextWindow,
    compactBudget,
  });

  /** Finalize mid-stream UI parts even when the sample throws. */
  const endSample = (
    stepNo: number,
    result: ChatResult | null,
    handlers: StreamHandlers | undefined,
  ) => {
    hooks.onSampleEnd?.(
      stepNo,
      result ?? {
        content: "",
        tool_calls: [],
        finish_reason: "error",
      },
      handlers,
    );
  };

  /** Soft digest + optional full compact → new session seed. */
  const maybeCompact = (reason: string): void => {
    // Always try soft digests first (cheap, pairing-safe)
    softCompactMessages(messages, {
      tokenBudget: compactBudget,
      keepRecent,
    });

    // Prefer last API prompt_tokens when present (more honest than chars/4 alone)
    const overBudget =
      shouldAutoCompact(messages, compactBudget) ||
      (lastApiPromptTokens > 0 && lastApiPromptTokens >= compactBudget);
    if (!overBudget) return;
    if (didSessionRollover) {
      // Already rolled once this turn — keep soft-compacting only
      softCompactMessages(messages, {
        tokenBudget: compactBudget,
        keepRecent: Math.max(6, keepRecent - 4),
        digestChars: 80,
      });
      return;
    }

    hooks.onPhase?.("streaming", "compacting context · new session…");
    const compacted = buildCompactedSession(messages, {
      budget: compactBudget,
      keepRecent,
      contextWindow,
    });

    // Replace live wire messages with compacted transcript
    messages.length = 0;
    messages.push(...compacted.wire);

    didSessionRollover = true;
    dbg(ns, "session_compact", {
      reason,
      before: compacted.beforeTokens,
      after: compacted.afterTokens,
      budget: compacted.budget,
      contextWindow: compacted.contextWindow,
    });

    hooks.onSessionRollover?.(compacted);
  };

  try {
    // Turn-start: if history already exceeds 80% context → new session
    maybeCompact("turn_start");

    while (step < maxSteps) {
      if (isAborted() || abortSignal?.aborted) {
        cancelled = true;
        dbg(ns, "aborted", { step, label });
        break;
      }
      step++;

      // Before each sample — soft digest; full rollover if still over budget
      maybeCompact(`step_${step}`);

      // Codex: every tool_call_id must have exactly one tool result on the wire
      // before the next sample (synthetic "aborted" for gaps; drop orphans).
      ensureToolCallPairing(messages);

      const isLast = step >= maxSteps;
      // Tools off on last step, force-answer, or when tools disabled for the whole turn
      const toolsEnabled =
        toolsEnabledInitially &&
        Boolean(toolSchemas?.length) &&
        !isLast &&
        !forceToolsOff;

      // Before sample: surface subagent completions that finished since last notice
      maybeInjectSubagentNotices(messages, hooks.drainSubagentNotices);

      // Same max-steps nudge for parent AND child — user system-reminder
      const sampleMessages = isLast
        ? [
            ...messages,
            { role: "user" as const, content: MAX_STEPS_PROMPT },
          ]
        : messages;

      // Native effort from per-model settings; explicit turn override wins
      // via ChatRequest.reasoning_effort (see llm/client).
      const effort =
        reasoningEffort?.trim() ||
        resolveEffortForModel(provider, model).effort;

      // Always "streaming" while the model is generating — never jump to
      // "tool" mid-thought. Tool phase starts only when tools actually run.
      hooks.onPhase?.(
        "streaming",
        isLast
          ? `finalizing · step ${step}`
          : forceToolsOff
            ? `stuck · answering · step ${step}`
            : lengthContinues > 0
              ? `continuing · step ${step}`
              : `streaming · step ${step}`,
      );

      dbg(ns, `step.${step}.start`, {
        messages: sampleMessages.length,
        tools: toolsEnabled,
        isLast,
        forceToolsOff,
        maxStepsPrompt: isLast,
        tokensApprox: approxTokensFromMessages(sampleMessages),
        effort,
        lengthContinues,
      });

      const sampleHandlers = hooks.onSampleStart?.(step);
      const roundSpan = span(ns, `step.${step}`, { model });

      let result: ChatResult;
      try {
        result = await withRetry(
          () =>
            chat(
              {
                provider,
                model,
                messages: sampleMessages,
                tools: toolsEnabled ? toolSchemas : undefined,
                tool_choice: !toolsEnabled
                  ? "none"
                  : (toolChoice ?? "auto"),
                temperature: lightReasoning || forceToolsOff ? 0.2 : 0.4,
                stream: true,
                applyNativeReasoning: true,
                // Explicit child/spawn effort override (native still applied first)
                ...(reasoningEffort?.trim()
                  ? { reasoning_effort: reasoningEffort.trim() }
                  : {}),
                // No max_tokens — unlimited generation; effort only via API fields
                signal: abortSignal,
                label: `${label}.s${step}`,
              },
              sampleHandlers,
            ),
          {
            signal: abortSignal,
            onRetry: (attempt, err, delayMs) => {
              dbg(ns, "llm.retry", {
                attempt,
                delayMs,
                error: err instanceof Error ? err.message : String(err),
              });
              // Same sampleHandlers/processor is reused for the next
              // attempt — wipe its buffered/streamed state first so the
              // retry doesn't append onto a partial, now-abandoned reply.
              hooks.onSampleReset?.();
            },
          },
        );
        endSample(step, result, sampleHandlers);
      } catch (err) {
        // Clear streaming flags so the UI does not freeze mid-stream
        endSample(step, null, sampleHandlers);
        throw err;
      }

      if (result.usage) {
        const p = result.usage.prompt_tokens ?? 0;
        const c = result.usage.completion_tokens ?? 0;
        promptTok += p;
        completionTok += c;
        if (p > 0) lastApiPromptTokens = p;
        hooks.onUsage?.(p, c);
      }

      // Client-side thinking-tail loop (Grok Build spirit without server signals)
      if (
        !forceToolsOff &&
        !isLast &&
        detectThoughtLoop(thoughtLoop, result.reasoning)
      ) {
        thoughtLoop.recoveries++;
        dbg(ns, `step.${step}.thought_loop`, {
          recoveries: thoughtLoop.recoveries,
          reasoningLen: result.reasoning?.length ?? 0,
        });
        if (result.content?.trim() || result.reasoning?.trim()) {
          messages.push(
            attachInTurnReasoning(
              {
                role: "assistant",
                content: result.content?.trim() || null,
              },
              result.reasoning,
            ),
          );
        }
        messages.push({ role: "user", content: THOUGHT_LOOP_REMINDER });
        if (thoughtLoop.recoveries >= 2) {
          forceToolsOff = true;
          hooks.onPhase?.("streaming", "thought-loop · answering");
        }
        // If model also emitted tools this round, still allow one tool wave
        // unless we're already force-off — fall through only when tools present
        // and first recovery; otherwise continue to re-sample with reminder.
        const hasTools = result.tool_calls.some((t) => t.function?.name);
        if (!hasTools || thoughtLoop.recoveries >= 2) {
          finalText = result.content?.trim() || finalText;
          if (thoughtLoop.recoveries >= 2 && !hasTools) {
            // Will re-sample with tools off on next iteration
            continue;
          }
          if (!hasTools) continue;
        }
      }

      // OpenCode: tool_calls present ⇒ continue even if finish_reason=stop
      const openTools = result.tool_calls.filter((t) => t.function?.name);
      const lengthCut = isLengthFinish(result.finish_reason);
      // Large write payloads often truncate mid-JSON — salvage partial content
      // (balance braces / close strings) before treating as hard-broken.
      let salvagedCount = 0;
      if (openTools.length > 0 && hasBrokenToolCallArgs(openTools)) {
        salvagedCount = salvageBrokenToolCallArgs(openTools);
        if (salvagedCount > 0) {
          dbg(ns, `step.${step}.salvaged_tool_args`, {
            salvaged: salvagedCount,
            tools: openTools.map((t) => t.function.name),
          });
        }
      }
      const brokenTools =
        openTools.length > 0 && hasBrokenToolCallArgs(openTools);

      roundSpan.end({
        finish: result.finish_reason,
        tools: openTools.map((t) => t.function.name),
        contentLen: result.content.length,
        reasoningLen: result.reasoning?.length ?? 0,
        lengthCut,
        brokenTools,
        salvagedCount,
      });

      // Truncated tool args (often finish_reason=length mid JSON): do not
      // execute — ask the model to re-emit complete calls with tools still on.
      if (
        brokenTools &&
        !isLast &&
        !cancelled &&
        lengthContinues < MAX_LENGTH_CONTINUATIONS
      ) {
        lengthContinues++;
        if (result.content?.trim() || result.reasoning?.trim()) {
          messages.push(
            attachInTurnReasoning(
              {
                role: "assistant",
                content: result.content?.trim() || null,
              },
              result.reasoning,
            ),
          );
        }
        messages.push({
          role: "user",
          content: brokenToolArgsNudge(openTools.map((t) => t.function.name)),
        });
        finalText = result.content?.trim() || finalText;
        dbg(ns, `step.${step}.length_broken_tools`, {
          lengthContinues,
          tools: openTools.map((t) => t.function.name),
        });
        continue;
      }

      // Valid tool calls → execute and loop (never on last step / force-answer)
      if (openTools.length && !isLast && !brokenTools && !forceToolsOff) {
        const wireTools = normalizeToolCallsForWire(openTools);
        const dispatchCalls = buildDispatchCalls(openTools);

        messages.push(
          buildAssistantToolRoundMessage({
            content: result.content || null,
            tool_calls: wireTools,
            reasoning: result.reasoning,
          }),
        );

        hooks.onPhase?.("tool", `running ${dispatchCalls.length} tool(s)`);
        hooks.onToolsStart?.(dispatchCalls);

        const toolSpan = span(ns, `step.${step}.tools`, {
          count: dispatchCalls.length,
          names: dispatchCalls.map((d) => d.name),
        });

        const outputs = await runtime.dispatchAll(dispatchCalls, {
          signal: abortSignal,
          isCustomTool: hooks.isCustomTool,
          customDispatch: hooks.customDispatch,
        });

        let waveDoom = 0;
        let waveFail = 0;
        let waveMutateOk = 0;

        for (let i = 0; i < outputs.length; i++) {
          const out = outputs[i]!;
          const d = dispatchCalls[i]!;
          toolsUsed.push(out.name);
          dbg(ns, out.cached ? "tool.cache_hit" : "tool.done", {
            id: out.callId,
            name: out.name,
            ok: out.ok,
            ms: out.durationMs,
            cached: out.cached,
            doomLoop: out.doomLoop,
            doomReason: out.doomReason,
            outLen: out.output.length,
          });
          hooks.onToolDone?.(i, d, out);
          messages.push({
            role: "tool",
            tool_call_id: out.callId,
            content: out.output || "(empty)",
          });

          if (out.doomLoop) waveDoom++;
          if (!out.ok && !out.doomLoop) {
            waveFail++;
            recentFailFps.push(out.fingerprint);
            if (recentFailFps.length > 16) recentFailFps.shift();
            const snip = (out.output || "").slice(0, 120).toLowerCase();
            if (snip) {
              recentErrorSnips.push(snip);
              if (recentErrorSnips.length > 8) recentErrorSnips.shift();
            }
          }
          if (
            out.ok &&
            (out.name === "search_replace" ||
              out.name === "write" ||
              out.name === "write_file" ||
              out.name === "edit_file")
          ) {
            waveMutateOk++;
          }
        }

        toolSpan.end({
          ok: outputs.filter((o) => o.ok).length,
          fail: outputs.filter((o) => !o.ok).length,
          doom: waveDoom,
        });

        // Doom escalation: only on waves that actually blocked a tool
        if (waveDoom > 0) {
          doomWaves++;
          dbg(ns, `step.${step}.doom`, {
            waveDoom,
            doomHits: runtime.doomHitCount,
            doomWaves,
          });
          messages.push({
            role: "user",
            content: DOOM_FORCE_ANSWER_REMINDER,
          });
          if (
            doomWaves >= DOOM_FORCE_ANSWER_AFTER ||
            runtime.doomHitCount >= DOOM_LOOP_THRESHOLD
          ) {
            forceToolsOff = true;
            hooks.onPhase?.("streaming", "doom-loop · answering");
          }
        }

        // Stuck progress: same fail fingerprint or identical error snips
        const stuck = detectStuckProgress(
          recentFailFps,
          recentErrorSnips,
          waveFail,
          waveMutateOk,
          outputs.length,
        );
        if (stuck) {
          stuckWaves++;
          dbg(ns, `step.${step}.stuck`, { stuckWaves, waveFail });
          messages.push({ role: "user", content: STUCK_PROGRESS_REMINDER });
          if (stuckWaves >= STUCK_FORCE_ANSWER_AFTER) {
            forceToolsOff = true;
            hooks.onPhase?.("streaming", "stuck · answering");
          }
        } else if (waveMutateOk > 0) {
          // Progress resets stuck counter
          stuckWaves = 0;
        }

        // After tool wave: notify parent of any subagents that finished
        maybeInjectSubagentNotices(messages, hooks.drainSubagentNotices);

        finalText = result.content?.trim() || finalText;
        continue;
      }

      // Model asked for tools but we forced answer — drop tools and nudge
      if (openTools.length && forceToolsOff && !isLast) {
        if (result.content?.trim() || result.reasoning?.trim()) {
          messages.push(
            attachInTurnReasoning(
              {
                role: "assistant",
                content: result.content?.trim() || null,
              },
              result.reasoning,
            ),
          );
        }
        messages.push({
          role: "user",
          content: DOOM_FORCE_ANSWER_REMINDER,
        });
        finalText = result.content?.trim() || finalText;
        continue;
      }

      // No tools (or last step). Auto-continue when the provider hit its
      // output token cap mid-answer so responses are not frozen truncated.
      if (
        lengthCut &&
        !isLast &&
        !cancelled &&
        lengthContinues < MAX_LENGTH_CONTINUATIONS
      ) {
        lengthContinues++;
        const partial =
          result.content?.trim() ||
          result.reasoning?.trim() ||
          finalText ||
          "";
        messages.push(
          attachInTurnReasoning(
            {
              role: "assistant",
              content: result.content?.trim() || null,
            },
            result.reasoning,
          ),
        );
        messages.push({
          role: "user",
          content: lengthContinuationNudge(partial),
        });
        finalText = result.content?.trim() || finalText;
        dbg(ns, `step.${step}.length_continue`, {
          lengthContinues,
          partialLen: partial.length,
        });
        continue;
      }

      finalText =
        result.content?.trim() ||
        result.reasoning?.trim() ||
        finalText;
      dbg(ns, `step.${step}.stop`, {
        reason: isLast
          ? "max_steps"
          : cancelled
            ? "aborted"
            : result.finish_reason,
        tools: openTools.length,
        lengthContinues,
      });
      break;
    }

    if (!finalText.trim()) {
      if (cancelled) {
        finalText = "(cancelled)";
      } else if (step >= maxSteps) {
        finalText =
          "(hit max steps — partial work may exist in the workspace)";
      } else {
        finalText = "(no text)";
      }
    }

    hooks.onPhase?.("idle", "idle");
    turnSpan.end({
      rounds: step,
      tools: toolsUsed.length,
      cancelled,
    });

    return {
      rounds: step,
      finalText,
      toolsUsed,
      usage: { prompt_tokens: promptTok, completion_tokens: completionTok },
      error: cancelled
        ? "cancelled"
        : step >= maxSteps && toolsUsed.length > 0 && !finalText
          ? "max_rounds"
          : undefined,
      messages,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dbg(ns, "error", { error: msg });
    turnSpan.end({ error: msg });
    throw err;
  }
}

/**
 * Full interactive turn against HarnessStore (parent agent).
 * Setup only — control flow is runTurnCore.
 */
export async function runStoreTurn(
  ctx: RunTurnStoreContext,
  opts: TurnOptions,
): Promise<TurnResult> {
  const settings = loadAgentSettings();
  const cwd = opts.cwd ?? process.cwd();
  const label = opts.label ?? "agent";
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const toolCache = new Map<string, string>();
  const runner = new ToolRunner(cwd, {
    signal: opts.abortSignal,
    permissions: opts.permissions,
    ask: opts.onPermission,
    autoApprove: opts.autoApprove,
    toolsets: opts.toolsets,
    cache: toolCache,
  });
  const runtime = new ToolCallRuntime(runner);

  const multiAgentOn =
    opts.subagents !== false &&
    settings.subagents.enabled &&
    opts.tools !== false;
  const subRuntime = multiAgentOn
    ? new SubagentRuntime({
        parentProvider: opts.provider,
        parentModel: opts.model,
        cwd,
        depth: 0,
        config: settings.subagents,
        parentContextSummary:
          [...ctx.store.state.messages]
            .reverse()
            .find((m) => m.role === "user")
            ?.parts.filter((p) => p.type === "text")
            .map((p) => (p.type === "text" ? p.content : ""))
            .join("\n")
            .slice(0, 2000) ?? "",
        signal: opts.abortSignal,
        preferredModelKey: settings.subagents.preferredModelKey,
        // Tests inject chatImpl for parent + forced Ultra reasoners
        chatImpl: opts.chatImpl,
      })
    : null;
  const turnId = subRuntime?.beginTurn();

  const isUltra = settings.reasoning.custom === "ultra";
  const isUltraFusion = settings.reasoning.custom === "ultra-fusion";
  const proactive =
    settings.subagents.autoSpawn || isUltra || isUltraFusion;

  let system =
    opts.systemPrompt ??
    buildSystemPrompt({
      extra: settings.reasoning.customInstructions,
      model: opts.model,
      provider: opts.provider,
      cwd: ctx.store.state.session.cwd,
      profile: opts.promptProfile ?? "full",
    });

  if (subRuntime?.canSpawn) {
    system +=
      "\n\n" +
      buildMultiAgentSystemAddon({
        roles: subRuntime.listRoles(),
        maxThreads: settings.subagents.maxConcurrent,
        maxDepth: settings.subagents.maxDepth,
        proactive,
        peerMessaging: settings.subagents.peerMessaging !== false,
      });
  }

  /**
   * Ultra (not fusion): harness-forces parallel reason/explorer subagents
   * before the main sample loop so reasoning is extended by construction.
   * Fusion already dual-reasons in phase-1; skip double-prep there.
   * Main keeps full native effort (do not flip lightReasoning from this seed).
   */
  if (
    isUltra &&
    subRuntime?.canSpawn &&
    opts.tools !== false &&
    !opts.seedReasoning?.trim()
  ) {
    const userPrompt =
      [...ctx.store.state.messages]
        .reverse()
        .find((m) => m.role === "user")
        ?.parts.filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.content : ""))
        .join("\n")
        .trim() ?? "";

    if (userPrompt) {
      try {
        const ext = await forceUltraReasoningExtension(
          subRuntime,
          userPrompt,
          {
            signal: opts.abortSignal,
            onPhase: (lab) => ctx.store.setPhase("thinking", lab),
          },
        );
        // Mark notices consumed so mid-turn drain does not re-paste them
        void subRuntime.drainCompletionNotices();

        if (ext.systemAddon.trim()) {
          system += "\n\n" + ext.systemAddon;
        }
        // Thought blocks in the TUI (one per forced angle)
        for (const part of ext.parts) {
          if (!part.content.trim()) continue;
          ctx.store.appendPart(ctx.messageId, {
            id: newId("p"),
            type: "reasoning",
            content: part.content,
            streaming: false,
            collapsed: true,
            title: part.title,
          });
        }
        if (ext.okCount > 0) {
          ctx.store.setPhase(
            "thinking",
            `ultra · ${ext.okCount} reasoning subagent${ext.okCount === 1 ? "" : "s"} ready · ${Math.round(ext.ms)}ms`,
          );
        }
      } catch (err) {
        if (
          err instanceof DOMException &&
          err.name === "AbortError"
        ) {
          throw err;
        }
        dbg("agent", "ultra.force_reason.error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...historyToMessages(ctx.store),
  ];

  const toolSchemas =
    opts.tools !== false
      ? mergeToolSchemas(
          runner.registry.schemas({ slim: opts.slimTools === true }),
          subRuntime?.schemas() ?? [],
        )
      : undefined;

  const light =
    opts.lightReasoning ?? Boolean(opts.seedReasoning?.trim());
  const chat = opts.chatImpl ?? chatComplete;

  // Processor is recreated each sample inside onSampleStart
  let processor: ReturnType<typeof createSampleProcessor> | null = null;
  const modelBudget = compactBudgetForModel(
    opts.provider,
    opts.model,
    COMPACT_TOKEN_BUDGET,
  );

  try {
    return await runTurnCore({
      provider: opts.provider,
      model: opts.model,
      messages,
      toolSchemas,
      runner,
      runtime,
      maxSteps,
      lightReasoning: light,
      reasoningEffort: opts.reasoningEffort,
      toolChoice: opts.toolChoice,
      toolsEnabledInitially: opts.tools !== false,
      abortSignal: opts.abortSignal,
      isAborted: () =>
        ctx.abort() || opts.abortSignal?.aborted === true,
      label,
      chat,
      hooks: {
        spanNs: "agent",
        compactBudget: modelBudget,
        onPhase: (phase, lab) => ctx.store.setPhase(phase, lab),
        onUsage: (p, c) => ctx.store.addTokens(p, c),
        drainSubagentNotices: subRuntime
          ? () => subRuntime.drainCompletionNotices()
          : undefined,
        /**
         * Full auto-compact: wipe the old transcript and seed a **new**
         * session with the compacted context, then re-bind the live
         * assistant message id for the remainder of this turn.
         */
        onSessionRollover: (compacted) => {
          ctx.store.resetWithSeed(
            {
              title: compactSessionTitle(ctx.store.state.session.title),
              model: opts.model,
              provider: opts.provider,
              cwd: ctx.store.state.session.cwd,
            },
            compacted.uiMessages,
          );

          // Continue this turn on a fresh assistant shell in the new session
          const assistant = ctx.store.startAssistant();
          ctx.messageId = assistant.id;
          processor = null;

          const label =
            compacted.summary.length > 80
              ? compacted.summary.slice(0, 77) + "…"
              : compacted.summary;
          ctx.store.setPhase("streaming", label);
          dbg("agent", "session_rollover", {
            sessionId: ctx.store.state.session.id,
            before: compacted.beforeTokens,
            after: compacted.afterTokens,
            budget: compacted.budget,
            contextWindow: compacted.contextWindow,
          });
        },
        onSampleStart: () => {
          processor = createSampleProcessor(ctx.store, ctx.messageId);
          return processor.handlers;
        },
        onSampleEnd: (_step, result) => {
          processor?.finish(result);
        },
        onSampleReset: () => {
          processor?.resetForRetry();
        },
        onToolsStart: (calls) => {
          for (let i = 0; i < calls.length; i++) {
            const d = calls[i]!;
            processor?.ensureToolPart(i, d.name, d.args, d.callId);
          }
        },
        onToolDone: (i, d, out) => {
          const pid =
            processor?.toolPartId(i) ??
            processor?.ensureToolPart(i, d.name, d.args, d.callId);
          if (!pid) return;
          ctx.store.toolStatus(
            ctx.messageId,
            pid,
            out.ok ? "completed" : out.aborted ? "cancelled" : "error",
            {
              result: out.ok ? out.output : undefined,
              error: out.ok ? undefined : out.output,
            },
          );
        },
        isCustomTool: (name) => isMultiAgentTool(name),
        customDispatch: async (call) => {
          if (!subRuntime) {
            return {
              ok: false,
              output: `Multi-agent tool "${call.name}" unavailable`,
            };
          }
          ctx.store.setPhase("tool", `${call.name} · multi-agent`);
          const t0 = Date.now();
          const r = await subRuntime.dispatch(call.name, call.args);
          return {
            ok: r.ok,
            output: r.output,
            durationMs: Date.now() - t0,
          };
        },
      },
    });
  } finally {
    // Cancel only agents tagged to this parent turn
    if (turnId) subRuntime?.cancelTurn(turnId);
    else subRuntime?.cancelTurn();
  }
}

/**
 * Headless turn (subagents) — setup only; control flow is runTurnCore.
 */
export async function runHeadlessTurn(
  opts: TurnOptions & { headlessMessages: ChatMessage[] },
): Promise<TurnResult> {
  const cwd = opts.cwd ?? process.cwd();
  const label = opts.label ?? "subagent";
  const maxSteps = opts.maxSteps ?? DEFAULT_CHILD_MAX_STEPS;
  const runner = new ToolRunner(cwd, {
    headless: true,
    autoApprove: true,
    permissions: opts.permissions,
    toolsets: opts.toolsets,
    signal: opts.abortSignal,
  });
  const runtime = new ToolCallRuntime(runner);
  // If caller did not inject a system message, build one with profile.
  const messages: ChatMessage[] = [...opts.headlessMessages];
  if (!messages.some((m) => m.role === "system")) {
    messages.unshift({
      role: "system",
      content: buildSystemPrompt({
        model: opts.model,
        provider: opts.provider,
        cwd,
        profile: opts.promptProfile ?? "full",
        extra: opts.systemPrompt,
      }),
    });
  }
  const chat = opts.chatImpl ?? chatComplete;
  const light = Boolean(opts.lightReasoning);
  const baseSchemas =
    opts.tools !== false
      ? runner.registry.schemas({ slim: opts.slimTools === true })
      : undefined;
  const toolSchemas =
    baseSchemas && opts.extraTools?.length
      ? mergeToolSchemas(baseSchemas, opts.extraTools)
      : baseSchemas;

  try {
    return await runTurnCore({
      provider: opts.provider,
      model: opts.model,
      messages,
      toolSchemas,
      runner,
      runtime,
      maxSteps,
      lightReasoning: light,
      reasoningEffort: opts.reasoningEffort,
      toolChoice: opts.toolChoice,
      toolsEnabledInitially: opts.tools !== false,
      abortSignal: opts.abortSignal,
      isAborted: () => opts.abortSignal?.aborted === true,
      label,
      chat,
      hooks: {
        spanNs: "subagent",
        compactBudget: compactBudgetForModel(
          opts.provider,
          opts.model,
          COMPACT_TOKEN_BUDGET_CHILD,
        ),
        compactKeepRecent: 12,
        isCustomTool: opts.isCustomTool,
        customDispatch: opts.customDispatch,
        // Headless has no UI session — wire messages are already replaced
        // in maybeCompact; no onSessionRollover needed.
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      rounds: 0,
      finalText: `Subagent error: ${msg}`,
      toolsUsed: [],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      error: msg,
      messages,
    };
  }
}

function mergeToolSchemas(
  base: OpenAITool[],
  multi: OpenAITool[],
): OpenAITool[] {
  if (!multi.length) return base;
  const seen = new Set(base.map((t) => t.function.name));
  const out = [...base];
  for (const t of multi) {
    if (!seen.has(t.function.name)) {
      out.push(t);
      seen.add(t.function.name);
    }
  }
  return out;
}

/**
 * Append deduped subagent completion + parent-mailbox notices as a
 * system-reminder user turn (Grok completions + Codex v2 child→root).
 */
function maybeInjectSubagentNotices(
  messages: ChatMessage[],
  drain?: () => string | undefined,
): void {
  if (!drain) return;
  const text = drain()?.trim();
  if (!text) return;
  const hasMail = text.includes("<agent_message");
  const hasDone = text.includes("<subagent_completed");
  const label =
    hasMail && hasDone
      ? "Subagent updates since last notice (completions + parent mailbox):"
      : hasMail
        ? "Parent mailbox messages since last notice:"
        : "Subagent(s) finished since last notice:";
  messages.push({
    role: "user",
    content: `<system-reminder>\n${label}\n\n${text}\n</system-reminder>`,
  });
}

/** Detect thrashing: repeated fail fingerprints or identical error text. */
function detectStuckProgress(
  recentFailFps: string[],
  recentErrorSnips: string[],
  waveFail: number,
  waveMutateOk: number,
  waveSize: number,
): boolean {
  if (waveMutateOk > 0 || waveSize === 0) return false;
  if (waveFail === 0) return false;

  // Same fail fingerprint ≥2 in recent window
  if (recentFailFps.length >= 2) {
    const last = recentFailFps[recentFailFps.length - 1]!;
    const count = recentFailFps.filter((f) => f === last).length;
    if (count >= 2) return true;
  }

  // Last 3 error snips identical (and non-empty)
  if (recentErrorSnips.length >= 3) {
    const last3 = recentErrorSnips.slice(-3);
    if (last3[0] && last3.every((s) => s === last3[0])) return true;
  }

  return false;
}

/** Title for a session after auto-compaction rollover. */
function compactSessionTitle(prev: string): string {
  const base = (prev || "session")
    .replace(/\s*\(compacted(?:\s*·\s*\d+)?\)\s*$/i, "")
    .trim();
  return `${base || "session"} (compacted)`;
}

export type { ToolCall };
