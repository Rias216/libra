/**
 * Tool registry — names, descriptions, and arg hints used by the
 * agent loop and by deep autocomplete (`@tool` / command palette).
 */

export interface ToolDef {
  name: string;
  description: string;
  /** Example arg keys for suggestion chips */
  args: string[];
  category: "fs" | "search" | "shell" | "web" | "meta";
}

export const BUILTIN_TOOLS: ToolDef[] = [
  {
    name: "list_dir",
    description: "List files in a directory",
    args: ["target_directory"],
    category: "fs",
  },
  {
    name: "read_file",
    description: "Read file contents (optional line range)",
    args: ["target_file", "offset", "limit"],
    category: "fs",
  },
  {
    name: "write",
    description: "Write a full file",
    args: ["file_path", "content"],
    category: "fs",
  },
  {
    name: "search_replace",
    description: "Exact string replace in a file",
    args: ["file_path", "old_string", "new_string"],
    category: "fs",
  },
  {
    name: "grep",
    description: "Search file contents with regex",
    args: ["pattern", "path", "glob"],
    category: "search",
  },
  {
    name: "glob",
    description: "Find files by glob pattern",
    args: ["pattern"],
    category: "search",
  },
  {
    name: "run_terminal_command",
    description: "Execute a shell command",
    args: ["command", "timeout"],
    category: "shell",
  },
  {
    name: "web_search",
    description: "Search the web",
    args: ["query"],
    category: "web",
  },
  {
    name: "web_fetch",
    description: "Fetch a URL as markdown",
    args: ["url"],
    category: "web",
  },
  {
    name: "todo_write",
    description: "Update the task list",
    args: ["todos"],
    category: "meta",
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return BUILTIN_TOOLS.find((t) => t.name === name);
}

export function toolNames(): string[] {
  return BUILTIN_TOOLS.map((t) => t.name);
}
