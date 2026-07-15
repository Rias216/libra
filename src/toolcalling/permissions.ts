/**
 * OpenCode-style tool permissions: allow | ask | deny.
 *
 * Rules match tool names (with * wildcards) and optional bash command
 * patterns. First matching rule wins within a tool's pattern map;
 * global tool rules use most-specific-wins (longer pattern first).
 *
 * @see https://opencode.ai/docs/permissions/
 */

export type PermissionAction = "allow" | "ask" | "deny";

/** Per-tool config: default action, or pattern map for bash/edit paths. */
export type ToolPermissionConfig =
  | PermissionAction
  | {
      /** Default when no pattern matches */
      "*": PermissionAction;
      [pattern: string]: PermissionAction;
    };

export type PermissionRules = {
  /** Catch-all for tools not listed */
  "*"?: PermissionAction;
  [tool: string]: ToolPermissionConfig | undefined;
};

export interface PermissionRequest {
  tool: string;
  /** Pattern key used for bash commands / file paths */
  pattern?: string;
  args: Record<string, unknown>;
  title: string;
  /** Why approval is needed */
  reason: string;
}

export type PermissionAskFn = (
  req: PermissionRequest,
) => Promise<PermissionAction | boolean>;

export interface PermissionDecision {
  action: PermissionAction;
  /** Rule that matched (for debug) */
  matched: string;
  request?: PermissionRequest;
}

/** Dangerous shell patterns denied by default even under allow. */
const DEFAULT_DENY_BASH: Array<{ pattern: string; re: RegExp }> = [
  // Wipe filesystem roots only — not ordinary `rm -rf ./build`
  {
    pattern: "rm -rf /",
    re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\s+["']?\/["']?\s*$/i,
  },
  {
    pattern: "rm -rf /*",
    re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\s+["']?\/\*[^\s]*/i,
  },
  {
    pattern: "rm -rf ~",
    re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\s+["']?~(\/|["']|\s|$)/i,
  },
  { pattern: "mkfs", re: /\bmkfs(\.|$|\s)/i },
  { pattern: "dd if=", re: /\bdd\s+.*\bif=/i },
  { pattern: "format c:", re: /\bformat\s+[a-z]:/i },
  { pattern: "shutdown", re: /\b(shutdown|reboot|halt|poweroff)\b/i },
  { pattern: ":(){ :|:& };:", re: /:\(\)\s*\{\s*:\|:\&\s*\}\s*;/ },
  { pattern: "curl|sh pipe", re: /\b(curl|wget)\b.*\|\s*(ba)?sh\b/i },
  // Full iex of remote is dangerous; bare property name still blocked as noisy
  { pattern: "IEX download cradle", re: /iex\s*\(\s*(iwr|invoke-webrequest)/i },
];

/** Sensible interactive defaults (OpenCode: all allow; we harden bash). */
export const DEFAULT_PERMISSIONS: PermissionRules = {
  "*": "allow",
  // Read tools stay free
  list_dir: "allow",
  read_file: "allow",
  grep: "allow",
  glob: "allow",
  web_fetch: "allow",
  calc: "allow",
  todo_write: "allow",
  process: "allow",
  finish: "allow",
  // Mutations: allow by default (harness agents need them); user can set ask
  write: "allow",
  write_file: "allow",
  search_replace: "allow",
  edit_file: "allow",
  run_terminal_command: {
    "*": "allow",
    "git *": "allow",
    "npm *": "allow",
    "npx *": "allow",
    "pnpm *": "allow",
    "yarn *": "allow",
    "node *": "allow",
    "tsx *": "allow",
    "python *": "allow",
    "pytest *": "allow",
    "cargo *": "allow",
    "go *": "allow",
    "rm -rf *": "ask",
    "rm -r *": "ask",
    "del /s *": "ask",
    "Remove-Item * -Recurse *": "ask",
    "git push --force *": "ask",
    "git push -f *": "ask",
  },
  run_shell: {
    "*": "allow",
    "rm -rf *": "ask",
  },
};

/** Headless / CI: never prompt; deny only hard-dangerous. */
export const HEADLESS_PERMISSIONS: PermissionRules = {
  "*": "allow",
};

function wildcardMatch(text: string, pattern: string): boolean {
  if (pattern === "*") return true;
  // Escape regex specials except *
  const parts = pattern.split("*").map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`^${parts.join(".*")}$`, "i");
  return re.test(text);
}

/** Score pattern specificity (higher = more specific). */
function patternScore(pattern: string): number {
  if (pattern === "*") return 0;
  // Prefer longer patterns; fewer wildcards
  const wild = (pattern.match(/\*/g) ?? []).length;
  return pattern.length * 10 - wild * 5;
}

export class PermissionChecker {
  constructor(
    private rules: PermissionRules = DEFAULT_PERMISSIONS,
    private askFn?: PermissionAskFn,
    /** When true, treat "ask" as "allow" (OpenCode --auto) */
    private autoApprove = false,
  ) {}

  setRules(rules: PermissionRules): void {
    this.rules = rules;
  }

  setAskFn(fn: PermissionAskFn | undefined): void {
    this.askFn = fn;
  }

  setAutoApprove(v: boolean): void {
    this.autoApprove = v;
  }

  /**
   * Resolve permission for a tool invocation.
   * Does not call askFn — use resolveAndMaybeAsk for that.
   */
  resolve(
    tool: string,
    args: Record<string, unknown> = {},
  ): PermissionDecision {
    // Hard deny dangerous bash regardless of config
    if (tool === "run_terminal_command" || tool === "run_shell") {
      const cmd = String(args.command ?? "");
      for (const d of DEFAULT_DENY_BASH) {
        if (d.re.test(cmd)) {
          return {
            action: "deny",
            matched: `hard-deny:${d.pattern}`,
            request: {
              tool,
              pattern: cmd,
              args,
              title: cmd.slice(0, 80),
              reason: `Blocked dangerous command pattern: ${d.pattern}`,
            },
          };
        }
      }
    }

    const toolCfg = this.rules[tool] ?? this.rules["*"] ?? "allow";

    if (typeof toolCfg === "string") {
      return {
        action: toolCfg,
        matched: this.rules[tool] != null ? tool : "*",
        request: this.makeRequest(tool, args, toolCfg),
      };
    }

    // Pattern map
    const pattern = this.patternKey(tool, args);
    let best: { action: PermissionAction; pattern: string; score: number } | null =
      null;
    for (const [pat, action] of Object.entries(toolCfg)) {
      if (!wildcardMatch(pattern, pat)) continue;
      const score = patternScore(pat);
      if (!best || score > best.score) {
        best = { action, pattern: pat, score };
      }
    }
    const action = best?.action ?? toolCfg["*"] ?? "allow";
    return {
      action,
      matched: best ? `${tool}:${best.pattern}` : `${tool}:*`,
      request: this.makeRequest(tool, args, action),
    };
  }

  /**
   * Resolve and if action is ask, invoke askFn (or auto-approve / deny).
   */
  async resolveAndMaybeAsk(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<PermissionDecision> {
    const d = this.resolve(tool, args);
    if (d.action !== "ask") return d;

    if (this.autoApprove) {
      return { ...d, action: "allow", matched: `${d.matched}+auto` };
    }

    if (!this.askFn || !d.request) {
      // No UI hook → deny for safety (better than silent allow)
      return {
        ...d,
        action: "deny",
        matched: `${d.matched}+no-ask-handler`,
      };
    }

    const answer = await this.askFn(d.request);
    if (answer === true || answer === "allow") {
      return { ...d, action: "allow", matched: `${d.matched}+user-allow` };
    }
    if (answer === "ask") {
      // treat as deny if user re-asks
      return { ...d, action: "deny", matched: `${d.matched}+user-ask` };
    }
    return { ...d, action: "deny", matched: `${d.matched}+user-deny` };
  }

  private patternKey(tool: string, args: Record<string, unknown>): string {
    if (tool === "run_terminal_command" || tool === "run_shell") {
      return String(args.command ?? "").trim();
    }
    if (
      tool === "write" ||
      tool === "write_file" ||
      tool === "search_replace" ||
      tool === "edit_file"
    ) {
      return String(args.file_path ?? args.path ?? "").trim();
    }
    return tool;
  }

  private makeRequest(
    tool: string,
    args: Record<string, unknown>,
    action: PermissionAction,
  ): PermissionRequest {
    const pattern = this.patternKey(tool, args);
    return {
      tool,
      pattern,
      args,
      title: pattern || tool,
      reason:
        action === "ask"
          ? `Tool "${tool}" requires approval`
          : action === "deny"
            ? `Tool "${tool}" is denied by policy`
            : `Tool "${tool}" allowed`,
    };
  }
}

/** Format a denied tool result for the model. */
export function deniedToolOutput(decision: PermissionDecision): string {
  const req = decision.request;
  return [
    `Permission denied (${decision.matched}).`,
    req?.reason ?? "This tool is not allowed under current permissions.",
    "Do not retry the same call. Adjust the approach or ask the user to enable the tool.",
  ].join(" ");
}
