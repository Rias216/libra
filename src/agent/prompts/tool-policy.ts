/**
 * Shared Libra tool-usage policy — remapped from OpenCode (Bash→run_terminal_command, etc.).
 * Appended or embedded by provider prompt packs.
 */

export const LIBRA_TOOL_POLICY = `# Tool usage policy
- Prefer specialized tools over shell for file operations: list_dir, read_file, write, search_replace, grep, glob.
- Reserve run_terminal_command for builds, tests, git, package managers, and real system commands. NEVER use run_terminal_command to communicate with the user or to echo values you already have from a tool result.
- You can call multiple tools in one response. When independent, call them in parallel in the same step.
- Never re-run the same tool with the same arguments — reuse prior results.
- If a path is already known, call read_file DIRECTLY. Do not list_dir first.
- Batch multi-file reads with read_file target_files (or parallel read_file calls).
- Before search_replace on a file you have not seen this turn, prefer reading it first so old_string matches exactly.
- search_replace FAILS if old_string matches multiple times without replace_all — widen context or set replace_all.
- Use todo_write for multi-step work when available; mark items completed as you go.
- Tool results and user messages may include <system-reminder> tags. Follow them; they are not user content.`;

export const LIBRA_TOOL_POLICY_SLIM = `# Tools
- Prefer list_dir, read_file, write, search_replace, grep, glob over shell.
- run_terminal_command only for builds/tests/git — never to talk or echo known values.
- Batch independent tools; reuse prior results; read known paths directly.`;

/** Gemini-specific path guidance (OpenCode gemini.txt spirit). */
export const GEMINI_PATH_POLICY = `# Paths
- Prefer workspace-relative paths for list_dir / read_file / write / search_replace.
- If you construct absolute paths, they must stay under the working directory shown in <env>.
- Relative paths like "src/index.ts" or "./package.json" are preferred.`;
