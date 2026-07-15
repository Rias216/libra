/**
 * Windows shell normalization for agent-emitted commands.
 *
 * Models almost always emit bash-style shells (`&&`, bare `npm`/`npx`).
 * PowerShell rejects `&&` (pre-PS7) and resolves `npm` to `npm.ps1`, which
 * fails under restricted ExecutionPolicy — burning many turn steps.
 *
 * Default host shell is cmd.exe on Windows (supports && and .cmd shims).
 * When the user forces PowerShell via LIBRA_SHELL, we still rewrite
 * common pitfalls so coding agents stay productive.
 */

export type ShellHost = "cmd" | "powershell" | "posix" | "custom";

/** Resolve which shell host we will use for run_terminal_command. */
export function resolveShellHost(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { host: ShellHost; shellOption: string | true | boolean } {
  const override = env.LIBRA_SHELL?.trim();
  if (override) {
    const low = override.toLowerCase();
    if (low.includes("powershell") || low.endsWith("pwsh") || low.endsWith("pwsh.exe")) {
      return { host: "powershell", shellOption: override };
    }
    if (low.includes("cmd")) {
      return { host: "cmd", shellOption: override };
    }
    return { host: "custom", shellOption: override };
  }
  if (platform === "win32") {
    // cmd.exe: `&&` works, PATHEXT finds npm.cmd/npx.cmd, no PS execution policy.
    return { host: "cmd", shellOption: "cmd.exe" };
  }
  return { host: "posix", shellOption: true };
}

/**
 * Rewrite model-emitted shell commands for the active host so common
 * agent patterns succeed without burning retry steps.
 */
export function prepareShellCommand(
  command: string,
  host: ShellHost = resolveShellHost().host,
): string {
  let c = command;
  if (!c.trim()) return c;

  if (host === "cmd" || host === "powershell") {
    // Prefer .cmd shims so we never hit npm.ps1 under ExecutionPolicy.
    c = rewriteNodePackageBins(c);
    // Models pipe through Unix head/tail which do not exist on stock Windows.
    c = stripUnixHeadTailPipes(c);
  }

  if (host === "powershell") {
    // Pre-PS7: && is invalid. Prefer `; if ($?) { ... }` is heavy —
    // simple `;` keeps left-to-right sequencing for independent cmds.
    // For `a && b` → `a; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; b`
    // is more correct but verbose. Use stop-on-error chain:
    c = rewriteBashAndForPowerShell(c);
  }

  return c;
}

/**
 * Drop `| head` / `| tail` (and busybox-style) so `npm install 2>&1 | tail -5`
 * still runs the left-hand command on Windows instead of failing immediately.
 */
export function stripUnixHeadTailPipes(command: string): string {
  // Match: ... | tail -n 20 | head -5 etc. at end of pipeline segments
  return command
    .replace(
      /\s*\|\s*(?:tail|head)(?:\s+(?:-n\s*)?\d+)?(?:\s+-[a-zA-Z]+)*\s*/gi,
      " ",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** npm / npx / yarn / pnpm → .cmd variants on Windows hosts. */
export function rewriteNodePackageBins(command: string): string {
  // Word-boundary replacements; leave already-qualified *.cmd alone.
  let c = command
    .replace(/(^|[\s|&;])npm(?!\.cmd)(?=\s|$)/gi, "$1npm.cmd")
    .replace(/(^|[\s|&;])npx(?!\.cmd)(?=\s|$)/gi, "$1npx.cmd")
    .replace(/(^|[\s|&;])yarn(?!\.cmd)(?=\s|$)/gi, "$1yarn.cmd")
    .replace(/(^|[\s|&;])pnpm(?!\.cmd)(?=\s|$)/gi, "$1pnpm.cmd");
  c = rewriteBareTsc(c);
  // Strip wasteful version-probe chains models use before coding.
  c = stripRedundantVersionProbes(c);
  return c;
}

/**
 * Bare `tsc` is rarely on PATH (lives in node_modules/.bin). Prefer npx.cmd.
 * Skip when already invoked via npx/bunx/yarn/pnpm or a path.
 */
export function rewriteBareTsc(command: string): string {
  return command.replace(
    /(^|[\s|&;])tsc(?=\s|$)/gi,
    (full, pre: string, offset: number, whole: string) => {
      const head = whole.slice(0, offset + pre.length).toLowerCase();
      if (
        /npx(?:\.cmd)?\s+$/.test(head) ||
        /bunx\s+$/.test(head) ||
        /(?:yarn|pnpm)(?:\.cmd)?\s+(?:exec\s+)?$/.test(head) ||
        /node_modules[/\\].bin[/\\]$/.test(head) ||
        /[/\\]$/.test(head)
      ) {
        return full;
      }
      return `${pre}npx.cmd tsc`;
    },
  );
}

/**
 * Models often burn 3–6 steps on `node --version; bun --version; npm --version`.
 * Collapse pure version probes to a single cheap node -v (enough to proceed).
 */
export function stripRedundantVersionProbes(command: string): string {
  const trimmed = command.trim();
  // Only rewrite when the whole command is version checks (no real work).
  const onlyVersions =
    /^(?:(?:node|bun|npm(?:\.cmd)?|npx(?:\.cmd)?|tsc|python|python3)\s+(?:--version|-v)\s*(?:;|&&|\|\||\n|$)\s*)+$/i.test(
      trimmed,
    );
  if (onlyVersions) {
    return "node -v";
  }
  return command;
}

/**
 * Convert bash-style `&&` chains into PowerShell that stops on failure.
 * Does not try to fully parse strings — good enough for agent CLI patterns.
 */
export function rewriteBashAndForPowerShell(command: string): string {
  if (!command.includes("&&")) return command;
  // Split on && outside of simple quotes (best-effort)
  const parts = splitTopLevelAnd(command);
  if (parts.length <= 1) return command;
  // cmd1; if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; cmd2 ...
  // Note: native apps set $LASTEXITCODE; use -or for older PS:
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(
      "; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ",
    );
}

function splitTopLevelAnd(command: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      out.push(buf);
      buf = "";
      i++; // skip second &
      continue;
    }
    buf += ch;
  }
  if (buf.length) out.push(buf);
  return out;
}

/** One-line env hint injected into system prompt. */
export function shellEnvHint(
  platform: NodeJS.Platform = process.platform,
  host: ShellHost = resolveShellHost(platform).host,
): string {
  if (platform !== "win32") {
    return `  Shell: posix (bash/sh via system default)`;
  }
  if (host === "cmd") {
    return (
      `  Shell: Windows cmd.exe (&& works; use npm/npx/yarn normally — .cmd shims are auto-selected)`
    );
  }
  if (host === "powershell") {
    return (
      `  Shell: Windows PowerShell (avoid && — harness rewrites; prefer npm.cmd if policy blocks npm.ps1)`
    );
  }
  return `  Shell: Windows custom (LIBRA_SHELL)`;
}
