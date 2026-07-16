/**
 * Tool registry — names, descriptions, and arg hints used by the
 * agent loop and by deep autocomplete (`@tool` / command palette).
 */

export interface ToolDef {
  name: string;
  description: string;
  /** Example arg keys for suggestion chips */
  args: string[];
  category: "fs" | "search" | "shell" | "web" | "meta" | "process";
}

export const BUILTIN_TOOLS: ToolDef[] = [
  {
    name: "list_dir",
    description: "List directory entries (prefer over shell ls)",
    args: ["target_directory"],
    category: "fs",
  },
  {
    name: "read_file",
    description: "Read file(s); use target_files for batch / parallel-friendly multi-read",
    args: ["target_file", "target_files", "offset", "limit"],
    category: "fs",
  },
  {
    name: "write",
    description: "Write full file (prefer edit when possible)",
    args: ["file_path", "content"],
    category: "fs",
  },
  {
    name: "search_replace",
    description: "Exact string edit (fails if ambiguous without replace_all)",
    args: ["file_path", "old_string", "new_string", "replace_all"],
    category: "fs",
  },
  {
    name: "grep",
    description: "Regex content search (prefer over shell grep)",
    args: ["pattern", "path", "glob"],
    category: "search",
  },
  {
    name: "glob",
    description: "Find files by name pattern",
    args: ["pattern"],
    category: "search",
  },
  {
    name: "run_terminal_command",
    description: "Shell for builds/tests/git — not file ops; background=true for servers",
    args: ["command", "description", "timeout_ms", "background"],
    category: "shell",
  },
  {
    name: "process",
    description: "Manage background shell sessions (list/poll/log/wait/kill/write)",
    args: ["action", "session_id", "data", "timeout_ms"],
    category: "process",
  },
  {
    name: "web_search",
    description: "Search the web",
    args: ["query"],
    category: "web",
  },
  {
    name: "web_fetch",
    description: "Fetch a URL as text/markdown",
    args: ["url"],
    category: "web",
  },
  {
    name: "todo_write",
    description: "Update the task list (merge by id optional)",
    args: ["items", "merge"],
    category: "meta",
  },
  {
    name: "update_goal",
    description:
      "Goal progress tool: message / completed / blocked_reason (goal mode only)",
    args: ["completed", "message", "blocked_reason"],
    category: "meta",
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return BUILTIN_TOOLS.find((t) => t.name === name);
}

export function toolNames(): string[] {
  return BUILTIN_TOOLS.map((t) => t.name);
}
