/**
 * Debug logger suite — ensure instrumentation API works.
 */

import {
  dbg,
  getDebugLogPath,
  initDebug,
  isDebug,
  modelTag,
  span,
} from "../../../src/agent/debug.js";
import { Suite, assert, assertEq, assertIncludes } from "../runner.js";

export function suiteDebug(): Suite {
  const s = new Suite("debug");

  s.test("initDebug info enables logging", () => {
    initDebug("info");
    assert(isDebug());
    dbg("bench", "ping", { n: 1 });
    const path = getDebugLogPath();
    assert(path != null && path.length > 0, "log path");
    return { path };
  });

  s.test("span start/end", () => {
    const s1 = span("bench", "work", { x: 1 });
    s1.mark("mid");
    const ms = s1.end({ ok: true });
    assert(typeof ms === "number" && ms >= 0);
  });

  s.test("modelTag", () => {
    assertEq(modelTag("openrouter", "tencent/hy3:free"), "openrouter/tencent/hy3:free");
  });

  s.test("off level silences", () => {
    initDebug("off");
    assertEq(isDebug(), false);
    dbg("bench", "should-not-matter");
    // re-enable for later live suites if any
    if (process.env.LIBRA_DEBUG) initDebug();
  });

  return s;
}
