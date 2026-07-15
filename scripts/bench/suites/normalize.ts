/**
 * Tool normalize / fingerprint suite (offline).
 */

import {
  normalizeToolArgs,
  parseToolArgs,
  stableJson,
  toolFingerprint,
} from "../../../src/toolcalling/normalize.js";
import { Suite, assert, assertEq } from "../runner.js";

export function suiteNormalize(): Suite {
  const s = new Suite("tool-normalize");

  s.test("list_dir empty ≡ .", () => {
    const a = normalizeToolArgs("list_dir", {});
    const b = normalizeToolArgs("list_dir", { target_directory: "." });
    const c = normalizeToolArgs("list_dir", { target_directory: "./" });
    assertEq(a.target_directory, ".");
    assertEq(toolFingerprint("list_dir", {}), toolFingerprint("list_dir", b));
    assertEq(toolFingerprint("list_dir", {}), toolFingerprint("list_dir", c));
  });

  s.test("list_dir path slash normalize", () => {
    const a = normalizeToolArgs("list_dir", { target_directory: "src\\agent" });
    assertEq(a.target_directory, "src/agent");
  });

  s.test("read_file slash normalize", () => {
    const a = normalizeToolArgs("read_file", {
      target_file: "src\\package.json",
    });
    assertEq(a.target_file, "src/package.json");
  });

  s.test("read_file target_files batch normalize + fingerprint", () => {
    const a = normalizeToolArgs("read_file", {
      target_files: ["b.txt", "a.txt"],
    });
    // sorted for stable fingerprint regardless of call order
    assertEq(JSON.stringify(a.target_files), JSON.stringify(["a.txt", "b.txt"]));
    const fp1 = toolFingerprint("read_file", {
      target_files: ["b.txt", "a.txt"],
    });
    const fp2 = toolFingerprint("read_file", {
      target_files: ["a.txt", "b.txt"],
    });
    assertEq(fp1, fp2);
    // single-element batch collapses to target_file
    const one = normalizeToolArgs("read_file", { target_files: ["only.ts"] });
    assertEq(one.target_file, "only.ts");
    assert(one.target_files == null);
  });

  s.test("grep default path", () => {
    const a = normalizeToolArgs("grep", { pattern: "foo" });
    assertEq(a.path, ".");
    assertEq(a.pattern, "foo");
  });

  s.test("parseToolArgs empty / bad JSON", () => {
    assertEq(Object.keys(parseToolArgs("")).length, 0);
    assertEq(Object.keys(parseToolArgs(undefined)).length, 0);
    const bad = parseToolArgs("{not json");
    assert("_raw" in bad);
  });

  s.test("stableJson key order independent", () => {
    assertEq(
      stableJson({ b: 1, a: 2 }),
      stableJson({ a: 2, b: 1 }),
    );
  });

  s.test("different tools different fingerprints", () => {
    assert(
      toolFingerprint("list_dir", {}) !==
        toolFingerprint("read_file", { target_file: "x" }),
    );
  });

  s.test("catalog path aliases normalize to native fields", () => {
    const r = normalizeToolArgs("read_file", { path: "secret.txt" });
    assertEq(r.target_file, "secret.txt");
    assert(r.path == null, "path should be folded into target_file");

    const w = normalizeToolArgs("write_file", {
      path: "out.txt",
      content: "hi",
    });
    assertEq(w.file_path, "out.txt");

    const l = normalizeToolArgs("list_dir", { path: "creds" });
    assertEq(l.target_directory, "creds");

    const sh = normalizeToolArgs("run_shell", {
      command: "echo 1",
      timeout_s: 10,
    });
    assertEq(sh.timeout_ms, 10_000);
  });

  s.test("write_file and write share fingerprint", () => {
    const a = toolFingerprint("write", { file_path: "a.txt", content: "x" });
    const b = toolFingerprint("write_file", { path: "a.txt", content: "x" });
    assertEq(a, b);
  });

  s.test("run_terminal_command timeout → timeout_ms", () => {
    const n = normalizeToolArgs("run_terminal_command", {
      command: "echo",
      timeout: 45,
    });
    assertEq(n.timeout_ms, 45_000);
    assertEq(n.timeout, undefined);
  });

  return s;
}
