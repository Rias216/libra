/**
 * Headless child agent loop — shared runHeadlessTurn (Codex/OpenCode shape).
 * Isolated context, no parent store pollution.
 * Optional peer multi-agent tools (list/message/wait) for Codex v2.
 */

import type { ProviderId } from "../../auth/types.js";
import type { ChatMessage } from "../../llm/client.js";
import type {
  PermissionAskFn,
  PermissionRules,
} from "../../toolcalling/permissions.js";
import type { ToolsetId } from "../../toolcalling/registry.js";
import type { OpenAITool } from "../../toolcalling/schema.js";
import { runHeadlessTurn, type TurnOptions } from "../turn.js";
import type { ChildRunResult } from "./types.js";

const MAX_CHILD_ROUNDS = 8;

export interface ChildPeerHooks {
  /** Extra multi-agent peer tools (list/message/wait) */
  tools: OpenAITool[];
  isCustomTool: (name: string) => boolean;
  customDispatch: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; output: string }>;
}

export interface ChildLoopOptions {
  provider: ProviderId;
  model: string;
  cwd: string;
  system: string;
  /** Full history including the new user task as last user message */
  messages: ChatMessage[];
  toolsets: ToolsetId[];
  permissions: PermissionRules;
  signal?: AbortSignal;
  label?: string;
  maxRounds?: number;
  lightReasoning?: boolean;
  /** Applied to child chat as reasoning_effort (spawn/role override) */
  reasoningEffort?: string;
  /** Injected chat for tests */
  chatImpl?: TurnOptions["chatImpl"];
  /** Codex v2 peer messaging hooks */
  peer?: ChildPeerHooks;
  /**
   * Parent permission-ask hook. When set with interactivePermissions,
   * "ask" rules surface through this hook instead of auto-approving.
   */
  onPermission?: PermissionAskFn;
  /**
   * When true (default if no interactive path), "ask" rules become allow
   * without prompting — static allow/deny only. Set false when a parent
   * ask hook should handle execute/all children.
   */
  autoApprove?: boolean;
}

export async function runChildLoop(
  opts: ChildLoopOptions,
): Promise<ChildRunResult> {
  const messages: ChatMessage[] = [...opts.messages];
  // Ensure system is first
  if (!messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: opts.system });
  } else {
    const idx = messages.findIndex((m) => m.role === "system");
    if (idx >= 0) messages[idx] = { role: "system", content: opts.system };
  }

  // Default: non-interactive static allow/deny (autoApprove converts ask→allow).
  // Interactive only when caller opts in with a hook + autoApprove false.
  const autoApprove = opts.autoApprove ?? true;

  const result = await runHeadlessTurn({
    provider: opts.provider,
    model: opts.model,
    cwd: opts.cwd,
    tools: true,
    toolsets: opts.toolsets,
    permissions: opts.permissions,
    autoApprove,
    onPermission: autoApprove ? undefined : opts.onPermission,
    abortSignal: opts.signal,
    label: opts.label ?? "subagent",
    maxSteps: opts.maxRounds ?? MAX_CHILD_ROUNDS,
    lightReasoning: opts.lightReasoning,
    reasoningEffort: opts.reasoningEffort,
    chatImpl: opts.chatImpl,
    headless: true,
    headlessMessages: messages,
    extraTools: opts.peer?.tools,
    isCustomTool: opts.peer?.isCustomTool,
    customDispatch: opts.peer
      ? async (call) => {
          const r = await opts.peer!.customDispatch(call.name, call.args);
          return {
            ok: r.ok,
            output: r.output,
          };
        }
      : undefined,
  });

  return {
    text: result.finalText,
    rounds: result.rounds,
    toolsUsed: result.toolsUsed,
    error: result.error,
    usage: {
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
    },
  };
}
