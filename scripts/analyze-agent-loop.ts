/**
 * Analyze a debug-live-run / bench outDir for agent-loop errors and speed.
 * Prefers loop-events.jsonl + steps.json + tools.json (full detail dumps).
 *
 * Usage:
 *   bun scripts/analyze-agent-loop.ts <outDir> [--write report.md]
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? ".");
const writeIdx = process.argv.indexOf("--write");
const writePath =
  writeIdx >= 0
    ? resolve(process.argv[writeIdx + 1] ?? join(outDir, "LOOP_ANALYSIS.md"))
    : join(outDir, "LOOP_ANALYSIS.md");

interface Meta {
  ms?: number;
  provider?: string;
  model?: string;
  mode?: string;
  error?: string | null;
  stepCount?: number;
  loopEventCount?: number;
  toolParts?: {
    total: number;
    completed: number;
    error: number;
    names: string[];
  };
  reasoningChars?: number;
  textChars?: number;
  messageCount?: number;
  tokens?: { input?: number; output?: number };
  latency?: {
    total?: { n?: number; p50?: number | null; p95?: number | null; mean?: number | null };
    byBucket?: Record<string, { n?: number; p50?: number | null; p95?: number | null }>;
    slowest?: Array<{ name: string; ms: number; bucket?: string; ok?: boolean }>;
  };
}

interface TimelineEv {
  t: number;
  type: string;
  phase?: string;
  label?: string;
  status?: string;
  partType?: string;
  preview?: string;
  toolName?: string;
  args?: unknown;
  resultChars?: number;
  deltaChars?: number;
}

interface LoopEv {
  seq: number;
  ms: number;
  at?: string;
  category: string;
  event: string;
  level?: string;
  data?: Record<string, unknown>;
}

interface StepRec {
  step: number;
  startMs?: number;
  endMs?: number;
  durationMs?: number;
  finish_reason?: string;
  ttftMs?: number;
  contentLen?: number;
  reasoningLen?: number;
  tools?: Array<{ id?: string; name?: string; argsChars?: number }>;
  toolWave?: Array<{
    name: string;
    ok: boolean;
    ms?: number;
    outLen?: number;
    doomLoop?: boolean;
  }>;
  events?: string[];
}

interface ToolRow {
  n?: number;
  toolName: string;
  status: string;
  callId?: string;
  args?: unknown;
  result?: string;
  error?: string;
  durationMs?: number;
}

function loadJson<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function loadJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => Boolean(x));
}

const EXPANSION = new Set([
  "list_windows",
  "screenshot",
  "read_image",
  "browser_devtools",
  "check",
  "git",
  "patch_apply",
  "wait_for_port",
  "clipboard_read",
  "find_symbol",
]);

function main() {
  const meta = loadJson<Meta>(join(outDir, "meta.json")) ?? {};
  const dump = loadJson<{
    messages?: Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    ms?: number;
    tokens?: { input?: number; output?: number };
    error?: string | null;
  }>(join(outDir, "dump.json"));
  const timeline = loadJsonl<TimelineEv>(join(outDir, "timeline.jsonl"));
  const loopEvents = loadJsonl<LoopEv>(join(outDir, "loop-events.jsonl"));
  const harnessJsonl = loadJsonl<LoopEv>(join(outDir, "harness-debug.jsonl"));
  const steps =
    loadJson<StepRec[]>(join(outDir, "steps.json")) ??
    deriveStepsFromLoop(loopEvents.length ? loopEvents : harnessJsonl);
  const toolsFile = loadJson<ToolRow[]>(join(outDir, "tools.json"));
  const latencyFile = loadJson<Meta["latency"]>(join(outDir, "latency.json"));
  const transcript = existsSync(join(outDir, "transcript.md"))
    ? readFileSync(join(outDir, "transcript.md"), "utf8")
    : "";

  const tools: ToolRow[] = toolsFile?.length
    ? toolsFile
    : [];
  if (!tools.length) {
    for (const m of dump?.messages ?? []) {
      for (const p of m.parts ?? []) {
        if (p.type !== "tool") continue;
        tools.push({
          toolName: String(p.toolName ?? ""),
          status: String(p.status ?? ""),
          callId: p.callId != null ? String(p.callId) : undefined,
          args: p.args,
          result:
            p.result != null
              ? String(p.result)
              : p.resultPreview != null
                ? String(p.resultPreview)
                : undefined,
          error: p.error != null ? String(p.error) : undefined,
          durationMs:
            typeof p.durationMs === "number" ? p.durationMs : undefined,
        });
      }
    }
  }

  // Timeline-derived latencies
  const phaseSpans: Array<{ label: string; ms: number }> = [];
  let lastPhaseT = timeline[0]?.t ?? meta.ms ?? 0;
  let lastLabel = "start";
  for (const ev of timeline) {
    if (ev.type === "phase") {
      const ms = ev.t - lastPhaseT;
      phaseSpans.push({ label: lastLabel, ms });
      lastPhaseT = ev.t;
      lastLabel = `${ev.phase}${ev.label ? " · " + ev.label : ""}`;
    }
  }
  if (timeline.length) {
    phaseSpans.push({
      label: lastLabel,
      ms: (timeline[timeline.length - 1]!.t - lastPhaseT) || 0,
    });
  }

  // Sample steps from transcript (legacy) or steps.json
  const stepMatches = [...transcript.matchAll(/streaming · step (\d+)/g)];
  const legacySteps = stepMatches.map((m) => Number(m[1]));
  const maxStep = steps.length
    ? Math.max(...steps.map((s) => s.step))
    : legacySteps.length
      ? Math.max(...legacySteps)
      : 0;

  let streamMs = 0;
  let toolMs = 0;
  for (const s of phaseSpans) {
    if (/tool/i.test(s.label)) toolMs += s.ms;
    else if (/stream/i.test(s.label)) streamMs += s.ms;
  }

  // Prefer step-level duration from loop events
  let sampleMsFromSteps = 0;
  let toolMsFromSteps = 0;
  for (const s of steps) {
    if (s.durationMs) sampleMsFromSteps += s.durationMs;
    if (s.toolWave) {
      for (const w of s.toolWave) toolMsFromSteps += w.ms ?? 0;
    }
  }

  const completed = tools.filter((t) => t.status === "completed");
  const errored = tools.filter(
    (t) => t.status === "error" || t.status === "cancelled",
  );
  const expansionUsed = [
    ...new Set(tools.map((t) => t.toolName).filter((n) => EXPANSION.has(n))),
  ];
  const expansionMissing = [...EXPANSION].filter((n) => !expansionUsed.includes(n));

  // Error taxonomy
  const errorBuckets: Record<string, string[]> = {};
  for (const t of errored) {
    const msg = (t.error ?? t.result ?? "").slice(0, 160);
    let bucket = "other";
    if (/permission|denied/i.test(msg)) bucket = "permission";
    if (/CDP|9222|9335|ECONNREFUSED/i.test(msg)) bucket = "cdp_unavailable";
    if (/not found|ENOENT|not implemented/i.test(msg)) bucket = "not_found_or_todo";
    if (/timeout|not open/i.test(msg)) bucket = "timeout_port";
    if (/unknown tool|disabled/i.test(msg)) bucket = "tool_missing";
    if (/hunk|mismatch/i.test(msg)) bucket = "patch_mismatch";
    if (/Playwright/i.test(msg)) bucket = "playwright_optional";
    if (/invalid|schema|required/i.test(msg)) bucket = "invalid_args";
    if (/JSON|parse/i.test(msg)) bucket = "json_parse";
    (errorBuckets[bucket] ??= []).push(`${t.toolName}: ${msg}`);
  }

  // Loop-event signals
  const loopSrc = loopEvents.length ? loopEvents : harnessJsonl;
  const doomHits =
    loopSrc.filter((e) => /\.doom$|doom_loop|doomLoop/i.test(e.event)).length +
    (transcript.match(/Doom-loop/gi) ?? []).length;
  const brokenArgs =
    loopSrc.filter((e) => /length_broken_tools|salvaged_tool_args|broken/i.test(e.event))
      .length +
    (transcript.match(/truncated.*JSON|brokenToolArgs|incomplete JSON/gi) ?? []).length;
  const thoughtLoops = loopSrc.filter((e) => /thought_loop/i.test(e.event)).length;
  const stuckHits = loopSrc.filter((e) => /\.stuck$/i.test(e.event)).length;
  const llmRetries = loopSrc.filter((e) => e.event === "llm.retry" || e.event.endsWith("llm.retry")).length;
  const httpErrors = loopSrc.filter((e) => /http\.error/i.test(e.event));
  const sampleErrors = loopSrc.filter((e) => /sample_error/i.test(e.event));

  const reReads = tools.filter((t) => t.toolName === "read_file").length;
  const writes = tools.filter((t) =>
    /^(write|write_file|search_replace|edit_file|patch_apply)$/.test(t.toolName),
  ).length;
  const shellCount = tools.filter((t) =>
    /run_terminal_command|bash|shell/i.test(t.toolName),
  ).length;
  const specializedInsteadOfShell = {
    git: tools.some((t) => t.toolName === "git"),
    check: tools.some((t) => t.toolName === "check"),
  };

  // Parallelism: multi-tool waves
  const multiToolWaves = steps
    .map((s) => s.tools?.length ?? s.toolWave?.length ?? 0)
    .filter((n) => n > 1);
  const timelineMulti = timeline
    .filter((ev) => ev.type === "phase" && /running\s+(\d+)\s+tool/i.test(ev.label ?? ""))
    .map((ev) => Number((ev.label ?? "").match(/running\s+(\d+)\s+tool/i)?.[1] ?? 1))
    .filter((n) => n > 1);
  const multiWaves = multiToolWaves.length ? multiToolWaves : timelineMulti;

  // Finish reason distribution
  const finishReasons: Record<string, number> = {};
  for (const s of steps) {
    const fr = s.finish_reason ?? "unknown";
    finishReasons[fr] = (finishReasons[fr] ?? 0) + 1;
  }

  // TTFT stats
  const ttfts = steps.map((s) => s.ttftMs).filter((n): n is number => typeof n === "number");
  const avgTtft = ttfts.length
    ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length)
    : null;

  // Tool name histogram
  const nameHist: Record<string, { total: number; ok: number; err: number }> = {};
  for (const t of tools) {
    const h = (nameHist[t.toolName] ??= { total: 0, ok: 0, err: 0 });
    h.total++;
    if (t.status === "completed") h.ok++;
    else h.err++;
  }

  // Speedups recommendations
  const recs: string[] = [];
  if (streamMs > toolMs * 3 && (meta.ms ?? 0) > 30_000) {
    recs.push(
      "Model sampling dominates wall time — consider slim tools/profile, lower reasoning effort for free models, or max_tokens env only when needed.",
    );
  }
  if (reReads > 12) {
    recs.push(
      `High read_file count (${reReads}) — encourage larger batch target_files and avoid re-read after successful search_replace.`,
    );
  }
  if (shellCount > 8 && specializedInsteadOfShell.git) {
    recs.push(
      "Shell still frequent despite git tool — prompt/discipline should prefer git/check tools.",
    );
  }
  if (doomHits > 0) {
    recs.push(
      `Doom-loop fired ${doomHits}× — inspect repeated fingerprints; improve tool error hints so model changes args.`,
    );
  }
  if (brokenArgs > 0) {
    recs.push(
      "Broken/truncated tool JSON detected — keep write chunking nudges; consider smaller patch_apply hunks.",
    );
  }
  if (thoughtLoops > 0) {
    recs.push(
      `Thought-loop recovery fired ${thoughtLoops}× — model spent multiple samples reasoning without tools.`,
    );
  }
  if (stuckHits > 0) {
    recs.push(
      `Stuck-progress fired ${stuckHits}× — repeated identical failures without mutation progress.`,
    );
  }
  if (llmRetries > 0) {
    recs.push(`LLM retries: ${llmRetries} — check rate limits / 5xx on free tier.`);
  }
  if (httpErrors.length) {
    recs.push(
      `HTTP errors: ${httpErrors.length} — e.g. ${String(httpErrors[0]?.data?.status ?? "")} ${String(httpErrors[0]?.data?.body ?? "").slice(0, 80)}`,
    );
  }
  if (expansionMissing.length && /expansion/i.test(outDir)) {
    recs.push(
      `Expansion tools not exercised: ${expansionMissing.join(", ")} — tighten mandatory checklist in TASK.md or raise max-steps.`,
    );
  }
  if (errored.some((t) => t.toolName === "wait_for_port")) {
    recs.push(
      "wait_for_port failures: ensure background server starts before wait; increase timeout_ms after spawn.",
    );
  }
  if (toolMs > 0 && streamMs > 0) {
    const ratio = streamMs / (streamMs + toolMs);
    if (ratio > 0.85) {
      recs.push(
        `Stream phase is ${(ratio * 100).toFixed(0)}% of measured phases — tool execution is relatively cheap; optimize model round-trips (batch tools in one step).`,
      );
    }
  }
  if (multiWaves.length === 0 && tools.length > 6) {
    recs.push(
      "No multi-tool waves observed — model may be calling tools serially; system prompt should stress parallel independent reads.",
    );
  } else if (multiWaves.length) {
    recs.push(
      `Multi-tool waves seen (count=${multiWaves.length}, max=${Math.max(...multiWaves)}) — keep parallel-safe tagging for expansion reads.`,
    );
  }
  if (writes === 0 && tools.length > 0) {
    recs.push("No write/edit tools used — model may have only explored or failed to implement.");
  }

  const latency = latencyFile ?? meta.latency;

  const lines: string[] = [];
  lines.push(`# Agent loop analysis`);
  lines.push("");
  lines.push(`- **outDir**: \`${outDir}\``);
  lines.push(`- **provider/model**: ${meta.provider ?? "?"}/${meta.model ?? "?"}`);
  lines.push(`- **mode**: ${meta.mode ?? "?"}`);
  lines.push(`- **wall_ms**: ${meta.ms ?? dump?.ms ?? "?"}`);
  if (meta.error || dump?.error) {
    lines.push(`- **run_error**: ${meta.error ?? dump?.error}`);
  }
  lines.push(
    `- **tokens**: in=${meta.tokens?.input ?? dump?.tokens?.input ?? "?"} out=${meta.tokens?.output ?? dump?.tokens?.output ?? "?"}`,
  );
  lines.push(
    `- **messages**: ${meta.messageCount ?? dump?.messages?.length ?? "?"}`,
  );
  lines.push(
    `- **tools**: total=${tools.length} completed=${completed.length} error=${errored.length} rate=${tools.length ? ((completed.length / tools.length) * 100).toFixed(0) : 0}%`,
  );
  lines.push(
    `- **reasoningChars**: ${meta.reasoningChars ?? "?"} **textChars**: ${meta.textChars ?? "?"}`,
  );
  lines.push(`- **steps**: ${maxStep || steps.length || "?"}`);
  lines.push(
    `- **phase stream_ms**: ${streamMs} **tool_ms**: ${toolMs}` +
      (sampleMsFromSteps
        ? ` · step-sample_ms≈${sampleMsFromSteps} step-tool_ms≈${toolMsFromSteps}`
        : ""),
  );
  lines.push(
    `- **loop_events**: ${meta.loopEventCount ?? loopSrc.length} (file: ${loopEvents.length ? "loop-events.jsonl" : harnessJsonl.length ? "harness-debug.jsonl" : "none"})`,
  );
  if (avgTtft != null) {
    lines.push(`- **avg_ttft_ms**: ${avgTtft} (n=${ttfts.length})`);
  }
  if (latency?.total?.n) {
    lines.push(
      `- **tool_latency**: n=${latency.total.n} p50=${latency.total.p50 ?? "?"} p95=${latency.total.p95 ?? "?"} mean=${latency.total.mean != null ? Math.round(latency.total.mean) : "?"}`,
    );
  }
  lines.push("");

  lines.push(`## Finish reasons`);
  lines.push("");
  if (!Object.keys(finishReasons).length) {
    lines.push("(no step samples recorded)");
  } else {
    for (const [k, v] of Object.entries(finishReasons).sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${k}\`: ${v}`);
    }
  }
  lines.push("");

  lines.push(`## Per-step breakdown`);
  lines.push("");
  if (!steps.length) {
    lines.push("(no steps.json / loop step events)");
  } else {
    lines.push(`| Step | Finish | TTFT | Content | Reason | Tools | Wave |`);
    lines.push(`|------|--------|------|---------|--------|-------|------|`);
    for (const s of steps) {
      const toolNames = (s.tools ?? []).map((t) => t.name).filter(Boolean).join(", ") || "—";
      const wave = s.toolWave
        ? s.toolWave.map((w) => `${w.name}:${w.ok ? "ok" : "ERR"}`).join(" ")
        : "—";
      lines.push(
        `| ${s.step} | ${s.finish_reason ?? "?"} | ${s.ttftMs ?? "?"} | ${s.contentLen ?? 0} | ${s.reasoningLen ?? 0} | ${toolNames} | ${wave} |`,
      );
    }
  }
  lines.push("");

  lines.push(`## Tool histogram`);
  lines.push("");
  lines.push(`| Tool | Total | OK | Err |`);
  lines.push(`|------|------:|---:|----:|`);
  for (const [name, h] of Object.entries(nameHist).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`| \`${name}\` | ${h.total} | ${h.ok} | ${h.err} |`);
  }
  if (!Object.keys(nameHist).length) lines.push("| — | 0 | 0 | 0 |");
  lines.push("");

  lines.push(`## Expansion tools coverage`);
  lines.push("");
  lines.push(`| Tool | Used |`);
  lines.push(`|------|------|`);
  for (const n of [...EXPANSION].sort()) {
    const hits = tools.filter((t) => t.toolName === n);
    const ok = hits.filter((t) => t.status === "completed").length;
    const bad = hits.filter((t) => t.status !== "completed").length;
    lines.push(
      `| \`${n}\` | ${hits.length ? `yes (${ok} ok, ${bad} err)` : "**no**"} |`,
    );
  }
  lines.push("");

  lines.push(`## Tool sequence`);
  lines.push("");
  lines.push(
    tools
      .map((t, i) => {
        const dur = t.durationMs != null ? ` ${t.durationMs}ms` : "";
        return `${i + 1}. \`${t.toolName}\` **${t.status}**${dur}`;
      })
      .join("\n") || "(none)",
  );
  lines.push("");

  lines.push(`## Errors`);
  lines.push("");
  if (!errored.length) {
    lines.push("No tool errors.");
  } else {
    for (const [bucket, items] of Object.entries(errorBuckets)) {
      lines.push(`### ${bucket}`);
      for (const it of items) lines.push(`- ${it}`);
      lines.push("");
    }
  }

  if (httpErrors.length || sampleErrors.length) {
    lines.push(`## LLM / transport errors`);
    lines.push("");
    for (const e of [...httpErrors, ...sampleErrors].slice(0, 20)) {
      lines.push(
        `- [${e.category}] ${e.event} @${e.ms}ms ${JSON.stringify(e.data ?? {}).slice(0, 200)}`,
      );
    }
    lines.push("");
  }

  lines.push(`## Phase spans (top 15 by duration)`);
  lines.push("");
  const top = [...phaseSpans].sort((a, b) => b.ms - a.ms).slice(0, 15);
  for (const s of top) {
    lines.push(`- ${s.ms}ms — ${s.label}`);
  }
  if (!top.length) lines.push("(no phase timeline)");
  lines.push("");

  if (latency?.slowest?.length) {
    lines.push(`## Slowest tools (latency collector)`);
    lines.push("");
    for (const s of latency.slowest.slice(0, 15)) {
      lines.push(
        `- ${s.ms}ms · \`${s.name}\` (${s.bucket ?? "?"})${s.ok === false ? " FAIL" : ""}`,
      );
    }
    lines.push("");
  }

  lines.push(`## Speedups / loop improvements`);
  lines.push("");
  if (!recs.length) {
    lines.push("- No major loop issues detected from this run.");
  } else {
    for (const r of recs) lines.push(`- ${r}`);
  }
  lines.push("");

  lines.push(`## Signals`);
  lines.push("");
  lines.push(`- doom-loop: ${doomHits}`);
  lines.push(`- broken/salvaged JSON: ${brokenArgs}`);
  lines.push(`- thought-loop: ${thoughtLoops}`);
  lines.push(`- stuck: ${stuckHits}`);
  lines.push(`- llm retries: ${llmRetries}`);
  lines.push(`- http errors: ${httpErrors.length}`);
  lines.push(`- read_file count: ${reReads}`);
  lines.push(`- write/edit count: ${writes}`);
  lines.push(`- shell-like count: ${shellCount}`);
  lines.push(`- multi-tool waves: ${multiWaves.length}${multiWaves.length ? ` (max ${Math.max(...multiWaves)})` : ""}`);

  const report = lines.join("\n");
  writeFileSync(writePath, report, "utf8");
  console.log(report);
  console.error(`\nWrote ${writePath}`);
}

function deriveStepsFromLoop(events: LoopEv[]): StepRec[] {
  const byStep = new Map<number, StepRec>();
  const ensure = (step: number): StepRec => {
    let r = byStep.get(step);
    if (!r) {
      r = { step, events: [] };
      byStep.set(step, r);
    }
    return r;
  };
  for (const ev of events) {
    const mSample = /^step\.(\d+)\.sample$/.exec(ev.event);
    if (mSample) {
      const step = Number(mSample[1]);
      const r = ensure(step);
      r.finish_reason = ev.data?.finish_reason as string | undefined;
      r.ttftMs = ev.data?.ttftMs as number | undefined;
      r.contentLen = ev.data?.contentLen as number | undefined;
      r.reasoningLen = ev.data?.reasoningLen as number | undefined;
      r.tools = ev.data?.tool_calls as StepRec["tools"];
      continue;
    }
    const mWave = /^step\.(\d+)\.tools\.wave_summary$/.exec(ev.event);
    if (mWave) {
      const step = Number(mWave[1]);
      const r = ensure(step);
      r.toolWave = ev.data?.results as StepRec["toolWave"];
      continue;
    }
    const mEnd = /^step\.(\d+):end$/.exec(ev.event);
    if (mEnd) {
      const step = Number(mEnd[1]);
      const r = ensure(step);
      r.durationMs = ev.data?.durationMs as number | undefined;
    }
  }
  return [...byStep.values()].sort((a, b) => a.step - b.step);
}

main();
