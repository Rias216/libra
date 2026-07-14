/**
 * OpenAI-compatible tool definitions for fast function calling.
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
      description:
        "List files and directories at a path (relative to workspace). Omit target_directory or use '.' for workspace root. Do not re-list a path you already listed.",
      parameters: {
        type: "object",
        properties: {
          target_directory: {
            type: "string",
            description: "Directory path relative to workspace. Default: '.'",
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
      description:
        "Read a text file. Optional line offset/limit for large files. Do not re-read the same file unless it may have changed.",
      parameters: {
        type: "object",
        properties: {
          target_file: { type: "string", description: "Path to file" },
          offset: { type: "integer", description: "1-based start line" },
          limit: { type: "integer", description: "Max lines to return" },
        },
        required: ["target_file"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write full contents to a file (creates parents).",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          content: { type: "string" },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_replace",
      description: "Exact string replacement in a file (once or all).",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regex/string pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "File or directory" },
          glob: { type: "string", description: "e.g. *.ts" },
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
      description: "Find files by glob pattern under the workspace.",
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
      description:
        "Run a shell command in the workspace. Prefer for builds/tests. Avoid destructive commands.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "integer", description: "Default 30000" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL and return text content (truncated).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
  },
];

export function toolNamesFromSchema(): string[] {
  return OPENAI_TOOLS.map((t) => t.function.name);
}
