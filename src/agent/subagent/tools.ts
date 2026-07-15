/**
 * Multi-agent tool schemas (Codex multi-agent v1 names + v2 peer messaging).
 * Parent gets full spawn surface; children get peer tools when enabled.
 */

import type { OpenAITool } from "../../toolcalling/schema.js";
import {
  defaultCapabilityForRole,
  type ResolvedRole,
} from "./roles.js";

export const MULTI_AGENT_TOOL_NAMES = [
  "spawn_agent",
  "wait_agent",
  "send_input",
  "message_agent",
  "close_agent",
  "list_agents",
] as const;

export type MultiAgentToolName = (typeof MULTI_AGENT_TOOL_NAMES)[number];

/** Tools children may use to coordinate with siblings (no spawn). */
export const PEER_TOOL_NAMES = [
  "list_agents",
  "message_agent",
  "wait_agent",
] as const;

export type PeerToolName = (typeof PEER_TOOL_NAMES)[number];

export function isMultiAgentTool(name: string): name is MultiAgentToolName {
  return (MULTI_AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

export function isPeerTool(name: string): name is PeerToolName {
  return (PEER_TOOL_NAMES as readonly string[]).includes(name);
}

function roleHelpLine(roles: ResolvedRole[]): string {
  return roles
    .map((r) => {
      const cap = defaultCapabilityForRole(r);
      const tools =
        r.sandbox === "read-only"
          ? "read/search/web (no write/shell)"
          : "read/write/shell/process";
      return `${r.id} [sandbox=${r.sandbox}, default_capability=${cap}, tools=${tools}]: ${r.description}`;
    })
    .join("\n- ");
}

export function buildMultiAgentTools(roles: ResolvedRole[]): OpenAITool[] {
  const roleIds = roles.map((r) => r.id);
  const roleHelp = roleHelpLine(roles);

  return [
    {
      type: "function",
      function: {
        name: "spawn_agent",
        description: [
          "Spawn a specialized subagent.",
          "Use for independent parallel work: deep reasoning (reason), exploration, review, tests, focused implementation.",
          "Under Ultra, prefer agent_type=reason with reasoning_effort=max to extend thinking on hard sub-problems.",
          "Returns agent_id immediately; the child runs in the background.",
          "Prefer: spawn several agents in one tool step, then one wait_agent — do not busy-wait/poll.",
          "Peers can coordinate with message_agent (and children can message each other under Ultra).",
          "Resume a completed agent with resume_from=<agent_id> + a new message.",
          "Optional capability_mode: read-only | read-write | execute | all.",
          "Optional reasoning_effort applied to the child request.",
          "",
          "Available agent_type values:",
          `- ${roleHelp}`,
        ].join("\n"),
        parameters: {
          type: "object",
          properties: {
            agent_type: {
              type: "string",
              description: `Role to spawn. One of: ${roleIds.join(", ")}`,
              enum: roleIds.length ? roleIds : undefined,
            },
            message: {
              type: "string",
              description:
                "Full task for the subagent. Be specific about scope, files, and what to return.",
            },
            description: {
              type: "string",
              description: "Short 3–5 word label for UI / logs",
            },
            model: {
              type: "string",
              description:
                "Optional model override (provider/model or model id). Soft-ignored when resume_from is set.",
            },
            reasoning_effort: {
              type: "string",
              description:
                "Optional effort override: none|low|medium|high|xhigh|max (applied to child chat).",
            },
            capability_mode: {
              type: "string",
              description:
                "Override role sandbox: read-only | read-write | execute | all",
              enum: ["read-only", "read-write", "execute", "all"],
            },
            resume_from: {
              type: "string",
              description:
                "Completed agent_id from this session to continue (prior history + new message).",
            },
            fork_context: {
              type: "boolean",
              description:
                "If true, include a short parent-context summary in the child prompt. Default false.",
            },
          },
          required: ["message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "wait_agent",
        description: [
          "Wait for one or more subagents to finish and return their summaries.",
          "Omit agent_ids to wait for all currently open (non-closed) agents.",
          "Prefer waiting once after spawning several agents in parallel.",
          "Do not poll with sleep — this tool blocks until done or timeout_ms.",
        ].join("\n"),
        parameters: {
          type: "object",
          properties: {
            agent_ids: {
              type: "array",
              items: { type: "string" },
              description: "Agent ids from spawn_agent. Omit = all open.",
            },
            timeout_ms: {
              type: "integer",
              description: "Max wait in milliseconds (default from config)",
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "send_input",
        description: [
          "Send a follow-up message to an existing subagent and resume it (parent → child).",
          "For peer-to-peer between children, prefer message_agent.",
          "If the agent is still running, the message is queued until idle.",
        ].join("\n"),
        parameters: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            message: { type: "string" },
          },
          required: ["agent_id", "message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "message_agent",
        description: [
          "Message another agent in this multi-agent session (peer chat).",
          "Works parent→child and child→child. Queues if the target is still running;",
          "delivers (and auto-resumes) when the target is idle/completed.",
          "Use for handoffs: explorer findings → worker, worker asking explorer for a path, etc.",
          "Include agent_id from list_agents or spawn_agent.",
        ].join("\n"),
        parameters: {
          type: "object",
          properties: {
            agent_id: {
              type: "string",
              description: "Target agent_id (sibling or child)",
            },
            message: {
              type: "string",
              description: "Message for the target agent",
            },
          },
          required: ["agent_id", "message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "close_agent",
        description:
          "Cancel a running subagent (if any) and close its thread. Free a slot under max_threads.",
        parameters: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
          },
          required: ["agent_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_agents",
        description:
          "List subagent threads and their status (running / completed / failed / closed). Use before message_agent to pick peers.",
        parameters: {
          type: "object",
          properties: {
            include_closed: {
              type: "boolean",
              description: "Include closed threads (default false)",
            },
          },
          required: [],
        },
      },
    },
  ];
}

/** Peer-only surface for children (no spawn/close unless depth allows spawn separately). */
export function buildPeerTools(): OpenAITool[] {
  const all = buildMultiAgentTools([]);
  return all.filter((t) =>
    (PEER_TOOL_NAMES as readonly string[]).includes(t.function.name),
  );
}

/** System-prompt block for the parent when multi-agent is enabled. */
export function buildMultiAgentSystemAddon(opts: {
  roles: ResolvedRole[];
  maxThreads: number;
  maxDepth: number;
  /** Ultra / ultra-fusion: encourage proactive delegation */
  proactive: boolean;
  peerMessaging?: boolean;
}): string {
  const roleLines = opts.roles
    .map((r) => {
      const cap = defaultCapabilityForRole(r);
      return `- **${r.id}** (sandbox=${r.sandbox}, capability=${cap}): ${r.description}`;
    })
    .join("\n");

  const peerNote = opts.peerMessaging !== false
    ? `
## Peer messaging
- message_agent — send a message to another agent by id (queued if running)
- Children also have list_agents / message_agent / wait_agent so they can talk to each other
- Pattern: spawn explorer + worker → explorer message_agent(worker, findings) OR parent wait then synthesize
`
    : "";

  const proactiveBlock = opts.proactive
    ? `
# Ultra multi-agent — REQUIRED (reasoning + execution)
The harness may have already forced parallel **reason** / **explorer** subagents to extend thinking.
You still MUST keep using multi-agent tools for the rest of the turn:
1. Treat forced reasoning briefs (if present) as primary planning input — synthesize, do not ignore
2. Spawn **reason** again when a hard sub-problem needs a second deep pass
3. Spawn **explorer** for more evidence; spawn **worker/implement** for changes
4. Optionally spawn **review** after implementation
5. Prefer **spawn N in one tool step**, then **one wait_agent**
6. Use **message_agent** so peers share findings (explorer → worker) instead of only reporting to you
7. Do NOT solve multi-axis work solo when spawn_agent is available — delegate first
Dual-reason Fusion traces (if present) are for **planning only**; spawn_agent is for **execution + further reasoning**.
Do not dump raw tool logs to the user — summarize path:line findings.
`
    : `
# When to delegate
Spawn subagents when the user asks for parallel agents, or when independent workstreams would clearly reduce context pollution.
Spawn several → one wait_agent. Use message_agent for peer handoffs; resume_from / send_input for follow-ups.
`;

  return `
# Multi-agent
You coordinate specialized subagents. Each runs in an isolated context; summaries and peer messages return here.

## Tools
- spawn_agent — start a child (returns agent_id immediately). Supports reasoning_effort, capability_mode, resume_from.
- wait_agent — block until children finish; get summaries
- message_agent — peer/parent message to an agent (queue or resume)
- send_input — parent follow-up / resume a child
- close_agent — cancel and free a slot
- list_agents — status overview
${peerNote}
## Limits
- max concurrent threads: ${opts.maxThreads}
- max spawn depth: ${opts.maxDepth} (children spawn only when depth remains)
- Prefer parallel spawn then a single wait. Parent may receive <subagent_completed> notices.

## Roles
${roleLines}
${proactiveBlock}
## Output contract for children (tell them in message)
Ask each child to return: findings, file references (path:line), and recommended next steps — not full file dumps.
When peers should coordinate, give them each other's agent_id after spawn (or tell them to list_agents).
`.trim();
}

/** Extra system text for children with peer tools. */
export function buildPeerChildSystemAddon(selfId: string): string {
  return `
# Peer multi-agent tools (this session)
Your agent_id is ${selfId}.
You can coordinate with sibling agents:
- list_agents — see peers and status
- message_agent — send them a handoff/question (queued if they are still running)
- wait_agent — wait for peer(s) if you need their result before continuing
Do not claim to spawn new agents unless spawn_agent is in your tool list.
Keep messages concise with path:line refs.
`.trim();
}

/** Format a queued peer message as a user turn. */
export function formatPeerUserMessage(
  from: string,
  message: string,
): string {
  return `[peer message from ${from}]\n${message}`;
}
