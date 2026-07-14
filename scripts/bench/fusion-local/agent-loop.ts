/**
 * Headless agent loop matching combined-harness.md §2–3.
 */

import { chatComplete, type ChatMessage, type ToolCall } from "../../../src/llm/client.js";
import type { ProviderId } from "../../../src/auth/types.js";
import type { OpenAITool } from "../../../src/toolcalling/schema.js";
import { ToolExecutor } from "../../../src/toolcalling/executor.js";
import {
  normalizeToolArgs,
  parseToolArgs,
} from "../../../src/toolcalling/normalize.js";
import type { ToolTraceEntry } from "./hard-checks.js";
import { appendJsonl } from "./sandbox.js";

export interface AgentLoopConfig {
  provider: ProviderId;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: OpenAITool[];
  workspace: string;
  maxTurns: number;
  timeoutS: number;
  transcriptPath: string;
  temperature?: number;
  label?: string;
}

export interface AgentLoopResult {
  status: "finished" | "finished_failed" | "max_turns" | "timeout" | "error";
  finalAnswer: string;
  success?: boolean;
  turns: number;
  toolCalls: number;
  durationMs: number;
  trace: ToolTraceEntry[];
  error?: string;
}

export async function runHeadlessAgent(
  cfg: AgentLoopConfig,
): Promise<AgentLoopResult> {
  const t0 = Date.now();
  const executor = new ToolExecutor(cfg.workspace, {
    resultStyle: "json",
    shellAllowlist: true,
  });

  const messages: ChatMessage[] = [
    { role: "system", content: cfg.systemPrompt },
    { role: "user", content: cfg.userPrompt },
  ];
  appendJsonl(cfg.transcriptPath, { role: "system", content: cfg.systemPrompt });
  appendJsonl(cfg.transcriptPath, { role: "user", content: cfg.userPrompt });

  const trace: ToolTraceEntry[] = [];
  let finalAnswer = "";
  let status: AgentLoopResult["status"] = "max_turns";
  let success: boolean | undefined;
  let turns = 0;
  let toolCalls = 0;
  let nudged = false;

  const deadline = t0 + cfg.timeoutS * 1000;

  try {
    for (let turn = 1; turn <= cfg.maxTurns; turn++) {
      if (Date.now() > deadline) {
        status = "timeout";
        turns = turn - 1;
        break;
      }
      turns = turn;

      const resp = await chatComplete({
        provider: cfg.provider,
        model: cfg.model,
        messages,
        tools: cfg.tools,
        tool_choice: "auto",
        temperature: cfg.temperature ?? 0,
        stream: false,
        applyNativeReasoning: false,
        max_tokens: 4096,
        label: `${cfg.label ?? "fusion"}.t${turn}`,
      });

      if (!resp.tool_calls.length) {
        messages.push({ role: "assistant", content: resp.content || "" });
        appendJsonl(cfg.transcriptPath, {
          role: "assistant",
          content: resp.content,
          turn,
        });

        // Soft-final: if model dumps an answer without finish, accept once as last resort near end
        if (!nudged) {
          nudged = true;
          messages.push({
            role: "user",
            content:
              "Headless mode: use tools or call finish. Do not ask questions.",
          });
          appendJsonl(cfg.transcriptPath, {
            role: "user",
            content: "nudge",
            turn,
          });
          continue;
        }

        // Second plain-text: capture as soft final
        if (resp.content?.trim()) {
          finalAnswer = resp.content.trim();
          status = "finished";
        }
        break;
      }

      // Normalize tool call args for execution + trace
      const validated: ToolCall[] = resp.tool_calls.map((tc) => {
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

      messages.push({
        role: "assistant",
        content: resp.content || null,
        tool_calls: validated,
      });
      appendJsonl(cfg.transcriptPath, {
        role: "assistant",
        turn,
        tool_calls: validated.map((t) => ({
          id: t.id,
          name: t.function.name,
          arguments: t.function.arguments,
        })),
        content: resp.content,
      });

      let finishArgs: Record<string, unknown> | null = null;

      // Execute all tools (parallel), but finish is not executed as a real tool
      const nonFinish = validated.filter((t) => t.function.name !== "finish");
      const finishCalls = validated.filter((t) => t.function.name === "finish");

      const execResults = await Promise.all(
        nonFinish.map(async (tc) => {
          const args = parseToolArgs(tc.function.arguments);
          const exec = await executor.run(tc.function.name, args);
          const result =
            exec.data ??
            (exec.ok
              ? { ok: true, content: exec.output }
              : { ok: false, error: exec.output });
          return { tc, args, result, duration_ms: exec.durationMs };
        }),
      );

      for (const { tc, args, result, duration_ms } of execResults) {
        toolCalls++;
        // Prefer original catalog arg shape in trace when possible
        const traceArgs = denormalizeForTrace(tc.function.name, args);
        const entry: ToolTraceEntry = {
          turn,
          id: tc.id,
          name: tc.function.name,
          arguments: traceArgs,
          result,
          duration_ms,
        };
        trace.push(entry);
        const content = JSON.stringify(result);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content,
        });
        appendJsonl(cfg.transcriptPath, {
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content,
          turn,
        });
      }

      for (const tc of finishCalls) {
        toolCalls++;
        const args = parseToolArgs(tc.function.arguments);
        finishArgs = args;
        const entry: ToolTraceEntry = {
          turn,
          id: tc.id,
          name: "finish",
          arguments: args,
          result: { ok: true, finished: true },
          duration_ms: 0,
        };
        trace.push(entry);
        appendJsonl(cfg.transcriptPath, {
          role: "tool",
          tool_call_id: tc.id,
          name: "finish",
          content: JSON.stringify(entry.result),
          turn,
        });
      }

      if (finishArgs != null) {
        // Coerce numbers/bools; trim so hard regexes like ^VALUE=\d+$ match cleanly
        const rawAns = finishArgs.answer;
        finalAnswer =
          rawAns == null
            ? ""
            : typeof rawAns === "string"
              ? rawAns.trim()
              : String(rawAns).trim();
        success = finishArgs.success !== false;
        status = success ? "finished" : "finished_failed";
        break;
      }
    }
  } catch (e) {
    status = "error";
    return {
      status,
      finalAnswer,
      success,
      turns,
      toolCalls,
      durationMs: Date.now() - t0,
      trace,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  return {
    status,
    finalAnswer,
    success,
    turns,
    toolCalls,
    durationMs: Date.now() - t0,
    trace,
  };
}

/** Emit catalog-friendly arg keys in tool_trace for judge readability. */
function denormalizeForTrace(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...args };
  switch (name) {
    case "read_file":
      if (out.target_file != null && out.path == null) {
        out.path = out.target_file;
        delete out.target_file;
      }
      break;
    case "write_file":
    case "edit_file":
      if (out.file_path != null && out.path == null) {
        out.path = out.file_path;
        delete out.file_path;
      }
      break;
    case "list_dir":
      if (out.target_directory != null && out.path == null) {
        out.path = out.target_directory;
        delete out.target_directory;
      }
      break;
    case "run_shell":
      if (out.timeout_ms != null && out.timeout_s == null) {
        out.timeout_s = Math.round(Number(out.timeout_ms) / 1000);
        delete out.timeout_ms;
      }
      break;
    default:
      break;
  }
  return out;
}

export function buildAgentUser(caseTask: {
  task: string;
  context: string;
  constraints: string;
  tools?: string[];
}): string {
  const parts = [
    "## Task",
    caseTask.task.trim(),
    "",
    "## Context",
    caseTask.context.trim() || "(none)",
    "",
    "## Constraints",
    caseTask.constraints.trim() || "(none)",
    "",
    "## Workspace",
    "Your current working directory is the case sandbox workspace.",
    "Use tools to inspect files. Call finish when done.",
  ];
  if (caseTask.tools?.length) {
    parts.push(
      "",
      `Tools enabled for this case: ${caseTask.tools.join(", ")}`,
    );
  }
  return parts.join("\n");
}
