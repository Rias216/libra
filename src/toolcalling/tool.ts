/**
 * Tool identity + parallel-safety (Codex registry / OpenCode tool.ts spirit).
 */

import { canonicalToolName } from "./normalize.js";

/** Tools that may run concurrently with other parallel-safe tools. */
const PARALLEL_SAFE = new Set([
  "list_dir",
  "read_file",
  "grep",
  "glob",
  "web_search",
  "web_fetch",
  "todo_write",
  "list_agents",
  // Fire-and-forget: returns agent_id immediately; child runs in background
  "spawn_agent",
  "message_agent",
]);

/** Mutators / exclusive tools — need write-lock style admission. */
const EXCLUSIVE = new Set([
  "write",
  "search_replace",
  "run_terminal_command",
  "process",
  // Blocks until children finish — never treat as parallel-safe with parent work
  "wait_agent",
  "send_input",
  "close_agent",
]);

export function isParallelSafeTool(name: string): boolean {
  const c = canonicalToolName(name);
  if (EXCLUSIVE.has(c) || EXCLUSIVE.has(name)) return false;
  return PARALLEL_SAFE.has(c) || PARALLEL_SAFE.has(name);
}

export function waitsForCancel(name: string): boolean {
  const c = canonicalToolName(name);
  return c === "run_terminal_command" || c === "process" || c === "wait_agent";
}

/**
 * OpenCode / Codex name aliases → Libra canonical tool names.
 * Models trained on other harnesses often emit these.
 */
export const TOOL_ALIASES: Record<string, string> = {
  // OpenCode-style
  read: "read_file",
  Read: "read_file",
  write_file: "write",
  Write: "write",
  edit: "search_replace",
  Edit: "search_replace",
  edit_file: "search_replace",
  str_replace: "search_replace",
  bash: "run_terminal_command",
  shell: "run_terminal_command",
  Shell: "run_terminal_command",
  run_shell: "run_terminal_command",
  ls: "list_dir",
  list: "list_dir",
  Grep: "grep",
  Glob: "glob",
  websearch: "web_search",
  webfetch: "web_fetch",
  todowrite: "todo_write",
  // Codex-ish
  local_shell: "run_terminal_command",
};

/** Resolve model-emitted tool name to Libra canonical name. */
export function resolveToolName(name: string): string {
  if (!name) return name;
  const mapped = TOOL_ALIASES[name] ?? TOOL_ALIASES[name.toLowerCase()];
  if (mapped) return mapped;
  return canonicalToolName(name);
}
