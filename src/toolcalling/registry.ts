/**
 * Tool registry with toolsets (Hermes-style) and risk tags.
 * Filters which tools are exposed to the model per agent/mode.
 */

import type { OpenAITool } from "./schema.js";
import { OPENAI_TOOLS } from "./schema.js";
import { CATALOG_TOOLS } from "./catalog.js";
import { slimToolSchemas } from "./slim-schema.js";

/** Logical groups — enable/disable like Hermes toolsets. */
export type ToolsetId =
  | "fs"
  | "search"
  | "shell"
  | "web"
  | "meta"
  | "catalog"
  | "process";

/** Risk for permission defaults and UI badges. */
export type ToolRisk = "read" | "write" | "exec" | "network" | "meta";

export interface RegistryEntry {
  name: string;
  toolset: ToolsetId;
  risk: ToolRisk;
  /** OpenAI schema when available */
  schema?: OpenAITool;
  /** Aliases that map to this tool at execute time */
  aliases?: string[];
  description?: string;
}

export type ToolHookPhase = "before" | "after";

export interface ToolHookContext {
  name: string;
  args: Record<string, unknown>;
  /** Set after execution */
  result?: {
    ok: boolean;
    output: string;
    durationMs: number;
  };
  /** Abort the call from a before-hook */
  cancel?: boolean;
  cancelReason?: string;
}

export type ToolHook = (
  phase: ToolHookPhase,
  ctx: ToolHookContext,
) => void | Promise<void>;

const ENTRIES: RegistryEntry[] = [
  {
    name: "list_dir",
    toolset: "fs",
    risk: "read",
    aliases: ["ls", "list"],
    description: "List directory entries",
  },
  {
    name: "read_file",
    toolset: "fs",
    risk: "read",
    aliases: ["read", "Read"],
    description: "Read file contents",
  },
  {
    name: "write",
    toolset: "fs",
    risk: "write",
    aliases: ["write_file", "Write"],
    description: "Write full file",
  },
  {
    name: "search_replace",
    toolset: "fs",
    risk: "write",
    aliases: ["edit_file", "edit", "Edit", "str_replace"],
    description: "Exact string edit",
  },
  {
    name: "grep",
    toolset: "search",
    risk: "read",
    aliases: ["Grep"],
    description: "Content search",
  },
  {
    name: "glob",
    toolset: "search",
    risk: "read",
    aliases: ["Glob"],
    description: "Find files by pattern",
  },
  {
    name: "run_terminal_command",
    toolset: "shell",
    risk: "exec",
    aliases: ["run_shell", "bash", "shell", "Shell", "local_shell"],
    description: "Shell command",
  },
  {
    name: "process",
    toolset: "process",
    risk: "exec",
    description: "Manage background shell processes",
  },
  {
    name: "web_search",
    toolset: "web",
    risk: "network",
    aliases: ["websearch"],
    description: "Search the web",
  },
  {
    name: "web_fetch",
    toolset: "web",
    risk: "network",
    aliases: ["webfetch"],
    description: "Fetch URL text",
  },
  {
    name: "todo_write",
    toolset: "meta",
    risk: "meta",
    aliases: ["todowrite"],
    description: "Update task list",
  },
  {
    name: "calc",
    toolset: "catalog",
    risk: "meta",
    description: "Evaluate math expression",
  },
  {
    name: "finish",
    toolset: "catalog",
    risk: "meta",
    description: "Complete harness task",
  },
];

const BY_NAME = new Map<string, RegistryEntry>();
for (const e of ENTRIES) {
  BY_NAME.set(e.name, e);
  for (const a of e.aliases ?? []) BY_NAME.set(a, e);
}

// Attach schemas
for (const t of OPENAI_TOOLS) {
  const e = BY_NAME.get(t.function.name);
  if (e) e.schema = t;
}
for (const t of CATALOG_TOOLS) {
  const e = BY_NAME.get(t.function.name);
  if (e && !e.schema) e.schema = t;
}

export const ALL_TOOLSETS: ToolsetId[] = [
  "fs",
  "search",
  "shell",
  "web",
  "meta",
  "process",
  "catalog",
];

/** Default interactive agent toolsets (no catalog finish/calc unless asked). */
export const DEFAULT_AGENT_TOOLSETS: ToolsetId[] = [
  "fs",
  "search",
  "shell",
  "web",
  "meta",
  "process",
];

/** Fusion / headless eval toolsets. */
export const CATALOG_TOOLSETS: ToolsetId[] = [
  "fs",
  "search",
  "shell",
  "catalog",
  "meta",
];

export class ToolRegistry {
  private enabled = new Set<ToolsetId>(DEFAULT_AGENT_TOOLSETS);
  private disabledNames = new Set<string>();
  private extraSchemas: OpenAITool[] = [];
  private hooks: ToolHook[] = [];

  enableToolsets(sets: ToolsetId[]): void {
    for (const s of sets) this.enabled.add(s);
  }

  disableToolsets(sets: ToolsetId[]): void {
    for (const s of sets) this.enabled.delete(s);
  }

  setToolsets(sets: ToolsetId[]): void {
    this.enabled = new Set(sets);
  }

  /** Disable a specific tool by name (OpenCode tools: { edit: false }). */
  setToolEnabled(name: string, enabled: boolean): void {
    if (enabled) this.disabledNames.delete(name);
    else this.disabledNames.add(name);
  }

  addHook(hook: ToolHook): void {
    this.hooks.push(hook);
  }

  clearHooks(): void {
    this.hooks = [];
  }

  registerSchema(tool: OpenAITool): void {
    this.extraSchemas.push(tool);
  }

  getEntry(name: string): RegistryEntry | undefined {
    return BY_NAME.get(name);
  }

  isEnabled(name: string): boolean {
    if (this.disabledNames.has(name)) return false;
    const e = BY_NAME.get(name);
    if (!e) {
      // Extra / MCP tools: allowed if not explicitly disabled
      return !this.disabledNames.has(name);
    }
    return this.enabled.has(e.toolset);
  }

  /**
   * OpenAI tool defs for the model (filtered).
   * @param opts.slim short descriptions (fewer prompt tokens)
   */
  schemas(opts?: { slim?: boolean }): OpenAITool[] {
    const out: OpenAITool[] = [];
    const seen = new Set<string>();
    for (const t of OPENAI_TOOLS) {
      if (!this.isEnabled(t.function.name)) continue;
      out.push(t);
      seen.add(t.function.name);
    }
    for (const t of this.extraSchemas) {
      if (seen.has(t.function.name) || !this.isEnabled(t.function.name)) {
        continue;
      }
      out.push(t);
      seen.add(t.function.name);
    }
    return opts?.slim ? slimToolSchemas(out) : out;
  }

  listEntries(): RegistryEntry[] {
    return ENTRIES.filter((e) => this.isEnabled(e.name));
  }

  async runHooks(
    phase: ToolHookPhase,
    ctx: ToolHookContext,
  ): Promise<ToolHookContext> {
    for (const h of this.hooks) {
      await h(phase, ctx);
      if (ctx.cancel) break;
    }
    return ctx;
  }
}

/** Shared default registry for agent loop. */
export function createDefaultRegistry(
  toolsets: ToolsetId[] = DEFAULT_AGENT_TOOLSETS,
): ToolRegistry {
  const r = new ToolRegistry();
  r.setToolsets(toolsets);
  return r;
}

export function listBuiltinEntries(): RegistryEntry[] {
  return [...ENTRIES];
}
