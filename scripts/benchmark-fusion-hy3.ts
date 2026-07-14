/**
 * Live Ultra+Fusion benchmark: two independent hy3:free reasoning passes.
 *
 *   LIBRA_DEBUG=1 npx tsx scripts/benchmark-fusion-hy3.ts
 *   npm run bench:fusion:hy3
 *
 * Pipeline under test:
 *   phase1: main hy3 + peer hy3 reason in parallel (no tools)
 *   phase2: main hy3 compares + executes tools
 */

import { saveApiKey, resolveToken } from "../src/auth/api-key.js";
import { saveConfig } from "../src/config/store.js";
import { saveAgentSettings, loadAgentSettings } from "../src/agent/config.js";
import { HarnessStore } from "../src/core/store.js";
import { AgentLoop, buildSystemPrompt } from "../src/agent/loop.js";
import { prepareFusionForMain } from "../src/agent/fusion.js";
import {
  initDebug,
  dbg,
  getDebugLogPath,
  isDebug,
} from "../src/agent/debug.js";

const HY3 = "tencent/hy3:free";
const HY3_KEY = `openrouter/${HY3}`;

const KEY =
  process.env.OPENROUTER_API_KEY || resolveToken("openrouter") || "";

async function main(): Promise<void> {
  initDebug(process.env.LIBRA_DEBUG ? undefined : "info");
  if (!KEY) {
    console.error("No OpenRouter key. Set OPENROUTER_API_KEY or /login openrouter");
    process.exit(1);
  }
  saveApiKey("openrouter", KEY, { label: "fusion-hy3-bench" });

  console.log("═══ Ultra+Fusion · dual hy3:free ═══\n");
  if (isDebug()) console.log(`Debug: ${getDebugLogPath()}\n`);

  // Configure dual same-model fusion
  saveConfig({
    provider: "openrouter",
    model: HY3,
    modelKey: HY3_KEY,
  });
  saveAgentSettings({
    reasoning: {
      custom: "ultra-fusion",
      effort: "low",
      perModelEffort: {
        [HY3_KEY]: "low",
      },
      fusion: {
        modelKeys: [HY3_KEY], // peer = same hy3 (dual independent sample)
        analysisInstructions: "Max 6 short bullets. No tools.",
        fuseInstructions:
          "Merge both plans. Immediately call list_dir on . then answer briefly.",
      },
    },
  });

  const settings = loadAgentSettings();
  console.log("Config:");
  console.log(`  main:  ${HY3_KEY}`);
  console.log(`  peer:  ${settings.reasoning.fusion.modelKeys[0]}`);
  console.log(`  mode:  ${settings.reasoning.custom}`);
  console.log(`  dual:  ${settings.reasoning.fusion.modelKeys[0] === HY3_KEY}`);

  const store = new HarnessStore({
    provider: "openrouter",
    model: HY3,
    title: "fusion-hy3",
  });
  store.subscribe(() => {});

  const prompt =
    "Use list_dir on . and list top-level names briefly. Prefer tools over guessing.";

  const wall0 = Date.now();
  dbg("hy3bench", "start", { prompt });

  // ── Phase 1 ──────────────────────────────────────────
  console.log("\n── Phase 1: dual reason (parallel) ──");
  const prep = await prepareFusionForMain(store, prompt, "openrouter", HY3);

  console.log(`  wall phase1: ${prep.phase1Ms}ms`);
  console.log(
    `  main: ${prep.mainReasoning.ms}ms ttft=${prep.mainReasoning.ttftMs ?? "-"} chars=${prep.mainReasoning.text.length} err=${prep.mainReasoning.error ?? "-"}`,
  );
  const peer = prep.secondaries[0];
  console.log(
    `  peer: ${peer?.ms ?? "?"}ms ttft=${peer?.ttftMs ?? "-"} chars=${peer?.text.length ?? 0} err=${peer?.error ?? "-"}`,
  );
  console.log("\n  --- main plan (clip) ---");
  console.log(clip(prep.mainReasoning.text, 400));
  console.log("\n  --- peer plan (clip) ---");
  console.log(clip(peer?.text ?? peer?.error ?? "(none)", 400));

  const phase1Ok =
    prep.mainReasoning.text.trim().length > 10 &&
    (peer?.text.trim().length ?? 0) > 10 &&
    !prep.mainReasoning.error &&
    !peer?.error;

  // ── Phase 2 ──────────────────────────────────────────
  console.log("\n── Phase 2: main execute (tools) ──");
  const agent = new AgentLoop(store);
  const tExec = Date.now();
  const system =
    buildSystemPrompt(settings.reasoning.customInstructions) +
    "\n\n" +
    prep.systemAddon;

  await agent.handle(prompt, {
    provider: "openrouter",
    model: HY3,
    cwd: process.cwd(),
    tools: true,
    systemPrompt: system,
    seedReasoning: prep.displayReasoning,
    lightReasoning: true,
    label: "hy3.fusion.execute",
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

  console.log(`  execute: ${executeMs}ms`);
  console.log(
    `  tools: ${tools.map((p) => (p.type === "tool" ? `${p.toolName}:${p.status}` : "")).join(", ") || "(none)"}`,
  );
  console.log(`  text: ${clip(text, 300)}`);
  console.log(`  tokens:`, store.state.tokens);
  console.log(`  total wall: ${Date.now() - wall0}ms`);

  const summary = {
    main: HY3,
    peer: HY3,
    dualSameModel: true,
    phase1Ms: prep.phase1Ms,
    mainReasonLen: prep.mainReasoning.text.length,
    peerReasonLen: peer?.text.length ?? 0,
    mainMs: prep.mainReasoning.ms,
    peerMs: peer?.ms ?? 0,
    executeMs,
    toolCalls: tools.length,
    toolOk,
    textPreview: text.slice(0, 200),
    phase1Ok,
    executeOk: toolOk && text.length > 5,
    perfect: phase1Ok && toolOk && text.length > 5,
    debugLog: getDebugLogPath(),
  };

  console.log("\n═══ Summary ═══\n");
  console.log(JSON.stringify(summary, null, 2));

  if (!summary.perfect) {
    console.error("\n✗ Dual hy3 fusion not perfect");
    if (!phase1Ok) console.error("  - phase1 dual reason incomplete");
    if (!toolOk) console.error("  - tools did not complete");
    if (text.length <= 5) console.error("  - empty final answer");
    process.exit(1);
  }
  console.log("\n✓ Dual hy3 Ultra+Fusion perfect (both reason + tools + answer)");
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
