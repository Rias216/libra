/**
 * Slim OpenAI tool schemas — short descriptions for low-stakes turns / benches.
 * Full schemas stay in schema.ts for production quality.
 */

import type { OpenAITool } from "./schema.js";
import { OPENAI_TOOLS } from "./schema.js";

const SLIM_DESC: Record<string, string> = {
  list_dir: "List files in a directory (prefer over shell ls/dir).",
  read_file:
    "Read file(s) as LINE_NUMBER→content. target_file or target_files. Negative offset = from end. Prefer over cat/type.",
  write: "Write full file contents (creates parents).",
  search_replace:
    "Exact string edit. Do not paste LINE_NUMBER→ prefixes. old_string must be unique unless replace_all; re-read on failure.",
  grep: "Search file contents by regex/pattern.",
  glob: "Find files by glob pattern.",
  run_terminal_command:
    "Run a shell command (builds/tests/git). Prefer specialized tools for file ops. On Windows avoid missing unix utils; background=true + process tool, no sleep-poll.",
  web_search: "Search the web.",
  todo_write: "Update the session todo list.",
  process: "Manage background processes (poll/log/wait/kill — do not sleep-poll).",
};

/** Return schemas with short descriptions; parameters unchanged. */
export function slimToolSchemas(tools: OpenAITool[] = OPENAI_TOOLS): OpenAITool[] {
  return tools.map((t) => {
    const name = t.function.name;
    const desc = SLIM_DESC[name] ?? t.function.description.split("\n")[0] ?? name;
    return {
      type: "function" as const,
      function: {
        name,
        description: desc,
        parameters: t.function.parameters,
      },
    };
  });
}

export function estimateSchemaChars(tools: OpenAITool[]): number {
  return JSON.stringify(tools).length;
}
