/**
 * Offline tests for fusion-local suite runner pieces (parse, hard checks, calc).
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  loadSuite,
  loadCase,
  parseSimpleYaml,
} from "../fusion-local/parse.js";
import { runHardChecks } from "../fusion-local/hard-checks.js";
import { evalMath } from "../../../src/toolcalling/executor.js";
import { Suite, assert, assertEq } from "../runner.js";

const SUITE_PATH =
  "C:\\Users\\rias\\Desktop\\fustion benchmarks\\suite.yaml";

export function suiteFusionLocal(): Suite {
  const s = new Suite("fusion-local");

  s.test("yaml double-quote unescapes regex patterns", () => {
    const meta = parseSimpleYaml(`
hard_checks:
  - type: final_regex
    pattern: "\\\\b63\\\\b"
  - type: final_regex
    pattern: "^VALUE=\\\\d+$"
`);
    const checks = meta.hard_checks as Array<{ pattern: string }>;
    assertEq(checks[0]!.pattern, "\\b63\\b");
    assertEq(checks[1]!.pattern, "^VALUE=\\d+$");
    assert(new RegExp(checks[0]!.pattern).test("63"));
    assert(new RegExp(checks[1]!.pattern).test("VALUE=17"));
  });

  s.test("evalMath exact arithmetic", () => {
    assertEq(evalMath("(17+4)*3"), 63);
    assertEq(evalMath("(30+12)*2"), 84);
    assertEq(evalMath("24*5"), 120);
  });

  s.test("load suite + case 01", () => {
    if (!existsSync(SUITE_PATH)) {
      return { skipped: true };
    }
    const suite = loadSuite(SUITE_PATH);
    assertEq(suite.casePaths.length, 12);
    const c = loadCase(join(suite.root, suite.casePaths[0]!), suite.defaults);
    assertEq(c.id, "01-single-tool-call");
    assert(c.task.includes("secret"), "task should mention secret");
    assert(c.success_criteria.length > 0, "success criteria present");
    assert(
      !c.task.includes("alpha-42") || c.success_criteria.includes("alpha-42"),
      "golden should not be required in task alone",
    );
    return { id: c.id, hard: c.hard_checks.length };
  });

  s.test("hard final_regex after unescape", () => {
    if (!existsSync(SUITE_PATH)) return { skipped: true };
    const suite = loadSuite(SUITE_PATH);
    const c = loadCase(
      join(suite.root, "cases/02-tool-args-precision.md"),
      suite.defaults,
    );
    const hard = runHardChecks(
      c.hard_checks,
      [
        {
          turn: 1,
          id: "c1",
          name: "calc",
          arguments: { expression: "(17+4)*3" },
          result: { ok: true, value: 63 },
          duration_ms: 1,
        },
        {
          turn: 2,
          id: "c2",
          name: "finish",
          arguments: { answer: "63" },
          result: { ok: true, finished: true },
          duration_ms: 0,
        },
      ],
      "63",
      suite.root,
    );
    assert(hard.passed, JSON.stringify(hard.checks));
    return { checks: hard.checks.length };
  });

  return s;
}
