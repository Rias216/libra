/**
 * Fusion suite (offline) — peer resolve, display, compare addon, dual same-model.
 */

import {
  formatFusionReasoningDisplay,
  resolveSecondaryReasoners,
  type FusionCandidate,
} from "../../../src/agent/fusion.js";
import {
  DEFAULT_FUSION,
  type FusionConfig,
} from "../../../src/agent/config.js";
import { Suite, assert, assertEq, assertIncludes } from "../runner.js";

function cand(
  key: string,
  text: string,
  ms = 100,
  error?: string,
): FusionCandidate {
  const model = key.includes("/") ? key.split("/").slice(1).join("/") : key;
  return {
    modelKey: key,
    provider: "openrouter",
    model,
    text,
    error,
    ms,
    ttftMs: 50,
  };
}

export function suiteFusion(): Suite {
  const s = new Suite("fusion");

  s.test("resolveSecondary prefers different configured peer", async () => {
    const fusion: FusionConfig = {
      ...DEFAULT_FUSION,
      modelKeys: ["openrouter/peer:free"],
    };
    const peers = await resolveSecondaryReasoners(
      fusion,
      "openrouter/tencent/hy3:free",
    );
    assertEq(peers.length, 1);
    assertEq(peers[0], "openrouter/peer:free");
  });

  s.test("resolveSecondary allows dual same-model (hy3+hy3)", async () => {
    const main = "openrouter/tencent/hy3:free";
    const fusion: FusionConfig = {
      ...DEFAULT_FUSION,
      modelKeys: [main],
    };
    const peers = await resolveSecondaryReasoners(fusion, main);
    assertEq(peers.length, 1);
    assertEq(peers[0], main, "dual sample same model must be allowed");
  });

  s.test("resolveSecondary prefers different when both listed", async () => {
    const main = "openrouter/tencent/hy3:free";
    const fusion: FusionConfig = {
      ...DEFAULT_FUSION,
      modelKeys: [main, "openrouter/other:free"],
    };
    const peers = await resolveSecondaryReasoners(fusion, main);
    assertEq(peers[0], "openrouter/other:free");
  });

  s.test("formatFusionReasoningDisplay includes both traces", () => {
    const main = cand("openrouter/tencent/hy3:free", "MAIN PLAN: list_dir");
    const peer = cand("openrouter/tencent/hy3:free", "PEER PLAN: list then summarize");
    const body = formatFusionReasoningDisplay(
      main,
      [peer],
      "openrouter/tencent/hy3:free",
    );
    assertIncludes(body, "Ultra + Fusion");
    assertIncludes(body, "MAIN PLAN");
    assertIncludes(body, "PEER PLAN");
    assertIncludes(body, "ttft=");
  });

  s.test("formatFusionReasoningDisplay shows errors", () => {
    const main = cand("openrouter/a", "", 10, "HTTP 429");
    const peer = cand("openrouter/b", "ok plan");
    const body = formatFusionReasoningDisplay(main, [peer], "openrouter/a");
    assertIncludes(body, "error: HTTP 429");
    assertIncludes(body, "ok plan");
  });

  s.test("formatFusionReasoningDisplay clips huge traces", () => {
    const huge = "x".repeat(5000);
    const main = cand("openrouter/a", huge);
    const body = formatFusionReasoningDisplay(main, [], "openrouter/a");
    assert(body.length < 5000, `expected clip, got ${body.length}`);
    assertIncludes(body, "truncated");
  });

  return s;
}
