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
  type ChatMessage,
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

const MAX_ROUNDS = 12;
/** After this many fully-cached tool rounds, stop tools and demand text */
const MAX_CACHED_TOOL_ROUNDS = 1;

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

      const light =
        opts.lightReasoning ?? Boolean(opts.seedReasoning?.trim());
      const isFree =
        /:free$/i.test(opts.model) || /\/free$/i.test(opts.model);

      let cachedToolRounds = 0;
      /** After duplicate-only tool round, force tool_choice=none once */
      let forceFinalAnswer = false;

      /** Coalesce high-frequency token events before hitting the store/TUI */
      const streamBatch = createStreamBatcher();
      let round = 0;
      while (round < MAX_ROUNDS) {
        if (this.abort) {
          dbg("agent", "aborted", { round });
          break;
        }
        round++;

        const appliedEffort =
          light || isFree
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

        this.store.setPhase(
          round === 1 ? "streaming" : "tool",
          forceFinalAnswer
            ? `finalizing · round ${round}`
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
          cacheSize: toolCache.size,
        });

        const textPartId = newId("p");
        let textStarted = false;
        const reasoningPartId = newId("p");
        let reasoningStarted = false;
        const toolPartIds = new Map<number, string>();

        const roundSpan = span("agent", `round.${round}`, {
          model: opts.model,
        });

        const toolsEnabled = opts.tools !== false && !forceFinalAnswer;
        const toolSchemas = toolsEnabled
          ? mergeToolSchemas(
              this.runner.registry.schemas(),
              this.subRuntime?.schemas() ?? [],
            )
          : undefined;
        const result = await chatComplete(
          {
            provider: opts.provider,
            model: opts.model,
            messages,
            tools: toolSchemas,
            tool_choice: !toolsEnabled
              ? "none"
              : (opts.toolChoice ?? "auto"),
            temperature: 0.2,
            stream: true,
            applyNativeReasoning: !(light || isFree),
            reasoning_effort: light || isFree ? "low" : undefined,
            max_tokens: isFree ? 1536 : 4096,
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
                  status: "pending",
                });
                dbg("agent", "tool.pending", {
                  index,
                  name: partial.function.name,
                });
              }
            },
            onFirstToken: (kind, ms) => {
              dbg("agent", `round.${round}.ttft`, { kind, ms });
            },
          },
        );

        // Flush any coalesced stream text before reconciling with result
        streamBatch.flush();

        // Client partitions think-tags / reasoning echoes out of content.
        // Overwrite store parts so escaped CoT never remains as the answer.
        if (textStarted) {
          this.store.patchPart(mid, textPartId, {
            content: result.content,
            streaming: false,
          } as never);
        } else if (result.content) {
          this.store.appendPart(mid, {
            id: textPartId,
            type: "text",
            content: result.content,
          });
          textStarted = true;
        }
        if (reasoningStarted) {
          this.store.patchPart(mid, reasoningPartId, {
            content: result.reasoning ?? "",
            streaming: false,
          } as never);
        } else if (result.reasoning?.trim()) {
          this.store.appendPart(mid, {
            id: reasoningPartId,
            type: "reasoning",
            content: result.reasoning,
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
          usage: result.usage,
        });

        // Forced final (or natural stop)
        if (!result.tool_calls.length || forceFinalAnswer) {
          if (!textStarted && result.content) {
            this.store.appendPart(mid, {
              id: newId("p"),
              type: "text",
              content: result.content,
            });
          }
          if (
            !textStarted &&
            !result.content &&
            result.reasoning &&
            !result.tool_calls.length
          ) {
            this.store.appendPart(mid, {
              id: newId("p"),
              type: "text",
              content: "(model produced reasoning only — no final answer)",
            });
          }
          // If we forced final but model still emitted tools, drop them
          if (forceFinalAnswer && result.tool_calls.length && !result.content) {
            this.store.appendPart(mid, {
              id: newId("p"),
              type: "text",
              content: summarizeFromCache(toolCache),
            });
          }
          dbg("agent", `round.${round}.stop`, {
            reason: forceFinalAnswer ? "force_final" : result.finish_reason,
          });
          break;
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

        // Ensure UI parts exist before path-aware waves
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
              status: "running",
              startedAt: Date.now(),
            });
            toolPartIds.set(i, pid);
          } else {
            this.store.toolStatus(mid, pid, "running");
            this.store.patchPart(mid, pid, { args } as never);
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
        const notes = tools
          .map((p) => {
            if (p.type !== "tool") return "";
            const snippet =
              p.status === "completed" && p.result
                ? String(p.result).slice(0, 400)
                : p.status;
            return `[${p.toolName} → ${snippet}]`;
          })
          .filter(Boolean);
        const content = [text, ...notes].filter(Boolean).join("\n");
        if (content || reasoning) {
          out.push(
            attachInTurnReasoning(
              { role: "assistant", content: content || null },
              reasoning,
            ),
          );
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
