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
  formatCompletionNotices,
  formatResumeFooter,
  type AgentThread,
  type AgentThreadStatus,
  type CapabilityMode,
  type CloseAgentArgs,
  type ListAgentsArgs,
  type MessageAgentArgs,
  type SendInputArgs,
  type SpawnAgentArgs,
  type WaitAgentArgs,
} from "./types.js";
import type { OpenAITool } from "../../toolcalling/schema.js";
import type { TurnOptions } from "../turn.js";

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
}

let agentSeq = 0;
function nextAgentId(): string {
  agentSeq += 1;
  return `agent_${Date.now().toString(36)}_${agentSeq}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TERMINAL: ReadonlySet<AgentThreadStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export class SubagentRuntime {
  private threads = new Map<string, AgentThread>();
  private aborts = new Map<string, AbortController>();
  private roles: ResolvedRole[];
  private maxThreads: number;
  private maxDepth: number;
  private jobTimeoutMs: number;
  /** Current parent turn id — spawns tag with this; cancelTurn filters by it */
  private activeTurnId: string = "turn_0";
  /** Agent ids already reported via drainCompletionNotices */
  private notifiedCompletions = new Set<string>();

  constructor(private opts: SubagentRuntimeOptions) {
    this.roles = listSpawnableRoles(opts.config.roles);
    this.maxThreads = Math.max(1, opts.config.maxConcurrent || 6);
    this.maxDepth = Math.max(0, opts.config.maxDepth ?? 1);
    this.jobTimeoutMs =
      (opts.config.jobMaxRuntimeSeconds ?? 600) * 1000;
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
        return this.spawn(args as unknown as SpawnAgentArgs);
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
      default:
        return { ok: false, error: `unhandled: ${name}` };
    }
  }

  /**
   * Peer/parent → agent messaging (Codex multi-agent v2).
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
    if (id === fromId) {
      return { ok: false, error: "cannot message self" };
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
    return {
      agent_id: t.id,
      agent_type: t.agentType,
      nickname: t.nickname,
      status: t.status,
      model: `${t.provider}/${t.model}`,
      description: t.message.slice(0, 80),
      result_preview: t.result?.slice(0, 400),
      error: t.error,
      rounds: t.rounds,
      tools_used: t.toolsUsed,
      started_at: t.startedAt,
      ended_at: t.endedAt,
      turn_id: t.turnId,
      reasoning_effort: t.reasoningEffort,
      capability_mode: t.capabilityMode,
      ms:
        t.endedAt && t.startedAt
          ? t.endedAt - t.startedAt
          : Date.now() - t.startedAt,
    };
  }

  /**
   * Drain completion notices for agents that finished since last call.
   * Deduped by agent id (Grok ReportedTaskCompletions spirit).
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
    return formatCompletionNotices(fresh);
  }

  async spawn(args: SpawnAgentArgs): Promise<Record<string, unknown>> {
    if (!this.canSpawn) {
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

    if (this.openCount() >= this.maxThreads) {
      return {
        ok: false,
        error: `max_threads (${this.maxThreads}) reached — wait_agent or close_agent first`,
        code: "max_threads",
      };
    }

    let role = resolveRole(args.agent_type, this.opts.config.roles);
    const capMode = normalizeCapabilityMode(args.capability_mode);
    role = applyCapabilityMode(role, capMode);
    const { provider, model } = this.resolveModel(args.model, role);
    const effort = resolveChildEffort(args.reasoning_effort, role);
    const id = nextAgentId();
    const nickname =
      args.description?.trim() ||
      `${role.name} ${id.slice(-4)}`;
    const turnId = this.activeTurnId;
    const effectiveCap: CapabilityMode | undefined =
      capMode ??
      (role.sandbox === "read-only" ? "read-only" : "execute");

    const thread: AgentThread = {
      id,
      agentType: role.id,
      nickname,
      status: "running",
      depth: this.opts.depth + 1,
      provider,
      model,
      message,
      history: [{ role: "user", content: message }],
      startedAt: Date.now(),
      turnId,
      reasoningEffort: effort,
      capabilityMode: effectiveCap,
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
      turn_id: turnId,
      hint:
        "Child is running in the background. Continue other parent work now. Call wait_agent only when you need this summary; mid-turn <subagent_completed> notices may arrive first. Resume later with resume_from.",
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

    const jobTimer = setTimeout(() => {
      if (thread.status === "running") {
        ac.abort();
        thread.error = `timeout after ${this.jobTimeoutMs}ms`;
      }
    }, this.jobTimeoutMs);

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

    thread.promise = (async () => {
      try {
        dbg("subagent", isResume ? "child.resume" : "child.start", {
          id,
          type: role.id,
          model: `${thread.provider}/${thread.model}`,
          effort,
          peer: peerOn,
          canSpawn: childCanSpawn,
        });
        const result = await runChildLoop({
          provider: thread.provider,
          model: thread.model,
          cwd: this.opts.cwd,
          system,
          messages: historyMsgs,
          toolsets: role.toolsets,
          permissions: role.permissions,
          signal: ac.signal,
          label: `child.${role.id}.${id.slice(-6)}`,
          reasoningEffort: effort,
          chatImpl: this.opts.chatImpl,
          peer:
            childMaTools.length > 0
              ? {
                  tools: childMaTools,
                  isCustomTool: (n) =>
                    childCanSpawn
                      ? isMultiAgentTool(n)
                      : isPeerTool(n),
                  customDispatch: async (name, args) => {
                    if (childCanSpawn) {
                      return this.dispatch(name, args, id);
                    }
                    return this.dispatchPeer(id, name, args);
                  },
                }
              : undefined,
        });
        thread.result = result.text;
        thread.rounds = (thread.rounds ?? 0) + result.rounds;
        thread.toolsUsed = [
          ...(thread.toolsUsed ?? []),
          ...result.toolsUsed,
        ];
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
        thread.status = "failed";
        thread.error = err instanceof Error ? err.message : String(err);
        thread.result = `Subagent failed: ${thread.error}`;
        dbg("subagent", "child.error", { id, error: thread.error });
      } finally {
        clearTimeout(jobTimer);
        thread.endedAt = Date.now();
        this.aborts.delete(id);
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
      return {
        ...this.summarizeThread(t),
        ok: !stillRunning && t.status !== "failed",
        timed_out: stillRunning,
        result: stillRunning
          ? undefined
          : t.result ?? t.error ?? "(no result)",
      };
    });

    const allDone = agents.every((a) => !("timed_out" in a && a.timed_out));
    return {
      ok: allDone,
      agents,
      summary: agents
        .map((a) => {
          const r = a as {
            agent_id: string;
            agent_type?: string;
            status?: string;
            result?: string;
            error?: string;
          };
          return `### ${r.agent_type ?? "agent"} (${r.agent_id}) [${r.status}]\n${r.result ?? r.error ?? ""}`;
        })
        .join("\n\n"),
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
    return {
      ok: true,
      open: this.openCount(),
      max_threads: this.maxThreads,
      depth: this.opts.depth,
      max_depth: this.maxDepth,
      agents,
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

  private buildChildSystem(role: ResolvedRole, forkContext: boolean): string {
    const parts = [
      `You are a specialized coding subagent (role: ${role.name}, id: ${role.id}).`,
      "Help with software engineering using the tools available to you. Do not claim any product name or brand.",
      role.instructions,
      "",
      "Rules:",
      "- Complete only the assigned task.",
      "- Be concise and direct. Prefer path:line references over long dumps.",
      "- Return a concise summary for the parent agent (findings, path:line refs, next steps).",
      "- Do not spawn further subagents — you have no multi-agent tools.",
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
