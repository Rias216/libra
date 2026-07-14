/**
 * Memory suite — prompt history, path index, session token harvest.
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PromptHistory } from "../../../src/memory/history.js";
import { PathIndex } from "../../../src/memory/paths.js";
import { extractSessionTokens } from "../../../src/memory/session-memory.js";
import { HarnessStore } from "../../../src/core/store.js";
import { newId } from "../../../src/core/types.js";
import { Suite, assert, assertEq, assertGte, assertIncludes } from "../runner.js";

export function suiteMemory(): Suite {
  const s = new Suite("memory");
  const root = join(
    tmpdir(),
    `libra-bench-mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export {}\n", "utf8");
  writeFileSync(join(root, "readme.md"), "# hi\n", "utf8");
  const histPath = join(root, "prompt_history.jsonl");

  s.test("PromptHistory push + recent + dedupe", () => {
    const h = new PromptHistory({ path: histPath, limit: 50 });
    h.push("first");
    h.push("first"); // consecutive dedupe
    h.push("second");
    assertEq(h.all().length, 2);
    assertEq(h.recent(1)[0], "second");
    assertEq(h.recent(10)[0], "second");
    assertEq(h.recent(10)[1], "first");
    return { n: h.all().length };
  });

  s.test("PromptHistory persists across instances", () => {
    const h1 = new PromptHistory({ path: histPath, limit: 50 });
    h1.push("persisted-prompt");
    const h2 = new PromptHistory({ path: histPath, limit: 50 });
    assert(h2.all().includes("persisted-prompt"), "should reload");
    assert(existsSync(histPath), "file exists");
  });

  s.test("PromptHistory limit trims old", () => {
    const p = join(root, "small.jsonl");
    const h = new PromptHistory({ path: p, limit: 3 });
    h.push("a");
    h.push("b");
    h.push("c");
    h.push("d");
    assertEq(h.all().length, 3);
    assertEq(h.all()[0], "b");
    assertEq(h.all()[2], "d");
  });

  s.test("PathIndex rebuild indexes workspace", () => {
    const idx = new PathIndex(root, 4000);
    const t0 = Date.now();
    idx.rebuild();
    const ms = Date.now() - t0;
    // entries private — search via rebuild side effects using public API if any
    // PathIndex only exposes rebuild/getRoot — use walk by checking known files via second API
    // Re-read implementation: only rebuild, getRoot, and private entries.
    // We'll test getRoot + rebuild doesn't throw + optional search if present
    assertEq(idx.getRoot(), root);
    // Dynamically access for bench (entries not exported)
    const entries = (idx as unknown as { entries: Array<{ path: string }> }).entries;
    assertGte(entries.length, 2);
    const paths = entries.map((e) => e.path);
    assert(paths.some((p) => p.includes("a.ts")), `paths=${paths.join(",")}`);
    assert(paths.some((p) => p.includes("readme.md")), "readme");
    return { entries: entries.length, ms };
  });

  s.test("PathIndex ignores node_modules", () => {
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "x.js"), "1", "utf8");
    const idx = new PathIndex(root, 4000);
    idx.rebuild();
    const entries = (idx as unknown as { entries: Array<{ path: string }> }).entries;
    assert(
      !entries.some((e) => e.path.includes("node_modules")),
      "must ignore node_modules",
    );
  });

  s.test("session memory extracts paths/tools/words", () => {
    const store = new HarnessStore({ title: "mem", model: "m", provider: "p" });
    store.appendUser("Please read src/agent/loop.ts and fix the harness");
    const asst = store.startAssistant();
    store.appendPart(asst.id, {
      id: newId("p"),
      type: "tool",
      toolName: "read_file",
      args: { target_file: "src/agent/loop.ts" },
      status: "completed",
      result: "ok",
    });
    store.appendPart(asst.id, {
      id: newId("p"),
      type: "tool",
      toolName: "list_dir",
      args: { target_directory: "src" },
      status: "completed",
      result: "agent/",
    });
    store.appendPart(asst.id, {
      id: newId("p"),
      type: "text",
      content: "Fixed @src/agent/loop.ts",
    });
    store.appendPart(asst.id, {
      id: newId("p"),
      type: "diff",
      path: "src/agent/loop.ts",
      additions: 1,
      deletions: 0,
      hunks: [],
    });

    const tok = extractSessionTokens(store.state);
    assert(tok.tools.includes("read_file"), `tools=${tok.tools}`);
    assert(tok.tools.includes("list_dir"), `tools=${tok.tools}`);
    assert(
      tok.paths.some((p) => p.includes("loop.ts") || p.includes("src/agent")),
      `paths=${tok.paths.join(",")}`,
    );
    // single-segment path from list_dir target_directory
    assert(
      tok.paths.includes("src"),
      `expected src in paths=${tok.paths.join(",")}`,
    );
    assert(tok.words.some((w) => /harness|fix|read/i.test(w)), `words=${tok.words.slice(0, 20)}`);
    assertGte(tok.prompts.length, 1);
    assertIncludes(tok.prompts[0]!, "harness");
    return {
      paths: tok.paths.length,
      tools: tok.tools,
      words: tok.words.length,
    };
  });

  s.test("session memory empty state", () => {
    const store = new HarnessStore({});
    const tok = extractSessionTokens(store.state);
    assertEq(tok.paths.length, 0);
    assertEq(tok.tools.length, 0);
    assertEq(tok.prompts.length, 0);
  });

  s.test("cleanup", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  return s;
}
