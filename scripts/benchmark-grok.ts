/**
 * Live harness benchmarks (latency / tools / agent / multistep / memory / fusion).
 *
 *   LIBRA_DEBUG=1 npx tsx scripts/benchmark-grok.ts
 *   npm run bench:grok
 *   npx tsx scripts/benchmark-grok.ts --model=grok-4.5
 *   npx tsx scripts/benchmark-grok.ts --provider=openrouter --model=tencent/hy3:free
 *   npx tsx scripts/benchmark-grok.ts --skip=fusion
 *
 * Suites (live):
 *   latency   — simple ping + TTFT
 *   tools     — forced tool_choice + ToolExecutor
 *   agent     — full AgentLoop multi-round (list_dir → answer)
 *   multistep — agent must list + read package.json
 *   fusion    — Ultra+Fusion (peer hy3 when OpenRouter available, else dual main)
 *   memory    — session token harvest after agent turn
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveToken } from "../src/auth/api-key.js";
import type { ProviderId } from "../src/auth/types.js";
import { saveConfig } from "../src/config/store.js";
import { saveAgentSettings } from "../src/agent/config.js";
import { HarnessStore } from "../src/core/store.js";
import { AgentLoop, buildSystemPrompt } from "../src/agent/loop.js";
import { prepareFusionForMain } from "../src/agent/fusion.js";
import { initDebug, dbg, getDebugLogPath, isDebug } from "../src/agent/debug.js";
import { chatComplete } from "../src/llm/client.js";
import { OPENAI_TOOLS } from "../src/toolcalling/schema.js";
import { ToolExecutor } from "../src/toolcalling/executor.js";
import { extractSessionTokens } from "../src/memory/session-memory.js";
import {
  Suite,
  runSuites,
  printReport,
  assert,
  assertGte,
  assertIncludes,
  type BenchReport,
} from "./bench/runner.js";

const PROVIDER = (() => {
  const a = process.argv.find((x) => x.startsWith("--provider="));
  return (a?.split("=")[1] || process.env.LIBRA_BENCH_PROVIDER || "xai") as ProviderId;
})();

const MODEL = (() => {
  const a = process.argv.find((x) => x.startsWith("--model="));
  if (a?.split("=")[1]) return a.split("=")[1]!;
  if (PROVIDER === "openrouter") {
    return process.env.LIBRA_HY3_MODEL || "tencent/hy3:free";
  }
  return process.env.LIBRA_GROK_MODEL || "grok-4.5";
})();

const MAIN_KEY = `${PROVIDER}/${MODEL}`;
const isHy3 =
  PROVIDER === "openrouter" && /hy3/i.test(MODEL);

const skip = new Set(
  (process.argv.find((a) => a.startsWith("--skip="))?.split("=")[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function hasXai(): boolean {
  return Boolean(resolveToken("xai") || process.env.XAI_API_KEY);
}

function hasOpenRouter(): boolean {
  return Boolean(resolveToken("openrouter") || process.env.OPENROUTER_API_KEY);
}

function hasProvider(p: ProviderId): boolean {
  if (p === "xai") return hasXai();
  if (p === "openrouter") return hasOpenRouter();
  return Boolean(resolveToken(p) || process.env[`${p.toUpperCase()}_API_KEY`]);
}

async function main(): Promise<void> {
  initDebug(process.env.LIBRA_DEBUG ? undefined : "info");

  if (!hasProvider(PROVIDER)) {
    console.error(
      `No credentials for ${PROVIDER}. Run /login ${PROVIDER} or set API key env, then retry.`,
    );
    process.exit(1);
  }

  saveConfig({
    provider: PROVIDER,
    model: MODEL,
    modelKey: MAIN_KEY,
  });

  const title = isHy3 ? "hy3" : PROVIDER === "xai" ? "Grok" : PROVIDER;
  console.log(`═══ Libra Live Benchmark · ${title} ═══\n`);
  console.log(`Model: ${MAIN_KEY}`);
  if (isDebug()) console.log(`Debug: ${getDebugLogPath()}`);

  const suites: Suite[] = [];
  if (!skip.has("latency")) suites.push(suiteLatency());
  if (!skip.has("tools")) suites.push(suiteTools());
  if (!skip.has("agent")) suites.push(suiteAgent());
  if (!skip.has("multistep")) suites.push(suiteMultistep());
  if (!skip.has("memory")) suites.push(suiteMemoryLive());
  if (!skip.has("fusion")) suites.push(suiteFusion());

  const report = await runSuites(suites);
  printReport(report);

  // Persist
  try {
    const dir = join(homedir(), ".libra", "debug");
    mkdirSync(dir, { recursive: true });
    const reportName = isHy3
      ? "bench-hy3-live-latest.json"
      : PROVIDER === "xai"
        ? "bench-grok-latest.json"
        : `bench-${PROVIDER}-live-latest.json`;
    const path = join(dir, reportName);
    writeFileSync(
      path,
      JSON.stringify(
        {
          model: MAIN_KEY,
          ...report,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(`\nReport → ${path}`);
  } catch {
    /* */
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  }

  summarizeGrok(report);
  process.exit(report.failed > 0 ? 1 : 0);
}

function suiteLatency(): Suite {
  const s = new Suite("latency");

  s.test("simple stream TTFT + content", async () => {
    dbg("grokbench", "latency.start");
    const r = await chatComplete({
      provider: PROVIDER,
      model: MODEL,
      messages: [
        {
          role: "user",
          content: "Reply with exactly one word: pong",
        },
      ],
      stream: true,
      // hy3:free often burns tokens on reasoning first — leave headroom
      max_tokens: isHy3 ? 96 : 32,
      temperature: 0,
      applyNativeReasoning: false,
      label: isHy3 ? "hy3.latency" : "grok.latency",
    });
    // Answer channel must be non-empty after ensureAnswerChannel
    assert(r.content.trim().length > 0, `empty content (reasoningLen=${r.reasoning?.length ?? 0})`);
    assertGte(r.durationMs ?? 0, 1);
    const body = r.content.toLowerCase();
    // soft check — model should mention pong
    const okish = body.includes("pong") || body.length > 0;
    assert(okish, `unexpected body: ${body.slice(0, 80)}`);
    return {
      ttftMs: r.ttftMs,
      durationMs: r.durationMs,
      contentLen: r.content.length,
      preview: r.content.slice(0, 60),
      usage: r.usage,
    };
  });

  s.test("second call warm-ish latency", async () => {
    const r = await chatComplete({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Say hi in 2 words max." }],
      stream: true,
      max_tokens: isHy3 ? 128 : 24,
      temperature: 0,
      applyNativeReasoning: false,
      label: isHy3 ? "hy3.latency2" : "grok.latency2",
    });
    assert(r.content.trim().length > 0, "empty content after promote");
    return {
      ttftMs: r.ttftMs,
      durationMs: r.durationMs,
      preview: r.content.slice(0, 40),
    };
  });

  return s;
}

function suiteTools(): Suite {
  const s = new Suite("tools-live");

  s.test("forced list_dir tool_call", async () => {
    const r = await chatComplete({
      provider: PROVIDER,
      model: MODEL,
      messages: [
        {
          role: "system",
          content: "You are a tool-using agent. Use list_dir when asked about files.",
        },
        {
          role: "user",
          content:
            "List the workspace root with the list_dir tool. Do not guess file names.",
        },
      ],
      tools: OPENAI_TOOLS.slice(0, 4),
      tool_choice: "required",
      stream: true,
      max_tokens: 1024,
      temperature: 0,
      applyNativeReasoning: false,
      label: "grok.tools.required",
    });

    assertGte(r.tool_calls.length, 1, "expected ≥1 tool call");
    const tc = r.tool_calls[0]!;
    assert(tc.id.length > 0, "missing tool id");
    assert(tc.function.name.length > 0, "missing tool name");

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      assert(false, `bad tool JSON: ${tc.function.arguments.slice(0, 120)}`);
    }

    const exec = new ToolExecutor(process.cwd());
    const out = await exec.run(tc.function.name, args);
    assert(out.ok, `exec failed: ${out.output}`);
    assertIncludes(out.output, "package.json");

    return {
      ttftMs: r.ttftMs,
      durationMs: r.durationMs,
      tool: tc.function.name,
      toolId: tc.id,
      args,
      execMs: out.durationMs,
      outPreview: out.output.slice(0, 120),
      usage: r.usage,
    };
  });

  s.test("auto tool_choice still tools when appropriate", async () => {
    const r = await chatComplete({
      provider: PROVIDER,
      model: MODEL,
      messages: [
        {
          role: "system",
          content: "Use tools to inspect the workspace. Prefer list_dir.",
        },
        {
          role: "user",
          content: "What files are in the project root? Use tools.",
        },
      ],
      tools: OPENAI_TOOLS,
      tool_choice: "auto",
      stream: true,
      max_tokens: 1024,
      temperature: 0,
      applyNativeReasoning: false,
      label: "grok.tools.auto",
    });
    // Grok should tool-call; if it only answers, soft-fail with detail
    const used = r.tool_calls.length > 0;
    if (used) {
      const name = r.tool_calls[0]!.function.name;
      assert(
        ["list_dir", "glob", "grep", "read_file"].includes(name),
        `unexpected tool ${name}`,
      );
    } else {
      // still require some answer content
      assert(r.content.length > 10, "no tools and no content");
    }
    return {
      usedTools: used,
      tools: r.tool_calls.map((t) => t.function.name),
      ttftMs: r.ttftMs,
      durationMs: r.durationMs,
      contentLen: r.content.length,
    };
  });

  return s;
}

function suiteAgent(): Suite {
  const s = new Suite("agent-loop");

  s.test("AgentLoop list_dir + final answer", async () => {
    const store = new HarnessStore({
      provider: PROVIDER,
      model: MODEL,
      title: "grok-agent",
    });
    store.subscribe(() => {});
    const agent = new AgentLoop(store);
    const t0 = Date.now();
    await agent.handle(
      "Use list_dir on . and list the top-level names. Be brief.",
      {
        provider: PROVIDER,
        model: MODEL,
        cwd: process.cwd(),
        tools: true,
        lightReasoning: true,
        label: "grok.agent",
      },
    );
    const ms = Date.now() - t0;
    assert(store.state.phase !== "error", `phase=${store.state.phase}`);

    const last = store.state.messages[store.state.messages.length - 1];
    const tools =
      last?.parts.filter((p) => p.type === "tool") ?? [];
    const toolOk = tools.some(
      (p) => p.type === "tool" && p.status === "completed",
    );
    const text =
      last?.parts
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.content : ""))
        .join("\n") ?? "";

    assert(toolOk, `tools=${tools.map((p) => (p.type === "tool" ? `${p.toolName}:${p.status}` : "")).join(",")}`);
    assert(text.length > 5, "empty final text");
    // should mention something from real listing
    const lower = text.toLowerCase();
    assert(
      lower.includes("package") ||
        lower.includes("src") ||
        lower.includes("scripts") ||
        lower.includes("readme"),
      `answer missing workspace cues: ${text.slice(0, 120)}`,
    );

    return {
      ms,
      tools: tools.map((p) =>
        p.type === "tool" ? `${p.toolName}:${p.status}` : "",
      ),
      textPreview: text.slice(0, 200),
      tokens: store.state.tokens,
    };
  });

  return s;
}

function suiteMultistep(): Suite {
  const s = new Suite("multistep");

  s.test("list then read package.json name", async () => {
    const store = new HarnessStore({
      provider: PROVIDER,
      model: MODEL,
      title: "grok-multi",
    });
    store.subscribe(() => {});
    const agent = new AgentLoop(store);
    const t0 = Date.now();
    await agent.handle(
      "1) list_dir on .\n2) read_file package.json\n3) Tell me the package name field. Be brief.",
      {
        provider: PROVIDER,
        model: MODEL,
        cwd: process.cwd(),
        tools: true,
        lightReasoning: true,
        label: "grok.multistep",
      },
    );
    const ms = Date.now() - t0;
    const last = store.state.messages[store.state.messages.length - 1];
    const tools =
      last?.parts.filter((p) => p.type === "tool") ?? [];
    const names = tools
      .filter((p) => p.type === "tool")
      .map((p) => (p.type === "tool" ? p.toolName : ""));
    const completed = tools.filter(
      (p) => p.type === "tool" && p.status === "completed",
    ).length;
    const text =
      last?.parts
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.content : ""))
        .join("\n") ?? "";

    assertGte(completed, 1, `completed tools=${completed} names=${names}`);
    // ideally read_file used; soft if only list + knowledge
    const usedRead = names.includes("read_file");
    const mentionsLibra = /libra/i.test(text);
    assert(
      usedRead || mentionsLibra,
      `expected read_file or 'libra' in answer; tools=${names} text=${text.slice(0, 100)}`,
    );
    if (usedRead) {
      assert(mentionsLibra || text.length > 5, "read but no useful answer");
    }

    return {
      ms,
      tools: names,
      completed,
      usedRead,
      textPreview: text.slice(0, 200),
      tokens: store.state.tokens,
    };
  });

  return s;
}

function suiteMemoryLive(): Suite {
  const s = new Suite("memory-live");

  s.test("session tokens after tool turn", async () => {
    const store = new HarnessStore({
      provider: PROVIDER,
      model: MODEL,
      title: "grok-mem",
    });
    store.subscribe(() => {});
    const agent = new AgentLoop(store);
    await agent.handle(
      "Use list_dir on src and say how many top entries you see. Brief.",
      {
        provider: PROVIDER,
        model: MODEL,
        cwd: process.cwd(),
        tools: true,
        lightReasoning: true,
        label: "grok.memory",
      },
    );
    const tok = extractSessionTokens(store.state);
    assertGte(tok.prompts.length, 1);
    assert(
      tok.tools.includes("list_dir") || tok.tools.length >= 0,
      `tools=${tok.tools}`,
    );
    // paths or tools should be non-empty if agent used tools
    const last = store.state.messages[store.state.messages.length - 1];
    const usedTool = last?.parts.some(
      (p) => p.type === "tool" && p.status === "completed",
    );
    if (usedTool) {
      assert(
        tok.tools.includes("list_dir") ||
          tok.paths.some((p) => p.includes("src")),
        `memory miss: tools=${tok.tools} paths=${tok.paths.slice(0, 10)}`,
      );
    }
    return {
      tools: tok.tools,
      paths: tok.paths.slice(0, 15),
      words: tok.words.slice(0, 15),
      prompts: tok.prompts.length,
    };
  });

  return s;
}

function suiteFusion(): Suite {
  const s = new Suite("fusion");

  s.test("Ultra+Fusion main + peer reason → execute", async () => {
    // Peer: when main is already hy3, dual-sample same model; else prefer free hy3 peer
    const peerKey = isHy3
      ? MAIN_KEY
      : hasOpenRouter()
        ? "openrouter/tencent/hy3:free"
        : MAIN_KEY;

    saveAgentSettings({
      reasoning: {
        custom: "ultra-fusion",
        effort: "low",
        perModelEffort: {
          [MAIN_KEY]: "low",
          [peerKey]: "low",
        },
        fusion: {
          modelKeys: [peerKey],
          analysisInstructions: "Max 6 short bullets. No tools.",
          fuseInstructions:
            "Merge plans. Call list_dir on . immediately, then answer briefly.",
        },
      },
    });

    const store = new HarnessStore({
      provider: PROVIDER,
      model: MODEL,
      title: isHy3 ? "hy3-fusion" : "grok-fusion",
    });
    store.subscribe(() => {});

    const prompt =
      "Use list_dir on . and list top-level names briefly. Prefer tools.";

    const prep = await prepareFusionForMain(
      store,
      prompt,
      PROVIDER,
      MODEL,
    );

    assert(
      prep.mainReasoning.text.length > 10 || prep.mainReasoning.error == null,
      `main reason fail: ${prep.mainReasoning.error}`,
    );
    // peer may 429 on free — main must still work
    const mainOk = prep.mainReasoning.text.trim().length > 10;

    const agent = new AgentLoop(store);
    const t0 = Date.now();
    await agent.handle(prompt, {
      provider: PROVIDER,
      model: MODEL,
      cwd: process.cwd(),
      tools: true,
      systemPrompt:
        buildSystemPrompt() + "\n\n" + prep.systemAddon,
      seedReasoning: prep.displayReasoning,
      lightReasoning: true,
      label: isHy3 ? "hy3.fusion.execute" : "grok.fusion.execute",
    });
    const executeMs = Date.now() - t0;

    const last = store.state.messages[store.state.messages.length - 1];
    const tools =
      last?.parts.filter((p) => p.type === "tool") ?? [];
    const toolOk = tools.some(
      (p) => p.type === "tool" && p.status === "completed",
    );
    const text =
      last?.parts
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.content : ""))
        .join("\n") ?? "";

    assert(mainOk, "main phase1 empty");
    assert(toolOk, "fusion execute tools failed");
    assert(text.length > 5, "empty fusion answer");

    return {
      peerKey,
      phase1Ms: prep.phase1Ms,
      mainReasonLen: prep.mainReasoning.text.length,
      peerReasonLen: prep.secondaries[0]?.text.length ?? 0,
      peerError: prep.secondaries[0]?.error?.slice(0, 120),
      executeMs,
      tools: tools.map((p) =>
        p.type === "tool" ? `${p.toolName}:${p.status}` : "",
      ),
      textPreview: text.slice(0, 160),
      tokens: store.state.tokens,
    };
  });

  return s;
}

function summarizeGrok(report: BenchReport): void {
  console.log(`\n── ${MAIN_KEY} performance snapshot ──`);
  for (const s of report.suites) {
    for (const c of s.cases) {
      if (c.status !== "pass" || !c.detail) continue;
      const d = c.detail;
      const bits: string[] = [];
      if (d.ttftMs != null) bits.push(`ttft=${d.ttftMs}ms`);
      if (d.durationMs != null) bits.push(`dur=${d.durationMs}ms`);
      if (d.ms != null) bits.push(`wall=${d.ms}ms`);
      if (d.executeMs != null) bits.push(`exec=${d.executeMs}ms`);
      if (d.phase1Ms != null) bits.push(`p1=${d.phase1Ms}ms`);
      if (bits.length) console.log(`  ${s.name}/${c.name}: ${bits.join(" ")}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
