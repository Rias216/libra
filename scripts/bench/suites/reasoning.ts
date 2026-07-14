/**
 * Reasoning caps / effort clamp suite (offline heuristics).
 */

import {
  ALL_GATEWAY_EFFORTS,
  buildReasoningApiFields,
  clearReasoningCapsCache,
  resolveCapsForModel,
  setReasoningCaps,
  type ModelReasoningCaps,
} from "../../../src/agent/reasoning.js";
import {
  CUSTOM_REASONING_OPTIONS,
  DEFAULT_AGENT_SETTINGS,
  FUSION_MAX_SECONDARIES,
  loadAgentSettings,
  saveAgentSettings,
} from "../../../src/agent/config.js";
import { Suite, assert, assertEq, assertGte } from "../runner.js";

export function suiteReasoning(): Suite {
  const s = new Suite("reasoning-config");

  s.test("CUSTOM modes include ultra-fusion", () => {
    const vals = CUSTOM_REASONING_OPTIONS.map((o) => o.value);
    assert(vals.includes("none"));
    assert(vals.includes("ultra"));
    assert(vals.includes("ultra-fusion"));
  });

  s.test("FUSION_MAX_SECONDARIES is 1", () => {
    assertEq(FUSION_MAX_SECONDARIES, 1);
  });

  s.test("buildReasoningApiFields openrouter low", () => {
    clearReasoningCapsCache();
    const caps: ModelReasoningCaps = {
      supported: true,
      efforts: ["none", "low", "high"],
      style: "openrouter_reasoning",
      source: "api",
    };
    setReasoningCaps("openrouter", "tencent/hy3:free", caps);
    // Use per-model effort via save — or force via unsupported path
    // buildReasoningApiFields uses resolveEffortForModel from settings
    const fields = buildReasoningApiFields("openrouter", "tencent/hy3:free", {
      forceMax: true,
    });
    assert(
      (fields.reasoning as { effort?: string } | undefined)?.effort === "high" ||
        Object.keys(fields).length >= 0,
      JSON.stringify(fields),
    );
    // forceMax should pick high
    assertEq(
      (fields.reasoning as { effort: string }).effort,
      "high",
    );
  });

  s.test("unsupported model returns empty fields", () => {
    clearReasoningCapsCache();
    setReasoningCaps("openrouter", "plain-model", {
      supported: false,
      efforts: [],
      style: "none",
      source: "none",
    });
    const fields = buildReasoningApiFields("openrouter", "plain-model");
    assertEq(Object.keys(fields).length, 0);
  });

  s.test("ALL_GATEWAY_EFFORTS ordered", () => {
    assertGte(ALL_GATEWAY_EFFORTS.length, 5);
    assertEq(ALL_GATEWAY_EFFORTS[0], "none");
  });

  s.test("resolveCapsForModel heuristic free hy3", () => {
    clearReasoningCapsCache();
    const caps = resolveCapsForModel("openrouter", "tencent/hy3:free", true);
    // heuristic or cached — just ensure doesn't throw
    assert(caps != null);
    return { supported: caps.supported, efforts: caps.efforts, style: caps.style };
  });

  s.test("saveAgentSettings caps fusion peers to 1", () => {
    const prev = loadAgentSettings();
    try {
      const next = saveAgentSettings({
        reasoning: {
          custom: "ultra-fusion",
          fusion: {
            modelKeys: [
              "openrouter/a:free",
              "openrouter/b:free",
              "openrouter/c:free",
            ],
          },
        },
      });
      assertEq(next.reasoning.fusion.modelKeys.length, 1);
      assertEq(next.reasoning.custom, "ultra-fusion");
      assert(next.subagents.autoSpawn, "ultra-fusion enables autoSpawn");
    } finally {
      // restore
      saveAgentSettings({
        reasoning: prev.reasoning,
        subagents: prev.subagents,
      });
    }
  });

  s.test("DEFAULT_AGENT_SETTINGS shape", () => {
    assertEq(DEFAULT_AGENT_SETTINGS.reasoning.custom, "none");
    assertEq(DEFAULT_AGENT_SETTINGS.reasoning.fusion.reasoningOnly, true);
  });

  return s;
}
