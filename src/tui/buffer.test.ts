/**
 * Lightweight self-check:
 *   npx tsx src/tui/buffer.test.ts
 */

import { FrameBuffer } from "./buffer.js";
import { reduce } from "../core/events.js";
import { createEmptyState, newId } from "../core/types.js";
import { ensureCodeFences, renderMarkdown } from "./markdown.js";
import { resolveTheme } from "./theme.js";
import { buildScrollRows } from "./scrollback.js";
import { computeScrollbar, scrollPercent } from "./scrollbar.js";
import { complete } from "../complete/engine.js";
import { fuzzyFilter } from "../complete/fuzzy.js";
import { PathIndex } from "../memory/paths.js";
import { PromptHistory } from "../memory/history.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Frame buffer
{
  const buf = new FrameBuffer(20, 5, "truecolor", { r: 0, g: 0, b: 0 });
  buf.write(0, 0, "hello", { fg: { r: 255, g: 0, b: 0 } });
  const a = buf.flushDiff();
  assert(a.includes("hello"), "first flush should contain text");
  const b = buf.flushDiff();
  assert(b === "", "unchanged frame should emit nothing");
}

// Event reduce
{
  let state = createEmptyState();
  const mid = newId("m");
  const pid = newId("p");
  state = reduce(state, {
    type: "message.append",
    message: {
      id: mid,
      role: "assistant",
      createdAt: Date.now(),
      parts: [{ id: pid, type: "text", content: "", streaming: true }],
    },
  });
  state = reduce(state, {
    type: "text.delta",
    messageId: mid,
    partId: pid,
    delta: "Hi",
  });
  const part = state.messages[0]!.parts[0]!;
  assert(part.type === "text" && part.content === "Hi", "delta appends text");
}

// Markdown + scrollback
{
  const theme = resolveTheme("libra-night");
  const lines = renderMarkdown("**bold** and `code`", theme, 40);
  assert(lines.length >= 1, "markdown produces lines");
  const state = createEmptyState();
  state.messages.push({
    id: "m1",
    role: "user",
    createdAt: Date.now(),
    parts: [{ id: "p1", type: "text", content: "hello" }],
  });
  assert(buildScrollRows(state, theme, 60, 0).length > 0, "scroll rows");
}

// Bare code auto-fenced so it renders as a compact block
{
  const bare = [
    "Here is the fix:",
    "const x = 1;",
    "function add(a, b) {",
    "  return a + b;",
    "}",
    "Done.",
  ].join("\n");
  const fenced = ensureCodeFences(bare);
  assert(fenced.includes("```"), "bare code should gain fences: " + fenced);
  assert(fenced.includes("const x = 1;"), "code preserved");
  assert(
    fenced.indexOf("```") < fenced.indexOf("const x"),
    "fence opens before code",
  );
  // Existing fences untouched
  const already = "```js\nconst y = 2;\n```";
  assert(ensureCodeFences(already) === already, "existing fences preserved");
  // Indented code block
  const indented = "Intro\n\n    def foo():\n        return 1\n\nOutro";
  const ind = ensureCodeFences(indented);
  assert(ind.includes("```"), "indented code fenced: " + ind);
  const theme = resolveTheme("libra-night");
  const painted = renderMarkdown(bare, theme, 60);
  const plain = painted.map((l) => l.plain).join("\n");
  assert(
    plain.includes("┌") || plain.includes("│"),
    "code block paints box gutters: " + plain.slice(0, 200),
  );
}

// Scrollbar
{
  const theme = resolveTheme("libra-night");
  const cells = computeScrollbar(
    { top: 2, height: 10, total: 100, offset: 20, col: 79 },
    theme,
    true,
  );
  assert(cells.length === 10, "scrollbar fills viewport height");
  assert(cells.some((c) => c.ch === "#"), "has thumb");
  assert(scrollPercent(0, 100, 10) === "top", "scroll top");
  assert(scrollPercent(90, 100, 10) === "bot", "scroll bot");
}

// Fuzzy + complete
{
  const hits = fuzzyFilter("rfile", ["read_file", "write", "list_dir"], 5);
  assert(hits[0]?.item === "read_file", "fuzzy ranks read_file");

  const paths = new PathIndex(process.cwd());
  paths.rebuild();
  const history = new PromptHistory({ path: "" }); // no disk I/O
  const r = complete({
    text: "/th",
    cursor: 3,
    state: createEmptyState(),
    paths,
    history,
  });
  assert(r.mode === "command", "slash mode");
  assert(r.items.some((i) => i.label.includes("theme")), "suggests theme");

  const params = complete({
    text: "/thinking ",
    cursor: 11,
    state: createEmptyState(),
    paths,
    history,
  });
  assert(params.mode === "param", "param mode after /thinking ");
  assert(
    params.items.some(
      (i) =>
        i.insert === "on" ||
        i.insert === "off" ||
        /^on$/i.test(i.label) ||
        /^off$/i.test(i.label),
    ),
    "suggests on/off",
  );

  const free = complete({
    text: "hello",
    cursor: 5,
    state: createEmptyState(),
    paths,
    history,
  });
  assert(free.mode === "none", "no free-text complete");

  const files = complete({
    text: "@src",
    cursor: 4,
    state: createEmptyState(),
    paths,
    history,
  });
  assert(files.mode === "file", "file mode");
}

console.log("ok — buffer, reduce, scrollback, scrollbar, complete");
