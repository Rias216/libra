/**
 * Headless TUI stream layout benchmark — simulates large/fast reasoning
 * traces without a TTY, measuring realised layout cost (paint budget).
 *
 * Usage:
 *   bun scripts/bench-tui-stream.ts
 *   bun scripts/bench-tui-stream.ts --chars 150000 --width 80
 */

import { performance } from "node:perf_hooks";
import { HarnessStore } from "../src/core/store.js";
import { buildScrollDocument, clearScrollCache } from "../src/tui/scrollback.js";
import { resolveTheme } from "../src/tui/theme.js";
import { clearStreamLayouts } from "../src/tui/stream-layout.js";
import { clearStreamBodyCache } from "../src/tui/components/parts.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const targetChars = Number(arg("--chars", "120000"));
const width = Number(arg("--width", "80"));
const deltaSize = Number(arg("--delta", "64"));
const theme = resolveTheme("libra-night");

clearScrollCache();
clearStreamLayouts();
clearStreamBodyCache();

const store = new HarnessStore({
  title: "bench-tui-stream",
  provider: "openrouter",
  model: "tencent/hy3:free",
  cwd: process.cwd(),
});
store.setPhase("thinking", "streaming reasoning…");
const msg = store.startAssistant();
const partId = "p-reason-bench";
store.appendPart(msg.id, {
  id: partId,
  type: "reasoning",
  content: "",
  streaming: true,
});

const filler =
  "The agent considers tradeoffs, edge cases, invariants, and a concrete plan. ";
let paints = 0;
let slowPaints = 0;
let totalPaintMs = 0;
let maxPaintMs = 0;
const paintTimes: number[] = [];
const t0 = performance.now();
let contentLen = 0;

while (contentLen < targetChars) {
  const next = Math.min(deltaSize, targetChars - contentLen);
  // Vary content so wrap isn't a trivial single-char run
  const piece = filler
    .repeat(Math.ceil(next / filler.length))
    .slice(0, next);
  store.reasoningDelta(msg.id, partId, piece);
  contentLen += next;

  const pt0 = performance.now();
  buildScrollDocument(store.state, theme, width, paints, { needPlain: false });
  const pMs = performance.now() - pt0;
  totalPaintMs += pMs;
  if (pMs > maxPaintMs) maxPaintMs = pMs;
  if (pMs > 28) slowPaints++;
  paints++;
  paintTimes.push(pMs);
}

const wallMs = performance.now() - t0;
const avg = totalPaintMs / Math.max(1, paints);
const p95 = percentile(paintTimes, 0.95);
const p99 = percentile(paintTimes, 0.99);
const theoreticalFps = avg > 0 ? 1000 / avg : 0;
const endDoc = buildScrollDocument(store.state, theme, width, 0);

const report = {
  targetChars,
  contentLen,
  width,
  paints,
  wallMs: Math.round(wallMs),
  totalPaintMs: Math.round(totalPaintMs * 10) / 10,
  avgPaintMs: Math.round(avg * 1000) / 1000,
  p95PaintMs: Math.round(p95 * 1000) / 1000,
  p99PaintMs: Math.round(p99 * 1000) / 1000,
  maxPaintMs: Math.round(maxPaintMs * 1000) / 1000,
  slowPaintsOver28ms: slowPaints,
  theoreticalLayoutFps: Math.round(theoreticalFps * 10) / 10,
  docRowsAtEnd: endDoc.rows.length,
  pass:
    avg < 5 &&
    p95 < 12 &&
    theoreticalFps >= 60 &&
    slowPaints / paints < 0.05,
};

console.log(JSON.stringify(report, null, 2));
if (!report.pass) {
  console.error("[bench-tui-stream] FAIL — layout still too expensive");
  process.exit(1);
}
console.error(
  `[bench-tui-stream] PASS avg=${report.avgPaintMs}ms p95=${report.p95PaintMs}ms ~${report.theoreticalLayoutFps}fps`,
);

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(p * (s.length - 1)));
  return s[i]!;
}
