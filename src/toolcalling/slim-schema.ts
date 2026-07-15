/**
 * Slim OpenAI tool schemas — short descriptions for low-stakes turns / benches.
 * Full schemas stay in schema.ts for production quality.
 */

import type { OpenAITool } from "./schema.js";
import { OPENAI_TOOLS } from "./schema.js";

const SLIM_DESC: Record<string, string> = {
  list_dir: "List files in a directory (prefer over shell ls/dir).",
  read_file:
    "Read file(s). Use target_file or target_files (batch). Prefer over cat/type.",
  write: "Write full file contents (creates parents).",
  search_replace:
    "Exact string edit. old_string must be unique unless replace_all.",
  grep: "Search file contents by regex/pattern.",
  glob: "Find files by glob pattern.",
  run_terminal_command:
    "Run a shell command (builds/tests/git only — not for reading files).",
  web_search: "Search the web.",
  todo_write: "Update the session todo list.",
  process: "Manage background processes (poll/log/wait/kill).",
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
