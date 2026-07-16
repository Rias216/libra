/**
 * Headless live debug run against a real provider.
 * Drives AgentLoop + store; dumps every agent-loop detail for postmortem.
 *
 * Usage:
 *   LIBRA_DEBUG=info bun scripts/debug-live-run.ts --cwd <dir> --prompt <text>
 *   bun scripts/debug-live-run.ts --cwd <dir> --prompt-file <path>
 *   bun scripts/debug-live-run.ts --fusion --model tencent/hy3:free --peer openrouter/tencent/hy3:free ...
 *
 * Full detail (no truncation, JSONL + loop-events):
 *   LIBRA_DEBUG=info LIBRA_DEBUG_FULL=1 bun scripts/debug-live-run.ts ...
 *
 * Ultra + Fusion (dual hy3):
 *   --fusion  (or config agent.reasoning.custom=ultra-fusion)
 *   main + peer each reason (no tools), then main compares + executes
 *
 * Artifacts written to --out (default <cwd>/.libra-debug-run):
 *   dump.json           full message/part dump (incl. tool args/results)
 *   meta.json           summary scores inputs
 *   transcript.md       human-readable
 *   timeline.jsonl      harness UI events
 *   loop-events.jsonl   every dbg() event mirrored in-process
 *   tools.json          ordered tool call table
 *   steps.json          per-step sample + tool wave summary
 *   latency.json        globalLatency p50/p95
 *   system-prompt.txt   effective system prompt (if recoverable)
 *   harness-debug.log   text debug log (when LIBRA_DEBUG_FILE set here)
 *   harness-debug.jsonl structured debug log
 */

import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  copyFileSync,
  appendFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { HarnessStore } from "../src/core/store.js";
import { AgentLoop, buildSystemPrompt } from "../src/agent/loop.js";
import {
  initDebug,
  getDebugLogPath,
  getDebugJsonlPath,
  onDebugEvent,
  dbg,
  clearDebugRing,
  getDebugRing,
  type DebugEvent,
} from "../src/agent/debug.js";
import { resolveToken } from "../src/auth/api-key.js";
import { loadConfig } from "../src/config/store.js";
import {
  loadAgentSettings,
  saveAgentSettings,
  type CustomReasoningMode,
} from "../src/agent/config.js";
import { prepareFusionForMain } from "../src/agent/fusion.js";
import { modelKey } from "../src/auth/models.js";
import type { ProviderId } from "../src/auth/types.js";
import type { Part } from "../src/core/types.js";
import { globalLatency } from "../src/toolcalling/latency.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

/** Bench effort: free models cap at medium (tool-loop wall time); paid → high. */
function benchEffortForModel(model: string, current: string): string {
  const free = /:free$|flash-free|hy3|pickle|deepseek-v4-flash(?!-pro)/i.test(
    model,
  );
  const low =
    current === "default" ||
    current === "off" ||
    current === "none" ||
    current === "low" ||
    current === "minimal";
  if (free) {
    if (current === "high" || current === "xhigh" || current === "max") {
      return "medium";
    }
    return low ? "medium" : current;
  }
  return low ? "high" : current;
}

interface StepRecord {
  step: number;
  startMs?: number;
  endMs?: number;
  durationMs?: number;
  finish_reason?: string;
  ttftMs?: number;
  contentLen?: number;
  reasoningLen?: number;
  tools?: Array<{ id?: string; name?: string; argsChars?: number }>;
  usage?: unknown;
  toolWave?: Array<{
    name: string;
    ok: boolean;
    ms?: number;
    outLen?: number;
    doomLoop?: boolean;
  }>;
  events: string[];
}

function extractSteps(events: DebugEvent[]): StepRecord[] {
  const byStep = new Map<number, StepRecord>();
  const ensure = (step: number): StepRecord => {
    let r = byStep.get(step);
    if (!r) {
      r = { step, events: [] };
      byStep.set(step, r);
    }
    return r;
  };

  for (const ev of events) {
    const mStart = /^step\.(\d+)\.start$/.exec(ev.event);
    if (mStart) {
      const step = Number(mStart[1]);
      const r = ensure(step);
      r.startMs = ev.ms;
      r.events.push(ev.event);
      continue;
    }
    const mSample = /^step\.(\d+)\.sample$/.exec(ev.event);
    if (mSample) {
      const step = Number(mSample[1]);
      const r = ensure(step);
      r.finish_reason = ev.data?.finish_reason as string | undefined;
      r.ttftMs = ev.data?.ttftMs as number | undefined;
      r.contentLen = ev.data?.contentLen as number | undefined;
      r.reasoningLen = ev.data?.reasoningLen as number | undefined;
      r.usage = ev.data?.usage;
      r.tools = ev.data?.tool_calls as StepRecord["tools"];
      r.events.push(ev.event);
      continue;
    }
    const mWave = /^step\.(\d+)\.tools\.wave_summary$/.exec(ev.event);
    if (mWave) {
      const step = Number(mWave[1]);
      const r = ensure(step);
      r.toolWave = ev.data?.results as StepRecord["toolWave"];
      r.events.push(ev.event);
      continue;
    }
    const mEnd = /^step\.(\d+):end$/.exec(ev.event);
    if (mEnd) {
      const step = Number(mEnd[1]);
      const r = ensure(step);
      r.endMs = ev.ms;
      r.durationMs = (ev.data?.durationMs as number | undefined) ?? undefined;
      r.events.push(ev.event);
      continue;
    }
    const mAny = /^step\.(\d+)\./.exec(ev.event);
    if (mAny) {
      ensure(Number(mAny[1])).events.push(ev.event);
    }
  }

  return [...byStep.values()].sort((a, b) => a.step - b.step);
}

async function main(): Promise<void> {
  // Respect LIBRA_DEBUG (info/trace/off). Default to info for benches —
  // forcing "trace" floods stderr + disk with every SSE chunk and is a
  // major lag source when reasoning streams are large/fast.
  // Prefer LIBRA_DEBUG_FULL=1 for complete tool args/results without SSE spam.
  const envDbg = (process.env.LIBRA_DEBUG ?? "info").trim().toLowerCase();
  const dbgLevel =
    envDbg === "0" || envDbg === "false" || envDbg === "off"
      ? "off"
      : envDbg === "trace" || envDbg === "2" || envDbg === "verbose"
        ? "trace"
        : "info";

  // Full payloads by default for live debug runs (benches need every detail).
  // Opt out with LIBRA_DEBUG_FULL=0.
  if (
    !process.env.LIBRA_DEBUG_FULL &&
    dbgLevel !== "off"
  ) {
    process.env.LIBRA_DEBUG_FULL = "1";
  }

  const cfg = loadConfig();
  const provider = (arg("--provider") ?? cfg.provider ?? "openrouter") as ProviderId;
  const model = arg("--model") ?? cfg.model ?? "tencent/hy3:free";
  const cwd = resolve(arg("--cwd") ?? process.cwd());
  const outDir = resolve(arg("--out") ?? join(cwd, ".libra-debug-run"));
  mkdirSync(outDir, { recursive: true });

  // Pin debug files into the outDir so benches are self-contained
  if (!process.env.LIBRA_DEBUG_FILE) {
    process.env.LIBRA_DEBUG_FILE = join(outDir, "harness-debug.log");
  }

  initDebug(dbgLevel);
  clearDebugRing();
  globalLatency.clear();

  // Mirror every dbg event into outDir/loop-events.jsonl in real time
  const loopEventsPath = join(outDir, "loop-events.jsonl");
  writeFileSync(loopEventsPath, "", "utf8");
  const captured: DebugEvent[] = [];
  const unsub = onDebugEvent((ev) => {
    captured.push(ev);
    try {
      appendFileSync(
        loopEventsPath,
        JSON.stringify({
          seq: ev.seq,
          ms: ev.ms,
          at: ev.at,
          category: ev.category,
          event: ev.event,
          level: ev.level,
          data: ev.data,
        }) + "\n",
        "utf8",
      );
    } catch {
      /* */
    }
  });

  let prompt =
    arg("--prompt") ??
    "Create a small TypeScript project: package.json, tsconfig, src/index.ts CLI that sums numbers from argv, and a test. Run the test.";
  const pf = arg("--prompt-file");
  if (pf) prompt = readFileSync(resolve(pf), "utf8");

  const token = resolveToken(provider);
  if (!token) {
    console.error(`No auth token for provider=${provider}. Login first.`);
    process.exit(2);
  }

  // Resolve harness mode: --fusion / --mode ultra-fusion | ultra | none
  // Defaults to config when flags omitted.
  const modeArg = (arg("--mode") ?? "").trim().toLowerCase();
  const wantFusion =
    hasFlag("--fusion") ||
    modeArg === "ultra-fusion" ||
    (modeArg === "" && loadAgentSettings().reasoning.custom === "ultra-fusion");
  const wantUltra =
    !wantFusion &&
    (modeArg === "ultra" ||
      (modeArg === "" && loadAgentSettings().reasoning.custom === "ultra"));
  // Explicit plain mode for fair toolcall benches
  const forcePlain =
    hasFlag("--plain") ||
    modeArg === "none" ||
    modeArg === "plain" ||
    modeArg === "off";

  const mainKey = modelKey({ provider, model });
  // Peer for fusion: --peer, else fusion.modelKeys[0], else dual-sample main (2× hy3)
  const peerArg = arg("--peer")?.trim();

  // Snapshot settings to restore after bench (avoid polluting user config)
  const settingsBefore = structuredClone(loadAgentSettings());

  if (forcePlain) {
    saveAgentSettings({
      reasoning: {
        ...settingsBefore.reasoning,
        custom: "none" as CustomReasoningMode,
        effort: benchEffortForModel(model, settingsBefore.reasoning.effort),
      },
      subagents: {
        ...settingsBefore.subagents,
        enabled: hasFlag("--subagents"),
        autoSpawn: hasFlag("--subagents"),
      },
    });
    console.error(`[debug-live-run] mode=plain (forced) main=${mainKey}`);
  } else if (wantFusion) {
    const peerKey = peerArg || loadAgentSettings().reasoning.fusion.modelKeys[0] || mainKey;
    const cur = loadAgentSettings();
    saveAgentSettings({
      reasoning: {
        ...cur.reasoning,
        custom: "ultra-fusion" as CustomReasoningMode,
        effort: benchEffortForModel(model, cur.reasoning.effort),
        fusion: {
          ...cur.reasoning.fusion,
          modelKeys: [peerKey],
          minModels: 1,
          maxParallel: 1,
          reasoningOnly: true,
        },
      },
      subagents: {
        ...cur.subagents,
        enabled: true,
        autoSpawn: true,
        preferredModelKey: mainKey,
      },
    });
    console.error(
      `[debug-live-run] mode=ultra-fusion main=${mainKey} peer=${peerKey}` +
        (peerKey === mainKey ? " (dual-sample)" : ""),
    );
  } else if (wantUltra) {
    const cur = loadAgentSettings();
    saveAgentSettings({
      reasoning: {
        ...cur.reasoning,
        custom: "ultra" as CustomReasoningMode,
        effort: benchEffortForModel(model, cur.reasoning.effort),
      },
      subagents: {
        ...cur.subagents,
        enabled: true,
        autoSpawn: true,
        preferredModelKey: mainKey,
      },
    });
    console.error(`[debug-live-run] mode=ultra main=${mainKey}`);
  } else {
    // Cap free effort even when not forcing mode
    const cur = loadAgentSettings();
    const effort = benchEffortForModel(model, cur.reasoning.effort);
    if (effort !== cur.reasoning.effort) {
      saveAgentSettings({
        reasoning: { ...cur.reasoning, effort },
      });
    }
    console.error(
      `[debug-live-run] mode=${loadAgentSettings().reasoning.custom} main=${mainKey}`,
    );
  }

  const store = new HarnessStore({
    title: "debug-live-run",
    provider,
    model,
    cwd,
  });

  // Mirror ALL harness events to timeline (full detail for tool status)
  const timeline: string[] = [];
  store.subscribe((ev) => {
    const t = Date.now();
    if (ev.type === "text.delta" || ev.type === "reasoning.delta") {
      timeline.push(
        JSON.stringify({
          t,
          type: ev.type,
          messageId: ev.messageId,
          partId: ev.partId,
          delta: (ev as { delta: string }).delta,
          deltaChars: (ev as { delta: string }).delta.length,
        }),
      );
    } else if (ev.type === "phase") {
      timeline.push(
        JSON.stringify({
          t,
          type: "phase",
          phase: ev.phase,
          label: ev.label,
        }),
      );
      process.stderr.write(`[phase] ${ev.phase} ${ev.label ?? ""}\n`);
    } else if (ev.type === "tool.status") {
      timeline.push(
        JSON.stringify({
          t,
          type: "tool.status",
          status: ev.status,
          partId: ev.partId,
          messageId: ev.messageId,
          result:
            ev.result != null ? String(ev.result).slice(0, 50_000) : undefined,
          error: ev.error != null ? String(ev.error).slice(0, 8_000) : undefined,
          resultChars: ev.result != null ? String(ev.result).length : 0,
        }),
      );
    } else if (ev.type === "part.append") {
      const p = ev.part;
      const row: Record<string, unknown> = {
        t,
        type: "part.append",
        messageId: ev.messageId,
        partType: p.type,
        partId: p.id,
      };
      if (p.type === "text" || p.type === "reasoning") {
        row.chars = p.content.length;
        row.preview = p.content.slice(0, 500);
        row.streaming = p.streaming;
        if (p.type === "reasoning" && p.title) row.title = p.title;
      } else if (p.type === "tool") {
        row.toolName = p.toolName;
        row.status = p.status;
        row.callId = p.callId;
        row.args = p.args;
      } else if (p.type === "status") {
        row.level = p.level;
        row.message = p.message;
      }
      timeline.push(JSON.stringify(row));
    } else if (ev.type === "part.update" || ev.type === "part.patch") {
      timeline.push(
        JSON.stringify({
          t,
          type: ev.type,
          messageId: ev.messageId,
          partId: ev.partId,
        }),
      );
    } else if (ev.type === "tokens") {
      timeline.push(
        JSON.stringify({
          t,
          type: "tokens",
          input: ev.input,
          output: ev.output,
        }),
      );
    } else if (ev.type === "error") {
      timeline.push(
        JSON.stringify({ t, type: "error", message: ev.message }),
      );
    } else {
      timeline.push(JSON.stringify({ t, type: ev.type }));
    }
  });

  const live = new AgentLoop(store);
  const started = Date.now();
  console.error(
    `[debug-live-run] provider=${provider} model=${model} cwd=${cwd}`,
  );
  console.error(`[debug-live-run] promptLen=${prompt.length} out=${outDir}`);
  console.error(
    `[debug-live-run] debug=${dbgLevel} full=${process.env.LIBRA_DEBUG_FULL ?? "?"} file=${getDebugLogPath()}`,
  );
  dbg("debug-run", "start", {
    provider,
    model,
    cwd,
    promptLen: prompt.length,
    fusion: wantFusion && !forcePlain,
    plain: forcePlain,
    promptPreview: prompt.slice(0, 500),
  });

  // Capture system prompt used (plain path rebuilds inside turn; dump settings-based)
  const settingsNow = loadAgentSettings();
  const systemPromptSnapshot = buildSystemPrompt({
    extra: settingsNow.reasoning.customInstructions,
    model,
    provider,
    cwd,
    profile: (arg("--profile") as "full" | "slim" | undefined) ?? "full",
  });
  writeFileSync(
    join(outDir, "system-prompt.txt"),
    systemPromptSnapshot,
    "utf8",
  );
  writeFileSync(join(outDir, "prompt.txt"), prompt, "utf8");

  const ac = new AbortController();
  const timeoutMs = Number(arg("--timeout-ms") ?? 600_000);
  const timer = setTimeout(() => {
    console.error(`[debug-live-run] timeout ${timeoutMs}ms — cancelling`);
    live.cancel();
    ac.abort();
  }, timeoutMs);

  const maxSteps = Number(arg("--max-steps") ?? 40);
  // Fusion / ultra default ON subagents; plain benches keep them off unless flagged
  const subagents =
    hasFlag("--subagents") ||
    (!forcePlain && (wantFusion || wantUltra));
  const promptProfile =
    (arg("--profile") as "full" | "slim" | undefined) ?? "full";

  let fusionMeta: Record<string, unknown> | null = null;
  let runError: string | null = null;

  try {
    if (wantFusion && !forcePlain) {
      const settings = loadAgentSettings();
      const peerKey =
        peerArg ||
        settings.reasoning.fusion.modelKeys[0] ||
        mainKey;
      console.error(`[debug-live-run] fusion phase-1: main + peer reasoning…`);
      const prep = await prepareFusionForMain(
        store,
        prompt,
        provider,
        model,
        {
          signal: ac.signal,
          // Explicit peer (supports dual hy3 when peer === main)
          secondaryKeys: [peerKey],
        },
      );
      fusionMeta = {
        summary: prep.summary,
        phase1Ms: prep.phase1Ms,
        main: {
          key: prep.mainReasoning.modelKey,
          ms: prep.mainReasoning.ms,
          ttftMs: prep.mainReasoning.ttftMs,
          chars: prep.mainReasoning.text.length,
          error: prep.mainReasoning.error,
        },
        peer: prep.secondaries[0]
          ? {
              key: prep.secondaries[0].modelKey,
              ms: prep.secondaries[0].ms,
              ttftMs: prep.secondaries[0].ttftMs,
              chars: prep.secondaries[0].text.length,
              error: prep.secondaries[0].error,
            }
          : null,
        displayReasoningChars: prep.displayReasoning.length,
        systemAddonChars: prep.systemAddon.length,
      };
      writeFileSync(
        join(outDir, "fusion-phase1.json"),
        JSON.stringify(
          {
            ...fusionMeta,
            mainPreview: prep.mainReasoning.text.slice(0, 2000),
            peerPreview: prep.secondaries[0]?.text.slice(0, 2000) ?? "",
            displayReasoning: prep.displayReasoning.slice(0, 8000),
            systemAddon: prep.systemAddon.slice(0, 8000),
          },
          null,
          2,
        ),
        "utf8",
      );
      console.error(
        `[debug-live-run] fusion phase-1 done ${prep.phase1Ms}ms ` +
          `mainChars=${prep.mainReasoning.text.length} peerChars=${prep.secondaries[0]?.text.length ?? 0}`,
      );
      if (prep.mainReasoning.error) {
        console.error(`[debug-live-run] main phase-1 error: ${prep.mainReasoning.error}`);
      }
      if (prep.secondaries[0]?.error) {
        console.error(`[debug-live-run] peer phase-1 error: ${prep.secondaries[0].error}`);
      }

      const system =
        buildSystemPrompt({
          extra: settings.reasoning.customInstructions,
          model,
          provider,
          cwd,
          profile: promptProfile,
        }) +
        "\n\n" +
        prep.systemAddon;
      writeFileSync(join(outDir, "system-prompt.txt"), system, "utf8");

      await live.handle(prompt, {
        provider,
        model,
        cwd,
        tools: true,
        autoApprove: true,
        abortSignal: ac.signal,
        label: arg("--label") ?? "debug-live-fusion",
        maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : 40,
        subagents,
        promptProfile,
        systemPrompt: system,
        seedReasoning: prep.displayReasoning,
        lightReasoning: true,
      });
    } else {
      await live.handle(prompt, {
        provider,
        model,
        cwd,
        tools: true,
        autoApprove: true,
        abortSignal: ac.signal,
        label: arg("--label") ?? "debug-live",
        maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : 40,
        subagents,
        promptProfile,
      });
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    console.error("[debug-live-run] error:", runError);
    dbg("debug-run", "error", { error: runError });
  } finally {
    clearTimeout(timer);
    unsub();
    // Restore user settings so benches don't stick ultra/plain modes
    try {
      saveAgentSettings(settingsBefore);
    } catch {
      /* */
    }
  }

  const ms = Date.now() - started;
  const allParts = store.state.messages.flatMap((m) => m.parts);
  const toolTable = extractToolTable(store.state.messages);
  const steps = extractSteps(captured.length ? captured : [...getDebugRing()]);

  const dump = {
    ms,
    provider,
    model,
    cwd,
    prompt,
    error: runError,
    fusion: fusionMeta,
    phase: store.state.phase,
    activityLabel: store.state.activityLabel,
    tokens: store.state.tokens,
    messages: store.state.messages.map((m) => ({
      id: m.id,
      role: m.role,
      createdAt: m.createdAt,
      parts: m.parts.map((p) => summarizePartFull(p)),
    })),
  };

  writeFileSync(join(outDir, "dump.json"), JSON.stringify(dump, null, 2), "utf8");
  writeFileSync(join(outDir, "timeline.jsonl"), timeline.join("\n") + "\n", "utf8");
  writeFileSync(join(outDir, "tools.json"), JSON.stringify(toolTable, null, 2), "utf8");
  writeFileSync(join(outDir, "steps.json"), JSON.stringify(steps, null, 2), "utf8");
  writeFileSync(
    join(outDir, "latency.json"),
    JSON.stringify(globalLatency.summary(), null, 2),
    "utf8",
  );

  // Human-readable transcript
  const lines: string[] = [];
  lines.push(`# Libra debug live run`);
  lines.push(`provider/model: ${provider}/${model}`);
  lines.push(`cwd: ${cwd}`);
  lines.push(`duration_ms: ${ms}`);
  lines.push(
    `mode: ${forcePlain ? "plain" : wantFusion ? "ultra-fusion" : wantUltra ? "ultra" : settingsBefore.reasoning.custom}`,
  );
  if (fusionMeta) {
    lines.push(`fusion_phase1_ms: ${fusionMeta.phase1Ms}`);
    lines.push(`fusion_summary: ${fusionMeta.summary}`);
  }
  if (runError) lines.push(`error: ${runError}`);
  lines.push(`tokens: in=${store.state.tokens.input} out=${store.state.tokens.output}`);
  lines.push(`phase: ${store.state.phase}`);
  lines.push(`steps: ${steps.length}`);
  lines.push(`tools: ${toolTable.length}`);
  lines.push("");
  lines.push(`## Prompt`);
  lines.push(prompt);
  lines.push("");

  lines.push(`## Steps summary`);
  for (const s of steps) {
    const toolNames = (s.tools ?? []).map((t) => t.name).filter(Boolean).join(", ");
    lines.push(
      `- step ${s.step}: finish=${s.finish_reason ?? "?"} ttft=${s.ttftMs ?? "?"}ms ` +
        `content=${s.contentLen ?? 0} reason=${s.reasoningLen ?? 0} tools=[${toolNames}]` +
        (s.toolWave
          ? ` wave=${s.toolWave.map((w) => `${w.name}:${w.ok ? "ok" : "ERR"}(${w.ms}ms)`).join(",")}`
          : ""),
    );
  }
  lines.push("");

  for (const m of store.state.messages) {
    lines.push(`## ${m.role} (${m.id})`);
    for (const p of m.parts) {
      if (p.type === "reasoning") {
        lines.push(
          `### reasoning${p.collapsed ? " [collapsed]" : ""}${p.title ? " · " + p.title : ""}`,
        );
        lines.push(p.content);
        lines.push("");
      } else if (p.type === "text") {
        lines.push(`### text`);
        lines.push(p.content);
        lines.push("");
      } else if (p.type === "tool") {
        lines.push(
          `### tool ${p.toolName} (${p.status}) callId=${p.callId ?? "?"}`,
        );
        lines.push("```json");
        lines.push(JSON.stringify(p.args ?? {}, null, 2));
        lines.push("```");
        if (p.result) {
          lines.push("result:");
          lines.push("```");
          // Full result in transcript (bench postmortem)
          lines.push(String(p.result).slice(0, 20_000));
          lines.push("```");
        }
        if (p.error) {
          lines.push(`error: ${p.error}`);
        }
        lines.push("");
      } else if (p.type === "status") {
        lines.push(`### status ${p.level}: ${p.message}`);
        lines.push("");
      }
    }
  }

  const transcriptPath = join(outDir, "transcript.md");
  writeFileSync(transcriptPath, lines.join("\n"), "utf8");

  const modeLabel = forcePlain
    ? "plain"
    : wantFusion
      ? "ultra-fusion"
      : wantUltra
        ? "ultra"
        : "plain";

  const dbgPath = getDebugLogPath();
  const jsonlPath = getDebugJsonlPath();

  // Copy jsonl into outDir if it lives elsewhere
  if (jsonlPath && existsSync(jsonlPath)) {
    try {
      copyFileSync(jsonlPath, join(outDir, "harness-debug.jsonl"));
    } catch {
      /* */
    }
  }

  writeFileSync(
    join(outDir, "meta.json"),
    JSON.stringify(
      {
        ms,
        transcriptPath,
        debugLogPath: dbgPath,
        debugJsonlPath: jsonlPath,
        loopEventsPath,
        outDir,
        provider,
        model,
        mode: modeLabel,
        error: runError,
        fusion: fusionMeta,
        messageCount: store.state.messages.length,
        stepCount: steps.length,
        toolParts: countTools(allParts),
        reasoningChars: sumReasoning(allParts),
        textChars: sumText(allParts),
        tokens: store.state.tokens,
        loopEventCount: captured.length,
        latency: globalLatency.summary(),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.error(`[debug-live-run] done in ${ms}ms → ${outDir}`);
  console.error(`[debug-live-run] transcript: ${transcriptPath}`);
  console.error(
    `[debug-live-run] steps=${steps.length} tools=${toolTable.length} loopEvents=${captured.length}`,
  );
  if (dbgPath) console.error(`[debug-live-run] debug log: ${dbgPath}`);
  console.log(transcriptPath);
}

function summarizePartFull(p: Part): Record<string, unknown> {
  if (p.type === "text" || p.type === "reasoning") {
    return {
      type: p.type,
      chars: p.content.length,
      content: p.content,
      streaming: p.streaming,
      collapsed: "collapsed" in p ? p.collapsed : undefined,
      title: p.type === "reasoning" ? p.title : undefined,
    };
  }
  if (p.type === "tool") {
    return {
      type: "tool",
      toolName: p.toolName,
      status: p.status,
      callId: p.callId,
      args: p.args,
      result: p.result != null ? String(p.result) : undefined,
      error: p.error,
      startedAt: p.startedAt,
      finishedAt: p.finishedAt,
      durationMs:
        p.startedAt && p.finishedAt ? p.finishedAt - p.startedAt : undefined,
    };
  }
  if (p.type === "status") {
    return { type: "status", level: p.level, message: p.message };
  }
  return { type: p.type };
}

function extractToolTable(
  messages: Array<{ role: string; parts: Part[] }>,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let i = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== "tool") continue;
      i++;
      rows.push({
        n: i,
        toolName: p.toolName,
        status: p.status,
        callId: p.callId,
        args: p.args,
        result: p.result != null ? String(p.result) : undefined,
        error: p.error,
        startedAt: p.startedAt,
        finishedAt: p.finishedAt,
        durationMs:
          p.startedAt && p.finishedAt
            ? p.finishedAt - p.startedAt
            : undefined,
      });
    }
  }
  return rows;
}

function countTools(parts: Part[]): {
  total: number;
  completed: number;
  error: number;
  names: string[];
} {
  const tools = parts.filter((p) => p.type === "tool");
  return {
    total: tools.length,
    completed: tools.filter((p) => p.type === "tool" && p.status === "completed")
      .length,
    error: tools.filter((p) => p.type === "tool" && p.status === "error").length,
    names: tools.map((p) => (p.type === "tool" ? p.toolName : "")),
  };
}

function sumReasoning(parts: Part[]): number {
  return parts
    .filter((p) => p.type === "reasoning")
    .reduce((n, p) => n + (p.type === "reasoning" ? p.content.length : 0), 0);
}

function sumText(parts: Part[]): number {
  return parts
    .filter((p) => p.type === "text")
    .reduce((n, p) => n + (p.type === "text" ? p.content.length : 0), 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
