/**
 * Codex multi-agent v1 runtime: spawn / wait / send_input / close / list.
 *
 * Parent orchestrates; children run headless with isolated tool contexts.
 * max_depth=1 by default: children cannot spawn further agents.
 */

import type { ProviderId } from "../../auth/types.js";
import { parseModelKey } from "../../auth/models.js";
import type { SubagentConfig } from "../config.js";
import { dbg, span } from "../debug.js";
import type { ChatMessage } from "../../llm/client.js";
import { runChildLoop } from "./child-loop.js";
import {
  listSpawnableRoles,
  resolveRole,
  type ResolvedRole,
} from "./roles.js";
import {
  buildMultiAgentTools,
  isMultiAgentTool,
  type MultiAgentToolName,
} from "./tools.js";
import type {
  AgentThread,
  AgentThreadStatus,
  CloseAgentArgs,
  ListAgentsArgs,
  SendInputArgs,
  SpawnAgentArgs,
  WaitAgentArgs,
} from "./types.js";
import type { OpenAITool } from "../../toolcalling/schema.js";

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
}

let agentSeq = 0;
function nextAgentId(): string {
  agentSeq += 1;
  return `agent_${Date.now().toString(36)}_${agentSeq}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class SubagentRuntime {
  private threads = new Map<string, AgentThread>();
  private aborts = new Map<string, AbortController>();
  private roles: ResolvedRole[];
  private maxThreads: number;
  private maxDepth: number;
  private jobTimeoutMs: number;

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

  /** Dispatch multi-agent tool → structured result for the model. */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: string; data?: Record<string, unknown> }> {
    if (!isMultiAgentTool(name)) {
      return {
        ok: false,
        output: `unknown multi-agent tool: ${name}`,
      };
    }
    try {
      const data = await this.dispatchInner(name, args);
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
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case "spawn_agent":
        return this.spawn(args as unknown as SpawnAgentArgs);
      case "wait_agent":
        return this.wait(args as unknown as WaitAgentArgs);
      case "send_input":
        return this.sendInput(args as unknown as SendInputArgs);
      case "close_agent":
        return this.close(args as unknown as CloseAgentArgs);
      case "list_agents":
        return this.list(args as unknown as ListAgentsArgs);
      default:
        return { ok: false, error: `unhandled: ${name}` };
    }
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
      ms:
        t.endedAt && t.startedAt
          ? t.endedAt - t.startedAt
          : Date.now() - t.startedAt,
    };
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
    if (this.openCount() >= this.maxThreads) {
      return {
        ok: false,
        error: `max_threads (${this.maxThreads}) reached — wait_agent or close_agent first`,
        code: "max_threads",
      };
    }

    const role = resolveRole(args.agent_type, this.opts.config.roles);
    const { provider, model } = this.resolveModel(args.model, role);
    const id = nextAgentId();
    const nickname =
      args.description?.trim() ||
      `${role.name} ${id.slice(-4)}`;

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
    };

    const ac = new AbortController();
    this.aborts.set(id, ac);
    if (this.opts.signal) {
      const onParentAbort = () => ac.abort();
      this.opts.signal.addEventListener("abort", onParentAbort, {
        once: true,
      });
    }

    // Job timeout
    const jobTimer = setTimeout(() => {
      if (thread.status === "running") {
        ac.abort();
        thread.error = `timeout after ${this.jobTimeoutMs}ms`;
      }
    }, this.jobTimeoutMs);

    const system = this.buildChildSystem(role, args.fork_context === true);

    const runSpan = span("subagent", "spawn", {
      id,
      type: role.id,
      model: `${provider}/${model}`,
    });

    thread.promise = (async () => {
      try {
        dbg("subagent", "child.start", {
          id,
          type: role.id,
          model: `${provider}/${model}`,
        });
        const result = await runChildLoop({
          provider,
          model,
          cwd: this.opts.cwd,
          system,
          messages: [
            { role: "system", content: system },
            { role: "user", content: message },
          ],
          toolsets: role.toolsets,
          permissions: role.permissions,
          signal: ac.signal,
          label: `child.${role.id}.${id.slice(-6)}`,
          // Use API-level effort only (same as parent); do not force low reasoning
        });
        thread.result = result.text;
        thread.rounds = result.rounds;
        thread.toolsUsed = result.toolsUsed;
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
        dbg("subagent", "child.done", {
          id,
          status: thread.status,
          rounds: result.rounds,
          outLen: result.text.length,
        });
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

    this.threads.set(id, thread);

    return {
      ok: true,
      agent_id: id,
      agent_type: role.id,
      nickname,
      status: "running" as AgentThreadStatus,
      model: `${provider}/${model}`,
      sandbox: role.sandbox,
      hint: 'Call wait_agent with this agent_id (or omit ids to wait for all) when you need the summary.',
    };
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
    for (const id of ids) {
      const t = this.threads.get(id);
      if (!t) continue;
      if (t.promise && (t.status === "running" || t.status === "queued")) {
        const remaining = timeout - (Date.now() - t0);
        if (remaining <= 0) break;
        await Promise.race([t.promise, sleep(remaining)]);
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

    // Wait if still running
    if (t.promise && t.status === "running") {
      await t.promise;
    }
    // Re-read after await (close_agent may have run)
    const latest = this.threads.get(id);
    if (!latest || latest.status === "closed") {
      return { ok: false, error: "agent closed" };
    }

    const role = resolveRole(t.agentType, this.opts.config.roles);
    t.history.push({ role: "user", content: message });
    t.status = "running";
    t.message = message;
    t.startedAt = Date.now();
    t.endedAt = undefined;
    t.error = undefined;

    const ac = new AbortController();
    this.aborts.set(id, ac);
    if (this.opts.signal?.aborted) ac.abort();

    const system = this.buildChildSystem(role, false);
    const historyMsgs: ChatMessage[] = [
      { role: "system", content: system },
      ...t.history.map((h) => ({
        role: h.role as "user" | "assistant" | "system",
        content: h.content,
      })),
    ];

    t.promise = (async () => {
      try {
        const result = await runChildLoop({
          provider: t.provider,
          model: t.model,
          cwd: this.opts.cwd,
          system,
          messages: historyMsgs,
          toolsets: role.toolsets,
          permissions: role.permissions,
          signal: ac.signal,
          label: `child.resume.${id.slice(-6)}`,
          // Use API-level effort only (same as parent); do not force low reasoning
        });
        t.result = result.text;
        t.rounds = (t.rounds ?? 0) + result.rounds;
        t.toolsUsed = [
          ...(t.toolsUsed ?? []),
          ...result.toolsUsed,
        ];
        t.history.push({ role: "assistant", content: result.text });
        t.status =
          ac.signal.aborted || result.error === "cancelled"
            ? "cancelled"
            : result.error && result.error !== "max_rounds"
              ? "failed"
              : "completed";
        if (result.error) t.error = result.error;
      } catch (err) {
        t.status = "failed";
        t.error = err instanceof Error ? err.message : String(err);
        t.result = `Subagent failed: ${t.error}`;
      } finally {
        t.endedAt = Date.now();
        this.aborts.delete(id);
      }
    })();

    return {
      ok: true,
      agent_id: id,
      status: "running",
      hint: "Call wait_agent to collect the follow-up result.",
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
      // Don't hang forever on close
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

  /** Cancel all running children (parent abort). */
  cancelAll(): void {
    for (const [id, ac] of this.aborts) {
      try {
        ac.abort();
      } catch {
        /* */
      }
      const t = this.threads.get(id);
      if (t && t.status === "running") {
        t.status = "cancelled";
        t.endedAt = Date.now();
      }
    }
  }

  private buildChildSystem(role: ResolvedRole, forkContext: boolean): string {
    const parts = [
      `You are a specialized coding subagent (role: ${role.name}, id: ${role.id}).`,
      "You help with software engineering tasks using the tools available to you. Do not claim a product identity or brand name.",
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

    // Bare model id → inherit parent provider
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
