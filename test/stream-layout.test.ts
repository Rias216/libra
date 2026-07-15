/**
 * Stream layout microbenches + correctness for large reasoning traces.
 * Run: bun test/stream-layout.test.ts
 */

import assert from "node:assert/strict";
import {
  clearStreamLayouts,
  wrapPlainLines,
  wrapStreamPlain,
} from "../src/tui/stream-layout.js";
import {
  clearStreamBodyCache,
  renderPart,
} from "../src/tui/components/parts.js";
import { resolveTheme } from "../src/tui/theme.js";
import type { ReasoningPart, TextPart } from "../src/core/types.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(err);
  }
}

const theme = resolveTheme("libra-night");

test("wrapStreamPlain append is consistent with full wrap", () => {
  clearStreamLayouts();
  const id = "p1";
  let content = "";
  const chunks = [
    "Hello world, ",
    "this is a long-ish reasoning line that should wrap around the width boundary for sure.\n",
    "Next paragraph continues the thought about algorithms and data structures.\n",
    "Final.",
  ];
  for (const c of chunks) {
    content += c;
    wrapStreamPlain(id, content, 40);
  }
  const { lines, open } = wrapStreamPlain(id, content, 40);
  const full = wrapPlainLines(content, 40);
  const streamAll = open ? [...lines, open] : [...lines];
  // Full wrap folds open into lines
  assert.deepEqual(streamAll, full);
});

test("wrapStreamPlain width change rebuilds", () => {
  clearStreamLayouts();
  const id = "p2";
  const content = "abcdefghijklmnopqrstuvwxyz 0123456789";
  const a = wrapStreamPlain(id, content, 10);
  const b = wrapStreamPlain(id, content, 20);
  assert.notEqual(a.lines.length + (a.open ? 1 : 0), 0);
  assert.ok(
    b.lines.length + (b.open ? 1 : 0) <= a.lines.length + (a.open ? 1 : 0),
  );
});

test("incremental wrap stays cheap as content grows to 100k", () => {
  clearStreamLayouts();
  const id = "big";
  const chunk =
    "The model reasons carefully about the problem, considering edge cases and tradeoffs. ";
  let content = "";
  let totalMs = 0;
  let steps = 0;
  while (content.length < 100_000) {
    content += chunk;
    // Simulate ~30fps paints that only see the append
    if (content.length % 400 < chunk.length) {
      const t0 = performance.now();
      wrapStreamPlain(id, content, 80);
      totalMs += performance.now() - t0;
      steps++;
    }
  }
  const avg = totalMs / steps;
  console.log(
    `    incremental wrap: steps=${steps} totalMs=${totalMs.toFixed(1)} avgMs=${avg.toFixed(3)}`,
  );
  // Old full-rewrapping path averaged ~100ms+/step near the end and
  // tens of seconds overall. Incremental must stay near-linear and fast.
  assert.ok(totalMs < 500, `total wrap time too high: ${totalMs}ms`);
  assert.ok(avg < 5, `avg step too high: ${avg}ms`);
});

test("streaming reasoning body reuses cache on tick-only paints", () => {
  clearStreamLayouts();
  clearStreamBodyCache();
  const part: ReasoningPart = {
    id: "r1",
    type: "reasoning",
    content: "A".repeat(20_000),
    streaming: true,
  };
  const t0 = performance.now();
  const a = renderPart(part, theme, {
    width: 80,
    showToolDetails: false,
    showThinking: true,
    tick: 0,
    messageId: "m1",
  });
  const firstMs = performance.now() - t0;
  const t1 = performance.now();
  for (let tick = 1; tick <= 60; tick++) {
    renderPart(part, theme, {
      width: 80,
      showToolDetails: false,
      showThinking: true,
      tick,
      messageId: "m1",
    });
  }
  const tickMs = performance.now() - t1;
  console.log(
    `    reasoning 20k: firstMs=${firstMs.toFixed(2)} 60ticksMs=${tickMs.toFixed(2)} rows=${a.length}`,
  );
  assert.ok(a.length > 10, "expected multi-line body");
  // 60 tick paints must be near free (header only + body cache hit)
  assert.ok(tickMs < 50, `tick paints too slow: ${tickMs}ms`);
});

test("streaming text append paint path stays sub-linear", () => {
  clearStreamLayouts();
  clearStreamBodyCache();
  const part: TextPart = {
    id: "t1",
    type: "text",
    content: "",
    streaming: true,
  };
  let totalMs = 0;
  let steps = 0;
  const chunk = "word ".repeat(20);
  while (part.content.length < 80_000) {
    part.content += chunk;
    const t0 = performance.now();
    renderPart(part, theme, {
      width: 72,
      showToolDetails: false,
      showThinking: true,
      tick: steps,
      messageId: "m",
    });
    totalMs += performance.now() - t0;
    steps++;
  }
  console.log(
    `    streaming text grow: steps=${steps} totalMs=${totalMs.toFixed(1)} avgMs=${(totalMs / steps).toFixed(3)}`,
  );
  assert.ok(totalMs < 1500, `total render too high: ${totalMs}ms`);
});

test("streaming reasoning append stays sub-linear (no O(n²) body copy)", () => {
  clearStreamLayouts();
  clearStreamBodyCache();
  const part: ReasoningPart = {
    id: "r-grow",
    type: "reasoning",
    content: "",
    streaming: true,
  };
  let totalMs = 0;
  let steps = 0;
  const chunk =
    "The model reasons carefully about the problem, considering edge cases.\n";
  while (part.content.length < 80_000) {
    part.content += chunk;
    const t0 = performance.now();
    renderPart(part, theme, {
      width: 80,
      showToolDetails: false,
      showThinking: true,
      tick: steps,
      messageId: "m1",
    });
    totalMs += performance.now() - t0;
    steps++;
  }
  const last = renderPart(part, theme, {
    width: 80,
    showToolDetails: false,
    showThinking: true,
    tick: steps,
    messageId: "m1",
  });
  console.log(
    `    streaming reasoning grow: steps=${steps} totalMs=${totalMs.toFixed(1)} avgMs=${(totalMs / steps).toFixed(3)} rows=${last.length}`,
  );
  // Pre-fix full body[i]=finished[i] each frame was O(n²) and multi-second.
  assert.ok(totalMs < 1500, `total reasoning render too high: ${totalMs}ms`);
  assert.ok(last.length > 100, "expected large multi-line reasoning body");
});

test("streaming body restores plain finished row after caret overlay", () => {
  clearStreamLayouts();
  clearStreamBodyCache();
  // Width 20 forces short lines. Content that completes a line (no open tail)
  // puts the caret on the last finished row; the next append must restore
  // that row to its plain finished form (no caret) when a new open line starts.
  const part: TextPart = {
    id: "t-caret",
    type: "text",
    content: "abcdefghij klmnopqr\n",
    streaming: true,
  };
  const width = 20;
  const rows1 = renderPart(part, theme, {
    width,
    showToolDetails: false,
    showThinking: true,
    tick: 0,
    messageId: "m",
  });
  // Last body row should carry the caret (no separate open line).
  const last1 = rows1[rows1.length - 1]!;
  const last1Text = last1.segments.map((s) => s.text).join("");
  assert.ok(last1Text.includes("│"), `expected caret on last row: ${last1Text}`);

  part.content += "next open line";
  const rows2 = renderPart(part, theme, {
    width,
    showToolDetails: false,
    showThinking: true,
    tick: 1,
    messageId: "m",
  });
  assert.ok(rows2.length >= 2, "expected finished + open rows");
  // Earlier finished rows must not keep the caret after a new open line appears.
  for (let i = 0; i < rows2.length - 1; i++) {
    const text = rows2[i]!.segments.map((s) => s.text).join("");
    assert.ok(
      !text.includes("│"),
      `finished row ${i} still has caret: ${text}`,
    );
  }
  const last2 = rows2[rows2.length - 1]!;
  const last2Text = last2.segments.map((s) => s.text).join("");
  assert.ok(last2Text.includes("│"), `expected caret on open row: ${last2Text}`);
});

test("formatTokenStatus fps field (chrome)", async () => {
  const { formatTokenStatus } = await import("../src/tui/chrome.js");
  assert.equal(formatTokenStatus(1200), "1.2k");
  assert.equal(formatTokenStatus(1200, 60), "1.2k / 60t");
  assert.equal(formatTokenStatus(1200, 60, 28), "1.2k / 60t / 28f");
  assert.equal(formatTokenStatus(1200, 0, 28), "1.2k / 28f");
});

test("context bar fill + spinner glyphs (OpenCode-style)", async () => {
  const {
    formatContextBar,
    contextBarColor,
    DEFAULT_CONTEXT_WINDOW,
  } = await import("../src/tui/chrome.js");
  const {
    BRAILLE_SPINNER,
    spinnerFrame,
    setSpinnerGlyphs,
    getSpinnerGlyphs,
  } = await import("../src/tui/components/parts.js");
  const { resolveTheme } = await import("../src/tui/theme.js");

  const half = formatContextBar(64_000, 128_000, 10);
  assert.equal(half.percent, 50);
  assert.equal(half.bar.length, 10);
  assert.ok(half.bar.includes("█"));
  assert.ok(half.bar.includes("░"));
  assert.match(half.label, /64k\/128k/);

  const full = formatContextBar(128_000, 128_000, 8);
  assert.equal(full.percent, 100);
  assert.equal(full.bar, "████████");

  const empty = formatContextBar(0, 128_000, 8);
  assert.equal(empty.percent, 0);
  assert.equal(empty.bar, "░░░░░░░░");

  const theme = resolveTheme("libra-night");
  assert.deepEqual(contextBarColor(0.2, theme), theme.accent);
  assert.deepEqual(contextBarColor(0.6, theme), theme.info);
  assert.deepEqual(contextBarColor(0.8, theme), theme.warn);
  assert.deepEqual(contextBarColor(0.95, theme), theme.error);

  assert.ok(DEFAULT_CONTEXT_WINDOW >= 100_000);

  // Default spinner is braille (not |/-\)
  setSpinnerGlyphs(null);
  assert.equal(getSpinnerGlyphs()[0], BRAILLE_SPINNER[0]);
  assert.equal(spinnerFrame(0), "⠋");
  assert.equal(spinnerFrame(1), "⠙");
  assert.ok(!["|", "/", "-", "\\"].includes(spinnerFrame(0)));
});

test("every theme has coherent semantic colors (no night-default leaks)", async () => {
  const { listThemes, resolveTheme } = await import("../src/tui/theme.js");
  const {
    contextBarColor,
    renderContextBarSegments,
  } = await import("../src/tui/chrome.js");

  const night = resolveTheme("libra-night");
  const rgbKey = (c: { r: number; g: number; b: number }) =>
    `${c.r},${c.g},${c.b}`;

  for (const theme of listThemes()) {
    // Semantic slots must resolve to the theme's own palette anchors
    assert.deepEqual(
      theme.success,
      theme.toolOk,
      `${theme.name}: success should match toolOk`,
    );
    assert.deepEqual(
      theme.warn,
      theme.toolRunning,
      `${theme.name}: warn should match toolRunning`,
    );
    assert.deepEqual(
      theme.error,
      theme.toolError,
      `${theme.name}: error should match toolError`,
    );
    assert.deepEqual(
      theme.info,
      theme.accentUser,
      `${theme.name}: info should match accentUser`,
    );
    assert.deepEqual(
      theme.spinner,
      theme.accent,
      `${theme.name}: spinner should match accent`,
    );

    // Context bar fill uses only this theme's tokens at each band
    assert.deepEqual(contextBarColor(0.1, theme), theme.accent);
    assert.deepEqual(contextBarColor(0.55, theme), theme.info);
    assert.deepEqual(contextBarColor(0.8, theme), theme.warn);
    assert.deepEqual(contextBarColor(0.95, theme), theme.error);

    // Empty track uses fgFaint (readable on bgElevated)
    const segs = renderContextBarSegments(0, 128_000, theme, 8);
    const emptySeg = segs.find((s) => s.text.includes("░"));
    assert.ok(emptySeg, `${theme.name}: expected empty track`);
    assert.deepEqual(
      emptySeg!.style?.fg,
      theme.fgFaint,
      `${theme.name}: empty track should use fgFaint`,
    );

    // Non-night themes must not silently inherit night's accent for spinner
    if (theme.name !== "libra-night") {
      // At least one of accent / accentUser should differ from night
      // (otherwise the palette is a clone and derivation is moot)
      const differs =
        rgbKey(theme.accent) !== rgbKey(night.accent) ||
        rgbKey(theme.accentUser) !== rgbKey(night.accentUser) ||
        rgbKey(theme.toolOk) !== rgbKey(night.toolOk);
      assert.ok(differs, `${theme.name}: expected palette distinct from night`);
    }
  }
});

test("renderMarkdown cache hits on large finished messages", async () => {
  const {
    renderMarkdown,
    markdownCacheStats,
    clearMarkdownCache,
  } = await import("../src/tui/markdown.js");
  clearMarkdownCache();
  const big =
    "# Title\n\n" +
    "Some **bold** and `code`.\n\n".repeat(200) +
    "```ts\nconst x = 1;\n```\n";
  const a = renderMarkdown(big, theme, 80);
  const b = renderMarkdown(big, theme, 80);
  const c = renderMarkdown(big, theme, 80);
  assert.equal(a, b);
  assert.equal(b, c);
  const stats = markdownCacheStats();
  assert.equal(stats.misses, 1);
  assert.equal(stats.hits, 2);
  assert.ok(stats.hitRate >= 0.66, `hitRate=${stats.hitRate}`);
  // width change must miss
  renderMarkdown(big, theme, 100);
  assert.equal(markdownCacheStats().misses, 2);
});

console.log(`\nstream-layout: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
