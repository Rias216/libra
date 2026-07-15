/**
 * Hardened toolcalling: permissions, validation, concurrency, runner.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Suite, assert, assertEq, assertIncludes } from "../runner.js";
import {
  PermissionChecker,
  DEFAULT_PERMISSIONS,
  deniedToolOutput,
} from "../../../src/toolcalling/permissions.js";
import {
  validateToolArgs,
  formatValidationError,
} from "../../../src/toolcalling/validate.js";
import { scheduleToolWaves } from "../../../src/toolcalling/concurrency.js";
import { ToolRunner } from "../../../src/toolcalling/runner.js";
import { ToolRegistry } from "../../../src/toolcalling/registry.js";
import { parseToolArgs } from "../../../src/toolcalling/normalize.js";

function makeWs(): string {
  const dir = join(
    tmpdir(),
    `libra-harden-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.txt"), "alpha\n", "utf8");
  writeFileSync(join(dir, "b.txt"), "beta\n", "utf8");
  return dir;
}

export function suiteToolHarden(): Suite {
  const s = new Suite("tool-harden");
  const cwd = makeWs();

  s.test("permissions: allow list_dir by default", () => {
    const p = new PermissionChecker(DEFAULT_PERMISSIONS);
    const d = p.resolve("list_dir", { target_directory: "." });
    assertEq(d.action, "allow");
  });

  s.test("permissions: hard-deny dangerous bash", () => {
    const p = new PermissionChecker({ "*": "allow" });
    const d = p.resolve("run_terminal_command", {
      command: "rm -rf /",
    });
    assertEq(d.action, "deny");
    assertIncludes(d.matched, "hard-deny");
  });

  s.test("permissions: bash pattern ask for rm -rf *", async () => {
    let asked = false;
    const p = new PermissionChecker(
      {
        run_terminal_command: {
          "*": "allow",
          "rm -rf *": "ask",
        },
      },
      async () => {
        asked = true;
        return "deny";
      },
    );
    const d = await p.resolveAndMaybeAsk("run_terminal_command", {
      command: "rm -rf ./tmp",
    });
    assert(asked, "should ask");
    assertEq(d.action, "deny");
  });

  s.test("permissions: deny tool emits recovery text", () => {
    const p = new PermissionChecker({ write: "deny", "*": "allow" });
    const d = p.resolve("write", { file_path: "x", content: "y" });
    assertEq(d.action, "deny");
    const out = deniedToolOutput(d);
    assertIncludes(out.toLowerCase(), "permission denied");
  });

  s.test("validate: missing required write content", () => {
    const r = validateToolArgs("write", { file_path: "x.ts" });
    assert(!r.ok, "should fail");
    assert(r.issues.some((i) => i.path === "content"), "content issue");
    assertIncludes(formatValidationError("write", r), "invalid_args");
  });

  s.test("validate: coerce string number timeout", () => {
    const r = validateToolArgs("run_terminal_command", {
      command: "echo hi",
      timeout_ms: "5000",
    });
    assert(r.ok, JSON.stringify(r.issues));
    assertEq(r.args.timeout_ms, 5000);
  });

  s.test("validate: read_file needs path", () => {
    const r = validateToolArgs("read_file", {});
    assert(!r.ok, "should fail");
  });

  s.test("validate: identical old/new string", () => {
    const r = validateToolArgs("search_replace", {
      file_path: "a.ts",
      old_string: "x",
      new_string: "x",
    });
    assert(!r.ok, "no-op edit");
  });

  s.test("parseToolArgs repairs trailing comma", () => {
    const a = parseToolArgs('{"pattern":"foo",}');
    assertEq(a.pattern, "foo");
  });

  s.test("concurrency: same-file writes in separate waves", () => {
    const waves = scheduleToolWaves([
      { id: "1", name: "search_replace", args: { file_path: "a.txt", old_string: "a", new_string: "b" } },
      { id: "2", name: "search_replace", args: { file_path: "a.txt", old_string: "b", new_string: "c" } },
      { id: "3", name: "read_file", args: { target_file: "b.txt" } },
    ]);
    // Two writes to a.txt cannot share a wave
    assert(waves.length >= 2, `expected ≥2 waves, got ${waves.length}`);
    const wave0ids = waves[0]!.map((c) => c.id);
    assert(
      !(wave0ids.includes("1") && wave0ids.includes("2")),
      "writes to same file must not share wave",
    );
  });

  s.test("concurrency: independent reads one wave", () => {
    const waves = scheduleToolWaves([
      { id: "1", name: "read_file", args: { target_file: "a.txt" } },
      { id: "2", name: "read_file", args: { target_file: "b.txt" } },
      { id: "3", name: "list_dir", args: { target_directory: "." } },
    ]);
    assertEq(waves.length, 1);
    assertEq(waves[0]!.length, 3);
  });

  s.test("registry toolsets filter schemas", () => {
    const reg = new ToolRegistry();
    reg.setToolsets(["fs", "search"]);
    const names = reg.schemas().map((t) => t.function.name);
    assert(names.includes("read_file"), "read");
    assert(!names.includes("run_terminal_command"), "no shell");
    assert(!names.includes("web_fetch"), "no web");
  });

  s.test("ToolRunner validates + executes", async () => {
    const runner = new ToolRunner(cwd, { headless: true, autoApprove: true });
    const bad = await runner.run("write", { file_path: "x.txt" });
    assert(!bad.ok && bad.invalid, bad.output);

    const ok = await runner.run("read_file", { target_file: "a.txt" });
    assert(ok.ok, ok.output);
    assertIncludes(ok.output, "alpha");

    const cached = await runner.run("read_file", { target_file: "a.txt" });
    assert(cached.cached, "second call should cache");
  });

  s.test("ToolRunner path-aware runMany", async () => {
    const runner = new ToolRunner(cwd, { headless: true, autoApprove: true });
    writeFileSync(join(cwd, "seq.txt"), "one\n", "utf8");
    const results = await runner.runMany([
      {
        id: "w1",
        name: "search_replace",
        args: {
          file_path: "seq.txt",
          old_string: "one",
          new_string: "two",
        },
      },
      {
        id: "w2",
        name: "search_replace",
        args: {
          file_path: "seq.txt",
          old_string: "two",
          new_string: "three",
        },
      },
    ]);
    assert(results.every((r) => r.ok), results.map((r) => r.output).join("|"));
    assertEq(readFileSync(join(cwd, "seq.txt"), "utf8"), "three\n");
  });

  s.test("ToolRunner permission deny", async () => {
    const runner = new ToolRunner(cwd, {
      headless: true,
      permissions: { "*": "allow", write: "deny" },
    });
    const r = await runner.run("write", {
      file_path: "nope.txt",
      content: "x",
    });
    assert(!r.ok && r.denied, r.output);
  });

  s.test("cleanup", () => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  return s;
}
