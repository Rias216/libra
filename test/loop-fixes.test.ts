/**
 * Agent-loop thrift fixes (Codex/OpenCode-aligned) from expansion heavy bench.
 */
import { describe, expect, test } from "bun:test";
import {
  preferredToolForShell,
  shellDisciplineAdvisory,
} from "../src/toolcalling/discipline.js";
import { applyHunk, parseUnifiedDiff } from "../src/toolcalling/patch.js";
import {
  compactBudgetForModel,
  COMPACT_CONTEXT_RATIO,
  COMPACT_CONTEXT_RATIO_FREE,
  DEFAULT_COMPACT_TOKEN_BUDGET,
  isFreeTierModelId,
} from "../src/agent/compaction.js";
import {
  FREE_TIER_EFFORT_CAP,
  isFreeTierReasoningModel,
  resolveEffortForModel,
} from "../src/agent/reasoning.js";
import { LIBRA_TOOL_POLICY } from "../src/agent/prompts/tool-policy.js";
import { saveAgentSettings, loadAgentSettings } from "../src/agent/config.js";

describe("shell discipline → specialized tools", () => {
  test("maps git porcelain and tsc/eslint to git/check", () => {
    expect(preferredToolForShell("git status")).toBe("git");
    expect(preferredToolForShell("git diff --stat")).toBe("git");
    expect(preferredToolForShell("git log -n 5")).toBe("git");
    expect(preferredToolForShell("git blame src/a.ts")).toBe("git");
    expect(preferredToolForShell("git commit -m x")).toBeNull();
    expect(preferredToolForShell("npx tsc --noEmit")).toBe("check");
    expect(preferredToolForShell("bun run typecheck")).toBe("check");
    expect(preferredToolForShell("npm run typecheck")).toBe("check");
    expect(preferredToolForShell("eslint src")).toBe("check");
    expect(preferredToolForShell("ls -la")).toBe("list_dir");
  });

  test("shellDisciplineAdvisory mentions preferred tool", () => {
    const note = shellDisciplineAdvisory("git status --porcelain", []);
    expect(note).toBeTruthy();
    expect(note!).toMatch(/git/);
    const tsc = shellDisciplineAdvisory("npx tsc --noEmit --pretty false", []);
    expect(tsc).toMatch(/check/);
  });
});

describe("patch_apply recovery hint", () => {
  test("mismatch error tells model to re-read", () => {
    const files = parseUnifiedDiff(
      [
        "--- a/x.txt",
        "+++ b/x.txt",
        "@@ -1,1 +1,1 @@",
        "-nope",
        "+yes",
      ].join("\n"),
    );
    const r = applyHunk("different content\n", files[0]!.hunks[0]!, 0);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Re-read|read_file|retry patch_apply/i);
  });
});

describe("free-tier effort cap + earlier compact", () => {
  test("isFreeTier helpers", () => {
    expect(isFreeTierReasoningModel("deepseek-v4-flash-free")).toBe(true);
    expect(isFreeTierModelId("deepseek-v4-flash-free")).toBe(true);
    expect(isFreeTierReasoningModel("claude-sonnet-4-6")).toBe(false);
  });

  test("resolveEffortForModel caps free global high to medium", () => {
    const prev = loadAgentSettings();
    try {
      saveAgentSettings({
        reasoning: {
          ...prev.reasoning,
          effort: "high",
          perModelEffort: {},
        },
      });
      const r = resolveEffortForModel("opencode", "deepseek-v4-flash-free");
      // When free model supports medium, must not exceed FREE_TIER_EFFORT_CAP
      if (r.effort) {
        const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
        expect(order.indexOf(r.effort)).toBeLessThanOrEqual(
          order.indexOf(FREE_TIER_EFFORT_CAP),
        );
      }
    } finally {
      saveAgentSettings(prev);
    }
  });

  test("compactBudgetForModel is tighter for free models", () => {
    // Explicit free fallback ratio (no catalog window for :free id)
    const freeFb = compactBudgetForModel(
      "openrouter",
      "some-vendor/model:free",
      100_000,
    );
    const paidFb = compactBudgetForModel(
      "openrouter",
      "some-vendor/model-paid-unique-id-xyz",
      100_000,
    );
    expect(freeFb).toBe(
      Math.max(
        4_096,
        Math.floor(100_000 * (COMPACT_CONTEXT_RATIO_FREE / COMPACT_CONTEXT_RATIO)),
      ),
    );
    expect(freeFb).toBeLessThan(paidFb);
    expect(isFreeTierModelId("some-vendor/model:free")).toBe(true);
    void DEFAULT_COMPACT_TOKEN_BUDGET;
  });
});

describe("tool policy mentions expansion + check/git", () => {
  test("LIBRA_TOOL_POLICY includes check/git and parallel", () => {
    expect(LIBRA_TOOL_POLICY).toMatch(/check/);
    expect(LIBRA_TOOL_POLICY).toMatch(/\bgit\b/);
    expect(LIBRA_TOOL_POLICY).toMatch(/parallel/i);
    expect(LIBRA_TOOL_POLICY).toMatch(/patch_apply/);
    expect(LIBRA_TOOL_POLICY).toMatch(/find_symbol|list_windows/);
  });
});
