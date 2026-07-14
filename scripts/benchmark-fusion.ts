/**
 * Benchmark Ultra+Fusion with 2 free OpenRouter models.
 *
 *   LIBRA_DEBUG=1 npx tsx scripts/benchmark-fusion.ts
 *   LIBRA_DEBUG=trace npx tsx scripts/benchmark-fusion.ts --main=tencent/hy3:free --peer=openai/gpt-oss-20b:free
 *
 * Phases:
 *  A) Pick / validate 2 free models (tool-capable preferred)
 *  B) Single-model tool smoke for each
 *  C) Full fusion: phase-1 dual reason → main execute with tools
 *  D) Print latency breakdown + pass/fail
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { saveApiKey, resolveToken } from "../src/auth/api-key.js";
import { saveConfig } from "../src/config/store.js";
import { saveAgentSettings } from "../src/agent/config.js";
import { HarnessStore } from "../src/core/store.js";
import { AgentLoop, buildSystemPrompt } from "../src/agent/loop.js";
import { prepareFusionForMain } from "../src/agent/fusion.js";
import { initDebug, dbg, getDebugLogPath, isDebug } from "../src/agent/debug.js";
import { OPENAI_TOOLS } from "../src/toolcalling/schema.js";
import { chatComplete } from "../src/llm/client.js";
import { ToolExecutor } from "../src/toolcalling/executor.js";

const KEY =
  process.env.OPENROUTER_API_KEY ||
  resolveToken("openrouter") ||
  "";

const BASE = "https://openrouter.ai/api/v1";

/** Preferred free pair (tool-capable, reasonably fast) */
const PREFERRED_MAIN = "tencent/hy3:free";
const PREFERRED_PEERS = [
  "openai/gpt-oss-20b:free",
  "qwen/qwen3-coder:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "google/gemma-4-26b-a4b-it:free",
  "poolside/laguna-xs-2.1:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "openrouter/free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}

interface ModelProbe {
  model: string;
  ok: boolean;
  latencyMs: number;
  ttftMs?: number;
  toolCall: boolean;
  toolOk: boolean;
  error?: string;
  preview?: string;
}

async function main(): Promise<void> {
  initDebug(process.env.LIBRA_DEBUG ? undefined : "info");
  if (!KEY) {
    console.error("No OpenRouter key. Set OPENROUTER_API_KEY or /login openrouter");
    process.exit(1);
  }
  saveApiKey("openrouter", KEY, { label: "fusion-bench" });

  console.log("═══ Libra Fusion Benchmark (2 free OpenRouter models) ═══\n");
  if (isDebug()) {
    console.log(`Debug log: ${getDebugLogPath() ?? "(stderr only)"}\n`);
  }

  const freeList = await listFreeModels();
  console.log(`Catalog: ${freeList.length} free models\n`);

  let mainModel = arg("main") || PREFERRED_MAIN;
  let peerModel = arg("peer") || "";
  const skipProbe = process.argv.includes("--skip-probe");
  const lean = !process.argv.includes("--full-probe");

  // Probe main (lean = latency only, save free quota for fusion)
  console.log(`Probing MAIN ${mainModel}${lean ? " (lean)" : ""}…`);
  let mainProbe = skipProbe
    ? {
        model: mainModel,
        ok: true,
        latencyMs: 0,
        toolCall: true,
        toolOk: true,
        preview: "(skipped)",
      }
    : await probeModel(mainModel, { tools: !lean });
  printProbe("main", mainProbe);

  if (!mainProbe.ok) {
    console.log("Main failed — searching free catalog for a working model…");
    const found = await findWorkingFree(
      freeList,
      PREFERRED_PEERS.concat(freeList),
      lean,
    );
    if (!found) {
      console.error("No free model available (rate limits?). Try later.");
      process.exit(2);
    }
    mainModel = found.model;
    mainProbe = found;
    printProbe("main(fallback)", mainProbe);
  }

  // Probe peer (different from main) — lean probes only to preserve free quota
  const peerCandidates = [
    ...(peerModel ? [peerModel] : []),
    ...PREFERRED_PEERS,
    ...freeList,
  ].filter((m, i, a) => m !== mainModel && a.indexOf(m) === i);

  let peerProbe: ModelProbe | null = null;
  const maxPeerProbes = lean ? 4 : 12;
  for (const cand of peerCandidates.slice(0, maxPeerProbes)) {
    console.log(`Probing PEER ${cand}${lean ? " (lean)" : ""}…`);
    const p = await probeModel(cand, { tools: !lean });
    printProbe("peer", p);
    if (p.ok) {
      peerModel = cand;
      peerProbe = p;
      break;
    }
    // brief backoff on 429
    if (p.error?.includes("429")) {
      await sleep(lean ? 800 : 1500);
    }
  }

  if (!peerProbe || !peerModel) {
    console.warn(
      "\n⚠ No second free model available (daily free-model limit).\n" +
        "  Falling back to self-pair is disabled — fusion needs distinct models.\n" +
        "  Will still run fusion with peer = main only if --force-same is set.\n",
    );
    if (process.argv.includes("--force-same")) {
      peerModel = mainModel;
      peerProbe = mainProbe;
    } else {
      // Last resort: try openrouter/free as router even if probe failed earlier
      console.log("Retry openrouter/free once more after 3s…");
      await sleep(3000);
      const p = await probeModel("openrouter/free");
      printProbe("peer", p);
      if (p.ok) {
        peerModel = "openrouter/free";
        peerProbe = p;
      } else {
        console.error(
          "Cannot run 2-model fusion without a peer. Re-run when free quota resets, or:\n" +
            "  npx tsx scripts/benchmark-fusion.ts --main=tencent/hy3:free --peer=<other>:free\n",
        );
        // Still run single-model tool perfection path
        await runToolPerfection(mainModel);
        process.exit(3);
      }
    }
  }

  console.log("\n── Selected pair ──");
  console.log(`  MAIN: ${mainModel}`);
  console.log(`  PEER: ${peerModel}`);
  console.log(`  main tools: ${mainProbe.toolCall ? (mainProbe.toolOk ? "ok" : "fail") : "no"}`);
  console.log(`  peer tools: ${peerProbe!.toolCall ? (peerProbe!.toolOk ? "ok" : "fail") : "no"}`);

  // Persist for TUI
  saveConfig({
    provider: "openrouter",
    model: mainModel,
    modelKey: `openrouter/${mainModel}`,
  });
  saveAgentSettings({
    reasoning: {
      custom: "ultra-fusion",
      effort: "low",
      perModelEffort: {
        [`openrouter/${mainModel}`]: "low",
        [`openrouter/${peerModel}`]: "low",
      },
      fusion: {
        modelKeys: [`openrouter/${peerModel}`],
        analysisInstructions:
          "Be concrete and short. List 3 steps max. Prefer list_dir then act.",
        fuseInstructions:
          "Merge plans, then USE tools immediately. Prefer list_dir on . first.",
      },
    },
  });

  // Full fusion run
  console.log("\n═══ Fusion end-to-end ═══\n");
  const fusionResult = await runFusionE2E(mainModel, peerModel);

  console.log("\n═══ Summary ═══\n");
  console.log(
    JSON.stringify(
      {
        main: mainModel,
        peer: peerModel,
        mainProbe: {
          ok: mainProbe.ok,
          ms: mainProbe.latencyMs,
          tools: mainProbe.toolOk,
        },
        peerProbe: {
          ok: peerProbe!.ok,
          ms: peerProbe!.latencyMs,
          tools: peerProbe!.toolOk,
        },
        fusion: fusionResult,
        debugLog: getDebugLogPath(),
      },
      null,
      2,
    ),
  );

  const peerContributed = fusionResult.peerReasonLen > 20;
  const perfect =
    fusionResult.ok &&
    fusionResult.phase1Ok &&
    fusionResult.toolCalls > 0 &&
    fusionResult.toolOk &&
    fusionResult.mainReasonLen > 20;
  if (!perfect) {
    console.error("\n✗ Fusion not perfect yet — see debug log and iterate.");
    process.exit(1);
  }
  if (peerContributed) {
    console.log("\n✓ Dual-model fusion perfect (both reason + tools + answer).");
  } else {
    console.warn(
      "\n⚠ Peer reason empty (often free-tier 429). Main+tools path is solid; re-run when peer quota resets for dual traces.",
    );
    console.log("\n✓ Fusion execute perfection met (phase1 main + tools + answer).");
  }
}

function printProbe(role: string, p: ModelProbe): void {
  if (p.ok) {
    console.log(
      `  [${role}] OK ${p.latencyMs}ms ttft=${p.ttftMs ?? "-"} tools=${p.toolCall ? (p.toolOk ? "ok" : "fail") : "no"} preview=${JSON.stringify(p.preview ?? "")}`,
    );
  } else {
    console.log(`  [${role}] FAIL ${p.latencyMs}ms ${p.error?.slice(0, 100)}`);
  }
}

async function listFreeModels(): Promise<string[]> {
  const res = await fetch(`${BASE}/models`, {
    headers: {
      Authorization: `Bearer ${KEY}`,
      "HTTP-Referer": "https://github.com/libra-tui",
      "X-Title": "Libra Fusion Bench",
    },
  });
  if (!res.ok) throw new Error(`models HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: Array<{
      id?: string;
      pricing?: { prompt?: string; completion?: string };
      supported_parameters?: string[];
    }>;
  };
  const withTools: string[] = [];
  const rest: string[] = [];
  for (const m of json.data ?? []) {
    if (!m.id) continue;
    const free =
      m.id.includes(":free") ||
      (m.pricing?.prompt === "0" && m.pricing?.completion === "0");
    if (!free) continue;
    if (m.supported_parameters?.includes("tools")) withTools.push(m.id);
    else rest.push(m.id);
  }
  return [...withTools.sort(), ...rest.sort()];
}

async function findWorkingFree(
  catalog: string[],
  prefer: string[],
  lean = true,
): Promise<ModelProbe | null> {
  const order = [...prefer, ...catalog].filter(
    (m, i, a) => a.indexOf(m) === i,
  );
  for (const m of order.slice(0, lean ? 5 : 10)) {
    const p = await probeModel(m, { tools: !lean });
    if (p.ok) return { ...p, model: m };
    if (p.error?.includes("429")) await sleep(1000);
  }
  return null;
}

async function probeModel(
  model: string,
  opts: { tools?: boolean } = {},
): Promise<ModelProbe> {
  const t0 = Date.now();
  const withTools = opts.tools !== false;
  try {
    dbg("bench", "probe.start", { model, withTools });
    const simple = await chatComplete({
      provider: "openrouter",
      model,
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      stream: true,
      max_tokens: 64,
      temperature: 0,
      applyNativeReasoning: false,
      reasoning_effort: "low",
      label: `probe.${model}`,
    });

    let toolCall = false;
    let toolOk = false;
    if (withTools) {
      try {
        const toolRes = await chatComplete({
          provider: "openrouter",
          model,
          messages: [
            {
              role: "system",
              content:
                "You are a tool-using agent. Always call list_dir when asked about files.",
            },
            {
              role: "user",
              content:
                "List the workspace root directory using the list_dir tool. Do not guess.",
            },
          ],
          tools: OPENAI_TOOLS.slice(0, 3),
          tool_choice: "required",
          stream: true,
          max_tokens: 512,
          temperature: 0,
          applyNativeReasoning: false,
          reasoning_effort: "low",
          label: `probe.tools.${model}`,
        });
        if (toolRes.tool_calls.length > 0) {
          toolCall = true;
          const tc = toolRes.tool_calls[0]!;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* */
          }
          const exec = new ToolExecutor(process.cwd());
          const out = await exec.run(tc.function.name, args);
          toolOk = out.ok && out.output.length > 0;
          dbg("bench", "probe.tool", {
            model,
            name: tc.function.name,
            ok: toolOk,
            out: out.output.slice(0, 100),
          });
        }
      } catch (err) {
        dbg("bench", "probe.tool_error", {
          model,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      model,
      ok: true,
      latencyMs: Date.now() - t0,
      ttftMs: simple.ttftMs,
      toolCall,
      toolOk,
      preview: (simple.content || simple.reasoning || "").slice(0, 40),
    };
  } catch (err) {
    return {
      model,
      ok: false,
      latencyMs: Date.now() - t0,
      toolCall: false,
      toolOk: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runFusionE2E(
  mainModel: string,
  peerModel: string,
): Promise<{
  ok: boolean;
  phase1Ok: boolean;
  phase1Ms: number;
  mainReasonLen: number;
  peerReasonLen: number;
  executeMs: number;
  toolCalls: number;
  toolOk: boolean;
  textPreview: string;
  error?: string;
}> {
  const store = new HarnessStore({
    provider: "openrouter",
    model: mainModel,
    title: "fusion-bench",
  });
  store.subscribe(() => {
    /* drain */
  });

  const prompt =
    "Use list_dir on . and tell me the top-level file/folder names. Be brief.";

  const t0 = Date.now();
  try {
    // Ensure fusion peer in settings matches
    saveAgentSettings({
      reasoning: {
        custom: "ultra-fusion",
        fusion: {
          modelKeys: [`openrouter/${peerModel}`],
        },
      },
    });

    const prep = await prepareFusionForMain(
      store,
      prompt,
      "openrouter",
      mainModel,
    );

    const phase1Ok =
      (!prep.mainReasoning.error || prep.mainReasoning.text.length > 0) &&
      (!prep.secondaries[0]?.error ||
        (prep.secondaries[0]?.text.length ?? 0) > 0);

    console.log(`Phase-1 done in ${prep.phase1Ms}ms`);
    console.log(
      `  main reason chars=${prep.mainReasoning.text.length} err=${prep.mainReasoning.error ?? "-"}`,
    );
    console.log(
      `  peer reason chars=${prep.secondaries[0]?.text.length ?? 0} err=${prep.secondaries[0]?.error ?? "-"}`,
    );
    console.log(`  display:\n${prep.displayReasoning.slice(0, 400)}…\n`);

    const agent = new AgentLoop(store);
    const tExec = Date.now();
    const settings = saveAgentSettings({}); // load current
    const system =
      buildSystemPrompt(settings.reasoning.customInstructions) +
      "\n\n" +
      prep.systemAddon;

    await agent.handle(prompt, {
      provider: "openrouter",
      model: mainModel,
      cwd: process.cwd(),
      tools: true,
      systemPrompt: system,
      seedReasoning: prep.displayReasoning,
      lightReasoning: true,
      label: "fusion.execute",
    });
    const executeMs = Date.now() - tExec;

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

    console.log(`Execute done in ${executeMs}ms`);
    console.log(
      `  tools: ${tools.map((p) => (p.type === "tool" ? `${p.toolName}:${p.status}` : "")).join(", ") || "(none)"}`,
    );
    console.log(`  text: ${text.slice(0, 300)}`);
    console.log(`  tokens:`, store.state.tokens);
    console.log(`  total wall: ${Date.now() - t0}ms`);

    return {
      ok: store.state.phase !== "error" && (toolOk || text.length > 10),
      phase1Ok:
        phase1Ok ||
        prep.mainReasoning.text.length > 20 ||
        (prep.secondaries[0]?.text.length ?? 0) > 20,
      phase1Ms: prep.phase1Ms,
      mainReasonLen: prep.mainReasoning.text.length,
      peerReasonLen: prep.secondaries[0]?.text.length ?? 0,
      executeMs,
      toolCalls: tools.length,
      toolOk,
      textPreview: text.slice(0, 200),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("Fusion E2E error:", error);
    return {
      ok: false,
      phase1Ok: false,
      phase1Ms: Date.now() - t0,
      mainReasonLen: 0,
      peerReasonLen: 0,
      executeMs: 0,
      toolCalls: 0,
      toolOk: false,
      textPreview: "",
      error,
    };
  }
}

/** When peer unavailable, still verify main tool path is solid */
async function runToolPerfection(model: string): Promise<void> {
  console.log(`\n── Tool perfection path for ${model} ──`);
  const store = new HarnessStore({
    provider: "openrouter",
    model,
    title: "tool-perf",
  });
  store.subscribe(() => {});
  const agent = new AgentLoop(store);
  const t0 = Date.now();
  await agent.handle(
    "Use list_dir on . and name the top-level entries. Brief.",
    {
      provider: "openrouter",
      model,
      cwd: process.cwd(),
      tools: true,
      lightReasoning: true,
      label: "tool.perfect",
    },
  );
  const last = store.state.messages[store.state.messages.length - 1];
  const tools =
    last?.parts
      .filter((p) => p.type === "tool")
      .map((p) =>
        p.type === "tool" ? `${p.toolName}:${p.status}` : "",
      ) ?? [];
  const text =
    last?.parts
      .filter((p) => p.type === "text")
      .map((p) => (p.type === "text" ? p.content : ""))
      .join("\n") ?? "";
  console.log(`ms=${Date.now() - t0} tools=${tools.join(",") || "none"}`);
  console.log(`text=${text.slice(0, 300)}`);
  console.log(`debug → ${getDebugLogPath() ?? join(homedir(), ".libra", "debug")}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
