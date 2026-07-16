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
import type { SubagentRuntime } from "./subagent/runtime.js";

export { buildSystemPrompt } from "./prompt.js";
export {
  toolFingerprint,
  normalizeToolArgs,
  parseToolArgs,
} from "../toolcalling/normalize.js";
export { historyToMessages };

/** One pre-seeded Thought block (Ultra+Fusion dual traces). */
export interface SeedReasoningPart {
  content: string;
  /** Label after "Thought ·" (e.g. "Main · opencode/…") */
  title?: string;
  /** Default false so dual fusion traces stay visible */
  collapsed?: boolean;
}

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
   * Multiple Thought parts (preferred for Ultra+Fusion Main + Peer).
   * When set, overrides single seedReasoning for UI seeding.
   */
  seedReasoningParts?: SeedReasoningPart[];
  /**
   * After fusion phase-1, skip heavy native reasoning on execute.
   * Default true when seedReasoning set.
   */
  lightReasoning?: boolean;
  /**
   * When set, skip appendUser / startAssistant — caller already created
   * the user + assistant messages (e.g. fusion streamed phase-1 into them).
   */
  existingAssistantId?: string;
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
  /**
   * Active goal orchestrator — registers update_goal tool dispatch and
   * injects goal rules into the system prompt when present and active.
   */
  goalOrchestrator?: import("./goal/orchestrator.js").GoalOrchestrator | null;
  /**
   * Extra absolute roots for file tools (goal plan/scratch). Merged with
   * goalOrchestrator.toolAllowedRoots() inside the turn runner.
   */
  allowedRoots?: string[];
}

export class AgentLoop {
  private busy = false;
  private abort = false;
  /**
   * Session-scoped multi-agent runtime — survives across handle() turns so
   * children can run in the background and resume_from works next message.
   */
  private subRuntime: SubagentRuntime | null = null;

  constructor(private store: HarnessStore) {}

  cancel(): void {
    this.abort = true;
    // Interrupt in-flight children for the active turn only
    this.subRuntime?.cancelTurn();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Session-hoisted multi-agent runtime (null until first multi-agent turn). */
  get subagentRuntime(): SubagentRuntime | null {
    return this.subRuntime;
  }

  /** Drop session runtime (tests / hard reset). Cancels open children. */
  resetSubagentRuntime(): void {
    this.subRuntime?.cancelAll();
    this.subRuntime = null;
  }

  async handle(userText: string, opts: AgentLoopOptions): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.abort = false;

    const label = opts.label ?? "agent";
    const multiSeed = (opts.seedReasoningParts ?? []).filter((p) =>
      p.content?.trim(),
    );
    const singleSeed = opts.seedReasoning?.trim() ?? "";
    const seeded =
      multiSeed.length > 0 || Boolean(singleSeed);
    const turn = span("agent", `${label}.handle`, {
      model: `${opts.provider}/${opts.model}`,
      promptLen: userText.length,
      tools: opts.tools !== false,
      seeded,
      seedParts: multiSeed.length,
    });

    try {
      let mid = opts.existingAssistantId;
      if (!mid) {
        this.store.appendUser(userText);
        mid = this.store.startAssistant().id;
      }

      // Only append seed Thought parts when we own the assistant shell.
      // Fusion live-streams Main/Peer into an existing message first.
      if (!opts.existingAssistantId) {
        if (multiSeed.length > 0) {
          for (const part of multiSeed) {
            this.store.appendPart(mid, {
              id: newId("p"),
              type: "reasoning",
              content: part.content.trim(),
              streaming: false,
              // Collapsed by default — click or leave collapsed for a quiet TUI
              collapsed: part.collapsed ?? true,
              title: part.title,
            });
          }
          dbg("agent", "seed_reasoning_parts", {
            count: multiSeed.length,
            chars: multiSeed.reduce((n, p) => n + p.content.length, 0),
          });
        } else if (singleSeed) {
          this.store.appendPart(mid, {
            id: newId("p"),
            type: "reasoning",
            content: singleSeed,
            streaming: false,
            collapsed: true,
          });
          dbg("agent", "seed_reasoning", {
            chars: singleSeed.length,
          });
        }
      }

      // Inject goal rules when an active goal is bound to this turn
      let systemPrompt = opts.systemPrompt;
      const goalOrch = opts.goalOrchestrator;
      if (goalOrch?.isActive()) {
        const addon = goalOrch.buildGoalSystemAddon();
        if (addon.trim()) {
          if (!opts.systemPrompt) {
            const { buildSystemPrompt } = await import("./prompt.js");
            systemPrompt =
              buildSystemPrompt({
                model: opts.model,
                provider: opts.provider,
                cwd: opts.cwd,
                profile: opts.promptProfile,
              }) +
              "\n\n" +
              addon;
          } else {
            systemPrompt = opts.systemPrompt + "\n\n" + addon;
          }
        }
      }

      const turnOpts: TurnOptions = {
        provider: opts.provider,
        model: opts.model,
        cwd: opts.cwd,
        systemPrompt,
        tools: opts.tools,
        abortSignal: opts.abortSignal,
        seedReasoning:
          multiSeed.length > 0
            ? multiSeed.map((p) => p.content).join("\n\n")
            : opts.seedReasoning,
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
        // Hoist SubagentRuntime across turns (review2 #1)
        subagentRuntime: this.subRuntime,
        adoptSubagentRuntime: (rt) => {
          this.subRuntime = rt;
        },
        goalOrchestrator: goalOrch ?? null,
        allowedRoots: opts.allowedRoots,
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
