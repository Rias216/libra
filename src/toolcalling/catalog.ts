/**
 * Fusion / headless harness tool catalog (OpenAI-style).
 * Names and parameters match `fustion benchmarks/tools/catalog.md`.
 */

import type { OpenAITool } from "./schema.js";

export const CATALOG_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a text file in the sandbox.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Sandbox-relative path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write text content to a file (overwrite). Creates parents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Search-and-replace text in an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean", default: false },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", default: "." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents for a pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", default: "." },
          glob: {
            type: "string",
            description: "optional file filter e.g. *.txt",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a shell command in the sandbox workspace. Network disabled.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_s: { type: "integer", default: 30 },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calc",
      description:
        "Evaluate a math expression exactly. Prefer this over mental math.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string" },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description: "Create or update a short todo list for the current task.",
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
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description:
        "Complete the task and return the final answer to the harness.",
      parameters: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            description: "Final answer or summary",
          },
          success: { type: "boolean", default: true },
        },
        required: ["answer"],
      },
    },
  },
];

const BY_NAME = new Map(CATALOG_TOOLS.map((t) => [t.function.name, t]));

/** Resolve case tool allowlist to OpenAI tool defs (always includes finish if listed). */
export function resolveCatalogTools(names?: string[]): OpenAITool[] {
  if (!names?.length) return [...CATALOG_TOOLS];
  const out: OpenAITool[] = [];
  for (const n of names) {
    const t = BY_NAME.get(n);
    if (t) out.push(t);
  }
  return out;
}

export function catalogToolNames(): string[] {
  return CATALOG_TOOLS.map((t) => t.function.name);
}
