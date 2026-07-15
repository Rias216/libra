/**
 * AgentLoop — thin façade over Codex/OpenCode-shaped runStoreTurn.
 * Public API stable for CLI / embeds.
 */

import type { HarnessStore } from "../core/store.js";
import { newId } from "../core/types.js";
import type { ProviderId } from "../auth/types.js";
import type {
  ChatMessage,
  ChatResult,
  ChatRequest,
  StreamHandlers,
} from "../llm/client.js";
import type { PermissionAskFn, PermissionRules } from "../toolcalling/permissions.js";
import type { ToolsetId } from "../toolcalling/registry.js";
import { dbg, span } from "./debug.js";
import { historyToMessages } from "./history.js";
import { buildSystemPrompt } from "./prompt.js";
import { runStoreTurn, type TurnOptions } from "./turn.js";

export { buildSystemPrompt } from "./prompt.js";
export {
  toolFingerprint,
  normalizeToolArgs,
  parseToolArgs,
} from "../toolcalling/normalize.js";
export { historyToMessages };

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
   * After fusion phase-1, skip heavy native reasoning on execute.
   * Default true when seedReasoning set.
   */
  lightReasoning?: boolean;
  /** Force tool_choice (e.g. required for smoke tests) */
  toolChoice?: "auto" | "none" | "required";
  /** Debug label prefix */
  label?: string;
  permissions?: PermissionRules;
  onPermission?: PermissionAskFn;
  autoApprove?: boolean;
  toolsets?: ToolsetId[];
  /**
   * Multi-agent (Codex v1). Default: follow settings.subagents.enabled.
   */
  subagents?: boolean;
  /** Override parent max sampling steps (default MAX_STEPS). */
  maxSteps?: number;
  /** full | slim system prompt pack. */
  promptProfile?: "full" | "slim";
  /** Short tool descriptions to save tokens. */
  slimTools?: boolean;
  /**
   * Test injection: replace chatComplete.
   */
  chatImpl?: (
    req: ChatRequest,
    handlers?: StreamHandlers,
  ) => Promise<ChatResult>;
}

export class AgentLoop {
  private busy = false;
  private abort = false;

  constructor(private store: HarnessStore) {}

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

    const label = opts.label ?? "agent";
    const turn = span("agent", `${label}.handle`, {
      model: `${opts.provider}/${opts.model}`,
      promptLen: userText.length,
      tools: opts.tools !== false,
      seeded: Boolean(opts.seedReasoning?.trim()),
    });

    try {
      this.store.appendUser(userText);
      const assistant = this.store.startAssistant();
      const mid = assistant.id;

      if (opts.seedReasoning?.trim()) {
        this.store.appendPart(mid, {
          id: newId("p"),
          type: "reasoning",
          content: opts.seedReasoning.trim(),
          streaming: false,
          collapsed: true, // OpenCode: folded until user expands
        });
        dbg("agent", "seed_reasoning", {
          chars: opts.seedReasoning.trim().length,
        });
      }

      const turnOpts: TurnOptions = {
        provider: opts.provider,
        model: opts.model,
        cwd: opts.cwd,
        systemPrompt: opts.systemPrompt,
        tools: opts.tools,
        abortSignal: opts.abortSignal,
        seedReasoning: opts.seedReasoning,
        lightReasoning: opts.lightReasoning,
        toolChoice: opts.toolChoice,
        label,
        permissions: opts.permissions,
        onPermission: opts.onPermission,
        autoApprove: opts.autoApprove,
        toolsets: opts.toolsets,
        subagents: opts.subagents,
        maxSteps: opts.maxSteps,
        promptProfile: opts.promptProfile,
        slimTools: opts.slimTools,
        chatImpl: opts.chatImpl,
      };

      const result = await runStoreTurn(
        {
          store: this.store,
          messageId: mid,
          abort: () => this.abort || opts.abortSignal?.aborted === true,
        },
        turnOpts,
      );

      this.store.setPhase("idle");
      turn.end({
        phase: "idle",
        rounds: result.rounds,
        tools: result.toolsUsed.length,
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
      this.busy = false;
    }
  }
}

/** Exported for tests */
export function _testHistoryToMessages(store: HarnessStore): ChatMessage[] {
  return historyToMessages(store);
}
