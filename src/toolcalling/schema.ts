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
        "- Optional offset/limit (1-based start line, max lines) apply to single-file reads only.",
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
            description: "1-based start line (single-file only)",
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
          content: { type: "string", description: "Full new file contents" },
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
        "- If old_string matches multiple times, the tool FAILS unless replace_all=true — include more context to make it unique.",
        "- Use replace_all when renaming a symbol across the whole file.",
        "- Fails if old_string is missing or ambiguous (multiple matches without replace_all).",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string", description: "Exact text to find" },
          new_string: { type: "string", description: "Replacement text" },
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
        "- NEVER use shell to talk to the user (no echo of explanations).",
        "- Avoid destructive commands unless the user asked.",
        "- Provide a short description (5–10 words) of what the command does.",
        "- Set background=true for long-running servers; then manage with the process tool.",
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
];

export function toolNamesFromSchema(): string[] {
  return OPENAI_TOOLS.map((t) => t.function.name);
}
