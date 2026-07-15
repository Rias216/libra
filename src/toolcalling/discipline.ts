/**
 * Tool-discipline helpers — catch "shell to print what you already know"
 * and other over-tooling patterns. Soft signals for model feedback + benches.
 */

export interface ToolTraceCall {
  name: string;
  args: Record<string, unknown>;
  output?: string;
  ok?: boolean;
  durationMs?: number;
}

/** Shell commands that only print a literal / echo a known value. */
export function looksLikeEchoCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const c = command.trim();
  // echo / Write-Output / printf of a simple token
  if (/^(echo|printf|Write-Output|Write-Host)\s+/i.test(c)) return true;
  if (/^cmd\s*\/c\s+echo\s+/i.test(c)) return true;
  if (/^powershell[^]*\b(echo|Write-Output)\b/i.test(c)) return true;
  return false;
}

/** Extract the printed payload from a simple echo command. */
export function echoPayload(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const c = command.trim();
  const m =
    c.match(/^(?:cmd\s*\/c\s+)?echo\s+(.+)$/i) ||
    c.match(/^printf\s+['"]?(.+?)['"]?\s*$/i) ||
    c.match(/^Write-(?:Output|Host)\s+['"]?(.+?)['"]?\s*$/i);
  if (!m) return null;
  return m[1]!.trim().replace(/^["']|["']$/g, "");
}

/**
 * True when a shell call appears to only re-print something already present
 * in a prior tool result (classic "echo the package name" anti-pattern).
 */
export function isRedundantShellEcho(
  call: ToolTraceCall,
  prior: ToolTraceCall[],
): boolean {
  if (call.name !== "run_terminal_command" && call.name !== "bash") {
    return false;
  }
  const cmd = call.args.command ?? call.args.cmd;
  if (!looksLikeEchoCommand(cmd)) return false;
  const payload = echoPayload(cmd);
  if (!payload) return false;
  // trivial empty
  if (!payload.trim()) return true;

  const needle = payload.toLowerCase();
  for (const p of prior) {
    if (!p.output) continue;
    // prior specialized tool already had this string
    if (
      ["read_file", "list_dir", "grep", "glob", "write", "search_replace"].includes(
        p.name,
      ) &&
      p.output.toLowerCase().includes(needle)
    ) {
      return true;
    }
  }
  return false;
}

export interface DisciplineReport {
  redundantShellEchoes: Array<{
    command: string;
    priorTool: string;
  }>;
  shellInsteadOfSpecialized: Array<{
    command: string;
    preferred: string;
  }>;
  /** 1.0 = clean, 0.0 = many violations */
  score: number;
  notes: string[];
}

/** Map common shell anti-patterns to preferred specialized tools. */
export function preferredToolForShell(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const c = command.trim();
  if (/^(ls|dir|Get-ChildItem)\b/i.test(c)) return "list_dir";
  if (/^(cat|type|Get-Content|head|tail)\b/i.test(c)) return "read_file";
  if (/^(rg|grep|findstr|Select-String)\b/i.test(c)) return "grep";
  if (/^(find|fd|Get-ChildItem\s+.*-Recurse)\b/i.test(c)) return "glob";
  return null;
}

export function analyzeToolDiscipline(calls: ToolTraceCall[]): DisciplineReport {
  const redundantShellEchoes: DisciplineReport["redundantShellEchoes"] = [];
  const shellInsteadOfSpecialized: DisciplineReport["shellInsteadOfSpecialized"] =
    [];
  const notes: string[] = [];

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const prior = calls.slice(0, i);
    if (isRedundantShellEcho(call, prior)) {
      const cmd = String(call.args.command ?? call.args.cmd ?? "");
      const priorTool =
        prior
          .slice()
          .reverse()
          .find((p) => p.output && echoPayload(call.args.command)?.length
            ? p.output
                .toLowerCase()
                .includes((echoPayload(call.args.command) || "").toLowerCase())
            : false)?.name ?? "prior_tool";
      redundantShellEchoes.push({ command: cmd, priorTool });
    }
    if (
      call.name === "run_terminal_command" ||
      call.name === "bash"
    ) {
      const pref = preferredToolForShell(call.args.command ?? call.args.cmd);
      if (pref) {
        shellInsteadOfSpecialized.push({
          command: String(call.args.command ?? call.args.cmd ?? ""),
          preferred: pref,
        });
      }
    }
  }

  const violations =
    redundantShellEchoes.length + shellInsteadOfSpecialized.length;
  const score =
    calls.length === 0
      ? 1
      : Math.max(0, 1 - violations / Math.max(1, calls.length));

  if (redundantShellEchoes.length) {
    notes.push(
      `Redundant shell echo x${redundantShellEchoes.length} (prefer answering from prior tool output)`,
    );
  }
  if (shellInsteadOfSpecialized.length) {
    notes.push(
      `Shell used where specialized tools fit x${shellInsteadOfSpecialized.length}`,
    );
  }

  return { redundantShellEchoes, shellInsteadOfSpecialized, score, notes };
}

/**
 * Soft advisory appended to shell tool output for the model (not a hard error).
 */
export function shellDisciplineAdvisory(
  command: unknown,
  prior: ToolTraceCall[],
): string | null {
  const call: ToolTraceCall = {
    name: "run_terminal_command",
    args: { command },
  };
  if (isRedundantShellEcho(call, prior)) {
    return (
      "\n\n[libra:discipline] This shell echo only reprints something already " +
      "available from a prior tool result. Prefer answering the user directly " +
      "from that result next time — do not use run_terminal_command to communicate."
    );
  }
  const pref = preferredToolForShell(command);
  if (pref) {
    return (
      `\n\n[libra:discipline] Prefer the specialized \`${pref}\` tool over shell ` +
      `for this kind of file operation.`
    );
  }
  return null;
}
