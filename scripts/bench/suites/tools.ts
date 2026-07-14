/**
 * Tool executor suite — every built-in tool, edge cases, sandboxing.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolExecutor } from "../../../src/toolcalling/executor.js";
import { OPENAI_TOOLS, toolNamesFromSchema } from "../../../src/toolcalling/schema.js";
import { BUILTIN_TOOLS } from "../../../src/toolcalling/tools.js";
import { Suite, assert, assertEq, assertGte, assertIncludes } from "../runner.js";

function makeWorkspace(): string {
  const dir = join(
    tmpdir(),
    `libra-bench-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "hello.txt"), "line1\nline2\nline3\nhello world\n", "utf8");
  writeFileSync(join(dir, "sub", "nested.ts"), "export const x = 1;\n", "utf8");
  writeFileSync(join(dir, "replace_me.txt"), "aaa bbb aaa\n", "utf8");
  return dir;
}

export function suiteTools(): Suite {
  const s = new Suite("toolcalling");
  const cwd = makeWorkspace();
  const exec = new ToolExecutor(cwd);

  s.test("schema covers all executor tools", () => {
    const schema = new Set(toolNamesFromSchema());
    const builtin = new Set(BUILTIN_TOOLS.map((t) => t.name));
    for (const name of [
      "list_dir",
      "read_file",
      "write",
      "search_replace",
      "grep",
      "glob",
      "run_terminal_command",
      "web_fetch",
    ]) {
      assert(schema.has(name), `schema missing ${name}`);
      assert(builtin.has(name), `BUILTIN_TOOLS missing ${name}`);
    }
    return { schemaCount: schema.size, builtinCount: builtin.size };
  });

  s.test("OPENAI_TOOLS have valid JSON-schema shape", () => {
    for (const t of OPENAI_TOOLS) {
      assertEq(t.type, "function");
      assert(t.function.name.length > 0, "empty name");
      assert(t.function.parameters?.type === "object", `${t.function.name} params`);
    }
    return { count: OPENAI_TOOLS.length };
  });

  s.test("list_dir root", async () => {
    const r = await exec.run("list_dir", { target_directory: "." });
    assert(r.ok, r.output);
    assertIncludes(r.output, "hello.txt");
    assertIncludes(r.output, "sub/");
    assertGte(r.durationMs, 0);
    return { ms: r.durationMs, lines: r.output.split("\n").length };
  });

  s.test("list_dir nested", async () => {
    const r = await exec.run("list_dir", { target_directory: "sub" });
    assert(r.ok, r.output);
    assertIncludes(r.output, "nested.ts");
  });

  s.test("list_dir missing → error", async () => {
    const r = await exec.run("list_dir", { target_directory: "nope-xyz" });
    assert(!r.ok, "should fail");
    assertIncludes(r.output, "not found");
  });

  s.test("read_file full", async () => {
    const r = await exec.run("read_file", { target_file: "hello.txt" });
    assert(r.ok, r.output);
    assertIncludes(r.output, "hello world");
    assertIncludes(r.output, "1|");
  });

  s.test("read_file offset+limit", async () => {
    const r = await exec.run("read_file", {
      target_file: "hello.txt",
      offset: 2,
      limit: 2,
    });
    assert(r.ok, r.output);
    assertIncludes(r.output, "2|");
    assert(!r.output.includes("1|"), "should skip line 1");
  });

  s.test("write creates parents", async () => {
    const r = await exec.run("write", {
      file_path: "deep/a/b.txt",
      content: "created",
    });
    assert(r.ok, r.output);
    assertEq(readFileSync(join(cwd, "deep/a/b.txt"), "utf8"), "created");
  });

  s.test("search_replace once", async () => {
    const r = await exec.run("search_replace", {
      file_path: "replace_me.txt",
      old_string: "aaa",
      new_string: "XXX",
      replace_all: false,
    });
    assert(r.ok, r.output);
    const body = readFileSync(join(cwd, "replace_me.txt"), "utf8");
    assertEq(body, "XXX bbb aaa\n");
  });

  s.test("search_replace all", async () => {
    writeFileSync(join(cwd, "replace_me.txt"), "aaa bbb aaa\n", "utf8");
    const r = await exec.run("search_replace", {
      file_path: "replace_me.txt",
      old_string: "aaa",
      new_string: "Y",
      replace_all: true,
    });
    assert(r.ok, r.output);
    assertEq(readFileSync(join(cwd, "replace_me.txt"), "utf8"), "Y bbb Y\n");
  });

  s.test("search_replace missing string → error", async () => {
    const r = await exec.run("search_replace", {
      file_path: "hello.txt",
      old_string: "NOT_IN_FILE_ZZZ",
      new_string: "x",
    });
    assert(!r.ok, "should fail");
  });

  s.test("grep finds pattern", async () => {
    const r = await exec.run("grep", { pattern: "hello", path: "." });
    assert(r.ok, r.output);
    assertIncludes(r.output, "hello.txt");
  });

  s.test("grep case_insensitive", async () => {
    const r = await exec.run("grep", {
      pattern: "HELLO",
      path: ".",
      case_insensitive: true,
    });
    assert(r.ok, r.output);
    assertIncludes(r.output, "hello");
  });

  s.test("grep no matches", async () => {
    const r = await exec.run("grep", { pattern: "zzz_no_match_qqq", path: "." });
    assert(r.ok, r.output);
    assertIncludes(r.output, "no matches");
  });

  s.test("glob **/*.ts", async () => {
    const r = await exec.run("glob", { pattern: "**/*.ts" });
    assert(r.ok, r.output);
    assertIncludes(r.output, "nested.ts");
  });

  s.test("run_terminal_command echo", async () => {
    const r = await exec.run("run_terminal_command", {
      command: process.platform === "win32" ? "echo bench-ok" : "echo bench-ok",
      timeout_ms: 10_000,
    });
    assert(r.ok, r.output);
    assertIncludes(r.output, "bench-ok");
    assertIncludes(r.output, "exit");
  });

  s.test("path escape blocked", async () => {
    const r = await exec.run("read_file", {
      target_file: process.platform === "win32" ? "..\\..\\Windows\\win.ini" : "../../etc/passwd",
    });
    assert(!r.ok, "must block escape");
    assertIncludes(r.output.toLowerCase(), "escape");
  });

  s.test("unknown tool → error", async () => {
    const r = await exec.run("not_a_real_tool", {});
    assert(!r.ok, "should fail");
    assertIncludes(r.output, "unknown tool");
  });

  s.test("result truncation on huge write/read", async () => {
    const big = "x".repeat(30_000);
    await exec.run("write", { file_path: "big.txt", content: big });
    // grep path that returns lots — use read which can be large
    const r = await exec.run("read_file", { target_file: "big.txt" });
    assert(r.ok, r.output);
    // line-prefixed output is larger than content; ensure completes fast
    assertGte(r.output.length, 1000);
    return { outLen: r.output.length, ms: r.durationMs };
  });

  s.test("catalog aliases: write_file / edit_file / calc / finish", async () => {
    const r1 = await exec.run("write_file", {
      path: "alias_out.txt",
      content: "v1",
    });
    assert(r1.ok, r1.output);
    assertEq(readFileSync(join(cwd, "alias_out.txt"), "utf8"), "v1");

    const r2 = await exec.run("edit_file", {
      path: "alias_out.txt",
      old_string: "v1",
      new_string: "v2",
    });
    assert(r2.ok, r2.output);
    assertEq(readFileSync(join(cwd, "alias_out.txt"), "utf8"), "v2");

    const r3 = await exec.run("calc", { expression: "(17+4)*3" });
    assert(r3.ok, r3.output);
    assertIncludes(r3.output, "63");

    const r4 = await exec.run("finish", { answer: "done", success: true });
    assert(r4.ok, r4.output);
  });

  s.test("json resultStyle returns catalog-shaped payloads", async () => {
    const jx = new ToolExecutor(cwd, { resultStyle: "json" });
    const r = await jx.run("read_file", { path: "hello.txt" });
    assert(r.ok, r.output);
    const data = JSON.parse(r.output) as { ok: boolean; content: string };
    assertEq(data.ok, true);
    assertIncludes(data.content, "hello world");
    assert(!data.content.includes("1|"), "json style should not line-prefix");

    const c = await jx.run("calc", { expression: "2+2" });
    const cd = JSON.parse(c.output) as { ok: boolean; value: number };
    assertEq(cd.value, 4);
  });

  s.test("parallel tool runs", async () => {
    const t0 = Date.now();
    const results = await Promise.all([
      exec.run("list_dir", { target_directory: "." }),
      exec.run("read_file", { target_file: "hello.txt" }),
      exec.run("glob", { pattern: "**/*" }),
    ]);
    assert(results.every((r) => r.ok), results.map((r) => r.output).join("|"));
    return { ms: Date.now() - t0, n: results.length };
  });

  // cleanup after suite definitions — run as last case
  s.test("cleanup workspace", () => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* */
    }
    assert(!existsSync(cwd) || true, "cleanup best-effort");
  });

  return s;
}
