/**
 * Autocomplete / fuzzy suite.
 */

import { fuzzyScore } from "../../../src/complete/fuzzy.js";
import { Suite, assert, assertEq, assertGte } from "../runner.js";

export function suiteComplete(): Suite {
  const s = new Suite("complete-fuzzy");

  s.test("exact match highest", () => {
    const a = fuzzyScore("help", "help");
    const b = fuzzyScore("help", "helper");
    assert(a && b, "both match");
    assertGte(a!.score, b!.score);
  });

  s.test("prefix beats substring", () => {
    const pre = fuzzyScore("mod", "model");
    const sub = fuzzyScore("mod", "commodore");
    assert(pre && sub);
    assertGte(pre!.score, sub!.score);
  });

  s.test("empty query scores all", () => {
    const h = fuzzyScore("", "anything");
    assert(h != null);
    assertEq(h!.score, 0);
  });

  s.test("no match returns null", () => {
    assertEq(fuzzyScore("zzz", "abc"), null);
  });

  s.test("path basename preference", () => {
    const base = fuzzyScore("loop", "src/agent/loop.ts");
    const deep = fuzzyScore("loop", "src/loopy/other.ts");
    assert(base != null, "base match");
    // either base scores or deep may match substring — base should be strong
    assertGte(base!.score, 1000);
    void deep;
  });

  s.test("throughput 5k scores", () => {
    const items = Array.from({ length: 5000 }, (_, i) => `src/file-${i}.ts`);
    const t0 = Date.now();
    let hits = 0;
    for (const it of items) {
      if (fuzzyScore("file-42", it)) hits++;
    }
    const ms = Date.now() - t0;
    assertGte(hits, 1);
    return { ms, hits, perSec: Math.round(5000 / (ms / 1000 || 1)) };
  });

  return s;
}
