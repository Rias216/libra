/**
 * Fast agent loop: LLM stream → tool calls → results → repeat.
 * OpenAI-compatible (OpenRouter, xAI, OpenAI, …).
 */

import type { HarnessStore } from "../core/store.js";
import { newId } from "../core/types.js";
import type { ProviderId } from "../auth/types.js";
import { loadAgentSettings } from "./config.js";
import {
  chatComplete,
  type ChatMessage,
  type ToolCall,
} from "../llm/client.js";
import { OPENAI_TOOLS } from "../toolcalling/schema.js";
import { ToolExecutor } from "../toolcalling/executor.js";
import { resolveEffortForModel } from "./reasoning.js";

const MAX_ROUNDS = 12;

export interface AgentLoopOptions {
  provider: ProviderId;
  model: string;
  cwd?: string;
  systemPrompt?: string;
  /** Disable tools for pure chat */
  tools?: boolean;
  abortSignal?: AbortSignal;
}

export class AgentLoop {
  private busy = false;
  private abort = false;
  private executor: ToolExecutor;

  constructor(private store: HarnessStore) {
    this.executor = new ToolExecutor(process.cwd());
  }

  cancel(): void {
    this.abort = true;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async handle(userText: string, opts: AgentLoopOptions): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.abort = false;
    this.executor = new ToolExecutor(opts.cwd ?? process.cwd());

    try {
      this.store.appendUser(userText);
      const assistant = this.store.startAssistant();
      const mid = assistant.id;
      const settings = loadAgentSettings();

      const system =
        opts.systemPrompt ??
        buildSystemPrompt(settings.reasoning.customInstructions);

      const messages: ChatMessage[] = [
        { role: "system", content: system },
        ...historyToMessages(this.store),
      ];

      let round = 0;
      while (round < MAX_ROUNDS) {
        if (this.abort) break;
        round++;
        const { effort, caps, clamped } = resolveEffortForModel(
          opts.provider,
          opts.model,
        );
        const effortLabel = effort
          ? `${effort}${clamped ? " (clamped)" : ""}`
          : "default";
        this.store.setPhase(
          round === 1 ? "streaming" : "tool",
          round === 1
            ? `streaming · reasoning=${effortLabel}`
            : `tool round ${round}`,
        );

        const textPartId = newId("p");
        let textStarted = false;
        const reasoningPartId = newId("p");
        let reasoningStarted = false;

        // Track tool call parts as they stream in
        const toolPartIds = new Map<number, string>();

        // Native API reasoning only — never "please think step by step"
        const result = await chatComplete(
          {
            provider: opts.provider,
            model: opts.model,
            messages,
            tools: opts.tools === false ? undefined : OPENAI_TOOLS,
            tool_choice: opts.tools === false ? "none" : "auto",
            temperature: 0.2,
            stream: true,
            applyNativeReasoning: true,
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
              this.store.textDelta(mid, textPartId, d);
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
              this.store.reasoningDelta(mid, reasoningPartId, d);
            },
            onToolCallDelta: (index, partial) => {
              if (!toolPartIds.has(index) && partial.function?.name) {
                const pid = newId("p");
                toolPartIds.set(index, pid);
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(partial.function.arguments || "{}");
                } catch {
                  args = { _raw: partial.function.arguments };
                }
                this.store.appendPart(mid, {
                  id: pid,
                  type: "tool",
                  toolName: partial.function.name,
                  args,
                  status: "pending",
                });
              }
            },
          },
        );

        if (textStarted) {
          this.store.patchPart(mid, textPartId, { streaming: false } as never);
        }
        if (reasoningStarted) {
          this.store.patchPart(mid, reasoningPartId, {
            streaming: false,
          } as never);
        }

        if (result.usage) {
          this.store.addTokens(
            result.usage.prompt_tokens ?? 0,
            result.usage.completion_tokens ?? 0,
          );
        }

        // No tools → done
        if (!result.tool_calls.length) {
          // Ensure some text if model only reasoned
          if (!textStarted && result.content) {
            this.store.appendPart(mid, {
              id: newId("p"),
              type: "text",
              content: result.content,
            });
          }
          break;
        }

        // Execute tools in parallel for speed
        this.store.setPhase("tool", `running ${result.tool_calls.length} tool(s)`);
        messages.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.tool_calls,
        });

        const toolResults = await Promise.all(
          result.tool_calls.map(async (tc, i) => {
            if (this.abort) {
              return { tc, output: "cancelled", ok: false };
            }
            const pid = toolPartIds.get(i) ?? newId("p");
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || "{}");
            } catch {
              args = { _raw: tc.function.arguments };
            }

            // Ensure tool part exists
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

            const exec = await this.executor.run(tc.function.name, args);
            this.store.toolStatus(mid, pid, exec.ok ? "completed" : "error", {
              result: exec.ok ? exec.output : undefined,
              error: exec.ok ? undefined : exec.output,
            });
            return { tc, output: exec.output, ok: exec.ok };
          }),
        );

        for (const { tc, output } of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: output,
          });
        }

        if (result.finish_reason === "stop" && !result.tool_calls.length) {
          break;
        }
      }

      this.store.setPhase("idle");
    } catch (err) {
      this.store.setPhase(
        "error",
        err instanceof Error ? err.message : String(err),
      );
      const mid = this.store.startAssistant().id;
      this.store.appendPart(mid, {
        id: newId("p"),
        type: "status",
        level: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      this.store.setPhase("idle");
    } finally {
      this.busy = false;
    }
  }
}

export function buildSystemPrompt(extra?: string): string {
  const base = `You are Libra, a fast coding agent in the terminal.
Use tools to read/search/edit the workspace. Prefer list_dir/grep/read_file before editing.
Be concise. When done, summarize what you did.
Current OS: ${process.platform}. Workspace tools are available.`;
  return extra?.trim() ? `${base}\n\n${extra.trim()}` : base;
}

/** Convert store messages to OpenAI chat messages (skip system noise). */
function historyToMessages(store: HarnessStore): ChatMessage[] {
  const out: ChatMessage[] = [];
  // Only last N turns for context speed
  const msgs = store.state.messages.slice(-24);
  for (const m of msgs) {
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
      // Represent completed tools as brief notes in content for continuity
      const tools = m.parts
        .filter((p) => p.type === "tool")
        .map((p) => {
          if (p.type !== "tool") return "";
          return `[tool ${p.toolName} → ${p.status}]`;
        })
        .filter(Boolean);
      const content = [text, ...tools].filter(Boolean).join("\n");
      if (content) out.push({ role: "assistant", content });
    }
  }
  // Drop the trailing user we just added via appendUser — last user is in messages
  // Actually appendUser already added; history includes it. Good.
  // Remove incomplete last assistant if empty
  return out;
}
