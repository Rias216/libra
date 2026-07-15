/**
 * Shared tool-output truncation (OpenCode truncate / Codex model budgets).
 */

/** Live turn / current sample — keep more context for the model. */
export const TOOL_OUTPUT_LIVE_MAX = 32_000;
/** Cross-turn history rebuild — slightly tighter. */
export const TOOL_OUTPUT_HISTORY_MAX = 16_000;
/** Child subagent tool results. */
export const TOOL_OUTPUT_CHILD_MAX = 12_000;

export function truncateToolOutput(
  text: string,
  max: number = TOOL_OUTPUT_LIVE_MAX,
): string {
  const s = text ?? "";
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.75);
  const tail = Math.max(0, max - head - 80);
  const omitted = s.length - head - tail;
  return (
    s.slice(0, head) +
    `\n\n...[truncated ${omitted} chars]...\n\n` +
    (tail > 0 ? s.slice(-tail) : "")
  );
}

/**
 * Codex-style shell output framing for the model.
 * Exit code + wall time + truncated body.
 */
export function formatShellOutputForModel(opts: {
  exitCode: number | null;
  durationMs: number;
  output: string;
  timedOut?: boolean;
  max?: number;
}): string {
  const secs = Math.round((opts.durationMs / 1000) * 10) / 10;
  const body = opts.timedOut
    ? `command timed out after ${opts.durationMs} milliseconds\n${opts.output}`
    : opts.output;
  const truncated = truncateToolOutput(body, opts.max ?? TOOL_OUTPUT_LIVE_MAX);
  const totalLines = body.split("\n").length;
  const outLines = truncated.split("\n").length;
  const sections = [
    `Exit code: ${opts.exitCode ?? "null"}`,
    `Wall time: ${secs} seconds`,
  ];
  if (totalLines !== outLines) {
    sections.push(`Total output lines: ${totalLines}`);
  }
  sections.push("Output:", truncated);
  return sections.join("\n");
}
