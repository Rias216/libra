/**
 * Run Fusion local harness suite (combined-harness.md).
 *
 *   npm run bench:fusion-local
 *   npx tsx scripts/benchmark-fusion-local.ts
 *   npx tsx scripts/benchmark-fusion-local.ts --only=01-single-tool-call
 *   npx tsx scripts/benchmark-fusion-local.ts --suite="C:/path/to/fustion benchmarks/suite.yaml"
 *   npx tsx scripts/benchmark-fusion-local.ts --no-judge
 *   npx tsx scripts/benchmark-fusion-local.ts --provider=xai --model=grok-4.5
 *
 * Agent + judge use xAI Grok by default (requires /login xai or XAI_API_KEY).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveToken } from "../src/auth/api-key.js";
import type { ProviderId } from "../src/auth/types.js";
import { resolveCatalogTools } from "../src/toolcalling/catalog.js";
import { initDebug, getDebugLogPath, isDebug } from "../src/agent/debug.js";
import {
  loadSuite,
  loadCase,
  extractAgentSystemPrompt,
  extractJudgeSystem,
  type CaseDef,
  type SuiteDef,
} from "./bench/fusion-local/parse.js";
import {
  prepareSandbox,
  workspaceSnapshot,
  writeJson,
  writeText,
} from "./bench/fusion-local/sandbox.js";
import { runHardChecks } from "./bench/fusion-local/hard-checks.js";
import {
  runHeadlessAgent,
  buildAgentUser,
} from "./bench/fusion-local/agent-loop.js";
import { runJudge, combineScores, type JudgeScore } from "./bench/fusion-local/judge.js";

const DEFAULT_SUITE = resolve(
  "C:\\Users\\rias\\Desktop\\fustion benchmarks\\suite.yaml",
);

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface CaseResult {
  case_id: string;
  status: string;
  hard: ReturnType<typeof runHardChecks>;
  judge: JudgeScore | null;
  combined_score: number;
  passed: boolean;
  turns: number;
  tool_calls: number;
  duration_ms: number;
  error?: string;
}

async function main(): Promise<void> {
  initDebug(process.env.LIBRA_DEBUG ? undefined : "info");

  const suitePath = resolve(arg("suite") ?? DEFAULT_SUITE);
  if (!existsSync(suitePath)) {
    console.error(`Suite not found: ${suitePath}`);
    process.exit(1);
  }

  const provider = (arg("provider") ?? "xai") as ProviderId;
  const model = arg("model") ?? process.env.LIBRA_GROK_MODEL ?? "grok-4.5";
  const judgeProvider = (arg("judge-provider") ?? provider) as ProviderId;
  const judgeModel =
    arg("judge-model") ?? model;
  const noJudge = hasFlag("no-judge");
  const onlyArg = arg("only");
  const only = onlyArg
    ? new Set(
        onlyArg.split(",").map((s) => s.trim()).filter(Boolean),
      )
    : null;

  if (!resolveToken(provider) && !process.env[`${provider.toUpperCase()}_API_KEY`] && !(provider === "xai" && process.env.XAI_API_KEY)) {
    // resolveToken already checks store; also check common env
    if (provider === "xai" && !resolveToken("xai") && !process.env.XAI_API_KEY) {
      console.error("No xAI credentials. /login xai or set XAI_API_KEY.");
      process.exit(1);
    }
    if (provider === "openrouter" && !resolveToken("openrouter") && !process.env.OPENROUTER_API_KEY) {
      console.error("No OpenRouter key.");
      process.exit(1);
    }
  }

  const suite = loadSuite(suitePath);
  const runsRoot = resolve(
    arg("out") ??
      join(homedir(), ".libra", "fusion-runs", new Date().toISOString().replace(/[:.]/g, "-")),
  );
  mkdirSync(runsRoot, { recursive: true });

  const agentSystem = extractAgentSystemPrompt(
    readFileSync(join(suite.root, "prompts", "headless-agent.md"), "utf8"),
  );
  const judgeSystem = extractJudgeSystem(
    readFileSync(join(suite.root, "judge", "system.md"), "utf8"),
  );

  console.log("═══ Fusion Local Harness (combined-harness) ═══\n");
  console.log(`Suite:   ${suite.suite} v${suite.version}`);
  console.log(`Root:    ${suite.root}`);
  console.log(`Agent:   ${provider}/${model}`);
  console.log(`Judge:   ${noJudge ? "(skipped)" : `${judgeProvider}/${judgeModel}`}`);
  console.log(`Runs:    ${runsRoot}`);
  if (isDebug()) console.log(`Debug:   ${getDebugLogPath()}`);
  console.log();

  const results: CaseResult[] = [];
  let cases = suite.casePaths.map((p) =>
    loadCase(join(suite.root, p), suite.defaults),
  );
  if (only) {
    cases = cases.filter(
      (c) => only.has(c.id) || [...only].some((o) => c.id.includes(o)),
    );
  }

  if (cases.length === 0) {
    console.error("No cases to run.");
    process.exit(2);
  }

  for (const caseDef of cases) {
    const r = await runOneCase({
      caseDef,
      suite,
      agentSystem,
      judgeSystem,
      provider,
      model,
      judgeProvider,
      judgeModel,
      noJudge,
      runsRoot,
    });
    results.push(r);
    const mark = r.passed ? "PASS" : "FAIL";
    const j = r.judge ? ` judge=${r.judge.score}` : "";
    console.log(
      `  [${mark}] ${r.case_id}  hard=${r.hard.passed ? "ok" : "no"}${j}  combined=${r.combined_score}  turns=${r.turns}  ${r.duration_ms}ms` +
        (r.error ? `  err=${r.error}` : ""),
    );
    if (!r.hard.passed) {
      for (const c of r.hard.checks.filter((x) => !x.passed)) {
        console.log(`         ↳ hard fail: ${c.type} ${c.detail}`);
      }
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const mean =
    results.length === 0
      ? 0
      : results.reduce((s, r) => s + r.combined_score, 0) / results.length;
  const hardPass = results.filter((r) => r.hard.passed).length;

  const summary = {
    suite: suite.suite,
    version: suite.version,
    started_at: new Date().toISOString(),
    model: `${provider}/${model}`,
    judge_model: noJudge ? null : `${judgeProvider}/${judgeModel}`,
    runs_root: runsRoot,
    cases: results.map((r) => ({
      id: r.case_id,
      passed: r.passed,
      combined_score: r.combined_score,
      hard_passed: r.hard.passed,
      judge_score: r.judge?.score ?? null,
      status: r.status,
      turns: r.turns,
      duration_ms: r.duration_ms,
    })),
    pass_rate: results.length ? passed / results.length : 0,
    hard_pass_rate: results.length ? hardPass / results.length : 0,
    mean_score: Math.round(mean * 1000) / 1000,
    passed,
    total: results.length,
  };

  writeJson(join(runsRoot, "suite_summary.json"), summary);

  // Also stash latest under ~/.libra/debug
  try {
    const debugDir = join(homedir(), ".libra", "debug");
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(
      join(debugDir, "bench-fusion-local-latest.json"),
      JSON.stringify(summary, null, 2) + "\n",
      "utf8",
    );
  } catch {
    /* */
  }

  console.log("\n─── Summary ───");
  console.log(
    `Passed ${passed}/${results.length} (hard ${hardPass}/${results.length})  mean combined=${summary.mean_score}`,
  );
  console.log(`Artifacts → ${runsRoot}`);
  console.log(`Summary  → ${join(runsRoot, "suite_summary.json")}`);

  process.exit(passed === results.length ? 0 : 1);
}

async function runOneCase(opts: {
  caseDef: CaseDef;
  suite: SuiteDef;
  agentSystem: string;
  judgeSystem: string;
  provider: ProviderId;
  model: string;
  judgeProvider: ProviderId;
  judgeModel: string;
  noJudge: boolean;
  runsRoot: string;
}): Promise<CaseResult> {
  const { caseDef, suite } = opts;
  process.stdout.write(`▶ ${caseDef.id} … `);

  const sandbox = prepareSandbox(opts.runsRoot, suite.root, caseDef);
  const tools = resolveCatalogTools(caseDef.tools);
  const toolNames = caseDef.tools.length
    ? caseDef.tools
    : tools.map((t) => t.function.name);

  const system =
    opts.agentSystem +
    `\n\nTools enabled for this case: ${toolNames.join(", ")}`;

  const user = buildAgentUser({
    task: caseDef.task,
    context: caseDef.context,
    constraints: caseDef.constraints,
    tools: toolNames,
  });

  const agent = await runHeadlessAgent({
    provider: opts.provider,
    model: opts.model,
    systemPrompt: system,
    userPrompt: user,
    tools,
    workspace: sandbox.workspace,
    maxTurns: caseDef.max_turns,
    timeoutS: caseDef.timeout_s,
    transcriptPath: join(sandbox.runRoot, "transcript.jsonl"),
    temperature: 0,
    label: caseDef.id,
  });

  writeJson(join(sandbox.runRoot, "tool_trace.json"), agent.trace);
  writeText(join(sandbox.runRoot, "final_answer.txt"), agent.finalAnswer);

  const hard = runHardChecks(
    caseDef.hard_checks,
    agent.trace,
    agent.finalAnswer,
    sandbox.workspace,
  );
  writeJson(join(sandbox.runRoot, "hard_checks.json"), hard);

  let judge: JudgeScore | null = null;
  if (!opts.noJudge) {
    try {
      judge = await runJudge({
        caseDef,
        hard,
        trace: agent.trace,
        finalAnswer: agent.finalAnswer,
        workspaceSnapshot: workspaceSnapshot(sandbox.workspace),
        agentModel: `${opts.provider}/${opts.model}`,
        turns: agent.turns,
        durationMs: agent.durationMs,
        agentStatus: agent.status,
        judgeSystem: opts.judgeSystem,
        provider: opts.judgeProvider,
        model: opts.judgeModel,
      });
      writeJson(join(sandbox.runRoot, "judge.json"), judge);
    } catch (e) {
      judge = {
        score: 0,
        pass: false,
        dimensions: {},
        rationale: e instanceof Error ? e.message : String(e),
        issues: ["judge_error"],
        highlights: [],
      };
      writeJson(join(sandbox.runRoot, "judge.json"), judge);
    }
  } else {
    // Offline mode: synthetic judge from hard rate
    const rate =
      hard.checks.length === 0
        ? 1
        : hard.checks.filter((c) => c.passed).length / hard.checks.length;
    judge = {
      score: Math.round(rate * 10),
      pass: hard.passed,
      dimensions: {},
      rationale: "no-judge mode: score derived from hard checks only",
      issues: hard.passed ? [] : ["hard_checks_failed"],
      highlights: [],
    };
  }

  const { combined_score, passed } = combineScores(
    hard,
    judge,
    caseDef.pass_threshold,
    suite.defaults.hard_weight,
    suite.defaults.judge_weight,
  );

  const result: CaseResult = {
    case_id: caseDef.id,
    status: agent.status,
    hard,
    judge,
    combined_score,
    passed,
    turns: agent.turns,
    tool_calls: agent.toolCalls,
    duration_ms: agent.durationMs,
    error: agent.error,
  };
  writeJson(join(sandbox.runRoot, "result.json"), result);
  console.log("done");
  return result;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
