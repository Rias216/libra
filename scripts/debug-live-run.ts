/**
 * Headless live debug run against a real provider.
 * Drives AgentLoop + store; dumps reasoning, tools, text, and debug log.
 *
 * Usage:
 *   LIBRA_DEBUG=trace bun scripts/debug-live-run.ts --cwd <dir> --prompt <text>
 *   LIBRA_DEBUG=trace bun scripts/debug-live-run.ts --cwd <dir> --prompt-file <path>
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { HarnessStore } from "../src/core/store.js";
import { AgentLoop } from "../src/agent/loop.js";
import { initDebug, getDebugLogPath, dbg } from "../src/agent/debug.js";
import { resolveToken } from "../src/auth/api-key.js";
import { loadConfig } from "../src/config/store.js";
import type { ProviderId } from "../src/auth/types.js";
import type { Part } from "../src/core/types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  // Respect LIBRA_DEBUG (info/trace/off). Default to info for benches —
  // forcing "trace" floods stderr + disk with every SSE chunk and is a
  // major lag source when reasoning streams are large/fast.
  const envDbg = (process.env.LIBRA_DEBUG ?? "info").trim().toLowerCase();
  const dbgLevel =
    envDbg === "0" || envDbg === "false" || envDbg === "off"
      ? "off"
      : envDbg === "trace" || envDbg === "2" || envDbg === "verbose"
        ? "trace"
        : "info";
  initDebug(dbgLevel);
  const cfg = loadConfig();
  const provider = (arg("--provider") ?? cfg.provider ?? "openrouter") as ProviderId;
  const model = arg("--model") ?? cfg.model ?? "tencent/hy3:free";
  const cwd = resolve(arg("--cwd") ?? process.cwd());
  const outDir = resolve(
    arg("--out") ?? join(cwd, ".libra-debug-run"),
  );
  mkdirSync(outDir, { recursive: true });

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

  const store = new HarnessStore({
    title: "debug-live-run",
    provider,
    model,
    cwd,
  });

  // Mirror events to a timeline file
  const timeline: string[] = [];
  store.subscribe((ev) => {
    const t = Date.now();
    if (ev.type === "text.delta" || ev.type === "reasoning.delta") {
      timeline.push(
        JSON.stringify({
          t,
          type: ev.type,
          delta: (ev as { delta: string }).delta.slice(0, 200),
        }),
      );
    } else if (ev.type === "phase") {
      timeline.push(JSON.stringify({ t, type: "phase", phase: ev.phase, label: ev.label }));
      process.stderr.write(`[phase] ${ev.phase} ${ev.label ?? ""}\n`);
    } else if (ev.type === "tool.status") {
      timeline.push(
        JSON.stringify({
          t,
          type: "tool.status",
          status: ev.status,
          partId: ev.partId,
        }),
      );
    } else if (ev.type === "part.append") {
      const p = ev.part;
      timeline.push(
        JSON.stringify({
          t,
          type: "part.append",
          partType: p.type,
          preview:
            p.type === "text" || p.type === "reasoning"
              ? p.content.slice(0, 120)
              : p.type === "tool"
                ? `${p.toolName} ${p.status}`
                : p.type,
        }),
      );
    }
  });

  const live = new AgentLoop(store);
  const started = Date.now();
  console.error(
    `[debug-live-run] provider=${provider} model=${model} cwd=${cwd}`,
  );
  console.error(`[debug-live-run] promptLen=${prompt.length}`);
  dbg("debug-run", "start", { provider, model, cwd, promptLen: prompt.length });

  const ac = new AbortController();
  const timeoutMs = Number(arg("--timeout-ms") ?? 600_000);
  const timer = setTimeout(() => {
    console.error(`[debug-live-run] timeout ${timeoutMs}ms — cancelling`);
    live.cancel();
    ac.abort();
  }, timeoutMs);

  const maxSteps = Number(arg("--max-steps") ?? 40);
  const subagents = hasFlag("--subagents"); // default OFF for clean benches
  const promptProfile =
    (arg("--profile") as "full" | "slim" | undefined) ?? "full";

  try {
    await live.handle(prompt, {
      provider,
      model,
      cwd,
      tools: true,
      autoApprove: true,
      abortSignal: ac.signal,
      label: arg("--label") ?? "debug-live",
      maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : 40,
      // Benches use external parallelism — Libra multi-agent off unless requested
      subagents,
      promptProfile,
    });
  } catch (err) {
    console.error(
      "[debug-live-run] error:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - started;
  const dump = {
    ms,
    provider,
    model,
    cwd,
    prompt,
    phase: store.state.phase,
    activityLabel: store.state.activityLabel,
    tokens: store.state.tokens,
    messages: store.state.messages.map((m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts.map(summarizePart),
    })),
  };

  writeFileSync(join(outDir, "dump.json"), JSON.stringify(dump, null, 2), "utf8");
  writeFileSync(join(outDir, "timeline.jsonl"), timeline.join("\n") + "\n", "utf8");

  // Human-readable transcript
  const lines: string[] = [];
  lines.push(`# Libra debug live run`);
  lines.push(`provider/model: ${provider}/${model}`);
  lines.push(`cwd: ${cwd}`);
  lines.push(`duration_ms: ${ms}`);
  lines.push(`tokens: in=${store.state.tokens.input} out=${store.state.tokens.output}`);
  lines.push(`phase: ${store.state.phase}`);
  lines.push("");
  lines.push(`## Prompt`);
  lines.push(prompt);
  lines.push("");

  for (const m of store.state.messages) {
    lines.push(`## ${m.role} (${m.id})`);
    for (const p of m.parts) {
      if (p.type === "reasoning") {
        lines.push(`### reasoning${p.collapsed ? " [collapsed]" : ""}`);
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
          lines.push(String(p.result).slice(0, 4000));
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

  // Copy debug log path pointer
  const dbgPath = getDebugLogPath();
  writeFileSync(
    join(outDir, "meta.json"),
    JSON.stringify(
      {
        ms,
        transcriptPath,
        debugLogPath: dbgPath,
        outDir,
        provider,
        model,
        messageCount: store.state.messages.length,
        toolParts: countTools(store.state.messages.flatMap((m) => m.parts)),
        reasoningChars: sumReasoning(store.state.messages.flatMap((m) => m.parts)),
        textChars: sumText(store.state.messages.flatMap((m) => m.parts)),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.error(`[debug-live-run] done in ${ms}ms → ${outDir}`);
  console.error(`[debug-live-run] transcript: ${transcriptPath}`);
  if (dbgPath) console.error(`[debug-live-run] debug log: ${dbgPath}`);
  console.log(transcriptPath);
}

function summarizePart(p: Part): Record<string, unknown> {
  if (p.type === "text" || p.type === "reasoning") {
    return {
      type: p.type,
      chars: p.content.length,
      preview: p.content.slice(0, 300),
      streaming: p.streaming,
      collapsed: "collapsed" in p ? p.collapsed : undefined,
    };
  }
  if (p.type === "tool") {
    return {
      type: "tool",
      toolName: p.toolName,
      status: p.status,
      callId: p.callId,
      args: p.args,
      resultPreview:
        p.result != null ? String(p.result).slice(0, 400) : undefined,
      error: p.error,
    };
  }
  if (p.type === "status") {
    return { type: "status", level: p.level, message: p.message };
  }
  return { type: p.type };
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
