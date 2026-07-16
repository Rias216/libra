/**
 * OpenAI-compatible tool definitions.
 *
 * Descriptions follow OpenCode's pattern: short purpose line + Usage bullets
 * that teach when to batch, when to skip, and when to prefer this tool over shell.
 * @see https://github.com/anomalyco/opencode (packages/opencode/src/tool/*.txt)
 */

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const OPENAI_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: [
        "List files and directories at a workspace path.",
        "",
        "Usage:",
        "- Omit target_directory or use \".\" for the workspace root.",
        "- Prefer this over shell ls/dir.",
        "- SKIP list_dir when you already know the file path — call read_file directly.",
        "- Do not re-list a path you already listed this turn.",
        "- Independent of other tools: run list_dir in parallel with unrelated reads/greps in the same step.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          target_directory: {
            type: "string",
            description: "Directory relative to workspace. Default: '.'",
            default: ".",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: [
        "Read one or more text files from the workspace.",
        "",
        "Usage:",
        "- target_file for a single path; target_files for a BATCH of paths in ONE call (preferred for 2+ files).",
        "- You can also issue multiple read_file calls in the SAME step in parallel.",
        "- Results are returned with line numbers: LINE_NUMBER→LINE_CONTENT (no padding).",
        "- When editing: the LINE_NUMBER→ prefix is NOT file content — match only the text after →.",
        "- Optional offset/limit apply to single-file reads only. offset is 1-based; negative offset starts from the end of the file (e.g. -20 = last 20 lines when used with limit).",
        "- Default limit is 2000 lines; if truncated, the result tells you the next offset.",
        "- Prefer this over shell cat/type/head. Cannot read binary files.",
        "- If the path is known, do not list_dir first.",
        "- Do not re-read the same unchanged file. Avoid tiny repeated slices; use a larger window if needed.",
        "- Use grep to find content in large files; use glob when you only know a name pattern.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          target_file: {
            type: "string",
            description: "Single file path (use target_files for 2+ files)",
          },
          target_files: {
            type: "array",
            items: { type: "string" },
            description:
              "Batch read multiple paths in one tool call (avoids extra model rounds)",
          },
          offset: {
            type: "integer",
            description:
              "1-based start line, or negative to count from end of file (single-file only)",
          },
          limit: {
            type: "integer",
            description: "Max lines to return (single-file only)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: [
        "Write full contents to a file (creates parent directories). Overwrites if present.",
        "",
        "Usage:",
        "- Prefer search_replace / edit of existing files over write when only a region changes.",
        "- Prefer this over shell redirection (echo >, cat <<EOF).",
        "- Do not create documentation/README files unless the user asked.",
        "- For brand-new files this is correct; for large rewrites of known files, write is fine after reading.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path relative to workspace" },
          content: {
            type: "string",
            description:
              "Full new file contents (required; use empty string \"\" only to create an empty file)",
          },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_replace",
      description: [
        "Exact string replacement in a file (once or all occurrences).",
        "",
        "Usage:",
        "- Prefer editing existing files over writing new ones.",
        "- Prefer this over shell sed/awk.",
        "- old_string must match the file exactly (including whitespace). If unsure, read_file first this turn.",
        "- When copying from a numbered read_file result, do NOT include the LINE_NUMBER→ prefix — only the text after →. (The harness also strips pasted N→ prefixes defensively.)",
        "- If old_string matches multiple times, the tool FAILS unless replace_all=true — include more context to make it unique.",
        "- Use replace_all when renaming a symbol across the whole file.",
        "- new_string may be \"\" to delete the matched text.",
        "- Fails if old_string is missing or ambiguous (multiple matches without replace_all). On failure, re-read with read_file before retrying.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string", description: "Exact text to find" },
          new_string: {
            type: "string",
            description: 'Replacement text (use "" to delete the match)',
          },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence (default false = first only)",
          },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: [
        "Search file contents with a regex or literal pattern.",
        "",
        "Usage:",
        "- Fast content search; prefer this over shell grep/rg for normal searches.",
        "- Filter with path and/or glob (e.g. \"*.ts\", \"*.{ts,tsx}\").",
        "- Batch independent greps in the same step when useful.",
        "- For open-ended multi-round exploration, keep greps parallel and focused.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex or string pattern" },
          path: { type: "string", description: "File or directory (default workspace root)" },
          glob: { type: "string", description: "e.g. **/*.ts" },
          case_insensitive: { type: "boolean" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: [
        "Find files by glob pattern under the workspace.",
        "",
        "Usage:",
        "- Patterns like \"**/*.ts\" or \"src/**/*.tsx\".",
        "- Prefer this over shell find when matching by name.",
        "- When you need several patterns, call glob multiple times in parallel in one step.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "e.g. **/*.ts" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_terminal_command",
      description: [
        "Run a shell command in the workspace.",
        "",
        "Usage:",
        "- Use for builds, tests, git, package managers, and OS commands that require a real shell.",
        "- Prefer specialized tools for file ops: list_dir, read_file, write, search_replace, grep, glob.",
        "- On Windows, unix utilities (grep, cat, find, head, tail, sed, awk) may be missing — use list_dir / read_file / grep / glob instead of shell for those.",
        "- NEVER use shell to talk to the user (no echo of explanations).",
        "- Avoid destructive commands unless the user asked.",
        "- Provide a short description (5–10 words) of what the command does.",
        "- Set background=true for long-running servers; then manage with the process tool (poll/log/wait). Do NOT busy-poll with sleep loops — use process(action=\"wait\"|\"poll\").",
        "- Independent shell commands may run in parallel in the same step when safe.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          description: {
            type: "string",
            description:
              "Clear 5–10 word summary of what this command does (for UI + logs)",
          },
          timeout_ms: {
            type: "integer",
            description: "Timeout in milliseconds (default 30000). Ignored when background=true.",
          },
          background: {
            type: "boolean",
            description:
              "If true, start in background and return session_id immediately (Hermes-style)",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "process",
      description: [
        "Manage background processes started with run_terminal_command(background=true).",
        "",
        "Actions:",
        '- list — show all sessions',
        '- poll — status + recent stdout/stderr for session_id',
        '- log — full output (offset/limit pagination)',
        '- wait — block until exit or timeout_ms',
        '- kill — terminate session_id',
        '- write — send data to stdin',
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "list | poll | log | wait | kill | write",
            enum: ["list", "poll", "log", "wait", "kill", "write"],
          },
          session_id: {
            type: "string",
            description: "Required for poll/log/wait/kill/write",
          },
          data: {
            type: "string",
            description: "Data to write to stdin (action=write)",
          },
          timeout_ms: {
            type: "integer",
            description: "Max wait for action=wait (default 60000)",
          },
          offset: { type: "integer", description: "Byte offset for log" },
          limit: { type: "integer", description: "Max bytes for log" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: [
        "Search the public web and return ranked results (title, URL, snippet).",
        "",
        "Usage:",
        "- Prefer this before guessing URLs. Then web_fetch the best links.",
        "- Good for docs, APIs, news, facts, package pages.",
        "- Read-only; does not modify the workspace.",
        "- Pass a focused query (keywords + intent), not a full essay.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query string (alias names pattern/q/search also accepted at runtime)",
          },
          max_results: {
            type: "integer",
            description: "Max results to return (default 8, max 12)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: [
        "Fetch a URL and return readable text content (HTML stripped; may be truncated).",
        "",
        "Usage:",
        "- Fully-formed URL required; bare domains and http are upgraded to https.",
        "- Use after web_search when you need full page text.",
        "- Read-only; does not modify the workspace. Binary/PDF not supported.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description: [
        "Create or update the session todo list for multi-step work.",
        "",
        "Usage:",
        "- Use for complex tasks with 3+ steps.",
        "- Pass items:[{id,content,status}] (or todos) to replace the list.",
        "- id is optional (auto-assigned). status: pending|in_progress|completed|cancelled.",
        "- Set merge=true to update items by id without wiping others.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
              },
              required: ["content"],
            },
          },
          todos: {
            type: "array",
            description: "Alias for items (same shape)",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string" },
              },
            },
          },
          merge: {
            type: "boolean",
            description: "Merge by id instead of replacing the whole list",
          },
        },
        // Prefer items; todos accepted at runtime if items omitted
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_goal",
      description: [
        "Report progress on the active goal. Use to log a status message,",
        "mark the goal completed, or flag that you're blocked.",
        "",
        "Usage notes:",
        "- Set completed: true ONLY when the goal is fully achieved. This does NOT",
        "  end the goal on the model's word alone — the harness runs adversarial",
        "  verification against the plan's acceptance criteria first.",
        "- Use message for progress notes or a completion summary.",
        "- Set blocked_reason only when truly stuck after multiple failed attempts",
        "  (FAILURE signal — never put success text there).",
        "- Only available while a /goal is active.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          completed: {
            type: "boolean",
            description:
              "Set true only when fully achieved; harness verifies before completing.",
          },
          message: {
            type: "string",
            description:
              "Optional progress note or completion summary.",
          },
          blocked_reason: {
            type: "string",
            description:
              "Pause the goal as blocked when truly stuck (not for success).",
          },
        },
        required: [],
      },
    },
  },
  // ── Expansion tools (libra-expansion.md) ──────────────────────────
  {
    type: "function",
    function: {
      name: "list_windows",
      description: [
        "Enumerate visible OS windows.",
        "",
        "Usage:",
        "- Returns {pid, title, processName, bounds}[] for each visible window.",
        "- Use before screenshot when targeting a specific window by pid.",
        "- Read-only; no capture.",
      ].join("\n"),
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: [
        "Capture a screenshot of a window, browser tab, or (explicitly) the full screen.",
        "",
        "Usage:",
        "- Prefer session_id (background process), pid (from list_windows), or url (browser).",
        "- Browser defaults to raw CDP (remote-debugging-port). engine:\"playwright\" is optional.",
        "- Never captures beyond the resolved target unless full_screen=true (requires approval).",
        "- Saves under .libra/screenshots/ and returns an image content block when the model has vision.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "Background process session from run_terminal_command(background=true)",
          },
          pid: { type: "integer", description: "Process id of the window to capture" },
          url: { type: "string", description: "Browser URL (CDP or Playwright)" },
          selector: {
            type: "string",
            description: "CSS selector for element capture (Playwright)",
          },
          full_page: { type: "boolean", description: "Full-page browser capture" },
          engine: {
            type: "string",
            enum: ["cdp", "playwright"],
            description: 'Browser engine (default "cdp")',
          },
          full_screen: {
            type: "boolean",
            description: "Capture entire screen (explicit opt-in; requires ask)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_image",
      description: [
        "Read an existing image file from the workspace and return it as an image content block.",
        "",
        "Usage:",
        "- Use for PNGs/JPEGs that read_file rejects as binary.",
        "- Path must be inside the workspace.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Image path relative to workspace" },
          file_path: { type: "string", description: "Alias for path" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_devtools",
      description: [
        "Drive a Chrome/Edge tab via raw CDP (no Playwright).",
        "",
        "Actions (same multiplexing shape as process):",
        '- goto — navigate targetId to url',
        '- click — click selector',
        '- fill — set selector value to text',
        '- screenshot — capture tab (scoped to targetId)',
        '- console_log — page context snapshot',
        '- eval — Runtime.evaluate expression',
        "",
        "Always scoped to one targetId (tab). Requires a browser with --remote-debugging-port.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["goto", "click", "fill", "screenshot", "console_log", "eval"],
          },
          targetId: { type: "string", description: "CDP target id (tab)" },
          target_id: { type: "string", description: "Alias for targetId" },
          url: { type: "string" },
          selector: { type: "string" },
          text: { type: "string", description: "Value for fill" },
          expression: { type: "string", description: "JS for eval" },
          cdp_port: { type: "integer", description: "Default 9222" },
          cdp_host: { type: "string", description: "Default 127.0.0.1" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check",
      description: [
        "Run project typecheck (tsc --noEmit) and eslint when configured; return structured diagnostics.",
        "",
        "Usage:",
        "- Prefer over raw shell tsc for parseable {file,line,col,severity,code,message}[].",
        "- Read-only.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          tsc: { type: "boolean", description: "Run tsc (default true when tsconfig exists)" },
          eslint: {
            type: "boolean",
            description: "Run eslint when config present (default auto)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git",
      description: [
        "Structured git status / diff / log / blame (prefer over raw shell git for UI-friendly output).",
        "",
        "Actions:",
        '- status — branch + porcelain files',
        '- diff — unified diff parsed into DiffHunk/DiffLine',
        '- log — recent commits',
        '- blame — per-line blame for path',
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "diff", "log", "blame"],
          },
          path: { type: "string", description: "File path for diff/blame" },
          staged: { type: "boolean", description: "diff --cached" },
          limit: { type: "integer", description: "log limit (default 10)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "patch_apply",
      description: [
        "Apply a unified diff to workspace files. Fails loudly if hunk context does not match.",
        "",
        "Usage:",
        "- Pass the full unified diff (---/+++/@@ hunks).",
        "- Prefer for multi-hunk edits; use search_replace for small single-site edits.",
        "- Does not silently mis-apply.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          diff: { type: "string", description: "Unified diff text" },
          patch: { type: "string", description: "Alias for diff" },
        },
        required: ["diff"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_for_port",
      description: [
        "Poll 127.0.0.1:<port> until TCP accepts connections or timeout.",
        "",
        "Usage:",
        "- Use before browser_devtools/screenshot against a freshly-started dev server.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          port: { type: "integer", description: "TCP port (1-65535)" },
          host: { type: "string", description: "Default 127.0.0.1" },
          timeout_ms: {
            type: "integer",
            description: "Max wait (default 30000)",
          },
        },
        required: ["port"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clipboard_read",
      description: [
        "Read the system clipboard text (pbpaste / Get-Clipboard / xclip|wl-paste).",
        "",
        "Usage:",
        "- Companion to OSC-52 clipboard write in the TUI.",
        "- May require approval (outside workspace data).",
      ].join("\n"),
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "find_symbol",
      description: [
        "Find TypeScript/JavaScript symbol definition, references, or implementations by name.",
        "",
        "Usage:",
        "- Prefer over grep when you need go-to-definition style navigation.",
        "- action: definition (default) | references | implementations.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol name" },
          name: { type: "string", description: "Alias for symbol" },
          action: {
            type: "string",
            enum: ["definition", "references", "implementations"],
          },
          file: { type: "string", description: "Optional source file for position" },
          line: { type: "integer" },
          col: { type: "integer" },
        },
        required: ["symbol"],
      },
    },
  },
];

export function toolNamesFromSchema(): string[] {
  return OPENAI_TOOLS.map((t) => t.function.name);
}
