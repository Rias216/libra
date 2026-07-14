/**
 * Auth verification suite.
 *
 *   npx tsx src/auth/auth.test.ts
 *   npx tsx src/auth/auth.test.ts --live
 */

import {
  validateKeyFormat,
  verifyAuthModelsOffline,
  verifyAll,
  verifyProvider,
} from "./verify.js";
import { PROVIDERS, type ProviderId } from "./types.js";
import { saveApiKey, resolveToken } from "./api-key.js";
import { connectXaiApiKey } from "./device.js";
import { removeCredential } from "./store.js";
import {
  modelKey,
  parseModelKey,
  pickHighestReasoningModel,
  type RemoteModel,
} from "./models.js";
import {
  CUSTOM_REASONING_OPTIONS,
  loadAgentSettings,
  saveAgentSettings,
  PROVIDER_EFFORT_OPTIONS,
} from "../agent/config.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");

  // xAI rejects fake device tokens
  const bad = connectXaiApiKey("xai_device_old");
  assert(!bad.ok, "must reject xai_device_ tokens");

  // Format rules
  const good: Record<ProviderId, string> = {
    xai: "xai-abcdefghijklmnopqrstuvwxyz",
    gemini: "AIzaSyDummyKeyForFormatCheck0123",
    openai: "sk-proj-abcdefghijklmnopqrstuv",
    codex: "sk-abcdefghijklmnopqrstuvwxyz12",
    openrouter: "sk-or-v1-abcdefghijklmnopqrstuv",
    anthropic: "sk-ant-api03-abcdefghijklmnopqr",
    custom: "local-dev-key-value-ok",
  };
  for (const p of PROVIDERS) {
    assert(validateKeyFormat(p.id, good[p.id]).ok, `${p.id} good key`);
    assert(!validateKeyFormat(p.id, "x").ok, `${p.id} short fails`);
  }

  // Multi-provider credential store
  saveApiKey("custom", "test-key-value-long-enough", {
    baseUrl: "http://127.0.0.1:11434/v1",
  });
  assert(resolveToken("custom")?.includes("test-key"), "resolve custom");
  removeCredential("custom");

  // Model key helpers
  assert(modelKey({ provider: "xai", model: "grok-4.5" }) === "xai/grok-4.5");
  assert(parseModelKey("openai/gpt-4.1")?.model === "gpt-4.1");

  const sample: RemoteModel[] = [
    { id: "fast-mini", name: "mini", provider: "xai" },
    { id: "grok-4.5", name: "g", provider: "xai", reasoning: true },
    { id: "other", name: "o", provider: "openai" },
  ];
  assert(
    pickHighestReasoningModel(sample)?.id === "grok-4.5",
    "highest reasoning pick",
  );

  // Agent settings / ultra
  const ultra = saveAgentSettings({ reasoning: { custom: "ultra" } });
  assert(ultra.reasoning.custom === "ultra", "ultra mode");
  assert(ultra.subagents.autoSpawn, "ultra forces autoSpawn");
  assert(ultra.subagents.enabled, "ultra forces enabled");

  const fusion = saveAgentSettings({
    reasoning: {
      custom: "ultra-fusion",
      fusion: {
        modelKeys: ["xai/grok-4.5", "openai/o3"],
        maxParallel: 3,
        minModels: 2,
        reasoningOnly: true,
        analysisInstructions: "test",
        fuseInstructions: "fuse test",
      },
    },
  });
  assert(fusion.reasoning.custom === "ultra-fusion", "ultra-fusion mode");
  assert(fusion.reasoning.fusion.reasoningOnly === true, "fusion reasoning only");
  assert(fusion.reasoning.fusion.modelKeys.length === 2, "fusion roster");
  assert(fusion.subagents.autoSpawn, "ultra-fusion forces autoSpawn");
  assert(
    CUSTOM_REASONING_OPTIONS.some((o) => o.value === "ultra-fusion"),
    "ultra-fusion in catalog",
  );
  assert(
    PROVIDER_EFFORT_OPTIONS.length >= 5 && CUSTOM_REASONING_OPTIONS.length >= 3,
    "reasoning options",
  );
  assert(
    !CUSTOM_REASONING_OPTIONS.some((o) => o.value === "deep" || o.value === "swarm"),
    "deep/swarm removed (not official)",
  );
  // reset custom to none for cleanliness
  saveAgentSettings({
    reasoning: { custom: "none", effort: "default" },
    subagents: { ...loadAgentSettings().subagents, autoSpawn: false },
  });

  const offline = await verifyAuthModelsOffline();
  const fails = offline.filter((r) => !r.ok);
  assert(
    fails.length === 0,
    `offline fails: ${fails.map((f) => f.provider + ":" + f.message).join("; ")}`,
  );

  console.log("ok — xAI API-key auth (no fake device code)");
  console.log("ok — key formats for all providers");
  console.log("ok — multi-provider store");
  console.log("ok — model key helpers + highest-reasoning pick");
  console.log("ok — ultra custom reasoning forces subagent auto-spawn");
  console.log("ok — ultra-fusion secondary-reason / main-execute config");
  console.log("ok — offline verify suite");

  if (live) {
    console.log("live probes (fetch /models)...");
    const results = await verifyAll({});
    for (const r of results) {
      console.log(
        `  ${r.ok ? "OK" : "FAIL"} ${r.provider.padEnd(12)} ${r.status.padEnd(14)} ${r.message}`,
      );
    }
  } else {
    console.log("(pass --live to probe real APIs when keys are set)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
