/**
 * Comprehensive offline harness benchmarks.
 *
 * Suites:
 *   toolcalling · memory · store · llm-helpers · fusion · agent-loop
 *   complete-fuzzy · reasoning-config · debug
 *
 *   npm run bench:harness
 *   npx tsx scripts/benchmark-harness.ts
 *   npx tsx scripts/benchmark-harness.ts --only=toolcalling,memory
 *   npx tsx scripts/benchmark-harness.ts --json
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runSuites, printReport, type Suite } from "./bench/runner.js";
import { suiteTools } from "./bench/suites/tools.js";
import { suiteMemory } from "./bench/suites/memory.js";
import { suiteStore } from "./bench/suites/store.js";
import { suiteLlm } from "./bench/suites/llm.js";
import { suiteFusion } from "./bench/suites/fusion.js";
import { suiteAgent } from "./bench/suites/agent.js";
import { suiteComplete } from "./bench/suites/complete.js";
import { suiteReasoning } from "./bench/suites/reasoning.js";
import { suiteDebug } from "./bench/suites/debug.js";
import { suiteNormalize } from "./bench/suites/normalize.js";
import { suiteFusionLocal } from "./bench/suites/fusion-local.js";
import { suiteToolHarden } from "./bench/suites/tool-harden.js";
import { suiteSubagent } from "./bench/suites/subagent.js";

const ALL: Suite[] = [
  suiteTools(),
  suiteToolHarden(),
  suiteSubagent(),
  suiteNormalize(),
  suiteMemory(),
  suiteStore(),
  suiteLlm(),
  suiteFusion(),
  suiteFusionLocal(),
  suiteAgent(),
  suiteComplete(),
  suiteReasoning(),
  suiteDebug(),
];

async function main(): Promise<void> {
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg
    ? new Set(
        onlyArg
          .split("=")[1]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;

  const suites = only
    ? ALL.filter((s) => only.has(s.name))
    : ALL;

  if (suites.length === 0) {
    console.error(
      `No suites matched. Available: ${ALL.map((s) => s.name).join(", ")}`,
    );
    process.exit(2);
  }

  console.log("═══ Libra Harness Benchmarks (offline) ═══");
  console.log(`Suites: ${suites.map((s) => s.name).join(", ")}`);

  const report = await runSuites(suites);
  printReport(report);

  // Persist report
  try {
    const dir = join(homedir(), ".libra", "debug");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "bench-harness-latest.json");
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`\nReport → ${path}`);
  } catch {
    /* */
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(report.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
