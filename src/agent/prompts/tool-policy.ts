/**
 * Shared Libra tool-usage policy — remapped from OpenCode (Bash→run_terminal_command, etc.).
 * Appended or embedded by provider prompt packs.
 */

export const LIBRA_TOOL_POLICY = `# Tool usage policy
- Prefer specialized tools over shell for file operations: list_dir, read_file, write, search_replace, grep, glob.
- Prefer **check** over shell \`tsc --noEmit\` / eslint for diagnostics. Prefer the **git** tool (status/diff/log/blame) over shell git for those actions; use shell only for commit/push/pull/rebase.
- Expansion tools when available: list_windows, screenshot, read_image, browser_devtools, wait_for_port, clipboard_read, find_symbol, patch_apply — use them instead of ad-hoc shell/PowerShell.
- For internet research: web_search first for queries, then web_fetch on the best URLs. Do not invent URLs or scrape via shell curl when web_fetch is available.
- Reserve run_terminal_command for builds, tests, package managers, and real system commands. NEVER use run_terminal_command to communicate with the user or to echo values you already have from a tool result.
- You can call multiple tools in one response. When independent, call them in **parallel in the same step** (e.g. git status + find_symbol + check together). Do not serialize independent reads.
- Never re-run the same tool with the same arguments — reuse prior results.
- If a path is already known, call read_file DIRECTLY. Do not list_dir first.
- Batch multi-file reads with read_file target_files (or parallel read_file calls).
- Before search_replace on a file you have not seen this turn, prefer reading it first so old_string matches exactly.
- search_replace FAILS if old_string matches multiple times without replace_all — widen context or set replace_all.
- patch_apply FAILS on context mismatch — re-read the file, copy exact lines into the unified diff, retry (do not guess).
- Use todo_write for multi-step work when available; mark items completed as you go.
- On Windows the shell is cmd.exe by default: \`&&\` chaining and npm/npx work. Prefer relative paths. Do not burn steps rediscovering the shell.
- Prefer writing source with the write tool, then one install + one test command — avoid many exploratory shell probes.
- Tool results and user messages may include <system-reminder> tags. Follow them; they are not user content.`;

export const LIBRA_TOOL_POLICY_SLIM = `# Tools
- Prefer list_dir, read_file, write, search_replace, grep, glob, check, git over shell.
- run_terminal_command only for builds/tests/package managers — never to talk or echo known values; not for tsc/git status/diff/log/blame.
- Batch independent tools in one step; reuse prior results; read known paths directly.
- patch_apply: on mismatch, re-read then retry with exact context.`;

/** Gemini-specific path guidance (OpenCode gemini.txt spirit). */
export const GEMINI_PATH_POLICY = `# Paths
- Prefer workspace-relative paths for list_dir / read_file / write / search_replace.
- If you construct absolute paths, they must stay under the working directory shown in <env>.
- Relative paths like "src/index.ts" or "./package.json" are preferred.`;
