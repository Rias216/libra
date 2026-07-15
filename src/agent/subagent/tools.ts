/**
 * Multi-agent v1 tool schemas (Codex-compatible names).
 * Parent agent calls these; children do not receive them (max_depth).
 */

import type { OpenAITool } from "../../toolcalling/schema.js";
import type { ResolvedRole } from "./roles.js";

export const MULTI_AGENT_TOOL_NAMES = [
  "spawn_agent",
  "wait_agent",
  "send_input",
  "close_agent",
  "list_agents",
] as const;

export type MultiAgentToolName = (typeof MULTI_AGENT_TOOL_NAMES)[number];

export function isMultiAgentTool(name: string): name is MultiAgentToolName {
  return (MULTI_AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

export function buildMultiAgentTools(roles: ResolvedRole[]): OpenAITool[] {
  const roleIds = roles.map((r) => r.id);
  const roleHelp = roles
    .map((r) => `${r.id} (${r.sandbox}): ${r.description}`)
    .join("; ");

  return [
    {
      type: "function",
      function: {
        name: "spawn_agent",
        description: [
          "Spawn a specialized subagent in an isolated context (Codex multi-agent v1).",
          "Use for independent parallel work: exploration, review, tests, focused implementation.",
          "Returns agent_id immediately; the child runs in the background.",
          "Call wait_agent to collect results. Prefer multiple spawn_agent calls in one step, then one wait_agent.",
          "",
          "Available agent_type values:",
          roleHelp,
          "",
          "Children return a summary only — intermediate tool noise stays off the main thread.",
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
                "Optional model override (provider/model or model id). Default: parent or role preference.",
            },
            reasoning_effort: {
              type: "string",
              description:
                "Optional effort override: none|low|medium|high|xhigh|max",
            },
            fork_context: {
              type: "boolean",
              description:
                "If true, include a short parent-context summary in the child prompt. Default false (fresh spawn).",
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
          "Send a follow-up message to an existing subagent and resume it.",
          "Use after wait_agent when you need clarification or a second pass.",
          "If the agent is still running, the message is queued until it becomes idle.",
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
          "List subagent threads and their status (running / completed / failed / closed).",
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

/** System-prompt block for the parent when multi-agent is enabled. */
export function buildMultiAgentSystemAddon(opts: {
  roles: ResolvedRole[];
  maxThreads: number;
  maxDepth: number;
  /** Ultra / ultra-fusion: encourage proactive delegation */
  proactive: boolean;
}): string {
  const roleLines = opts.roles
    .map((r) => `- **${r.id}** (${r.sandbox}): ${r.description}`)
    .join("\n");

  const proactiveBlock = opts.proactive
    ? `
# Proactive delegation (Ultra)
When the user task has independent parallel workstreams, spawn subagents without waiting to be asked:
- exploration / evidence gathering → explorer
- focused implementation → worker
- review / security / tests → matching roles
Spawn several in one step, then wait_agent once, then synthesize. Do not dump raw tool logs to the user — summarize.
`
    : `
# When to delegate
Spawn subagents when the user asks for parallel agents, or when independent workstreams would clearly reduce context pollution (large exploration, multi-axis review, split implementation).
`;

  return `
# Multi-agent (Codex v1-style)
You can coordinate specialized subagents. Each runs in an isolated context; only summaries return here.

## Tools
- spawn_agent — start a child (returns agent_id immediately)
- wait_agent — block until children finish; get summaries
- send_input — follow-up / resume a child
- close_agent — cancel and free a slot
- list_agents — status overview

## Limits
- max concurrent threads: ${opts.maxThreads}
- max spawn depth: ${opts.maxDepth} (children cannot spawn further when depth is exhausted)
- Prefer parallel spawn then a single wait.

## Roles
${roleLines}
${proactiveBlock}
## Output contract for children (tell them in message)
Ask each child to return: findings, file references (path:line), and recommended next steps — not full file dumps.
`.trim();
}
