/**
 * Fast agent loop: LLM stream → tool calls → results → repeat.
 * OpenAI-compatible (OpenRouter, xAI, OpenAI, …).
 *
 * Benchmark-driven improvements:
 *  - Normalize tool args (list_dir {} ≡ {target_directory:"."})
 *  - Cache identical tool results within a turn (no re-exec)
 *  - If the model re-requests only cached tools, force a final answer
 *    (Grok 4.5 burned an extra ~850ms round re-calling list_dir)
 *  - Tighter system prompt against redundant tool use
 */

import type { HarnessStore } from "../core/store.js";
import { newId } from "../core/types.js";
import type { ProviderId } from "../auth/types.js";
import { loadAgentSettings } from "./config.js";
import {
  attachInTurnReasoning,
  buildAssistantToolRoundMessage,
  chatComplete,
  extractLikelyAnswer,
  isFreeModelId,
  hasBrokenToolCallArgs,
  isLengthFinish,
  isMeaningfulAnswer,
  lengthContinuationNudge,
  MAX_LENGTH_CONTINUATIONS,
  resolveMaxOutputTokens,
  type ChatMessage,
  type ChatResult,
  type ChatRequest,
  type StreamHandlers,
  type ToolCall,
} from "../llm/client.js";
import {
  normalizeToolArgs,
  parseToolArgs,
  toolFingerprint,
} from "../toolcalling/normalize.js";
import { ToolRunner, type RunCallResult } from "../toolcalling/runner.js";
import { runInWaves } from "../toolcalling/concurrency.js";
import type { PermissionAskFn, PermissionRules } from "../toolcalling/permissions.js";
import type { ToolsetId } from "../toolcalling/registry.js";
import type { OpenAITool } from "../toolcalling/schema.js";
import { resolveEffortForModel } from "./reasoning.js";
import { dbg, span } from "./debug.js";
import { buildSystemPrompt } from "./prompt.js";
import { SubagentRuntime } from "./subagent/runtime.js";
import {
  buildMultiAgentSystemAddon,
  isMultiAgentTool,
} from "./subagent/tools.js";

export { buildSystemPrompt } from "./prompt.js";

const MAX_ROUNDS = 24;
/** After this many fully-cached tool rounds, stop tools and demand text */
const MAX_CACHED_TOOL_ROUNDS = 1;
/** Tool result snippet size in multi-turn history (opencode keeps more context). */
const HISTORY_TOOL_SNIPPET = 2_000;

export interface AgentLoopOptions {
  provider: ProviderId;
  model: string;
  cwd?: string;
  systemPrompt?: string;
  /** Disable tools for pure chat */
  tools?: boolean;
  abortSignal?: AbortSignal;
  /**
   * Pre-seeded reasoning shown as a normal thinking block on this turn
   * (e.g. Ultra + Fusion dual traces) before the model streams.
   */
  seedReasoning?: string;
  /**
   * After fusion phase-1, skip heavy native reasoning on execute —
   * compare+act should be fast. Default true when seedReasoning set.
   */
  lightReasoning?: boolean;
  /** Force tool_choice (e.g. required for smoke tests) */
  toolChoice?: "auto" | "none" | "required";
  /** Debug label prefix */
  label?: string;
  /** OpenCode-style permission rules */
  permissions?: PermissionRules;
  /** Prompt user (or UI) when permission is "ask" */
  onPermission?: PermissionAskFn;
  /** Auto-approve "ask" rules (CI / --auto) */
  autoApprove?: boolean;
  /** Hermes-style toolset filter */
  toolsets?: ToolsetId[];
  /**
   * Multi-agent (Codex v1). Default: follow settings.subagents.enabled.
   * Set false to force single-agent even in ultra.
   */
  subagents?: boolean;
  /**
   * Test injection: replace chatComplete (offline loop tests for length_continue /
   * length_broken_tools). Production callers omit this.
   */
  chatImpl?: (
    req: ChatRequest,
    handlers?: StreamHandlers,
  ) => Promise<ChatResult>;
}

export class AgentLoop {
  private busy = false;
  private abort = false;
  private runner: ToolRunner;
  private subRuntime: SubagentRuntime | null = null;

  constructor(private store: HarnessStore) {
    this.runner = new ToolRunner(process.cwd());
  }

  cancel(): void {
    this.abort = true;
    this.subRuntime?.cancelAll();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async handle(userText: string, opts: AgentLoopOptions): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.abort = false;
    const toolCache = new Map<string, string>();
    this.runner = new ToolRunner(opts.cwd ?? process.cwd(), {
      signal: opts.abortSignal,
      permissions: opts.permissions,
      ask: opts.onPermission,
      autoApprove: opts.autoApprove,
      toolsets: opts.toolsets,
      cache: toolCache,
    });
    const label = opts.label ?? "agent";
    const turn = span("agent", `${label}.turn`, {
      model: `${opts.provider}/${opts.model}`,
      promptLen: userText.length,
      tools: opts.tools !== false,
      seeded: Boolean(opts.seedReasoning?.trim()),
    });

    try {
      this.store.appendUser(userText);
      const assistant = this.store.startAssistant();
      const mid = assistant.id;
      const settings = loadAgentSettings();

      // Codex multi-agent v1 runtime (spawn/wait/send/close)
      const multiAgentOn =
        opts.subagents !== false &&
        settings.subagents.enabled &&
        opts.tools !== false;
      this.subRuntime = multiAgentOn
        ? new SubagentRuntime({
            parentProvider: opts.provider,
            parentModel: opts.model,
            cwd: opts.cwd ?? process.cwd(),
            depth: 0,
            config: settings.subagents,
            parentContextSummary: userText.slice(0, 2000),
            signal: opts.abortSignal,
            preferredModelKey: settings.subagents.preferredModelKey,
          })
        : null;

      if (opts.seedReasoning?.trim()) {
        const seedId = newId("p");
        this.store.appendPart(mid, {
          id: seedId,
          type: "reasoning",
          content: opts.seedReasoning.trim(),
          streaming: false,
        });
        dbg("agent", "seed_reasoning", {
          chars: opts.seedReasoning.trim().length,
        });
      }

      const proactive =
        settings.subagents.autoSpawn ||
        settings.reasoning.custom === "ultra" ||
        settings.reasoning.custom === "ultra-fusion";

      let system =
        opts.systemPrompt ??
        buildSystemPrompt(settings.reasoning.customInstructions);

      if (this.subRuntime?.canSpawn) {
        system +=
          "\n\n" +
          buildMultiAgentSystemAddon({
            roles: this.subRuntime.listRoles(),
            maxThreads: settings.subagents.maxConcurrent,
            maxDepth: settings.subagents.maxDepth,
            proactive,
          });
        dbg("agent", "multi_agent.enabled", {
          roles: this.subRuntime.listRoles().map((r) => r.id),
          maxThreads: settings.subagents.maxConcurrent,
          maxDepth: settings.subagents.maxDepth,
          proactive,
        });
      }

      const messages: ChatMessage[] = [
        { role: "system", content: system },
        ...historyToMessages(this.store),
      ];

      // lightReasoning: fusion execute path only — do NOT cripple free models
      // (old path forced low effort + 1.5k max_tokens → CoT ate the budget).
      const light =
        opts.lightReasoning ?? Boolean(opts.seedReasoning?.trim());
      const isFree = isFreeModelId(opts.model);

      let cachedToolRounds = 0;
      /** After duplicate-only tool round OR text length-continue, force tool_choice=none */
      let forceFinalAnswer = false;
      /** Auto-continue after finish_reason=length (text-only path; tools off). */
      let lengthContinuations = 0;
      /**
       * Broken tool-arg length retries — MUST keep tools enabled.
       * Separate from lengthContinuations so toolsEnabled is not gated off.
       */
      let brokenToolRetries = 0;
      /** Accumulated spoken text for this turn (for length-continue nudges). */
      let spokenSoFar = "";

      // One text + reasoning part for the whole turn (not per-round).
      // Per-round parts left plan-speak permanently in the final answer.
      const textPartId = newId("p");
      let textStarted = false;
      const reasoningPartId = newId("p");
      let reasoningStarted = false;

      const chat = opts.chatImpl ?? chatComplete;

      /** Coalesce high-frequency token events before hitting the store/TUI */
      const streamBatch = createStreamBatcher();
      let round = 0;
      while (round < MAX_ROUNDS) {
        if (this.abort) {
          dbg("agent", "aborted", { round });
          break;
        }
        round++;

        const appliedEffort = light
          ? "low/fast"
          : (() => {
              const { effort, clamped } = resolveEffortForModel(
                opts.provider,
                opts.model,
              );
              return effort
                ? `${effort}${clamped ? " (clamped)" : ""}`
                : "default";
            })();

        const maxTokens = resolveMaxOutputTokens({
          model: opts.model,
          tools: opts.tools !== false && !forceFinalAnswer,
          lengthContinuation:
            lengthContinuations > 0 || brokenToolRetries > 0,
        });

        this.store.setPhase(
          round === 1 ? "streaming" : "tool",
          forceFinalAnswer
            ? `finalizing · round ${round}`
            : brokenToolRetries > 0
              ? `retry tools · round ${round}`
              : lengthContinuations > 0
                ? `continuing · round ${round}`
                : round === 1
                  ? `streaming · reasoning=${appliedEffort}`
                  : `tool round ${round}`,
        );

        dbg("agent", `round.${round}.start`, {
          messages: messages.length,
          effort: appliedEffort,
          light,
          isFree,
          forceFinalAnswer,
          maxTokens,
          lengthContinuations,
          brokenToolRetries,
          cacheSize: toolCache.size,
        });

        const toolPartIds = new Map<number, string>();

        const roundSpan = span("agent", `round.${round}`, {
          model: opts.model,
        });

        // Reset the turn text part before each new stream so textDelta does not
        // append onto prior-round plan-speak (we overwrite after result).
        if (textStarted && round > 1) {
          this.store.patchPart(mid, textPartId, {
            content: "",
            streaming: true,
          } as never);
        }

        // Text length-continue: tools OFF (forceFinalAnswer).
        // Broken-arg tool retry: tools ON (only forceFinalAnswer gates tools).
        const toolsEnabled =
          opts.tools !== false && !forceFinalAnswer;
        const toolSchemas = toolsEnabled
          ? mergeToolSchemas(
              this.runner.registry.schemas(),
              this.subRuntime?.schemas() ?? [],
            )
          : undefined;
        const result = await chat(
          {
            provider: opts.provider,
            model: opts.model,
            messages,
            tools: toolSchemas,
            tool_choice: !toolsEnabled
              ? "none"
              : (opts.toolChoice ?? "auto"),
            // Mild default; leave room for reasoning models (opencode often omits)
            temperature: light ? 0.2 : 0.4,
            stream: true,
            // Native reasoning for all models including free — only skip when
            // fusion light path explicitly wants a cheap execute step.
            applyNativeReasoning: !light,
            reasoning_effort: light ? "low" : undefined,
            max_tokens: maxTokens,
            signal: opts.abortSignal,
            label: `${label}.r${round}`,
          },
          {
            onText: (d) => {
              if (!textStarted) {
                textStarted = true;
                this.store.appendPart(mid, {
                  id: textPartId,
                  type: "text",
                  content: "",
                  streaming: true,
                });
              }
              // Batch token deltas (~40fps) — fewer store events / GC pressure
              streamBatch.pushText(d, () => {
                if (streamBatch.text) {
                  this.store.textDelta(mid, textPartId, streamBatch.text);
                  streamBatch.text = "";
                }
              });
            },
            onReasoning: (d) => {
              if (!reasoningStarted) {
                reasoningStarted = true;
                this.store.appendPart(mid, {
                  id: reasoningPartId,
                  type: "reasoning",
                  content: "",
                  streaming: true,
                });
              }
              streamBatch.pushReasoning(d, () => {
                if (streamBatch.reasoning) {
                  this.store.reasoningDelta(
                    mid,
                    reasoningPartId,
                    streamBatch.reasoning,
                  );
                  streamBatch.reasoning = "";
                }
              });
            },
            onToolCallDelta: (index, partial) => {
              if (!toolPartIds.has(index) && partial.function?.name) {
                const pid = newId("p");
                toolPartIds.set(index, pid);
                const args = normalizeToolArgs(
                  partial.function.name,
                  parseToolArgs(partial.function.arguments),
                );
                this.store.appendPart(mid, {
                  id: pid,
                  type: "tool",
                  toolName: partial.function.name,
                  args,
                  callId: partial.id,
                  status: "pending",
                });
                dbg("agent", "tool.pending", {
                  index,
                  name: partial.function.name,
                  callId: partial.id,
                });
              } else if (toolPartIds.has(index) && partial.id) {
                this.store.patchPart(mid, toolPartIds.get(index)!, {
                  callId: partial.id,
                } as never);
              }
            },
            onFirstToken: (kind, ms) => {
              dbg("agent", `round.${round}.ttft`, { kind, ms });
            },
          },
        );

        // Flush any coalesced stream text before reconciling with result
        streamBatch.flush();

        // Going to tools this round? (may still be broken-arg recovery)
        const willRunTools =
          result.tool_calls.length > 0 &&
          !forceFinalAnswer &&
          !(
            isLengthFinish(result.finish_reason) &&
            hasBrokenToolCallArgs(result.tool_calls) &&
            brokenToolRetries < MAX_LENGTH_CONTINUATIONS
          );

        // spokenSoFar is ONLY for finish_reason=length text continuations.
        // Never append mid-tool chatter ("AgentLoop") — that prefixes the final
        // answer when the loop later does spokenSoFar || result.content.
        //
        // Mid-tool rounds: clear the answer channel (tools are not the final text).
        // Length-continue: accumulate in the length_continue branch below.
        // Natural final: replace with this round's content only.
        const displayText = willRunTools
          ? ""
          : spokenSoFar ||
            (isMeaningfulAnswer(result.content) ? result.content : "");

        // Overwrite the ONE turn text part (never stack per-round leftovers)
        if (textStarted) {
          this.store.patchPart(mid, textPartId, {
            content: displayText,
            streaming: false,
          } as never);
        } else if (displayText) {
          this.store.appendPart(mid, {
            id: textPartId,
            type: "text",
            content: displayText,
          });
          textStarted = true;
        }

        // Merge reasoning into the single turn reasoning part
        const reasonText = result.reasoning ?? "";
        if (reasoningStarted) {
          // Append new reasoning chunks for multi-round turns
          const prev = this.store.state.messages
            .find((m) => m.id === mid)
            ?.parts.find((p) => p.id === reasoningPartId);
          const prevR =
            prev && prev.type === "reasoning" ? prev.content : "";
          const merged =
            prevR && reasonText && !prevR.includes(reasonText)
              ? `${prevR}\n\n${reasonText}`
              : reasonText || prevR;
          this.store.patchPart(mid, reasoningPartId, {
            content: merged,
            streaming: false,
          } as never);
        } else if (reasonText.trim()) {
          this.store.appendPart(mid, {
            id: reasoningPartId,
            type: "reasoning",
            content: reasonText,
            streaming: false,
          });
          reasoningStarted = true;
        }

        if (result.usage) {
          this.store.addTokens(
            result.usage.prompt_tokens ?? 0,
            result.usage.completion_tokens ?? 0,
          );
        }

        roundSpan.end({
          finish: result.finish_reason,
          ttftMs: result.ttftMs,
          tools: result.tool_calls.map((t) => t.function.name),
          contentLen: result.content.length,
          reasoningLen: result.reasoning?.length ?? 0,
          displayTextLen: displayText.length,
          maxTokens,
          toolsEnabled,
          usage: result.usage,
        });

        // ---- finish_reason=length (text only): tools OFF next round
        if (
          isLengthFinish(result.finish_reason) &&
          !result.tool_calls.length &&
          lengthContinuations < MAX_LENGTH_CONTINUATIONS
        ) {
          lengthContinuations++;
          // Only place we accumulate spokenSoFar (partial → continue → final)
          if (isMeaningfulAnswer(result.content)) {
            spokenSoFar = spokenSoFar
              ? `${spokenSoFar}${result.content}`
              : result.content;
          }
          if (textStarted) {
            this.store.patchPart(mid, textPartId, {
              content: spokenSoFar,
              streaming: false,
            } as never);
          } else if (spokenSoFar) {
            this.store.appendPart(mid, {
              id: textPartId,
              type: "text",
              content: spokenSoFar,
            });
            textStarted = true;
          }
          messages.push(
            attachInTurnReasoning(
              {
                role: "assistant",
                content: isMeaningfulAnswer(result.content)
                  ? result.content
                  : null,
              },
              result.reasoning,
            ),
          );
          messages.push({
            role: "user",
            content: lengthContinuationNudge(
              spokenSoFar || result.content || result.reasoning || "",
            ),
          });
          forceFinalAnswer = true; // text continue only — tools stay off
          dbg("agent", `round.${round}.length_continue`, {
            attempt: lengthContinuations,
            max: MAX_LENGTH_CONTINUATIONS,
            toolsEnabledNext: false,
            partialContent: result.content.length,
            partialReasoning: result.reasoning?.length ?? 0,
            spokenSoFarLen: spokenSoFar.length,
          });
          continue;
        }

        // Truncated tool args — retry WITH tools still enabled
        if (
          isLengthFinish(result.finish_reason) &&
          result.tool_calls.length > 0 &&
          brokenToolRetries < MAX_LENGTH_CONTINUATIONS &&
          hasBrokenToolCallArgs(result.tool_calls)
        ) {
          brokenToolRetries++;
          // Do NOT set forceFinalAnswer; do NOT bump lengthContinuations for tools gate
          messages.push(
            attachInTurnReasoning(
              {
                role: "assistant",
                content: isMeaningfulAnswer(result.content)
                  ? result.content
                  : null,
              },
              result.reasoning,
            ),
          );
          messages.push({
            role: "user",
            content:
              "Your previous tool call JSON was cut off by the output token limit and is invalid. " +
              "Retry the needed tool call(s) with complete JSON arguments, or answer without tools if you already can.",
          });
          dbg("agent", `round.${round}.length_broken_tools`, {
            tools: result.tool_calls.map((t) => t.function.name),
            attempt: brokenToolRetries,
            toolsEnabledNext: true,
            forceFinalAnswer: false,
          });
          continue;
        }

        // Forced final (or natural stop)
        if (!result.tool_calls.length || forceFinalAnswer) {
          let finalText = "";
          if (spokenSoFar) {
            // Length-continue path: append this round's final chunk only
            if (
              isMeaningfulAnswer(result.content) &&
              !spokenSoFar.endsWith(result.content)
            ) {
              spokenSoFar = `${spokenSoFar}${result.content}`;
            }
            finalText = spokenSoFar;
          } else if (isMeaningfulAnswer(result.content)) {
            // Natural stop after tools: REPLACE — never prefix mid-tool chatter
            finalText = result.content;
          }
          // Reasoning-only stop: promote best answer from CoT (never a stub)
          if (
            !finalText.trim() &&
            result.reasoning?.trim() &&
            !result.tool_calls.length
          ) {
            const promoted = extractLikelyAnswer(result.reasoning);
            if (promoted.trim() && isMeaningfulAnswer(promoted)) {
              finalText = promoted;
              dbg("agent", `round.${round}.promote_reasoning`, {
                chars: promoted.length,
              });
            }
          }
          // If we forced final but model still emitted tools, drop them
          if (
            forceFinalAnswer &&
            result.tool_calls.length &&
            !finalText.trim()
          ) {
            finalText = summarizeFromCache(toolCache);
          }
          if (finalText.trim()) {
            if (textStarted) {
              this.store.patchPart(mid, textPartId, {
                content: finalText,
                streaming: false,
              } as never);
            } else {
              this.store.appendPart(mid, {
                id: textPartId,
                type: "text",
                content: finalText,
              });
              textStarted = true;
            }
          } else if (textStarted) {
            this.store.patchPart(mid, textPartId, {
              content: "",
              streaming: false,
            } as never);
          }
          dbg("agent", `round.${round}.stop`, {
            reason: forceFinalAnswer
              ? "force_final"
              : isLengthFinish(result.finish_reason)
                ? "length_exhausted"
                : result.finish_reason,
            lengthContinuations,
            brokenToolRetries,
            finalTextLen: finalText.length,
          });
          break;
        }

        // Continuing to tools: ensure answer channel is empty (no tool-round leftovers)
        if (textStarted) {
          this.store.patchPart(mid, textPartId, {
            content: "",
            streaming: false,
          } as never);
        }

        // Normalize tool call args for the wire format
        const validated: ToolCall[] = result.tool_calls.map((tc) => {
          const rawArgs = parseToolArgs(tc.function.arguments);
          const args = normalizeToolArgs(tc.function.name, rawArgs);
          return {
            ...tc,
            function: {
              ...tc.function,
              arguments: JSON.stringify(args),
            },
          };
        });

        this.store.setPhase("tool", `running ${validated.length} tool(s)`);
        // Codex/opencode: keep reasoning across in-turn tool rounds so the
        // next completion still has the CoT that chose these tools.
        const assistantRound = buildAssistantToolRoundMessage({
          content: result.content || null,
          tool_calls: validated,
          reasoning: result.reasoning,
        });
        messages.push(assistantRound);
        if (assistantRound.reasoning) {
          dbg("agent", `round.${round}.reasoning_attached`, {
            chars: assistantRound.reasoning.length,
            tools: validated.map((t) => t.function.name),
          });
        }

        const toolSpan = span("agent", `round.${round}.tools`, {
          count: validated.length,
          names: validated.map((t) => t.function.name),
        });

        // Ensure UI parts exist before path-aware waves; persist callId for history wire
        for (let i = 0; i < validated.length; i++) {
          const tc = validated[i]!;
          const pid = toolPartIds.get(i) ?? newId("p");
          const args = parseToolArgs(tc.function.arguments);
          if (!toolPartIds.has(i)) {
            this.store.appendPart(mid, {
              id: pid,
              type: "tool",
              toolName: tc.function.name,
              args,
              callId: tc.id,
              status: "running",
              startedAt: Date.now(),
            });
            toolPartIds.set(i, pid);
          } else {
            this.store.toolStatus(mid, pid, "running");
            this.store.patchPart(mid, pid, {
              args,
              callId: tc.id,
            } as never);
          }
        }

        // Path-aware concurrent execution; multi-agent tools via SubagentRuntime
        const prepared = validated.map((tc, i) => ({
          id: tc.id || `i${i}`,
          name: tc.function.name,
          args: parseToolArgs(tc.function.arguments),
        }));
        const toolResults = await runInWaves(prepared, async (call) => {
          if (this.abort) {
            return {
              ok: false,
              output: "cancelled",
              durationMs: 0,
              name: call.name,
              args: call.args,
              fingerprint: toolFingerprint(call.name, call.args),
              cached: false,
            } satisfies RunCallResult;
          }
          if (isMultiAgentTool(call.name) && this.subRuntime) {
            const t0 = Date.now();
            this.store.setPhase(
              "tool",
              `${call.name} · multi-agent`,
            );
            const r = await this.subRuntime.dispatch(call.name, call.args);
            return {
              ok: r.ok,
              output: r.output,
              durationMs: Date.now() - t0,
              name: call.name,
              args: call.args,
              fingerprint: toolFingerprint(call.name, call.args),
              cached: false,
              data: r.data,
            } satisfies RunCallResult;
          }
          return this.runner.run(call.name, call.args);
        });

        for (let i = 0; i < toolResults.length; i++) {
          const exec = toolResults[i]!;
          const tc = validated[i]!;
          const pid = toolPartIds.get(i)!;
          dbg("agent", exec.cached ? "tool.cache_hit" : "tool.done", {
            id: tc.id,
            name: tc.function.name,
            ok: exec.ok,
            ms: exec.durationMs,
            cached: exec.cached,
            denied: exec.denied,
            invalid: exec.invalid,
            multi: isMultiAgentTool(tc.function.name),
            outLen: exec.output.length,
            preview: exec.output.slice(0, 160),
          });
          this.store.toolStatus(mid, pid, exec.ok ? "completed" : "error", {
            result: exec.ok ? exec.output : undefined,
            error: exec.ok ? undefined : exec.output,
          });
        }

        const allCached = toolResults.every((r) => r.cached);

        toolSpan.end({
          ok: toolResults.filter((t) => t.ok).length,
          fail: toolResults.filter((t) => !t.ok).length,
          cached: toolResults.filter((t) => t.cached).length,
          allCached,
        });

        for (let i = 0; i < toolResults.length; i++) {
          const exec = toolResults[i]!;
          const tc = validated[i]!;
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: exec.output,
          });
        }

        if (allCached) {
          cachedToolRounds++;
          dbg("agent", "tools.all_cached", {
            cachedToolRounds,
            max: MAX_CACHED_TOOL_ROUNDS,
          });
          if (cachedToolRounds >= MAX_CACHED_TOOL_ROUNDS) {
            // Nudge then force answer next round
            messages.push({
              role: "user",
              content:
                "You already have the tool results above (including cached repeats). Answer the user now briefly. Do not call tools again.",
            });
            forceFinalAnswer = true;
            dbg("agent", "force_final_answer", { round });
          }
        } else {
          cachedToolRounds = 0;
        }
      }

      this.store.setPhase("idle");
      turn.end({
        phase: "idle",
        rounds: round,
        toolCacheSize: toolCache.size,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dbg("agent", "error", { error: msg });
      this.store.setPhase("error", msg);
      const mid = this.store.startAssistant().id;
      this.store.appendPart(mid, {
        id: newId("p"),
        type: "status",
        level: "error",
        message: msg,
      });
      this.store.setPhase("idle");
      turn.end({ error: msg });
    } finally {
      this.subRuntime?.cancelAll();
      this.subRuntime = null;
      this.busy = false;
    }
  }
}

/** Merge base tools + multi-agent tools (parent only). */
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

/** Batch stream deltas to cut store/TUI event rate without dropping content. */
function createStreamBatcher(): {
  text: string;
  reasoning: string;
  pushText: (d: string, flush: () => void) => void;
  pushReasoning: (d: string, flush: () => void) => void;
  flush: () => void;
} {
  const INTERVAL = 24; // ms
  let text = "";
  let reasoning = "";
  let textTimer: ReturnType<typeof setTimeout> | null = null;
  let reasonTimer: ReturnType<typeof setTimeout> | null = null;
  let textFlush: (() => void) | null = null;
  let reasonFlush: (() => void) | null = null;

  const pushText = (d: string, flush: () => void) => {
    text += d;
    textFlush = flush;
    if (textTimer == null) {
      textTimer = setTimeout(() => {
        textTimer = null;
        flush();
      }, INTERVAL);
    }
  };
  const pushReasoning = (d: string, flush: () => void) => {
    reasoning += d;
    reasonFlush = flush;
    if (reasonTimer == null) {
      reasonTimer = setTimeout(() => {
        reasonTimer = null;
        flush();
      }, INTERVAL);
    }
  };
  const flushAll = () => {
    if (textTimer) {
      clearTimeout(textTimer);
      textTimer = null;
    }
    if (reasonTimer) {
      clearTimeout(reasonTimer);
      reasonTimer = null;
    }
    textFlush?.();
    reasonFlush?.();
  };

  return {
    get text() {
      return text;
    },
    set text(v: string) {
      text = v;
    },
    get reasoning() {
      return reasoning;
    },
    set reasoning(v: string) {
      reasoning = v;
    },
    pushText,
    pushReasoning,
    flush: flushAll,
  };
}

/** Fallback text if model refuses to answer after forced final */
function summarizeFromCache(cache: Map<string, string>): string {
  if (cache.size === 0) return "(no tool results)";
  const parts: string[] = ["Tool results:"];
  let i = 0;
  for (const [fp, out] of cache) {
    if (i++ >= 3) break;
    const name = fp.split(":")[0] ?? "tool";
    parts.push(`### ${name}\n${out.slice(0, 500)}`);
  }
  return parts.join("\n\n");
}

/**
 * Convert store messages to OpenAI chat messages.
 * Skips the empty assistant shell we just opened for this turn.
 * Reasoning parts are attached (codex/opencode: usable CoT context on wire).
 *
 * Tool turns use real tool_calls + tool-role results (not flattened notes),
 * matching OpenCode MessageV2 / Codex Responses item reconstruction so
 * multi-turn continuity keeps structured tool context.
 */
function historyToMessages(store: HarnessStore): ChatMessage[] {
  const out: ChatMessage[] = [];
  const msgs = store.state.messages.slice(-24);
  for (let mi = 0; mi < msgs.length; mi++) {
    const m = msgs[mi]!;
    // Skip trailing empty assistant (current in-progress turn)
    if (
      m.role === "assistant" &&
      m.parts.length === 0 &&
      mi === msgs.length - 1
    ) {
      continue;
    }
    if (m.role === "user") {
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.content : ""))
        .join("\n");
      if (text) out.push({ role: "user", content: text });
    } else if (m.role === "assistant") {
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.content : ""))
        .join("\n");
      const reasoning = m.parts
        .filter((p) => p.type === "reasoning")
        .map((p) => (p.type === "reasoning" ? p.content : ""))
        .filter(Boolean)
        .join("\n\n");
      const tools = m.parts.filter((p) => p.type === "tool");
      if (tools.length) {
        const toolCalls: ToolCall[] = tools
          .map((p, i) => {
            if (p.type !== "tool") return null;
            const id =
              p.callId && p.callId.length > 0
                ? p.callId
                : `hist_${m.id}_${i}`;
            return {
              id,
              type: "function" as const,
              function: {
                name: p.toolName,
                arguments: JSON.stringify(p.args ?? {}),
              },
            };
          })
          .filter((x): x is ToolCall => x != null);

        out.push(
          attachInTurnReasoning(
            {
              role: "assistant",
              content: text.trim() ? text : null,
              tool_calls: toolCalls,
            },
            reasoning,
          ),
        );

        for (let i = 0; i < tools.length; i++) {
          const p = tools[i]!;
          if (p.type !== "tool") continue;
          const tc = toolCalls[i]!;
          const body =
            p.status === "completed" && p.result != null
              ? String(p.result).slice(0, HISTORY_TOOL_SNIPPET)
              : p.status === "error" && p.error
                ? `ERROR: ${String(p.error).slice(0, HISTORY_TOOL_SNIPPET)}`
                : `[${p.status}]`;
          out.push({
            role: "tool",
            tool_call_id: tc.id,
            content: body,
          });
        }
      } else if (text || reasoning) {
        out.push(
          attachInTurnReasoning(
            { role: "assistant", content: text || null },
            reasoning,
          ),
        );
      }
    }
  }
  return out;
}

/** Exported for tests */
export function _testHistoryToMessages(store: HarnessStore): ChatMessage[] {
  return historyToMessages(store);
}

export {
  toolFingerprint,
  normalizeToolArgs,
  parseToolArgs,
} from "../toolcalling/normalize.js";
