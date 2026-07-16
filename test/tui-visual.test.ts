/**
 * TUI visual / agent-loop unit tests for codebox, highlight, doom, thought-loop.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveTheme } from "../src/tui/theme.js";
import { renderCodeBox } from "../src/tui/codebox.js";
import {
  highlightLine,
  langFromPath,
  clearHighlightCache,
} from "../src/tui/highlight.js";
import { renderMarkdown, clearMarkdownCache } from "../src/tui/markdown.js";
import {
  ToolCallRuntime,
  DOOM_LOOP_THRESHOLD,
} from "../src/toolcalling/runtime.js";
import {
  detectThoughtLoop,
  createThoughtLoopState,
  normalizeThoughtTail,
} from "../src/agent/thought-loop.js";
import { buildMainCompareAddon, WIRE_PLAN_BODY_MAX } from "../src/agent/fusion.js";
import { approxTokensFromMessages } from "../src/agent/history.js";
import type { ChatMessage } from "../src/llm/client.js";

const theme = resolveTheme("libra-night");

test("highlight: js keywords and strings", () => {
  clearHighlightCache();
  const spans = highlightLine(`const x = "hello"; // note`, "js");
  const kinds = spans.map((s) => s.kind);
  assert.ok(kinds.includes("keyword"), `expected keyword in ${kinds}`);
  assert.ok(kinds.includes("string"), `expected string in ${kinds}`);
  assert.ok(kinds.includes("comment"), `expected comment in ${kinds}`);
});

test("langFromPath maps extensions", () => {
  assert.equal(langFromPath("src/foo.ts"), "ts");
  assert.equal(langFromPath("a/b.py"), "py");
  assert.equal(langFromPath("x.rs"), "rs");
});

test("codebox: full-width corners and gutter parse", () => {
  const body = [
    "330→function renderGenericPlanet(idx){",
    "331→ const planet=PLANETS[idx]",
    "332→ // comment",
  ].join("\n");
  const rows = renderCodeBox(body, theme, 72, {
    lang: "js",
    label: "planet.html",
    parseLineGutters: true,
  });
  assert.ok(rows.length >= 4, "header + body + footer");
  const plain = rows.map((r) => r.segments.map((s) => s.text).join("")).join("\n");
  assert.match(plain, /┌/);
  assert.match(plain, /└/);
  assert.match(plain, /330/);
  assert.ok(!plain.includes("→"), "arrow gutters stripped");
  assert.match(plain, /function renderGenericPlanet/);
  // Solid bg on body rows
  assert.ok(rows.some((r) => r.bg), "row.bg set for panel");
});

test("markdown fences use codebox", () => {
  clearMarkdownCache();
  const lines = renderMarkdown(
    "Intro\n\n```ts\nconst a = 1;\n```\n\nDone",
    theme,
    60,
  );
  const plain = lines.map((l) => l.plain).join("\n");
  assert.match(plain, /┌/);
  assert.match(plain, /ts/);
  assert.match(plain, /const a = 1/);
  assert.match(plain, /└/);
});

test("doom-loop v2: count-based (not only consecutive tail)", () => {
  const runtime = new ToolCallRuntime({
    run: async () => ({
      ok: true,
      output: "ok",
      durationMs: 1,
      cached: false,
    }),
  } as never);

  const fp = "read_file|path=a.ts";
  // Simulate: fp, other, fp, other, fp → third fp should doom
  for (let i = 0; i < DOOM_LOOP_THRESHOLD; i++) {
    runtime.seedFingerprints([fp, "other|x"]);
  }
  // counts: fp appears DOOM_LOOP_THRESHOLD times already
  assert.equal(runtime.checkDoom(fp), "repeat");
});

test("thought-loop detects repeated tails", () => {
  const state = createThoughtLoopState();
  const block =
    "I need to replace the mini-planet drawer with full quality. " +
    "Let me do the search_replace now and complete the implementation.";
  // Same reasoning across 3 samples
  assert.equal(detectThoughtLoop(state, block), false); // first
  assert.equal(detectThoughtLoop(state, block), true); // second identical → loop
});

test("normalizeThoughtTail is stable", () => {
  const a = normalizeThoughtTail("Hello   World\n\nFoo");
  const b = normalizeThoughtTail("hello world foo");
  assert.equal(a, b);
});

test("fusion wire addon always embeds plan bodies (budgeted)", () => {
  const addon = buildMainCompareAddon(
    "implement feature X",
    {
      modelKey: "main",
      provider: "openai",
      model: "m",
      text: "MAIN_PLAN: touch src/a.ts then test",
      ms: 10,
    },
    [
      {
        modelKey: "peer",
        provider: "xai",
        model: "p",
        text: "PEER_PLAN: prefer smaller diff",
        ms: 12,
      },
    ],
    {
      modelKeys: [],
      minModels: 1,
      maxParallel: 1,
      reasoningOnly: true,
      analysisInstructions: "",
      fuseInstructions: "",
    },
    { compact: true },
  );
  assert.match(addon, /MAIN_PLAN/);
  assert.match(addon, /PEER_PLAN/);
  assert.ok(WIRE_PLAN_BODY_MAX >= 1000);
});

test("approxTokensFromMessages counts reasoning fields", () => {
  const msgs: ChatMessage[] = [
    {
      role: "assistant",
      content: "hi",
      reasoning: "x".repeat(400),
    } as ChatMessage,
  ];
  const tok = approxTokensFromMessages(msgs);
  // content 2 + reasoning 400 = 402/4 ≈ 100.5
  assert.ok(tok >= 100, `expected ~100+, got ${tok}`);
});

test("isReasoningCollapsed defaults true; tools follow showToolDetails", async () => {
  const {
    isReasoningCollapsed,
    isToolCollapsed,
  } = await import("../src/tui/components/parts.js");
  assert.equal(
    isReasoningCollapsed({
      id: "r1",
      type: "reasoning",
      content: "think",
      streaming: true,
    }),
    true,
  );
  // Explicit expand works even while streaming (current thinking)
  assert.equal(
    isReasoningCollapsed({
      id: "r1b",
      type: "reasoning",
      content: "think",
      streaming: true,
      collapsed: false,
    }),
    false,
  );
  assert.equal(
    isReasoningCollapsed({
      id: "r2",
      type: "reasoning",
      content: "think",
      collapsed: false,
    }),
    false,
  );
  assert.equal(
    isToolCollapsed(
      {
        id: "t1",
        type: "tool",
        toolName: "list_dir",
        args: {},
        status: "completed",
      },
      false,
    ),
    true,
  );
  assert.equal(
    isToolCollapsed(
      {
        id: "t2",
        type: "tool",
        toolName: "list_dir",
        args: {},
        status: "completed",
      },
      true,
    ),
    false,
  );
});

test("resolveContextUsage prefers session.contextWindow over catalog miss", async () => {
  const { resolveContextUsage } = await import("../src/tui/chrome.js");
  const { createEmptyState } = await import("../src/core/types.js");
  const state = createEmptyState({
    model: "totally-unknown-model-xyz",
    provider: "openai",
    contextWindow: 256_000,
  });
  state.tokens.lastPrompt = 12_800;
  const u = resolveContextUsage(state);
  assert.equal(u.limit, 256_000);
  assert.equal(u.used, 12_800);
  assert.ok(Math.abs(u.ratio - 12800 / 256000) < 0.001);
});
