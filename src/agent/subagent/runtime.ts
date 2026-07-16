/**
 * Codex multi-agent runtime: spawn / wait / send_input / message_agent / close / list.
 *
 * Parent orchestrates; children run headless with isolated tool contexts.
 * max_depth=1 by default; Ultra raises to 2. Peer messaging (v2) lets
 * children list/message/wait siblings without full spawn rights.
 */

import type { ProviderId } from "../../auth/types.js";
import { parseModelKey } from "../../auth/models.js";
import type { SubagentConfig } from "../config.js";
import { dbg, span } from "../debug.js";
import type { ChatMessage } from "../../llm/client.js";
import { runChildLoop } from "./child-loop.js";
import {
  applyCapabilityMode,
  listSpawnableRoles,
  normalizeCapabilityMode,
  resolveRole,
  type ResolvedRole,
} from "./roles.js";
import {
  buildMultiAgentTools,
  buildPeerChildSystemAddon,
  buildPeerTools,
  formatPeerUserMessage,
  isMultiAgentTool,
  isPeerTool,
  type MultiAgentToolName,
} from "./tools.js";
import {
  canonicalParentAgentId,
  formatCompletionNotices,
  formatParentMailboxNotices,
  formatResumeFooter,
  isParentAgentId,
  type AgentThread,
  type AgentThreadStatus,
  type CapabilityMode,
  extractHandoffSummary,
  type CloseAgentArgs,
  type GetAgentResultArgs,
  type ListAgentsArgs,
  type MessageAgentArgs,
  type ParentInboxEntry,
  type SendInputArgs,
  type SpawnAgentArgs,
  type SpawnAgentsBatchArgs,
  type WaitAgentArgs,
} from "./types.js";
import type { OpenAITool } from "../../toolcalling/schema.js";
import type { PermissionAskFn } from "../../toolcalling/permissions.js";
import {
  TOOL_OUTPUT_CHILD_MAX,
  truncateToolOutput,
} from "../../toolcalling/truncate.js";
import type { TurnOptions } from "../turn.js";
import {
  createAgentWorktree,
  shouldIsolateWorktree,
  type RunGitFn,
} from "./worktree.js";

export interface SubagentRuntimeOptions {
  parentProvider: ProviderId;
  parentModel: string;
  cwd: string;
  /** Nesting depth of this runtime (0 = root parent) */
  depth: number;
  config: SubagentConfig;
  /** Short parent-context summary for fork_context spawns */
  parentContextSummary?: string;
  signal?: AbortSignal;
  /** Prefer this model when role has no modelKey */
  preferredModelKey?: string;
  /** Injected chat for child loops (tests) */
  chatImpl?: TurnOptions["chatImpl"];
  /**
   * Parent permission-ask hook. When set, execute/all children surface
   * "ask" rules through this hook instead of auto-approving.
   * Without a hook, children stay non-interactive (static allow/deny).
   */
  onPermission?: PermissionAskFn;
  /** Injectable git runner for worktree isolation (tests). */
  runGit?: RunGitFn;
  /** Override parent dir for created worktrees (tests). */
  worktreeParent?: string;
  /**
   * Max terminal (completed/failed/cancelled/closed) threads retained for
   * resume_from / get_agent_result. Oldest beyond this are pruned.
   */
  maxRetainedTerminal?: number;
}

/** Partial rebind when a session-scoped runtime is reused on a new parent turn. */
export type SubagentRuntimeRebind = Partial<
  Pick<
    SubagentRuntimeOptions,
    | "parentProvider"
    | "parentModel"
    | "cwd"
    | "config"
    | "parentContextSummary"
    | "signal"
    | "preferredModelKey"
    | "chatImpl"
    | "onPermission"
    | "runGit"
    | "worktreeParent"
  >
>;

let agentSeq = 0;
function nextAgentId(): string {
  agentSeq += 1;
  return `agent_${Date.now().toString(36)}_${agentSeq}`;
}

/** Transient errors worth a single automatic retry. */
export function isTransientChildError(err: string | undefined): boolean {
  if (!err) return false;
  return /rate.?limit|429|503|502|504|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|fetch failed|socket|temporar|overloaded|unavailable|timeout/i.test(
    err,
  );
}

/** Avoid TS control-flow narrowing issues after awaits. */
function isThreadClosed(t: AgentThread): boolean {
  return t.status === "closed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse batch items from array, csv_text, or comma/newline string. */
export function parseBatchItems(args: SpawnAgentsBatchArgs): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t) out.push(t);
  };
  if (Array.isArray(args.items)) {
    for (const it of args.items) push(String(it ?? ""));
  } else if (typeof args.items === "string" && args.items.trim()) {
    splitCsvOrLines(args.items).forEach(push);
  }
  if (typeof args.csv_text === "string" && args.csv_text.trim()) {
    splitCsvOrLines(args.csv_text).forEach(push);
  }
  // Dedupe while preserving order (exactly-once assignment intent)
  const seen = new Set<string>();
  return out.filter((x) => {
    if (seen.has(x)) return false;
    seen.add(x);
    return true;
  });
}

function splitCsvOrLines(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  if (raw.includes("\n")) {
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  // Single line: split on commas unless it's a path-like single token
  if (raw.includes(",")) {
    return raw.split(",").map((c) => c.trim()).filter(Boolean);
  }
  return [raw];
}

const TERMINAL: ReadonlySet<AgentThreadStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Best-effort partial progress text while a child is still running.
 * Prefers structured handoff, then any result draft, then last assistant turn.
 */
export function partialProgressText(t: {
  result?: string;
  handoffSummary?: string;
  error?: string;
  history?: Array<{ role: string; content: string }>;
  rounds?: number;
  toolsUsed?: string[];
  status?: string;
}): string {
  if (t.handoffSummary?.trim()) return t.handoffSummary.trim();
  if (t.result?.trim()) return t.result.trim();
  if (t.error?.trim()) return t.error.trim();
  const hist = t.history ?? [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i]!;
    if (h.role === "assistant" && h.content?.trim()) {
      return h.content.trim().slice(0, 2_000);
    }
  }
  const tools = (t.toolsUsed ?? []).join(", ") || "none";
  return `[in progress] status=${t.status ?? "running"} rounds=${t.rounds ?? 0} tools=${tools}`;
}

export class SubagentRuntime {
  private threads = new Map<string, AgentThread>();
  private aborts = new Map<string, AbortController>();
  private roles: ResolvedRole[];
  private maxThreads: number;
  private maxDepth: number;
  private jobTimeoutMs: number;
  private maxRetainedTerminal: number;
  /** Current parent turn id — spawns tag with this; cancelTurn filters by it */
  private activeTurnId: string = "turn_0";
  /** Agent ids already reported via drainCompletionNotices */
  private notifiedCompletions = new Set<string>();
  /**
   * Root/parent mailbox (Codex multi-agent v2): children message agent_id
   * "parent" | "root". Drained mid-turn into the parent wire transcript.
   */
  private parentInbox: ParentInboxEntry[] = [];

  constructor(private opts: SubagentRuntimeOptions) {
    this.roles = listSpawnableRoles(opts.config.roles);
    this.maxThreads = Math.max(1, opts.config.maxConcurrent || 6);
    this.maxDepth = Math.max(0, opts.config.maxDepth ?? 1);
    this.jobTimeoutMs =
      (opts.config.jobMaxRuntimeSeconds ?? 600) * 1000;
    this.maxRetainedTerminal = Math.max(
      4,
      opts.maxRetainedTerminal ?? 24,
    );
  }

  /**
   * Update turn-scoped options when this runtime is session-hoisted and
   * reused across parent messages (model, signal, chatImpl, ask hook, …).
   */
  rebind(partial: SubagentRuntimeRebind): void {
    this.opts = { ...this.opts, ...partial };
    if (partial.config) {
      this.roles = listSpawnableRoles(partial.config.roles);
      this.maxThreads = Math.max(1, partial.config.maxConcurrent || 6);
      this.maxDepth = Math.max(0, partial.config.maxDepth ?? 1);
      this.jobTimeoutMs =
        (partial.config.jobMaxRuntimeSeconds ?? 600) * 1000;
    }
  }

  /** Snapshot of current options (tests / diagnostics). */
  getOptions(): Readonly<SubagentRuntimeOptions> {
    return this.opts;
  }

  /** OpenAI tools for the parent (empty if depth exhausted). */
  schemas(): OpenAITool[] {
    if (this.opts.depth >= this.maxDepth) return [];
    if (!this.opts.config.enabled) return [];
    return buildMultiAgentTools(this.roles);
  }

  get canSpawn(): boolean {
    return (
      this.opts.config.enabled && this.opts.depth < this.maxDepth
    );
  }

  listRoles(): ResolvedRole[] {
    return this.roles;
  }

  /** Start a new parent turn scope (for turn-scoped cancel). */
  beginTurn(turnId?: string): string {
    this.activeTurnId = turnId?.trim() || `turn_${Date.now().toString(36)}`;
    return this.activeTurnId;
  }

  getTurnId(): string {
    return this.activeTurnId;
  }

  /** Dispatch multi-agent tool → structured result for the model. */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
    fromAgentId?: string,
  ): Promise<{ ok: boolean; output: string; data?: Record<string, unknown> }> {
    if (!isMultiAgentTool(name)) {
      return {
        ok: false,
        output: `unknown multi-agent tool: ${name}`,
      };
    }
    try {
      const data = await this.dispatchInner(name, args, fromAgentId);
      return {
        ok: data.ok !== false,
        output: JSON.stringify(data, null, 0),
        data,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        output: JSON.stringify({ ok: false, error: msg }),
        data: { ok: false, error: msg },
      };
    }
  }

  private async dispatchInner(
    name: MultiAgentToolName,
    args: Record<string, unknown>,
    fromAgentId?: string,
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case "spawn_agent":
        return this.spawn(args as unknown as SpawnAgentArgs, fromAgentId);
      case "spawn_agents_batch":
        return this.spawnBatch(
          args as unknown as SpawnAgentsBatchArgs,
          fromAgentId,
        );
      case "wait_agent":
        return this.wait(args as unknown as WaitAgentArgs);
      case "send_input":
        return this.sendInput(args as unknown as SendInputArgs);
      case "message_agent":
        return this.messageAgent(
          args as unknown as MessageAgentArgs,
          fromAgentId ?? "parent",
        );
      case "close_agent":
        return this.close(args as unknown as CloseAgentArgs);
      case "list_agents":
        return this.list(args as unknown as ListAgentsArgs);
      case "get_agent_result":
        return this.getAgentResult(args as unknown as GetAgentResultArgs);
      default:
        return { ok: false, error: `unhandled: ${name}` };
    }
  }

  /**
   * Nesting depth of the agent that is calling spawn.
   * Root/parent uses runtime.opts.depth (0 for the session root).
   * A live child uses its thread.depth so maxDepth is enforced per hop.
   */
  private resolveCallerDepth(fromAgentId?: string): {
    ok: true;
    depth: number;
    from: string;
  } | { ok: false; error: string; code: string } {
    if (!fromAgentId || isParentAgentId(fromAgentId)) {
      return { ok: true, depth: this.opts.depth, from: "parent" };
    }
    const t = this.threads.get(fromAgentId);
    if (!t || t.status === "closed") {
      return {
        ok: false,
        error: `spawn denied: unknown or closed caller agent_id: ${fromAgentId}`,
        code: "unknown_caller",
      };
    }
    return { ok: true, depth: t.depth, from: fromAgentId };
  }

  /**
   * Peer/parent → agent messaging (Codex multi-agent v2).
   * Any live agent (root or child) can address any other live agent —
   * child↔child, child→root ("parent"/"root"), and root→child.
   * Queues while running; auto-resumes when idle/completed.
   */
  async messageAgent(
    args: MessageAgentArgs,
    fromId = "parent",
  ): Promise<Record<string, unknown>> {
    const id = String(args.agent_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!id || !message) {
      return { ok: false, error: "agent_id and message required" };
    }
    if (id === fromId || (isParentAgentId(id) && isParentAgentId(fromId))) {
      return { ok: false, error: "cannot message self" };
    }

    // Child → root / parent mailbox (first-class address, not a child thread)
    if (isParentAgentId(id)) {
      if (isParentAgentId(fromId)) {
        return { ok: false, error: "cannot message self" };
      }
      const target = canonicalParentAgentId(id);
      const entry: ParentInboxEntry = {
        from: fromId,
        message,
        at: Date.now(),
      };
      this.parentInbox.push(entry);
      dbg("subagent", "parent.inbox.push", {
        from: fromId,
        to: target,
        depth: this.parentInbox.length,
        chars: message.length,
      });
      return {
        ok: true,
        agent_id: target,
        to: target,
        from: fromId,
        queued: true,
        inbox_depth: this.parentInbox.length,
        delivered_to: "parent_mailbox",
        hint:
          "Message accepted into the parent/root mailbox (sender preserved). Parent will see it on the next mid-turn drain or wait.",
      };
    }

    const t = this.threads.get(id);
    if (!t || t.status === "closed") {
      return { ok: false, error: `unknown or closed agent: ${id}` };
    }

    const entry = { from: fromId, message, at: Date.now() };
    t.inbox = t.inbox ?? [];
    t.inbox.push(entry);

    if (t.status === "running" || t.status === "queued") {
      return {
        ok: true,
        agent_id: id,
        from: fromId,
        queued: true,
        inbox_depth: t.inbox.length,
        hint: "Message queued — delivered when the agent becomes idle (auto-resume).",
      };
    }

    // Idle/completed/failed/cancelled: deliver via resume
    const delivered = this.drainInbox(t);
    return this.sendInput({
      agent_id: id,
      message: delivered || formatPeerUserMessage(fromId, message),
    });
  }

  /** Drain inbox into a single user message (FIFO). */
  private drainInbox(t: AgentThread): string {
    const items = t.inbox ?? [];
    if (!items.length) return "";
    t.inbox = [];
    return items
      .map((m) => formatPeerUserMessage(m.from, m.message))
      .join("\n\n");
  }

  /** Peer tool dispatch from a child (no spawn/close). */
  async dispatchPeer(
    fromAgentId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: string; data?: Record<string, unknown> }> {
    if (!isPeerTool(name)) {
      return {
        ok: false,
        output: JSON.stringify({
          ok: false,
          error: `peer tools cannot call ${name}`,
        }),
      };
    }
    try {
      const data = await this.dispatchInner(
        name as MultiAgentToolName,
        args,
        fromAgentId,
      );
      return {
        ok: data.ok !== false,
        output: JSON.stringify(data, null, 0),
        data,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        output: JSON.stringify({ ok: false, error: msg }),
        data: { ok: false, error: msg },
      };
    }
  }

  private peerMessagingEnabled(): boolean {
    return this.opts.config.peerMessaging !== false;
  }

  private openCount(): number {
    let n = 0;
    for (const t of this.threads.values()) {
      if (t.status !== "closed") n++;
    }
    return n;
  }

  private summarizeThread(t: AgentThread): Record<string, unknown> {
    const handoff =
      t.handoffSummary ?? extractHandoffSummary(t.result);
    return {
      agent_id: t.id,
      agent_type: t.agentType,
      nickname: t.nickname,
      status: t.status,
      model: `${t.provider}/${t.model}`,
      description: t.message.slice(0, 80),
      result_preview: handoff?.slice(0, 400) ?? t.result?.slice(0, 400),
      handoff_summary: handoff,
      error: t.error,
      rounds: t.rounds,
      tools_used: t.toolsUsed,
      usage: t.usage,
      retries: t.retries,
      started_at: t.startedAt,
      ended_at: t.endedAt,
      turn_id: t.turnId,
      reasoning_effort: t.reasoningEffort,
      capability_mode: t.capabilityMode,
      cwd: t.cwd ?? this.opts.cwd,
      worktree_path: t.worktreePath,
      worktree_branch: t.worktreeBranch,
      batch_item: t.batchItem,
      ms:
        t.endedAt && t.startedAt
          ? t.endedAt - t.startedAt
          : Date.now() - t.startedAt,
    };
  }

  /** Sum usage across all threads (rough subagent spend). */
  totalUsage(): { prompt_tokens: number; completion_tokens: number } {
    let prompt = 0;
    let completion = 0;
    for (const t of this.threads.values()) {
      prompt += t.usage?.prompt_tokens ?? 0;
      completion += t.usage?.completion_tokens ?? 0;
    }
    return { prompt_tokens: prompt, completion_tokens: completion };
  }

  private uniqueNickname(base: string): string {
    const want = base.trim() || "agent";
    const taken = new Set(
      [...this.threads.values()]
        .filter((t) => t.status !== "closed")
        .map((t) => t.nickname),
    );
    if (!taken.has(want)) return want;
    let i = 2;
    while (taken.has(`${want} #${i}`)) i++;
    return `${want} #${i}`;
  }

  private threadPressureWarning(): string | undefined {
    const open = this.openCount();
    if (open >= this.maxThreads) {
      return `max_threads (${this.maxThreads}) full — wait_agent or close_agent before more spawns`;
    }
    // Nudge before hard failure (at 75% or within 2 of cap)
    if (
      open >= Math.max(1, this.maxThreads - 2) ||
      open / this.maxThreads >= 0.75
    ) {
      return `${open} of ${this.maxThreads} threads open — consider wait_agent or close_agent before hitting the cap`;
    }
    return undefined;
  }

  /** Drop oldest terminal threads beyond retention cap (session-scoped runtimes). */
  pruneTerminalThreads(): number {
    const terminal = [...this.threads.values()]
      .filter(
        (t) =>
          t.status === "closed" ||
          t.status === "completed" ||
          t.status === "failed" ||
          t.status === "cancelled",
      )
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    let removed = 0;
    while (terminal.length > this.maxRetainedTerminal) {
      const t = terminal.shift()!;
      // Prefer pruning closed first; always safe for non-running
      if (t.status === "running" || t.status === "queued") continue;
      this.threads.delete(t.id);
      this.aborts.delete(t.id);
      this.notifiedCompletions.delete(t.id);
      removed++;
    }
    return removed;
  }

  /** Open non-closed workspace-write (or execute/all) children. */
  private openWorkspaceWriteCount(): number {
    let n = 0;
    for (const t of this.threads.values()) {
      if (t.status === "closed") continue;
      if (t.status !== "running" && t.status !== "queued") continue;
      const cap = t.capabilityMode;
      if (cap === "read-only") continue;
      // read-write / execute / all / undefined with worker-like roles write
      if (
        cap === "read-write" ||
        cap === "execute" ||
        cap === "all" ||
        cap == null
      ) {
        // Prefer sandbox from resolved role when capability unset
        const role = resolveRole(t.agentType, this.opts.config.roles);
        if (role.sandbox === "workspace-write" || cap === "read-write" || cap === "execute" || cap === "all") {
          n++;
        }
      }
    }
    return n;
  }

  /**
   * Drain completion notices for agents that finished since last call.
   * Deduped by agent id (Grok ReportedTaskCompletions spirit).
   * Also drains parent-bound peer messages (child→root mailbox) so the
   * coordinating parent sees handoffs without only blocking on wait_agent.
   */
  drainCompletionNotices(): string {
    const fresh: Array<{
      id: string;
      agentType: string;
      status: AgentThreadStatus;
      resultPreview?: string;
    }> = [];
    for (const t of this.threads.values()) {
      if (!TERMINAL.has(t.status)) continue;
      if (this.notifiedCompletions.has(t.id)) continue;
      this.notifiedCompletions.add(t.id);
      fresh.push({
        id: t.id,
        agentType: t.agentType,
        status: t.status,
        resultPreview: t.result ?? t.error,
      });
    }
    const completions = formatCompletionNotices(fresh);
    const parentMail = this.drainParentInbox();
    return [completions, parentMail].filter(Boolean).join("\n\n");
  }

  /**
   * Drain child→root mailbox entries (FIFO). Returns formatted notices
   * for the parent wire, or empty string when nothing is pending.
   */
  drainParentInbox(): string {
    if (!this.parentInbox.length) return "";
    const items = this.parentInbox.splice(0, this.parentInbox.length);
    return formatParentMailboxNotices(items);
  }

  /** Test/inspection helper: pending parent mailbox depth (not drained). */
  parentInboxDepth(): number {
    return this.parentInbox.length;
  }

  /** Test helper: peek parent inbox without draining. */
  peekParentInbox(): readonly ParentInboxEntry[] {
    return this.parentInbox;
  }

  /**
   * Spawn a child agent. When called from a live child (fromAgentId), nesting
   * depth is parentThread.depth+1 so maxDepth is enforced per hop on the
   * shared root runtime (not only runtime.opts.depth).
   */
  async spawn(
    args: SpawnAgentArgs,
    fromAgentId?: string,
  ): Promise<Record<string, unknown>> {
    const caller = this.resolveCallerDepth(fromAgentId);
    if (!caller.ok) {
      return { ok: false, error: caller.error, code: caller.code };
    }
    // Deny when the caller is already at max depth (cannot spawn further).
    if (caller.depth >= this.maxDepth) {
      return {
        ok: false,
        error: `spawn denied: caller depth ${caller.depth} >= max_depth ${this.maxDepth}`,
        code: "max_depth",
        caller_depth: caller.depth,
        max_depth: this.maxDepth,
        from: caller.from,
      };
    }
    // Runtime-level gate for headless child runtimes that share opts.depth
    if (!this.canSpawn && (!fromAgentId || isParentAgentId(fromAgentId))) {
      return {
        ok: false,
        error: `spawn denied: depth ${this.opts.depth} >= max_depth ${this.maxDepth}`,
        code: "max_depth",
      };
    }

    const message = String(args.message ?? "").trim();
    if (!message) {
      return { ok: false, error: "message is required", code: "invalid_args" };
    }

    const resumeFrom = args.resume_from?.trim();
    if (resumeFrom) {
      return this.spawnResume(args, resumeFrom, message);
    }

    this.pruneTerminalThreads();
    if (this.openCount() >= this.maxThreads) {
      return {
        ok: false,
        error: `max_threads (${this.maxThreads}) reached — wait_agent or close_agent first`,
        code: "max_threads",
        open: this.openCount(),
        max_threads: this.maxThreads,
      };
    }

    let role = resolveRole(args.agent_type, this.opts.config.roles);
    const capMode = normalizeCapabilityMode(args.capability_mode);
    role = applyCapabilityMode(role, capMode);
    const { provider, model } = this.resolveModel(args.model, role);
    const effort = resolveChildEffort(args.reasoning_effort, role);
    const id = nextAgentId();
    const nickBase =
      args.description?.trim() || `${role.name} ${id.slice(-4)}`;
    const nickname = this.uniqueNickname(nickBase);
    const turnId = this.activeTurnId;
    const pressure = this.threadPressureWarning();
    const effectiveCap: CapabilityMode | undefined =
      capMode ??
      (role.sandbox === "read-only" ? "read-only" : "execute");
    const childDepth = caller.depth + 1;

    // Worktree isolation for workspace-write (opt-in or auto ≥2 concurrent)
    let childCwd = this.opts.cwd;
    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;
    const isolate = shouldIsolateWorktree({
      isolateFlag:
        typeof args.isolate_worktree === "boolean"
          ? args.isolate_worktree
          : null,
      sandbox: role.sandbox,
      openWorkspaceWriteCount: this.openWorkspaceWriteCount(),
    });
    if (isolate) {
      const wt = await createAgentWorktree({
        baseCwd: this.opts.cwd,
        agentId: id,
        runGit: this.opts.runGit,
        worktreeParent: this.opts.worktreeParent
          ? `${this.opts.worktreeParent}/${id}`
          : undefined,
      });
      if (!wt.ok) {
        return {
          ok: false,
          error: `worktree isolation failed: ${wt.error}`,
          code: "worktree_failed",
        };
      }
      childCwd = wt.worktreePath;
      worktreePath = wt.worktreePath;
      worktreeBranch = wt.branch;
    }

    const thread: AgentThread = {
      id,
      agentType: role.id,
      nickname,
      status: "running",
      depth: childDepth,
      provider,
      model,
      message,
      history: [{ role: "user", content: message }],
      startedAt: Date.now(),
      turnId,
      reasoningEffort: effort,
      capabilityMode: effectiveCap,
      cwd: childCwd,
      worktreePath,
      worktreeBranch,
    };

    this.launchChild(thread, role, message, args.fork_context === true, effort);
    this.threads.set(id, thread);

    return {
      ok: true,
      agent_id: id,
      agent_type: role.id,
      nickname,
      status: "running" as AgentThreadStatus,
      model: `${provider}/${model}`,
      sandbox: role.sandbox,
      reasoning_effort: effort,
      capability_mode: effectiveCap,
      depth: childDepth,
      max_depth: this.maxDepth,
      spawned_by: caller.from,
      turn_id: turnId,
      cwd: childCwd,
      worktree_path: worktreePath,
      worktree_branch: worktreeBranch,
      isolated: Boolean(worktreePath),
      open: this.openCount(),
      max_threads: this.maxThreads,
      warning: pressure,
      hint:
        "Child is running in the background (survives across parent turns until cancelled). Continue other parent work now. Call wait_agent only when you need this summary; mid-turn <subagent_completed> notices may arrive first. Resume later with resume_from or get_agent_result." +
        (worktreePath
          ? ` Worktree at ${worktreePath} — review/merge manually (no auto-merge).`
          : "") +
        (pressure ? ` Warning: ${pressure}` : ""),
    };
  }

  /**
   * Fan-out: one child per item with exactly-once assignment.
   */
  async spawnBatch(
    args: SpawnAgentsBatchArgs,
    fromAgentId?: string,
  ): Promise<Record<string, unknown>> {
    const items = parseBatchItems(args);
    if (!items.length) {
      return {
        ok: false,
        error: "items or csv_text required (non-empty)",
        code: "invalid_args",
      };
    }
    const template =
      (args.message_template ?? args.message ?? "").trim() || "{{item}}";
    const agents: Array<Record<string, unknown>> = [];
    const assignments: Array<{ item: string; agent_id?: string; ok: boolean; error?: string }> =
      [];

    for (const item of items) {
      if (this.openCount() >= this.maxThreads) {
        assignments.push({
          item,
          ok: false,
          error: `max_threads (${this.maxThreads}) reached`,
        });
        continue;
      }
      const message = template
        .replace(/\{\{\s*item\s*\}\}/gi, item)
        .replace(/\{\s*item\s*\}/gi, item);
      const spawnArgs: SpawnAgentArgs = {
        agent_type: args.agent_type,
        message,
        description:
          args.description?.trim()
            ? `${args.description.trim()} · ${item.slice(0, 40)}`
            : `batch ${item.slice(0, 40)}`,
        model: args.model,
        reasoning_effort: args.reasoning_effort,
        capability_mode: args.capability_mode,
        isolate_worktree: args.isolate_worktree,
        fork_context: args.fork_context,
      };
      const r = await this.spawn(spawnArgs, fromAgentId);
      if (r.ok && r.agent_id) {
        const t = this.threads.get(String(r.agent_id));
        if (t) t.batchItem = item;
        assignments.push({ item, agent_id: String(r.agent_id), ok: true });
        agents.push({ ...r, batch_item: item });
      } else {
        assignments.push({
          item,
          ok: false,
          error: String(r.error ?? "spawn failed"),
        });
      }
    }

    const okCount = assignments.filter((a) => a.ok).length;
    return {
      ok: okCount > 0,
      spawned: okCount,
      total_items: items.length,
      agents,
      assignments,
      hint:
        "Each item was assigned to at most one child. Continue parent work; wait_agent or get_agent_result for reports.",
    };
  }

  /**
   * Mailbox-style fetch of one child's result (budgeted).
   */
  async getAgentResult(
    args: GetAgentResultArgs,
  ): Promise<Record<string, unknown>> {
    const id = String(args.agent_id ?? "").trim();
    if (!id) {
      return { ok: false, error: "agent_id required", code: "invalid_args" };
    }
    const t = this.threads.get(id);
    if (!t) {
      return { ok: false, error: `unknown agent_id: ${id}`, code: "unknown_agent" };
    }
    const stillRunning =
      t.status === "running" || t.status === "queued";
    const raw = stillRunning
      ? undefined
      : t.result ?? t.error ?? "(no result)";
    const result =
      raw === undefined
        ? undefined
        : truncateToolOutput(raw, TOOL_OUTPUT_CHILD_MAX);
    const handoff = t.handoffSummary ?? extractHandoffSummary(t.result);
    return {
      ok: !stillRunning && t.status !== "failed",
      agent_id: id,
      agent_type: t.agentType,
      status: t.status,
      timed_out: stillRunning,
      result,
      handoff_summary: handoff,
      usage: t.usage,
      retries: t.retries,
      truncated:
        raw != null && raw.length > TOOL_OUTPUT_CHILD_MAX
          ? true
          : Boolean(result && /\[truncated \d+ chars\]/.test(result)),
      worktree_path: t.worktreePath,
      cwd: t.cwd ?? this.opts.cwd,
      batch_item: t.batchItem,
      hint: stillRunning
        ? "Agent still running — call wait_agent first, then get_agent_result."
        : undefined,
    };
  }

  private async spawnResume(
    args: SpawnAgentArgs,
    resumeFrom: string,
    message: string,
  ): Promise<Record<string, unknown>> {
    const source = this.threads.get(resumeFrom);
    if (!source) {
      return {
        ok: false,
        error: `resume_from unknown agent_id: ${resumeFrom}`,
        code: "unknown_agent",
      };
    }
    if (source.status === "running" || source.status === "queued") {
      return {
        ok: false,
        error: `resume_from agent is still ${source.status} — wait_agent first`,
        code: "not_completed",
      };
    }
    if (source.status === "closed") {
      return {
        ok: false,
        error: `resume_from agent is closed: ${resumeFrom}`,
        code: "closed",
      };
    }
    // Same agent_type if specified
    if (args.agent_type) {
      const want = resolveRole(args.agent_type, this.opts.config.roles).id;
      if (want !== source.agentType) {
        return {
          ok: false,
          error: `resume_from agent_type mismatch: source=${source.agentType}, requested=${want}`,
          code: "type_mismatch",
        };
      }
    }

    // Soft-ignore model override on resume (Grok behavior)
    if (args.model?.trim()) {
      dbg("subagent", "resume.soft_ignore_model", {
        resumeFrom,
        ignored: args.model,
      });
    }

    let role = resolveRole(source.agentType, this.opts.config.roles);
    const capMode =
      normalizeCapabilityMode(args.capability_mode) ?? source.capabilityMode;
    role = applyCapabilityMode(role, capMode);
    const effort =
      resolveChildEffort(args.reasoning_effort, role) ??
      source.reasoningEffort;

    // Reuse same agent id for continuity (continue history, not wipe)
    const t = source;
    t.history.push({ role: "user", content: message });
    t.status = "running";
    t.message = message;
    t.startedAt = Date.now();
    t.endedAt = undefined;
    t.error = undefined;
    t.turnId = this.activeTurnId;
    t.reasoningEffort = effort;
    if (capMode) t.capabilityMode = capMode as CapabilityMode;
    // Allow re-notify after this resume completes
    this.notifiedCompletions.delete(t.id);

    this.launchChild(t, role, message, false, effort, /* resume */ true);

    return {
      ok: true,
      agent_id: t.id,
      agent_type: t.agentType,
      nickname: t.nickname,
      status: "running" as AgentThreadStatus,
      model: `${t.provider}/${t.model}`,
      resumed_from: resumeFrom,
      reasoning_effort: effort,
      hint:
        "Resumed prior history with new message (running in background). Continue other work; wait_agent only if you need the result.",
    };
  }

  private launchChild(
    thread: AgentThread,
    role: ResolvedRole,
    message: string,
    forkContext: boolean,
    effort: string | undefined,
    isResume = false,
  ): void {
    const id = thread.id;
    const ac = new AbortController();
    this.aborts.set(id, ac);
    if (this.opts.signal) {
      const onParentAbort = () => {
        // Only abort if still tagged to a cancellable turn path;
        // parent signal still cancels in-flight work for this runtime.
        ac.abort();
      };
      this.opts.signal.addEventListener("abort", onParentAbort, {
        once: true,
      });
    }

    // Per-role timeout always set on ResolvedRole (role override or
    // defaultJobMaxRuntimeSecondsForRole); fall back to global only if absent.
    const jobTimeoutMs =
      (role.jobMaxRuntimeSeconds > 0
        ? role.jobMaxRuntimeSeconds
        : Math.round(this.jobTimeoutMs / 1000)) * 1000;
    const jobTimer = setTimeout(() => {
      if (thread.status === "running") {
        ac.abort();
        thread.error = `timeout after ${jobTimeoutMs}ms`;
      }
    }, jobTimeoutMs);

    const peerOn = this.peerMessagingEnabled();
    let system = this.buildChildSystem(role, forkContext);
    if (peerOn) {
      system += "\n\n" + buildPeerChildSystemAddon(id);
    }
    // Nested spawn: only when this child's depth is still under maxDepth
    const childCanSpawn = thread.depth < this.maxDepth;
    if (childCanSpawn) {
      system +=
        "\n\nYou may spawn helper subagents (depth remaining). Prefer peer message_agent for siblings.";
    }

    const runSpan = span("subagent", isResume ? "resume" : "spawn", {
      id,
      type: role.id,
      model: `${thread.provider}/${thread.model}`,
      effort: effort ?? null,
      peer: peerOn,
    });

    // Merge any queued peer messages into the user turn
    const inboxText = this.drainInbox(thread);
    const userContent = inboxText
      ? `${message}\n\n${inboxText}`
      : message;

    const historyMsgs: ChatMessage[] = isResume
      ? [
          { role: "system", content: system },
          ...thread.history.map((h) => ({
            role: h.role as "user" | "assistant" | "system",
            content: h.content,
          })),
        ]
      : [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ];
    // On resume, if we had only history and new message was already pushed
    // by sendInput/messageAgent, history already ends with user — good.
    // If inbox-only delivery, ensure last user has inbox content.
    if (isResume && inboxText) {
      const last = historyMsgs[historyMsgs.length - 1];
      if (last?.role === "user" && !String(last.content).includes("[peer message")) {
        last.content = `${last.content}\n\n${inboxText}`;
      }
    }

    const peerTools = peerOn ? buildPeerTools() : [];
    // Nested spawn: give full multi-agent tools when depth allows
    const childMaTools = childCanSpawn
      ? buildMultiAgentTools(this.roles)
      : peerTools;

    const maxRounds = role.maxRounds;
    const cap = thread.capabilityMode;
    const interactive =
      Boolean(this.opts.onPermission) &&
      (cap === "execute" || cap === "all");

    const runOnce = () =>
      runChildLoop({
        provider: thread.provider,
        model: thread.model,
        cwd: thread.cwd ?? this.opts.cwd,
        system,
        messages: historyMsgs,
        toolsets: role.toolsets,
        permissions: role.permissions,
        signal: ac.signal,
        label: `child.${role.id}.${id.slice(-6)}`,
        reasoningEffort: effort,
        maxRounds,
        chatImpl: this.opts.chatImpl,
        autoApprove: !interactive,
        onPermission: interactive ? this.opts.onPermission : undefined,
        peer:
          childMaTools.length > 0
            ? {
                tools: childMaTools,
                isCustomTool: (n) =>
                  childCanSpawn ? isMultiAgentTool(n) : isPeerTool(n),
                customDispatch: async (name, args) => {
                  if (childCanSpawn) {
                    return this.dispatch(name, args, id);
                  }
                  return this.dispatchPeer(id, name, args);
                },
              }
            : undefined,
      });

    thread.promise = (async () => {
      try {
        dbg("subagent", isResume ? "child.resume" : "child.start", {
          id,
          type: role.id,
          model: `${thread.provider}/${thread.model}`,
          effort,
          peer: peerOn,
          canSpawn: childCanSpawn,
          maxRounds: maxRounds ?? null,
          jobTimeoutMs,
        });

        let result = await runOnce();
        // One automatic retry on transient failure (network/rate-limit), not cancel.
        if (
          !ac.signal.aborted &&
          !isThreadClosed(thread) &&
          result.error &&
          result.error !== "cancelled" &&
          result.error !== "max_rounds" &&
          isTransientChildError(result.error)
        ) {
          thread.retries = (thread.retries ?? 0) + 1;
          dbg("subagent", "child.retry", {
            id,
            error: result.error,
            attempt: thread.retries,
          });
          result = await runOnce();
        } else if (
          !ac.signal.aborted &&
          thread.status !== "closed" &&
          !result.error &&
          // thrown path handled in catch — also retry empty hard failures via catch
          false
        ) {
          /* unreachable */
        }

        // close() may have won the race — never un-close a closed thread.
        if (isThreadClosed(thread)) {
          if (result.text) {
            thread.result = result.text;
            thread.handoffSummary = extractHandoffSummary(result.text);
          }
          this.accumulateUsage(thread, result.usage);
          dbg("subagent", "child.done_after_close", { id });
          return;
        }

        thread.result = result.text;
        thread.handoffSummary = extractHandoffSummary(result.text);
        thread.rounds = (thread.rounds ?? 0) + result.rounds;
        thread.toolsUsed = [
          ...(thread.toolsUsed ?? []),
          ...result.toolsUsed,
        ];
        this.accumulateUsage(thread, result.usage);
        thread.history.push({ role: "assistant", content: result.text });
        if (result.error === "cancelled" || ac.signal.aborted) {
          thread.status = "cancelled";
          thread.error = result.error ?? "cancelled";
        } else if (result.error && result.error !== "max_rounds") {
          thread.status = "failed";
          thread.error = result.error;
        } else {
          thread.status = "completed";
          if (result.error) thread.error = result.error;
        }
        // Resume guidance on completed results
        if (thread.status === "completed" && thread.result) {
          const footer = formatResumeFooter(id);
          if (!thread.result.includes(footer)) {
            thread.result = `${thread.result}\n\n${footer}`;
          }
        }
        dbg("subagent", "child.done", {
          id,
          status: thread.status,
          rounds: result.rounds,
          outLen: result.text.length,
          usage: thread.usage,
        });

        // Auto-chain: deliver peer messages that arrived during the run
        const chainN = thread.peerChainCount ?? 0;
        if (
          thread.status === "completed" &&
          (thread.inbox?.length ?? 0) > 0 &&
          !ac.signal.aborted &&
          chainN < 3
        ) {
          const chained = this.drainInbox(thread);
          if (chained) {
            thread.peerChainCount = chainN + 1;
            dbg("subagent", "child.auto_chain_inbox", {
              id,
              chars: chained.length,
              chain: thread.peerChainCount,
            });
            // Resume with inbox (sendInput starts a new promise)
            void this.sendInput({ agent_id: id, message: chained });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Single retry on thrown transient errors
        if (
          !ac.signal.aborted &&
          !isThreadClosed(thread) &&
          isTransientChildError(msg) &&
          (thread.retries ?? 0) < 1
        ) {
          try {
            thread.retries = (thread.retries ?? 0) + 1;
            dbg("subagent", "child.retry_throw", { id, error: msg });
            const result = await runOnce();
            if (isThreadClosed(thread)) {
              if (result.text) thread.result = result.text;
              this.accumulateUsage(thread, result.usage);
              return;
            }
            thread.result = result.text;
            thread.handoffSummary = extractHandoffSummary(result.text);
            thread.rounds = (thread.rounds ?? 0) + result.rounds;
            thread.toolsUsed = [
              ...(thread.toolsUsed ?? []),
              ...result.toolsUsed,
            ];
            this.accumulateUsage(thread, result.usage);
            thread.history.push({ role: "assistant", content: result.text });
            if (result.error === "cancelled" || ac.signal.aborted) {
              thread.status = "cancelled";
              thread.error = result.error ?? "cancelled";
            } else if (result.error && result.error !== "max_rounds") {
              thread.status = "failed";
              thread.error = result.error;
            } else {
              thread.status = "completed";
            }
            if (thread.status === "completed" && thread.result) {
              const footer = formatResumeFooter(id);
              if (!thread.result.includes(footer)) {
                thread.result = `${thread.result}\n\n${footer}`;
              }
            }
            return;
          } catch (err2) {
            const msg2 = err2 instanceof Error ? err2.message : String(err2);
            if (isThreadClosed(thread)) return;
            thread.status = "failed";
            thread.error = msg2;
            thread.result = `Subagent failed: ${msg2}`;
            dbg("subagent", "child.error", { id, error: msg2, afterRetry: true });
            return;
          }
        }
        if (isThreadClosed(thread)) return;
        thread.status = "failed";
        thread.error = msg;
        thread.result = `Subagent failed: ${thread.error}`;
        dbg("subagent", "child.error", { id, error: thread.error });
      } finally {
        clearTimeout(jobTimer);
        if (!isThreadClosed(thread)) {
          thread.endedAt = Date.now();
        } else {
          thread.endedAt = thread.endedAt ?? Date.now();
        }
        this.aborts.delete(id);
        this.pruneTerminalThreads();
        runSpan.end({
          status: thread.status,
          ms: thread.endedAt - thread.startedAt,
        });
      }
    })();
  }

  async wait(args: WaitAgentArgs = {}): Promise<Record<string, unknown>> {
    const timeout = args.timeout_ms ?? this.jobTimeoutMs;
    let ids = args.agent_ids?.map(String).filter(Boolean);
    if (!ids?.length) {
      ids = [...this.threads.values()]
        .filter((t) => t.status !== "closed")
        .map((t) => t.id);
    }
    if (!ids.length) {
      return { ok: true, agents: [], message: "no agents to wait for" };
    }

    const t0 = Date.now();
    // Settle through auto-chain / inbox resumes: a child may flip
    // completed → running again after peer/parent messages drain.
    for (const id of ids) {
      while (Date.now() - t0 < timeout) {
        const t = this.threads.get(id);
        if (!t) break;
        if (
          t.promise &&
          (t.status === "running" || t.status === "queued")
        ) {
          const remaining = timeout - (Date.now() - t0);
          if (remaining <= 0) break;
          await Promise.race([t.promise, sleep(remaining)]);
          // Yield so auto-chain sendInput can attach the next promise
          await sleep(0);
          continue;
        }
        break;
      }
    }

    const agents = ids.map((id) => {
      const t = this.threads.get(id);
      if (!t) {
        return { agent_id: id, ok: false, error: "unknown agent_id" };
      }
      const stillRunning =
        t.status === "running" || t.status === "queued";
      // Prefer final result; while running, surface best-effort partial text.
      const rawResult = stillRunning
        ? partialProgressText(t)
        : t.result ?? t.error ?? "(no result)";
      // Cap child text so a large completion cannot inflate parent context.
      const result =
        rawResult === undefined
          ? undefined
          : truncateToolOutput(rawResult, TOOL_OUTPUT_CHILD_MAX);
      const progress = {
        status: t.status,
        rounds: t.rounds ?? 0,
        tools_used: t.toolsUsed ?? [],
        ms:
          t.endedAt && t.startedAt
            ? t.endedAt - t.startedAt
            : Date.now() - t.startedAt,
        partial_text: stillRunning
          ? result
          : undefined,
      };
      return {
        ...this.summarizeThread(t),
        ok: !stillRunning && t.status !== "failed",
        timed_out: stillRunning,
        result: stillRunning ? undefined : result,
        progress,
      };
    });

    const allDone = agents.every((a) => !("timed_out" in a && a.timed_out));
    // Truncate the combined summary with the same child budget (may hold N agents).
    const summary = truncateToolOutput(
      agents
        .map((a) => {
          const r = a as {
            agent_id: string;
            agent_type?: string;
            status?: string;
            result?: string;
            error?: string;
            timed_out?: boolean;
            handoff_summary?: string;
            progress?: {
              rounds?: number;
              tools_used?: string[];
              partial_text?: string;
              ms?: number;
            };
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const handoff = r.handoff_summary
            ? `\n[handoff]\n${r.handoff_summary}`
            : "";
          const usage =
            r.usage &&
            (r.usage.prompt_tokens != null || r.usage.completion_tokens != null)
              ? `\n[usage] prompt=${r.usage.prompt_tokens ?? 0} completion=${r.usage.completion_tokens ?? 0}`
              : "";
          const body =
            r.result ??
            r.error ??
            (r.timed_out
              ? `[still running] rounds=${r.progress?.rounds ?? 0} tools=${(r.progress?.tools_used ?? []).join(",") || "none"} ms=${r.progress?.ms ?? 0}\n${r.progress?.partial_text ?? "(no partial output yet)"}`
              : "");
          return `### ${r.agent_type ?? "agent"} (${r.agent_id}) [${r.status}]\n${body}${handoff}${usage}`;
        })
        .join("\n\n"),
      TOOL_OUTPUT_CHILD_MAX,
    );
    const totals = this.totalUsage();
    // Wait tool itself succeeded in reporting status — timeout is not a hard
    // tool failure. Models read all_done / timed_out / progress instead.
    return {
      ok: true,
      all_done: allDone,
      timed_out: !allDone,
      agents,
      summary,
      subagent_usage: totals,
      hint: allDone
        ? undefined
        : "One or more agents still running — see progress/partial_text; wait_agent again or continue parent work.",
    };
  }

  async sendInput(args: SendInputArgs): Promise<Record<string, unknown>> {
    const id = String(args.agent_id ?? "");
    const message = String(args.message ?? "").trim();
    if (!id || !message) {
      return { ok: false, error: "agent_id and message required" };
    }
    const t = this.threads.get(id);
    if (!t || t.status === "closed") {
      return { ok: false, error: `unknown or closed agent: ${id}` };
    }

    // Queue while running — do not block the parent on the child (matches tool docs).
    if (t.status === "running" || t.status === "queued") {
      t.inbox = t.inbox ?? [];
      t.inbox.push({ from: "parent", message, at: Date.now() });
      return {
        ok: true,
        agent_id: id,
        queued: true,
        inbox_depth: t.inbox.length,
        status: t.status,
        hint:
          "Message queued — delivered when the agent becomes idle (auto-resume). Continue other parent work; wait_agent only if you need the next result.",
      };
    }

    let role = resolveRole(t.agentType, this.opts.config.roles);
    role = applyCapabilityMode(role, t.capabilityMode);
    // Merge any peer inbox with this follow-up
    const inboxExtra = this.drainInbox(t);
    const fullMsg = inboxExtra ? `${message}\n\n${inboxExtra}` : message;
    t.history.push({ role: "user", content: fullMsg });
    t.status = "running";
    t.message = fullMsg;
    t.startedAt = Date.now();
    t.endedAt = undefined;
    t.error = undefined;
    t.turnId = this.activeTurnId;
    this.notifiedCompletions.delete(id);

    this.launchChild(t, role, fullMsg, false, t.reasoningEffort, true);

    return {
      ok: true,
      agent_id: id,
      status: "running",
      hint:
        "Follow-up running in background. Continue other work; wait_agent only if you need the result.",
    };
  }

  async close(args: CloseAgentArgs): Promise<Record<string, unknown>> {
    const id = String(args.agent_id ?? "");
    const t = this.threads.get(id);
    if (!t) return { ok: false, error: `unknown agent_id: ${id}` };

    const ac = this.aborts.get(id);
    if (ac) {
      try {
        ac.abort();
      } catch {
        /* */
      }
    }
    if (t.promise) {
      await Promise.race([t.promise, sleep(2000)]);
    }
    t.status = "closed";
    t.endedAt = t.endedAt ?? Date.now();
    return { ok: true, agent_id: id, status: "closed" };
  }

  async list(args: ListAgentsArgs = {}): Promise<Record<string, unknown>> {
    const agents = [...this.threads.values()]
      .filter((t) => args.include_closed || t.status !== "closed")
      .map((t) => this.summarizeThread(t));
    // Root is always addressable for message_agent (Codex v2 peer+root)
    const parentRow = {
      agent_id: "parent",
      agent_type: "parent",
      nickname: "root",
      status: "running" as AgentThreadStatus,
      aliases: ["parent", "root"],
      description: "Root/parent coordinator — message_agent target for child→root",
      parent_inbox_depth: this.parentInbox.length,
    };
    const pressure = this.threadPressureWarning();
    return {
      ok: true,
      open: this.openCount(),
      max_threads: this.maxThreads,
      depth: this.opts.depth,
      max_depth: this.maxDepth,
      subagent_usage: this.totalUsage(),
      warning: pressure,
      parent: parentRow,
      agents: [parentRow, ...agents],
    };
  }

  /**
   * Cancel agents tagged to the given turn (default: active turn).
   * Leaves other-turn agents alone.
   */
  cancelTurn(turnId?: string): void {
    const target = turnId ?? this.activeTurnId;
    for (const [id, ac] of this.aborts) {
      const t = this.threads.get(id);
      if (t && t.turnId != null && t.turnId !== target) continue;
      try {
        ac.abort();
      } catch {
        /* */
      }
      if (t && t.status === "running") {
        t.status = "cancelled";
        t.endedAt = Date.now();
      }
    }
  }

  /**
   * @deprecated Prefer cancelTurn — kept for callers that need a full wipe.
   * Still turn-scoped when threads have turnId (skips foreign turns).
   */
  cancelAll(): void {
    this.cancelTurn(this.activeTurnId);
  }

  /** Test helper: get thread by id */
  getThread(id: string): AgentThread | undefined {
    return this.threads.get(id);
  }

  private accumulateUsage(
    thread: AgentThread,
    usage?: { prompt_tokens?: number; completion_tokens?: number },
  ): void {
    if (!usage) return;
    const prev = thread.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
    thread.usage = {
      prompt_tokens: (prev.prompt_tokens ?? 0) + (usage.prompt_tokens ?? 0),
      completion_tokens:
        (prev.completion_tokens ?? 0) + (usage.completion_tokens ?? 0),
    };
  }

  private buildChildSystem(role: ResolvedRole, forkContext: boolean): string {
    const peerOn = this.peerMessagingEnabled();
    const parts = [
      `You are a specialized coding subagent (role: ${role.name}, id: ${role.id}).`,
      "Help with software engineering using the tools available to you. Do not claim any product name or brand.",
      role.instructions,
      "",
      "Rules:",
      "- Complete only the assigned task.",
      "- Be concise and direct. Prefer path:line references over long dumps.",
      "- Return a concise summary for the parent agent (findings, path:line refs, next steps).",
      "- End your final reply with a structured handoff block exactly like:",
      "### Summary",
      "- Findings: …",
      "- Refs: path:line, …",
      "- Next: …",
      peerOn
        ? "- You may coordinate via list_agents / message_agent / wait_agent when those tools are available. Address the root with agent_id \"parent\" or \"root\"."
        : "- Do not spawn further subagents — you have no multi-agent tools.",
      role.sandbox === "read-only"
        ? "- READ-ONLY: do not edit files or run shell that mutates state."
        : "- Prefer specialized file tools over shell for edits.",
    ];
    if (forkContext && this.opts.parentContextSummary?.trim()) {
      parts.push(
        "",
        "## Parent context (fork_context)",
        this.opts.parentContextSummary.trim().slice(0, 4000),
      );
    }
    return parts.join("\n");
  }

  private resolveModel(
    override: string | undefined,
    role: ResolvedRole,
  ): { provider: ProviderId; model: string } {
    const key =
      override?.trim() ||
      role.modelKey?.trim() ||
      this.opts.preferredModelKey?.trim() ||
      this.opts.config.preferredModelKey?.trim() ||
      `${this.opts.parentProvider}/${this.opts.parentModel}`;

    if (!key.includes("/")) {
      return {
        provider: this.opts.parentProvider,
        model: key || this.opts.parentModel,
      };
    }
    const ref = parseModelKey(key);
    if (ref) {
      return { provider: ref.provider, model: ref.model };
    }
    return {
      provider: this.opts.parentProvider,
      model: this.opts.parentModel,
    };
  }
}

/** Spawn override wins; else role.reasoningEffort when set. */
export function resolveChildEffort(
  spawnEffort: string | undefined,
  role: ResolvedRole,
): string | undefined {
  const fromSpawn = spawnEffort?.trim();
  if (fromSpawn && fromSpawn !== "default") return fromSpawn;
  const fromRole = role.reasoningEffort?.trim();
  if (fromRole && fromRole !== "default") return fromRole;
  return undefined;
}
