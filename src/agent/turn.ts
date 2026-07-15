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
import { getModelContextWindow } from "../auth/models.js";

/** OpenCode-style step cap before max-steps nudge. */
export const MAX_STEPS = 24;
/** Default child/subagent step cap (still uses same core + MAX_STEPS_PROMPT). */
export const DEFAULT_CHILD_MAX_STEPS = 8;
/** Fallback soft budget when model context is unknown (also 80% target uses model). */
export const COMPACT_TOKEN_BUDGET = DEFAULT_COMPACT_TOKEN_BUDGET;
/** Slightly tighter budget for headless children (same compact fn). */
export const COMPACT_TOKEN_BUDGET_CHILD = 40_000;

/**
 * Injected on the final step (both parent and child) when tools would
 * otherwise still be enabled — OpenCode max-steps spirit.
 * Exported so tests can assert both paths use the same constant.
 */
export const MAX_STEPS_PROMPT =
  "You have used the maximum number of steps for this turn. " +
  "Do not call any more tools. Give the user your best final answer now based on what you already know.";

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

    if (!shouldAutoCompact(messages, compactBudget)) return;
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
      // Tools off only on last step OR when tools disabled for the whole turn
      const toolsEnabled =
        toolsEnabledInitially && Boolean(toolSchemas?.length) && !isLast;

      // Same max-steps nudge for parent AND child
      const sampleMessages = isLast
        ? [
            ...messages,
            { role: "assistant" as const, content: MAX_STEPS_PROMPT },
          ]
        : messages;

      // Reasoning effort is set only at the API layer (buildReasoningApiFields /
      // user per-model effort). Never force "low" or disable native reasoning.
      const effort = resolveEffortForModel(provider, model).effort;

      // Always "streaming" while the model is generating — never jump to
      // "tool" mid-thought. Tool phase starts only when tools actually run.
      hooks.onPhase?.(
        "streaming",
        isLast
          ? `finalizing · step ${step}`
          : lengthContinues > 0
            ? `continuing · step ${step}`
            : `streaming · step ${step}`,
      );

      dbg(ns, `step.${step}.start`, {
        messages: sampleMessages.length,
        tools: toolsEnabled,
        isLast,
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
                temperature: lightReasoning ? 0.2 : 0.4,
                stream: true,
                applyNativeReasoning: true,
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
        hooks.onUsage?.(p, c);
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

      // Valid tool calls → execute and loop (never on last step)
      if (openTools.length && !isLast && !brokenTools) {
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
            outLen: out.output.length,
          });
          hooks.onToolDone?.(i, d, out);
          messages.push({
            role: "tool",
            tool_call_id: out.callId,
            content: out.output || "(empty)",
          });
        }

        toolSpan.end({
          ok: outputs.filter((o) => o.ok).length,
          fail: outputs.filter((o) => !o.ok).length,
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
      })
    : null;

  const proactive =
    settings.subagents.autoSpawn ||
    settings.reasoning.custom === "ultra" ||
    settings.reasoning.custom === "ultra-fusion";

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
      });
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
    subRuntime?.cancelAll();
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

  try {
    return await runTurnCore({
      provider: opts.provider,
      model: opts.model,
      messages,
      toolSchemas:
        opts.tools !== false
          ? runner.registry.schemas({ slim: opts.slimTools === true })
          : undefined,
      runner,
      runtime,
      maxSteps,
      lightReasoning: light,
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

/** Title for a session after auto-compaction rollover. */
function compactSessionTitle(prev: string): string {
  const base = (prev || "session")
    .replace(/\s*\(compacted(?:\s*·\s*\d+)?\)\s*$/i, "")
    .trim();
  return `${base || "session"} (compacted)`;
}

export type { ToolCall };
