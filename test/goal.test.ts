/**
 * Goal loop unit tests — pure tracker, next-step, stop-detector, verdicts.
 * Drive shipped modules only (no re-implementation).
 *
 * Run: bun test/goal.test.ts
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  GoalTracker,
  extractFirstUnchecked,
  firstUncheckedPlanItem,
  matchedStopPattern,
  looksLikePrematureStop,
  aggregateSkepticVotes,
  gapFingerprint,
  parseSkepticVerdictBody,
  applyUpdateGoal,
  buildUpdateGoalSummary,
  parseUpdateGoalInput,
  isGoalTool,
  GOAL_TOOL_NAME,
  installPlanForTests,
  runPlanWriter,
  looksLikePlan,
  fallbackPlanMarkdown,
  mockVerifierSpawner,
  runVerifierPanel,
  maybeRunStrategist,
  GoalOrchestrator,
  runScriptedGoalLoop,
  isPausedStatus,
  GOAL_CLASSIFIER_STALL_THRESHOLD,
  resolveGoalSpawnerContext,
  rebindGoalSpawners,
  pauseGoalAwaitingAuth,
  prepareGoalContinue,
  goalCreateStatusSuffix,
  inspectSpawners,
  activePhaseLabel,
  statusLine,
  footerGoalChip,
  statusDisplayLabel,
  humanizeGoalEvent,
  formatGoalDetailCard,
  formatElapsed,
  goalChromeTone,
  buildDisplaySnapshot,
  sanitizePlanMarkdown,
  planBlock,
  goalRulesPrompt,
} from "../src/agent/goal/index.js";
import { getSlashCommand, SLASH_COMMANDS } from "../src/complete/commands.js";
import { OPENAI_TOOLS } from "../src/toolcalling/schema.js";
import { createDefaultRegistry } from "../src/toolcalling/registry.js";
import { ToolExecutor } from "../src/toolcalling/executor.js";

const SCRATCH =
  process.env.GROK_GOAL_SCRATCH ??
  join(tmpdir(), "grok-goal-16bb0c4ddf60", "implementer");

function freshSessionDir(label: string): string {
  const dir = join(
    tmpdir(),
    `libra-goal-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Tracker state machine ─────────────────────────────

function testTrackerTransitions(): void {
  const dir = freshSessionDir("tracker");
  const t = new GoalTracker(dir);
  assert.equal(t.hasGoal(), false);
  assert.equal(t.isActive(), false);

  const o = t.createGoal({ objective: "ship feature X" });
  assert.equal(o.status, "active");
  assert.equal(t.isActive(), true);
  assert.equal(t.objective(), "ship feature X");
  assert.ok(t.verifierId()?.length === 12);
  assert.equal(t.lastHistory()?.event, "goal_created");

  assert.equal(t.pause("user"), true);
  assert.equal(t.status(), "user_paused");
  assert.equal(t.isActive(), false);
  assert.ok(isPausedStatus(t.status()!));

  // pause while already paused → no-op
  assert.equal(t.pause("user"), false);

  assert.equal(t.resume(), true);
  assert.equal(t.status(), "active");
  assert.equal(t.lastHistory()?.event, "goal_resumed");

  assert.equal(t.pauseWithMessage("verification", "missing SDK"), true);
  assert.equal(t.status(), "blocked");
  assert.equal(t.snapshotMut()?.pause_message, "missing SDK");

  assert.equal(t.resume(), true);
  assert.equal(t.snapshotMut()?.pause_message, null);

  assert.equal(t.complete(), true);
  assert.equal(t.status(), "complete");
  assert.equal(t.phase(), "idle");
  assert.equal(t.complete(), false); // already terminal

  // New goal after complete
  t.createGoal({ objective: "another" });
  assert.equal(t.budgetLimit(), true);
  assert.equal(t.status(), "budget_limited");

  t.createGoal({ objective: "clear me" });
  t.clear();
  assert.equal(t.hasGoal(), false);

  // Stall detection
  t.createGoal({ objective: "stall test", classifierMaxRuns: 5 });
  const fp = "abc:2";
  assert.equal(t.recordClassifierStall(fp), false); // count=1
  assert.equal(
    t.recordClassifierStall(fp),
    GOAL_CLASSIFIER_STALL_THRESHOLD <= 2,
  ); // count=2 → stall

  // Different fingerprint resets
  t.resetClassifierStall();
  assert.equal(t.recordClassifierStall("x"), false);
  assert.equal(t.recordClassifierStall("y"), false);

  // Cap reservation
  t.createGoal({ objective: "cap", classifierMaxRuns: 2 });
  assert.equal(t.reserveClassifierAttempt(), true);
  assert.equal(t.reserveClassifierAttempt(), true);
  assert.equal(t.reserveClassifierAttempt(), false);
  t.rollbackClassifierAttempt();
  assert.equal(t.reserveClassifierAttempt(), true);

  // from_snapshot safety: active executing → user_paused
  t.createGoal({ objective: "snap" });
  t.setPhase("executing");
  const snap = t.snapshot()!;
  const restored = GoalTracker.fromSnapshot(dir, snap);
  assert.equal(restored.status(), "user_paused");
  assert.equal(restored.phase(), "idle");

  rmSync(dir, { recursive: true, force: true });
  console.log("ok tracker transitions");
}

// ── Next-step checklist mining ────────────────────────

function testNextStep(): void {
  // With Task checklist — only that section
  const body = `# Plan
## Acceptance criteria
1. app works
## Task checklist
- [x] scaffold
- [ ] wire input handling
## Notes
- [ ] stray box elsewhere
`;
  assert.equal(extractFirstUnchecked(body), "wire input handling");

  const done = `## Task checklist
- [x] scaffold
## Notes
- [ ] stray box
`;
  assert.equal(extractFirstUnchecked(done), null);

  // Subheaders stay in checklist
  const sub = `## Task checklist
### Phase 1
- [x] done
### Phase 2
- [ ] phase two step
## Notes
- [ ] stray
`;
  assert.equal(extractFirstUnchecked(sub), "phase two step");

  // Without checklist — exclude non-goals
  const noCl = `# Plan
- [x] a
- [ ] b step
## Non-goals
- [ ] never mine
`;
  assert.equal(extractFirstUnchecked(noCl), "b step");

  // Numbered acceptance criteria are NOT mined
  const numbered = `## Acceptance criteria
1. app is created
2. physics works
`;
  assert.equal(extractFirstUnchecked(numbered), null);

  // File path
  const dir = freshSessionDir("next");
  const plan = join(dir, "plan.md");
  writeFileSync(plan, body, "utf8");
  assert.equal(
    firstUncheckedPlanItem(plan, { isPath: true }),
    "wire input handling",
  );
  rmSync(dir, { recursive: true, force: true });
  console.log("ok next-step mining");
}

// ── Stop detector ─────────────────────────────────────

function testStopDetector(): void {
  assert.equal(
    matchedStopPattern("I can't proceed."),
    "unable_to_proceed",
  );
  assert.equal(matchedStopPattern("Giving up."), "giving_up");
  assert.equal(matchedStopPattern("Stopping here."), "stopping_here");
  assert.equal(
    matchedStopPattern("3 agents in flight."),
    "agents_in_flight",
  );
  assert.equal(matchedStopPattern("VERDICT: PASS"), "verdict_line");
  assert.equal(
    matchedStopPattern("Ready for review"),
    "ready_for_review",
  );
  assert.equal(
    matchedStopPattern("Please run the install for me"),
    "please_deflection",
  );

  // Mid-paragraph earlier text ignored — only last paragraph
  assert.equal(
    matchedStopPattern("Giving up.\n\nActually I fixed it and will continue."),
    null,
  );

  // In-word
  assert.equal(matchedStopPattern("Stopping hereafter we ship"), null);

  assert.ok(looksLikePrematureStop("I cannot continue."));
  assert.ok(!looksLikePrematureStop("Implemented the parser and tests pass."));
  console.log("ok stop-detector");
}

// ── Verdict aggregation ───────────────────────────────

function testVerdicts(): void {
  const achieved = aggregateSkepticVotes([
    { idx: 0, refuted: false, gaps: [] },
    { idx: 1, refuted: false, gaps: [] },
  ]);
  assert.equal(achieved.verdict, "achieved");
  assert.equal(achieved.gaps.length, 0);

  const notA = aggregateSkepticVotes([
    { idx: 0, refuted: false, gaps: [] },
    { idx: 1, refuted: true, gaps: ["missing test for parse()"] },
  ]);
  assert.equal(notA.verdict, "not_achieved");
  assert.ok(notA.gaps.some((g) => g.includes("parse")));
  assert.ok(notA.fingerprint.length > 0);

  // Fail-closed empty panel
  const empty = aggregateSkepticVotes([]);
  assert.equal(empty.verdict, "not_achieved");

  // Same gaps → same fingerprint
  const fp1 = gapFingerprint(["A gap", "B gap"]);
  const fp2 = gapFingerprint(["b gap", "a gap"]);
  assert.equal(fp1, fp2);

  const vote = parseSkepticVerdictBody(
    "refuted: true\n\n## Gaps\n- no evidence\n- flaky launch\n",
  );
  assert.equal(vote.refuted, true);
  assert.equal(vote.gaps.length, 2);

  const pass = parseSkepticVerdictBody("refuted: false\n\n## Gaps\n- (none)\n");
  assert.equal(pass.refuted, false);
  console.log("ok verdict aggregation");
}

// ── Progress tool ─────────────────────────────────────

function testProgressTool(): void {
  assert.ok(isGoalTool("update_goal"));
  assert.ok(isGoalTool("updateGoal"));
  assert.equal(GOAL_TOOL_NAME, "update_goal");

  const dir = freshSessionDir("progress");
  const t = new GoalTracker(dir);
  t.createGoal({ objective: "prog" });

  const prog = applyUpdateGoal(t, { message: "halfway" });
  assert.equal(prog.kind, "progress");
  assert.ok(buildUpdateGoalSummary({ message: "x" }).includes("Progress"));

  const queued = applyUpdateGoal(t, {
    completed: true,
    message: "all done",
  });
  assert.equal(queued.kind, "completed_queued");
  // Must NOT complete on claim alone
  assert.equal(t.status(), "active");

  const blocked = applyUpdateGoal(t, {
    blocked_reason: "no windows sdk",
  });
  assert.equal(blocked.kind, "blocked");
  assert.equal(t.status(), "blocked");

  const rejected = applyUpdateGoal(t, { completed: true });
  assert.equal(rejected.kind, "rejected");

  const input = parseUpdateGoalInput({
    completed: true,
    message: "hi",
    blocked_reason: null,
  });
  assert.equal(input.completed, true);
  assert.equal(input.message, "hi");

  rmSync(dir, { recursive: true, force: true });
  console.log("ok progress tool");
}

// ── Plan writer fail-closed ───────────────────────────

async function testPlanWriter(): Promise<void> {
  const dir = freshSessionDir("plan");
  const t = new GoalTracker(dir);
  t.createGoal({ objective: "add helper" });

  const good = `# Plan: helper
## Goal kind
code-change
## Acceptance criteria
1. helper exists
## Verification plan
1. gating: run unit test
## Non-goals
- polish
## Task checklist
- [ ] write helper
`;
  assert.ok(looksLikePlan(good));
  assert.ok(!looksLikePlan("not a plan"));

  const r = await runPlanWriter(
    t,
    async ({ planPath }) => {
      writeFileSync(planPath, good, "utf8");
      return { ok: true, body: good };
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.fallback, false);
  assert.ok(existsSync(r.planPath));
  assert.ok(t.snapshotMut()?.plan_file);
  assert.ok(t.snapshotMut()?.plan_baseline_file);

  // Empty spawner → fallback
  const t2 = new GoalTracker(freshSessionDir("plan2"));
  t2.createGoal({ objective: "fallback case" });
  const r2 = await runPlanWriter(t2, async () => ({ ok: false, error: "boom" }), {
    allowFallback: true,
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.fallback, true);
  assert.ok(looksLikePlan(r2.body!));

  // Fail-closed no fallback
  const t3 = new GoalTracker(freshSessionDir("plan3"));
  t3.createGoal({ objective: "abort" });
  const r3 = await runPlanWriter(
    t3,
    async () => ({ ok: false, error: "empty" }),
    { allowFallback: false },
  );
  assert.equal(r3.ok, false);
  assert.ok(isPausedStatus(t3.status()!));

  assert.ok(fallbackPlanMarkdown("x").includes("Acceptance criteria"));
  rmSync(dir, { recursive: true, force: true });
  console.log("ok plan writer");
}

// ── Verifier panel + strategist ───────────────────────

async function testVerifierAndStrategist(): Promise<void> {
  const dir = freshSessionDir("verify");
  const t = new GoalTracker(dir);
  t.createGoal({ objective: "verify me", classifierMaxRuns: 6 });
  installPlanForTests(
    t,
    fallbackPlanMarkdown("verify me"),
  );

  // NotAchieved first
  const panel1 = await runVerifierPanel(t, {
    panelSize: 2,
    finalResponse: "I think I'm done",
    spawner: mockVerifierSpawner((idx) => ({
      idx,
      refuted: true,
      gaps: ["missing unit test for helper"],
    })),
  });
  assert.ok(panel1);
  assert.equal(panel1!.aggregate.verdict, "not_achieved");

  const applied = t.applyVerifierResult({
    verdict: panel1!.aggregate.verdict,
    gapsSummary: panel1!.aggregate.gapsSummary,
    detailsPath: panel1!.detailsPath,
    fingerprint: panel1!.aggregate.fingerprint,
  });
  assert.equal(applied.stalled, false);
  assert.equal(t.snapshotMut()?.consecutive_not_achieved, 1);

  // Second identical NotAchieved → streak 2 → strategist
  t.recordNotAchievedStreak();
  const strat = await maybeRunStrategist(t, null, { force: true });
  assert.equal(strat.fired, true);
  assert.ok(strat.strategyPath && existsSync(strat.strategyPath));
  assert.ok(t.snapshotMut()?.last_strategy_recommendation);

  // Achieved panel
  const panel2 = await runVerifierPanel(t, {
    panelSize: 2,
    spawner: mockVerifierSpawner(() => ({
      idx: 0,
      refuted: false,
      gaps: [],
    })),
  });
  assert.ok(panel2);
  assert.equal(panel2!.aggregate.verdict, "achieved");
  t.applyVerifierResult({
    verdict: "achieved",
    gapsSummary: null,
    detailsPath: panel2!.detailsPath,
    fingerprint: "",
  });
  assert.equal(t.complete(), true);

  rmSync(dir, { recursive: true, force: true });
  console.log("ok verifier + strategist");
}

// ── Scripted full loop ────────────────────────────────

async function testScriptedLoop(): Promise<void> {
  const dir = freshSessionDir("loop");
  const planBody = `# Plan: scripted
## Goal kind
code-change
## Acceptance criteria
1. helper exists and is tested
## Verification plan
1. gating: unit test passes; capture to \`{SCRATCH}/out.log\`
## Non-goals
- extra features
## Task checklist
- [ ] implement helper
- [ ] add test
`;

  const result = await runScriptedGoalLoop({
    sessionDir: dir,
    objective: "add a one-file helper with test",
    planBody,
    turns: [
      {
        finalText: "Started work on helper.",
        updateGoal: { message: "scaffold done" },
      },
      {
        finalText: "Claiming done too early.",
        updateGoal: { completed: true, message: "done v1" },
      },
      {
        finalText: "Fixed gaps and re-claiming.",
        updateGoal: { completed: true, message: "done v2" },
      },
    ],
    // First completion claim → NotAchieved; second → Achieved
    verifierVotes: [
      [
        { refuted: true, gaps: ["no test file"] },
        { refuted: true, gaps: ["no test file"] },
      ],
      [
        { refuted: false, gaps: [] },
        { refuted: false, gaps: [] },
      ],
    ],
  });

  assert.ok(result.planPath && existsSync(result.planPath));
  assert.equal(result.finalStatus, "complete");
  const actions = result.decisions.map((d) => d.action);
  assert.ok(actions.includes("continue"), `expected continue, got ${actions}`);
  assert.ok(actions.includes("complete"), `expected complete, got ${actions}`);

  // Pause / resume / clear path
  const orch = new GoalOrchestrator({
    sessionDir: freshSessionDir("prc"),
    planSpawner: async ({ planPath }) => {
      writeFileSync(planPath, planBody, "utf8");
      return { ok: true, body: planBody };
    },
    verifierSpawner: mockVerifierSpawner(() => ({
      idx: 0,
      refuted: false,
      gaps: [],
    })),
    persist: true,
  });
  await orch.createGoal("pause path");
  assert.equal(orch.isActive(), true);
  assert.equal(orch.pause("user"), true);
  assert.equal(orch.isActive(), false);
  assert.equal(orch.resume(), true);
  assert.equal(orch.isActive(), true);
  orch.clear();
  assert.equal(orch.hasGoal(), false);

  // Double-run consistency
  const r2 = await runScriptedGoalLoop({
    sessionDir: freshSessionDir("loop2"),
    objective: "add a one-file helper with test",
    planBody,
    turns: [
      {
        finalText: "done",
        updateGoal: { completed: true, message: "ship" },
      },
    ],
    verifierVotes: [
      [
        { refuted: false, gaps: [] },
        { refuted: false, gaps: [] },
      ],
    ],
  });
  assert.equal(r2.finalStatus, "complete");

  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(
    join(SCRATCH, "goal-loop.log"),
    [
      "=== run 1 ===",
      ...result.logs,
      `final=${result.finalStatus}`,
      "=== run 2 ===",
      ...r2.logs,
      `final=${r2.finalStatus}`,
      "PASS",
    ].join("\n"),
    "utf8",
  );

  rmSync(dir, { recursive: true, force: true });
  console.log("ok scripted goal loop (×2)");
}

// ── No-auth create → login rebind → resume starts loop ─

async function testNoAuthThenResumeRebind(): Promise<void> {
  const dir = freshSessionDir("noauth");
  // Simulate unauthed create: null plan spawner → fallback plan; structural verifier
  const orch = new GoalOrchestrator({
    sessionDir: dir,
    planSpawner: null,
    verifierSpawner: null,
    strategistSpawner: null,
    persist: true,
  });
  rebindGoalSpawners(orch, null);
  assert.equal(inspectSpawners(orch).plan, false);
  assert.equal(inspectSpawners(orch).strategist, false);

  const created = await orch.createGoal("add helper after login");
  assert.equal(created.ok, true);
  assert.equal(orch.isActive(), true);

  // Auth gate: pause so /goal resume is the documented path
  const paused = pauseGoalAwaitingAuth(orch);
  assert.equal(paused.paused, true);
  assert.equal(orch.isActive(), false);
  assert.equal(orch.tracker.status(), "user_paused");

  // Status suffix must NOT claim loop is entering when unauthed
  const suffixNoAuth = goalCreateStatusSuffix({
    createdOk: true,
    hasAuth: false,
  });
  assert.ok(
    /paused awaiting auth|resume/i.test(suffixNoAuth),
    `expected awaiting-auth copy, got: ${suffixNoAuth}`,
  );
  assert.ok(
    !/Entering autonomous execute/i.test(suffixNoAuth),
    "must not claim loop started without auth",
  );
  const suffixAuth = goalCreateStatusSuffix({
    createdOk: true,
    hasAuth: true,
  });
  assert.ok(/Entering autonomous execute/i.test(suffixAuth));

  // "Login": resolve ctx + prepareGoalContinue rebinds LLM spawners and resumes
  const unauthedCtx = resolveGoalSpawnerContext({
    provider: "openai",
    model: "unset",
    hasToken: false,
  });
  assert.equal(unauthedCtx, null);

  const authedCtx = resolveGoalSpawnerContext({
    provider: "openai",
    model: "gpt-4.1",
    hasToken: true,
  });
  assert.ok(authedCtx);
  assert.equal(authedCtx!.model, "gpt-4.1");

  const prep = prepareGoalContinue(orch, {
    provider: "openai",
    model: "gpt-4.1",
    hasToken: true,
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.shouldStartLoop, true);
  assert.equal(orch.isActive(), true);
  assert.equal(prep.rebound.hasLlmPlan, true);
  assert.equal(prep.rebound.hasLlmStrategist, true);
  assert.equal(inspectSpawners(orch).plan, true);
  assert.equal(inspectSpawners(orch).strategist, true);
  assert.equal(inspectSpawners(orch).verifier, true);
  const presenceAfterLogin = inspectSpawners(orch);

  // Already-active path: rebind + shouldStartLoop (no dead-end)
  const prepActive = prepareGoalContinue(orch, {
    provider: "openai",
    model: "gpt-4.1",
    hasToken: true,
  });
  assert.equal(prepActive.ok, true);
  assert.equal(prepActive.shouldStartLoop, true);

  // Resume without auth stays paused / no loop
  orch.pause("user", "test");
  const prepNoAuth = prepareGoalContinue(orch, {
    provider: "none",
    model: "unset",
    hasToken: false,
  });
  assert.equal(prepNoAuth.ok, false);
  assert.equal(prepNoAuth.shouldStartLoop, false);
  assert.equal(prepNoAuth.rebound.hasLlmPlan, false);
  assert.equal(inspectSpawners(orch).plan, false);

  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(
    join(SCRATCH, "goal-auth-rebind.log"),
    [
      "no-auth create → pause awaiting auth",
      "status_after_pause=user_paused",
      `suffix_no_auth=${suffixNoAuth.trim()}`,
      "login rebind → shouldStartLoop + LLM plan/strategist spawners",
      `presence_after_login=${JSON.stringify(presenceAfterLogin)}`,
      `presence_after_unauth_rebind=${JSON.stringify(inspectSpawners(orch))}`,
      "PASS",
    ].join("\n"),
    "utf8",
  );

  rmSync(dir, { recursive: true, force: true });
  console.log("ok no-auth → resume rebind");
}

// ── Display polish (grok-parity labels / chip / card) ──

function testDisplayPolish(): void {
  assert.equal(statusDisplayLabel("user_paused"), "Paused");
  assert.equal(statusDisplayLabel("back_off_paused"), "Back-off");
  assert.equal(statusDisplayLabel("no_progress_paused"), "No progress");
  assert.equal(statusDisplayLabel("blocked"), "Blocked");
  assert.equal(statusDisplayLabel("complete"), "Complete");

  assert.equal(
    activePhaseLabel({ verifying: true, verifyAttempted: 2, verifyCap: 8 }),
    "Verifying (2/8)",
  );
  assert.equal(activePhaseLabel({ planning: true }), "Planning");
  assert.equal(activePhaseLabel({ phase: "executing" }), "Executing");
  // verifying wins over planning
  assert.equal(
    activePhaseLabel({ verifying: true, planning: true, verifyAttempted: 1, verifyCap: 3 }),
    "Verifying (1/3)",
  );

  const snap = {
    objective: "ship X",
    status: "active" as const,
    phase: "executing" as const,
    goalId: "g1",
    elapsedMs: 125_000,
    workerRounds: 3,
    verifyAttempted: 1,
    verifyCap: 8,
    planning: false,
    verifying: false,
    pauseMessage: null,
    lastVerdict: null,
    nextStep: "wire input",
    planPath: "/tmp/plan.md",
    scratchPath: null,
    progressNote: null,
  };
  assert.equal(statusLine(snap), "Active — Executing");
  assert.ok(footerGoalChip(snap).includes("Goal:"));
  assert.ok(footerGoalChip(snap).includes("Executing"));
  assert.ok(formatElapsed(125_000).includes("m"));

  assert.equal(humanizeGoalEvent("goal_paused", "back_off"), "Paused: back_off");
  assert.equal(
    humanizeGoalEvent("verification_completed", "not_achieved"),
    "Verification: NotAchieved",
  );
  assert.equal(goalChromeTone("active"), "active");
  assert.equal(goalChromeTone("blocked"), "error");
  assert.equal(goalChromeTone("complete"), "done");

  // Detail card from real tracker
  const dir = freshSessionDir("display");
  const t = new GoalTracker(dir);
  t.createGoal({ objective: "polish goal UI" });
  installPlanForTests(
    t,
    `# Plan\n## Acceptance criteria\n1. x\n## Verification plan\n1. y\n## Task checklist\n- [ ] first step\n`,
  );
  const card = formatGoalDetailCard(t.snapshotMut()!, {
    verifyCap: t.effectiveClassifierCap(),
    nextStep: "first step",
  });
  assert.ok(card.includes("### Goal"));
  assert.ok(card.includes("Active"));
  assert.ok(card.includes("first step"));
  assert.ok(card.includes("/goal pause"));

  const built = buildDisplaySnapshot(t.snapshotMut()!);
  assert.equal(built.status, "active");

  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(
    join(SCRATCH, "goal-display-polish.log"),
    [
      statusLine(snap),
      footerGoalChip(snap),
      activePhaseLabel({ verifying: true, verifyAttempted: 2, verifyCap: 8 }),
      "PASS",
    ].join("\n"),
    "utf8",
  );
  rmSync(dir, { recursive: true, force: true });
  console.log("ok display polish");
}

// ── Surface checks ────────────────────────────────────

async function testSurface(): Promise<void> {
  const goal = getSlashCommand("goal");
  assert.ok(goal, "/goal must be in slash catalog");
  assert.equal(goal!.name, "goal");
  const actions = goal!.params?.[0]?.values?.map((v) => v.value) ?? [];
  assert.ok(actions.includes("status"));
  assert.ok(actions.includes("pause"));
  assert.ok(actions.includes("resume"));
  assert.ok(actions.includes("clear"));

  assert.ok(SLASH_COMMANDS.some((c) => c.name === "goal"));

  const schemaNames = OPENAI_TOOLS.map((t) => t.function.name);
  assert.ok(schemaNames.includes("update_goal"));

  const reg = createDefaultRegistry();
  assert.ok(
    reg.schemas().some((t) => t.function.name === "update_goal"),
    "update_goal registered in default tool registry",
  );

  // Prompt templates name defining behaviors (imported at top via index)
  const {
    plannerSystemPrompt,
    verifierSystemPrompt,
    strategistSystemPrompt,
  } = await import("../src/agent/goal/prompts.js");
  const planP = plannerSystemPrompt("/tmp/plan.md");
  assert.ok(/fail-closed|Acceptance criteria|Verification plan/i.test(planP));
  const verP = verifierSystemPrompt({
    objective: "x",
    planFile: "p",
    implementerScratch: "i",
    skepticScratch: "s",
    detailsFile: "d",
    verdictFile: "v",
    priorGaps: "",
    finalResponse: "",
  });
  assert.ok(/adversarial|refute/i.test(verP));
  const stP = strategistSystemPrompt({
    objective: "x",
    planFile: "p",
    strategyFile: "s",
    gaps: "g",
    streak: 2,
  });
  assert.ok(/advisory|acceptance criteria/i.test(stP));

  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(
    join(SCRATCH, "goal-surface.txt"),
    [
      "slash: /goal status|pause|resume|clear",
      "tool: update_goal",
      "roles: plan-writer, verifier (adversarial), strategist (advisory)",
      "behaviors: fail-closed plan, verify-before-complete, strategist-on-stall",
    ].join("\n"),
    "utf8",
  );
  console.log("ok surface checks");
}

// ── Plan sandbox + sanitize + kickoff (BOMBA session fixes) ─

async function testPlanPathAllowlistAndSanitize(): Promise<void> {
  // 1) DSML / tool-call leakage stripped (BOMBA plan.md corruption)
  const junk =
    `# Plan: test\n\n## Acceptance criteria\n1. works\n\n## Verification plan\n1. gating: check\n\n## Non-goals\n- x\n\n## Task checklist\n- [ ] do it\n` +
    `</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>\n</\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>`;
  const clean = sanitizePlanMarkdown(junk);
  assert.ok(looksLikePlan(clean));
  assert.ok(!/DSML/i.test(clean));
  assert.ok(!/tool_calls/i.test(clean));
  assert.ok(!/\uFF5C/.test(clean));

  // 2) runPlanWriter sanitizes body before write
  const sessionDir = freshSessionDir("sanitize-write");
  const t = new GoalTracker(sessionDir);
  t.createGoal({ objective: "clean plan" });
  const r = await runPlanWriter(t, async () => ({ ok: true, body: junk }));
  assert.equal(r.ok, true);
  const onDisk = readFileSync(r.planPath, "utf8");
  assert.ok(!/DSML/i.test(onDisk));
  assert.ok(looksLikePlan(onDisk));

  // 3) ToolExecutor allows goal dir + scratch outside project cwd
  const projectCwd = freshSessionDir("project-cwd");
  const goalRoot = join(sessionDir, "goal");
  const scratchRoot = join(tmpdir(), `libra-goal-allow-${Date.now()}`);
  mkdirSync(scratchRoot, { recursive: true });
  writeFileSync(join(goalRoot, "probe.txt"), "plan-ok", "utf8");
  writeFileSync(join(scratchRoot, "evidence.txt"), "scratch-ok", "utf8");

  const blocked = new ToolExecutor(projectCwd);
  const blockedRes = await blocked.run("read_file", {
    target_file: join(goalRoot, "probe.txt"),
  });
  assert.equal(blockedRes.ok, false);
  assert.ok(
    /escapes workspace|path_escape/i.test(
      blockedRes.output + (blockedRes.code ?? ""),
    ),
    `expected path escape, got: ${blockedRes.output}`,
  );

  const allowed = new ToolExecutor(projectCwd, {
    allowedRoots: [goalRoot, scratchRoot],
  });
  const planRead = await allowed.run("read_file", {
    target_file: join(goalRoot, "probe.txt"),
  });
  assert.equal(planRead.ok, true, planRead.output);
  assert.ok(/plan-ok/.test(planRead.output));

  const scratchWrite = await allowed.run("write", {
    file_path: join(scratchRoot, "from-tool.txt"),
    content: "evidence",
  });
  assert.equal(scratchWrite.ok, true, scratchWrite.output);
  assert.equal(
    readFileSync(join(scratchRoot, "from-tool.txt"), "utf8"),
    "evidence",
  );

  // 4) Orchestrator roots + kickoff embeds plan (no "read path only")
  const orch = new GoalOrchestrator({
    sessionDir,
    planSpawner: async ({ planPath }) => {
      writeFileSync(planPath, onDisk, "utf8");
      return { ok: true, body: onDisk };
    },
    persist: false,
  });
  // Goal already created on tracker above — use fresh orch with create
  const orch2 = new GoalOrchestrator({
    sessionDir: freshSessionDir("kickoff"),
    planSpawner: async ({ planPath }) => {
      const body = `# Plan: kick\n## Acceptance criteria\n1. city renders\n## Verification plan\n1. gating: sample canvas pixels to {SCRATCH}/px.txt\n## Task checklist\n- [ ] create main.js\n`;
      writeFileSync(planPath, body, "utf8");
      return { ok: true, body };
    },
    persist: false,
  });
  await orch2.createGoal("take bomba sim to next level");
  const roots = orch2.toolAllowedRoots();
  assert.ok(roots.some((r) => /goal$/i.test(r) || r.includes("goal")));
  assert.ok(roots.some((r) => /grok-goal-/i.test(r)));
  const kick = orch2.buildKickoffPrompt();
  assert.ok(kick.includes("<goal-plan>"));
  assert.ok(kick.includes("city renders") || kick.includes("Acceptance criteria"));
  assert.ok(kick.includes("Plan path"));

  const addon = orch2.buildGoalSystemAddon();
  assert.ok(/VISUAL PROOF|programmatic checks/i.test(addon));
  assert.ok(/Never narrate|screenshot/i.test(addon));
  assert.ok(addon.includes("<goal-plan>"));

  // planBlock embeds body
  const pb = planBlock("/tmp/p.md", "## Acceptance criteria\n1. x\n");
  assert.ok(pb.includes("<goal-plan>"));
  assert.ok(pb.includes("1. x"));

  // Visual discipline in rules
  const rules = goalRulesPrompt({
    objective: "ui",
    planBlock: pb,
    scratchDir: scratchRoot,
    scratchReady: true,
  });
  assert.ok(/VISUAL PROOF/i.test(rules));
  assert.ok(!/If output is visual, capture and inspect it/i.test(rules));

  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(
    join(SCRATCH, "goal-plan-access.log"),
    [
      "sanitize: stripped DSML from plan",
      "allowlist: plan+scratch readable outside cwd",
      "kickoff: plan body inlined",
      "prompts: visual proof prefers metrics not screenshots",
      "PASS",
    ].join("\n"),
    "utf8",
  );

  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(projectCwd, { recursive: true, force: true });
  rmSync(scratchRoot, { recursive: true, force: true });
  void orch;
  console.log("ok plan path allowlist + sanitize + kickoff");
}

async function main(): Promise<void> {
  mkdirSync(SCRATCH, { recursive: true });
  const log: string[] = [];
  const run = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      log.push(`PASS ${name}`);
    } catch (e) {
      log.push(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
      throw e;
    }
  };

  await run("tracker", testTrackerTransitions);
  await run("next-step", testNextStep);
  await run("stop-detector", testStopDetector);
  await run("verdicts", testVerdicts);
  await run("progress-tool", testProgressTool);
  await run("plan-writer", testPlanWriter);
  await run("verifier-strategist", testVerifierAndStrategist);
  await run("scripted-loop", testScriptedLoop);
  await run("no-auth-resume-rebind", testNoAuthThenResumeRebind);
  await run("display-polish", testDisplayPolish);
  await run("surface", testSurface);
  await run(
    "plan-access-sanitize",
    testPlanPathAllowlistAndSanitize,
  );

  try {
    writeFileSync(join(SCRATCH, "goal-unit.log"), log.join("\n") + "\n", "utf8");
  } catch {
    writeFileSync(
      join(SCRATCH, "goal-unit-final.log"),
      log.join("\n") + "\n",
      "utf8",
    );
  }
  console.log("\nAll goal unit tests passed.");
  console.log(`Logs: ${SCRATCH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
