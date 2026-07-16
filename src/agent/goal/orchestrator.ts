/**
 * Goal orchestrator — wires tracker, plan-writer, progress tool,
 * verifier panel, strategist, stop-detector, and continuation nudges.
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GoalTracker } from "./tracker.js";
import {
  firstUncheckedPlanItem,
  GENERIC_NEXT_STEP,
  extractFirstUnchecked,
} from "./next-step.js";
import { matchedStopPattern } from "./stop-detector.js";
import {
  applyUpdateGoal,
  formatUpdateGoalToolResult,
  parseUpdateGoalInput,
  type UpdateGoalAck,
  type UpdateGoalInput,
} from "./progress-tool.js";
import { runPlanWriter, type PlanWriterSpawner } from "./planner.js";
import {
  runVerifierPanel,
  type VerifierSpawner,
  type VerifierPanelResult,
} from "./verifier.js";
import { maybeRunStrategist, type StrategistSpawner } from "./strategist.js";
import {
  continuationDirective,
  goalRulesPrompt,
  planBlock,
  renderBailPreface,
  renderStrategistNote,
  renderVerifierGapsBlock,
  GOAL_TOOL_NAME,
} from "./prompts.js";
import {
  goalDir,
  goalScratchRoot,
  implementerScratchDir,
  orchestrationSnapshotPath,
} from "./paths.js";
import type { GoalStatus } from "./types.js";
import { readFileSync } from "node:fs";
import {
  buildDisplaySnapshot,
  footerGoalChip,
  formatGoalDetailCard,
  formatGoalToast,
  goalChromeTone,
  statusLine,
  type GoalDisplaySnapshot,
} from "./display.js";
import type { GoalUiSnapshot } from "../../core/types.js";

export interface GoalOrchestratorOptions {
  sessionDir: string;
  planSpawner?: PlanWriterSpawner | null;
  verifierSpawner?: VerifierSpawner | null;
  strategistSpawner?: StrategistSpawner | null;
  /** Default panel size (default 2). */
  verifierPanelSize?: number;
  /** Persist orchestration.json after transitions (default true). */
  persist?: boolean;
}

export type GoalLoopDecision =
  | { action: "continue"; nudge: string }
  | { action: "complete"; summary: string }
  | { action: "paused"; status: GoalStatus; message?: string }
  | { action: "idle"; reason: string };

/**
 * Session-scoped goal controller.
 */
export class GoalOrchestrator {
  readonly tracker: GoalTracker;
  private planSpawner: PlanWriterSpawner | null;
  private verifierSpawner: VerifierSpawner | null;
  private strategistSpawner: StrategistSpawner | null;
  private panelSize: number;
  private persist: boolean;
  /** Pending completion claim awaiting verification. */
  private pendingCompletion: {
    message?: string;
    finalResponse?: string;
  } | null = null;
  /** Last progress messages (for status). */
  progressLog: string[] = [];

  constructor(opts: GoalOrchestratorOptions) {
    this.tracker = new GoalTracker(opts.sessionDir);
    this.planSpawner = opts.planSpawner ?? null;
    this.verifierSpawner = opts.verifierSpawner ?? null;
    this.strategistSpawner = opts.strategistSpawner ?? null;
    this.panelSize = opts.verifierPanelSize ?? 2;
    this.persist = opts.persist !== false;
  }

  setSpawners(args: {
    plan?: PlanWriterSpawner | null;
    verifier?: VerifierSpawner | null;
    strategist?: StrategistSpawner | null;
  }): void {
    if (args.plan !== undefined) this.planSpawner = args.plan;
    if (args.verifier !== undefined) this.verifierSpawner = args.verifier;
    if (args.strategist !== undefined) this.strategistSpawner = args.strategist;
  }

  /** Whether LLM-capable spawners are bound (plan/strategist null when unauthed). */
  spawnerPresence(): {
    plan: boolean;
    strategist: boolean;
    verifier: boolean;
  } {
    return {
      plan: this.planSpawner != null,
      strategist: this.strategistSpawner != null,
      verifier: this.verifierSpawner != null,
    };
  }

  isActive(): boolean {
    return this.tracker.isActive();
  }

  hasGoal(): boolean {
    return this.tracker.hasGoal();
  }

  /**
   * Create goal + fail-closed plan. Returns status lines for UI.
   */
  async createGoal(objective: string): Promise<{
    ok: boolean;
    lines: string[];
    planPath?: string;
    fallback?: boolean;
  }> {
    this.tracker.createGoal({ objective });
    this.pendingCompletion = null;
    this.progressLog = [];

    const plan = await runPlanWriter(this.tracker, this.planSpawner, {
      allowFallback: true,
    });

    if (!plan.ok || !this.tracker.snapshotMut()?.plan_file) {
      // Fail-closed abort
      if (this.tracker.isActive()) {
        this.tracker.pauseWithMessage(
          "infra",
          plan.error ?? "Plan missing after plan-writer (fail-closed).",
        );
      }
      this.save();
      return {
        ok: false,
        lines: [
          "Goal paused: plan-writer failed (fail-closed).",
          plan.error ?? "empty plan",
        ],
      };
    }

    this.save();
    return {
      ok: true,
      planPath: plan.planPath,
      fallback: plan.fallback,
      lines: [
        `Goal active: ${objective.slice(0, 100)}`,
        `Plan: ${plan.planPath}${plan.fallback ? " (fallback)" : ""}`,
        `Scratch: ${implementerScratchDir(this.tracker.verifierId()!)}`,
        `Use ${GOAL_TOOL_NAME} for progress; completion triggers verification.`,
      ],
    };
  }

  statusLines(): string[] {
    return this.tracker.formatStatusLines();
  }

  /**
   * Rich markdown status card (grok goal_detail spirit).
   */
  detailCard(): string {
    const o = this.tracker.snapshotMut();
    if (!o) return "No goal set.";
    this.tracker.accountElapsed();
    return formatGoalDetailCard(o, {
      nextStep: this.nextStepText(),
      progressNote: this.progressLog[this.progressLog.length - 1] ?? null,
      scratchPath: this.tracker.implementerScratch(),
      verifyCap: this.tracker.effectiveClassifierCap(),
    });
  }

  /** Live display snapshot for TUI chrome. */
  displaySnapshot(): GoalDisplaySnapshot | null {
    const o = this.tracker.snapshotMut();
    if (!o) return null;
    this.tracker.accountElapsed();
    return buildDisplaySnapshot(o, {
      nextStep: this.nextStepText(),
      progressNote: this.progressLog[this.progressLog.length - 1] ?? null,
      scratchPath: this.tracker.implementerScratch(),
      verifyCap: this.tracker.effectiveClassifierCap(),
    });
  }

  /** Push-ready GoalUiSnapshot for HarnessStore.setGoal. */
  uiSnapshot(): GoalUiSnapshot | null {
    const snap = this.displaySnapshot();
    if (!snap) return null;
    const tone = goalChromeTone(snap.status);
    return {
      objective: snap.objective,
      status: snap.status,
      statusLine: statusLine(snap),
      chip: footerGoalChip(snap),
      tone: tone === "none" ? "paused" : tone,
      nextStep: snap.nextStep ?? undefined,
      planning: snap.planning,
      verifying: snap.verifying,
    };
  }

  toast(
    kind: Parameters<typeof formatGoalToast>[0],
    detail?: string,
  ): string {
    return formatGoalToast(kind, detail);
  }

  pause(
    reason: "user" | "infra" | "back_off" | "no_progress" | "verification" = "user",
    message?: string,
  ): boolean {
    const ok = message
      ? this.tracker.pauseWithMessage(reason, message)
      : this.tracker.pause(reason);
    if (ok) this.save();
    return ok;
  }

  resume(): boolean {
    const ok = this.tracker.resume();
    if (ok) {
      this.pendingCompletion = null;
      this.save();
    }
    return ok;
  }

  clear(): void {
    this.tracker.clear();
    this.pendingCompletion = null;
    this.progressLog = [];
    this.save();
  }

  /**
   * Absolute roots the implementer/plan tools may touch outside project cwd:
   * session goal/ (plan.md) and private scratch under tmp.
   */
  toolAllowedRoots(): string[] {
    const roots = [goalDir(this.tracker.sessionDirectory)];
    const vid = this.tracker.verifierId();
    if (vid) {
      roots.push(goalScratchRoot(vid));
    }
    return roots;
  }

  /** Read plan.md body for prompt inlining (null if missing). */
  readPlanBody(maxBytes = 64 * 1024): string | null {
    const path = this.tracker.planFilePath();
    try {
      if (!path || !existsSync(path)) return null;
      return readFileSync(path, "utf8").slice(0, maxBytes);
    } catch {
      return null;
    }
  }

  /**
   * First implementer user message — embeds plan so tools aren't required
   * just to discover acceptance criteria.
   */
  buildKickoffPrompt(objective?: string): string {
    const o = this.tracker.snapshotMut();
    const obj = (objective ?? o?.objective ?? "").trim();
    const planPath = o?.plan_file ?? this.tracker.planFilePath();
    const body = this.readPlanBody();
    const parts = [
      `Goal objective (start now):`,
      obj,
      ``,
      planPath ? `Plan path (readable/writable): ${planPath}` : "",
      body
        ? [
            ``,
            `Plan contents (source of truth — follow this checklist):`,
            `<goal-plan>`,
            body,
            `</goal-plan>`,
          ].join("\n")
        : planPath
          ? `\nRead the plan at ${planPath} and begin the task checklist.`
          : `\nBegin implementing the objective.`,
      ``,
      `Begin the task checklist. Use file tools on the plan path and scratch as needed.`,
    ];
    return parts.filter((l) => l !== undefined).join("\n");
  }

  /**
   * Build system-prompt addon for the implementer turn.
   */
  buildGoalSystemAddon(opts?: { includeRules?: boolean }): string {
    const o = this.tracker.snapshotMut();
    if (!o || o.status !== "active") return "";
    const scratch = implementerScratchDir(o.verifier_id);
    const planBody = o.plan_file ? this.readPlanBody() : null;
    const parts: string[] = [];
    if (opts?.includeRules !== false) {
      parts.push(
        goalRulesPrompt({
          objective: o.objective,
          planBlock: o.plan_file ? planBlock(o.plan_file, planBody) : "",
          scratchDir: scratch,
          scratchReady: o.scratch_dir_ready,
        }),
      );
    }
    if (o.last_classifier_gaps) {
      parts.push(renderVerifierGapsBlock(o.last_classifier_gaps));
    }
    if (o.last_strategy_path || o.last_strategy_recommendation) {
      parts.push(
        renderStrategistNote(
          o.last_strategy_path,
          o.last_strategy_recommendation,
        ),
      );
    }
    return parts.join("\n");
  }

  /**
   * Build continuation nudge after a worker turn.
   */
  buildContinuationNudge(opts?: {
    bailPattern?: string | null;
    finalText?: string;
  }): string {
    const o = this.tracker.snapshotMut();
    if (!o) return "";
    const scratch = implementerScratchDir(o.verifier_id);
    const nextStep = this.nextStepText();
    const planBody = o.plan_file ? this.readPlanBody() : null;
    // Keep continuation lean: path + short reminder; full body already in system addon.
    const planPointer = o.plan_file
      ? [
          `Plan (source of truth): ${o.plan_file}`,
          planBody
            ? `Plan is also inlined in your goal system rules (<goal-plan>). Re-read the file if checklist checkboxes need updating.`
            : `Read the plan file if you do not have its contents.`,
          ``,
        ].join("\n")
      : undefined;
    return continuationDirective({
      objective: o.objective,
      tokens: "—",
      elapsed: `${Math.round(o.elapsed_ms / 1000)}s`,
      nextStep,
      scratchDir: scratch,
      scratchReady: o.scratch_dir_ready,
      bailPreface: opts?.bailPattern
        ? renderBailPreface(opts.bailPattern)
        : undefined,
      planPointer,
      verifierGaps: renderVerifierGapsBlock(o.last_classifier_gaps),
      strategistNote: renderStrategistNote(
        o.last_strategy_path,
        o.last_strategy_recommendation,
      ),
    });
  }

  nextStepText(): string {
    const o = this.tracker.snapshotMut();
    if (!o?.plan_file) return GENERIC_NEXT_STEP;
    try {
      if (!existsSync(o.plan_file)) return GENERIC_NEXT_STEP;
      const body = readFileSync(o.plan_file, "utf8");
      return extractFirstUnchecked(body) ?? GENERIC_NEXT_STEP;
    } catch {
      return firstUncheckedPlanItem(o.plan_file, { isPath: true }) ??
        GENERIC_NEXT_STEP;
    }
  }

  /**
   * Handle update_goal tool call from the model.
   */
  handleProgressTool(args: Record<string, unknown>): {
    ok: boolean;
    output: string;
    ack: UpdateGoalAck;
  } {
    const input = parseUpdateGoalInput(args);
    const ack = applyUpdateGoal(this.tracker, input);

    if (ack.kind === "progress" && input.message?.trim()) {
      this.progressLog.push(input.message.trim());
      if (this.progressLog.length > 32) {
        this.progressLog = this.progressLog.slice(-32);
      }
    }

    if (ack.kind === "completed_queued") {
      this.pendingCompletion = {
        message: input.message ?? undefined,
      };
    }

    if (ack.kind === "blocked") {
      this.pendingCompletion = null;
      this.save();
    }

    const formatted = formatUpdateGoalToolResult(ack);
    return { ...formatted, ack };
  }

  hasPendingCompletion(): boolean {
    return this.pendingCompletion != null;
  }

  /**
   * After implementer turn: record round, maybe verify, maybe continue.
   */
  async afterImplementerTurn(finalText: string): Promise<GoalLoopDecision> {
    const o = this.tracker.snapshotMut();
    if (!o) return { action: "idle", reason: "no goal" };

    if (o.status !== "active") {
      return {
        action: "paused",
        status: o.status,
        message: o.pause_message ?? undefined,
      };
    }

    this.tracker.recordWorkerRound();
    this.tracker.accountElapsed();
    if (finalText.trim()) {
      this.tracker.setFirstFinalResponse(finalText);
    }

    // Completion claim → verification
    if (this.pendingCompletion) {
      const claim = this.pendingCompletion;
      this.pendingCompletion = null;
      return this.runVerificationAndDecide(
        claim.finalResponse ?? finalText,
        claim.message,
      );
    }

    // Premature stop detection
    const pattern = matchedStopPattern(finalText);
    if (pattern) {
      this.tracker.recordPrematureStop(pattern);
      this.save();
      return {
        action: "continue",
        nudge: this.buildContinuationNudge({
          bailPattern: pattern,
          finalText,
        }),
      };
    }

    // Normal continuation while active
    this.save();
    return {
      action: "continue",
      nudge: this.buildContinuationNudge({ finalText }),
    };
  }

  /**
   * Explicitly run verification (also used when pending completion set).
   */
  async runVerificationAndDecide(
    finalResponse: string,
    claimMessage?: string,
  ): Promise<GoalLoopDecision> {
    const o = this.tracker.snapshotMut();
    if (!o || o.status !== "active") {
      return {
        action: "paused",
        status: o?.status ?? "user_paused",
        message: o?.pause_message ?? undefined,
      };
    }

    if (!this.verifierSpawner) {
      // Without a spawner, fail-closed: NotAchieved with gap
      const fake = await this.applySyntheticNotAchieved(
        "No verifier spawner configured — cannot trust completion claim.",
      );
      return fake;
    }

    // Cap check before run
    const cap = this.tracker.effectiveClassifierCap();
    if (
      cap != null &&
      o.classifier_runs_attempted >= cap
    ) {
      this.tracker.pause("back_off");
      this.save();
      return {
        action: "paused",
        status: "back_off_paused",
        message: `Verification cap reached (${cap}). /goal resume to retry.`,
      };
    }

    const panel = await runVerifierPanel(this.tracker, {
      panelSize: this.panelSize,
      finalResponse,
      spawner: this.verifierSpawner,
    });

    if (!panel) {
      this.tracker.pause("back_off");
      this.save();
      return {
        action: "paused",
        status: "back_off_paused",
        message: "Could not reserve verification attempt (cap).",
      };
    }

    return this.consumePanelResult(panel, claimMessage);
  }

  private async consumePanelResult(
    panel: VerifierPanelResult,
    claimMessage?: string,
  ): Promise<GoalLoopDecision> {
    const { aggregate, detailsPath } = panel;
    const applied = this.tracker.applyVerifierResult({
      verdict: aggregate.verdict,
      gapsSummary: aggregate.gapsSummary || null,
      detailsPath,
      fingerprint: aggregate.fingerprint,
    });

    if (aggregate.verdict === "achieved") {
      this.tracker.complete();
      this.save();
      return {
        action: "complete",
        summary:
          claimMessage?.trim() ||
          "Goal verified complete by adversarial panel.",
      };
    }

    // NotAchieved
    if (aggregate.allContradiction) {
      this.tracker.pauseWithMessage(
        "verification",
        "All skeptics flagged an unblockable contradiction / environment blocker.",
      );
      this.save();
      return {
        action: "paused",
        status: "blocked",
        message: this.tracker.snapshotMut()?.pause_message ?? undefined,
      };
    }

    if (applied.stalled) {
      this.tracker.pauseWithMessage(
        "no_progress",
        "Identical verifier gaps across consecutive attempts (stall).",
      );
      this.save();
      return {
        action: "paused",
        status: "no_progress_paused",
        message: "Stalled on identical gaps. /goal resume to retry.",
      };
    }

    if (applied.capHit) {
      this.tracker.pause("back_off");
      this.save();
      return {
        action: "paused",
        status: "back_off_paused",
        message: "Verification run cap reached. /goal resume to retry.",
      };
    }

    if (applied.shouldStrategist) {
      await maybeRunStrategist(this.tracker, this.strategistSpawner);
    }

    this.save();
    return {
      action: "continue",
      nudge: this.buildContinuationNudge(),
    };
  }

  private async applySyntheticNotAchieved(
    gap: string,
  ): Promise<GoalLoopDecision> {
    const o = this.tracker.snapshotMut();
    if (!o) return { action: "idle", reason: "no goal" };
    // Reserve attempt manually
    this.tracker.reserveClassifierAttempt();
    const detailsPath = join(
      implementerScratchDir(o.verifier_id),
      "synthetic-not-achieved.md",
    );
    try {
      mkdirSync(dirnameSafe(detailsPath), { recursive: true });
      writeFileSync(detailsPath, `refuted: true\n\n## Gaps\n- ${gap}\n`, "utf8");
    } catch {
      /* ignore */
    }
    const fingerprint = `syn:${gap.slice(0, 40)}`;
    const applied = this.tracker.applyVerifierResult({
      verdict: "not_achieved",
      gapsSummary: `- ${gap}`,
      detailsPath,
      fingerprint,
    });
    if (applied.stalled) {
      this.tracker.pause("no_progress");
      this.save();
      return {
        action: "paused",
        status: "no_progress_paused",
        message: gap,
      };
    }
    this.save();
    return {
      action: "continue",
      nudge: this.buildContinuationNudge(),
    };
  }

  save(): void {
    if (!this.persist) return;
    const o = this.tracker.snapshot();
    const path = orchestrationSnapshotPath(this.tracker.sessionDirectory);
    try {
      mkdirSync(dirnameSafe(path), { recursive: true });
      if (!o) {
        // cleared — write empty marker or remove
        writeFileSync(path, "null", "utf8");
        return;
      }
      writeFileSync(path, JSON.stringify(o, null, 2), "utf8");
    } catch {
      /* best-effort */
    }
  }
}

function dirnameSafe(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : ".";
}

/**
 * Scripted end-to-end loop for tests (no real LLM).
 * Drive: create → plan → implementer rounds with progress tool → verify → done.
 */
export async function runScriptedGoalLoop(args: {
  sessionDir: string;
  objective: string;
  planBody: string;
  /** Sequence of implementer "turns": text + optional update_goal input */
  turns: Array<{
    finalText: string;
    updateGoal?: UpdateGoalInput;
  }>;
  /** Verifier results per completion claim (in order) */
  verifierVotes: Array<Array<{ refuted: boolean; gaps: string[] }>>;
  strategist?: StrategistSpawner | null;
}): Promise<{
  decisions: GoalLoopDecision[];
  finalStatus: GoalStatus | null;
  planPath: string | null;
  logs: string[];
}> {
  let verifyCall = 0;
  let skepticInPanel = 0;
  const panelSize = Math.max(
    1,
    ...args.verifierVotes.map((p) => p.length),
    1,
  );

  const orch = new GoalOrchestrator({
    sessionDir: args.sessionDir,
    persist: true,
    planSpawner: async ({ planPath }) => {
      mkdirSync(dirnameSafe(planPath), { recursive: true });
      writeFileSync(planPath, args.planBody, "utf8");
      return { ok: true, body: args.planBody };
    },
    verifierSpawner: async (vArgs) => {
      const panel = args.verifierVotes[verifyCall] ?? [
        { refuted: true, gaps: ["default refute"] },
      ];
      const vote = panel[vArgs.idx] ??
        panel[panel.length - 1] ?? {
          refuted: true,
          gaps: ["missing vote"],
        };
      const body = [
        `refuted: ${vote.refuted}`,
        ``,
        `## Gaps`,
        ...(vote.gaps.length ? vote.gaps.map((g) => `- ${g}`) : ["- (none)"]),
      ].join("\n");
      mkdirSync(dirnameSafe(vArgs.verdictFile), { recursive: true });
      writeFileSync(vArgs.verdictFile, body, "utf8");
      writeFileSync(vArgs.detailsFile, body, "utf8");
      skepticInPanel += 1;
      if (skepticInPanel >= panelSize) {
        verifyCall += 1;
        skepticInPanel = 0;
      }
      return { ok: true, body };
    },
    strategistSpawner: args.strategist ?? null,
    verifierPanelSize: panelSize,
  });

  const logs: string[] = [];
  const decisions: GoalLoopDecision[] = [];

  const created = await orch.createGoal(args.objective);
  logs.push(...created.lines);
  if (!created.ok) {
    return {
      decisions,
      finalStatus: orch.tracker.status(),
      planPath: null,
      logs,
    };
  }

  for (const turn of args.turns) {
    if (!orch.isActive()) break;

    if (turn.updateGoal) {
      const r = orch.handleProgressTool(
        turn.updateGoal as Record<string, unknown>,
      );
      logs.push(`update_goal: ${r.ack.kind} — ${r.ack.summary}`);
    }

    const decision = await orch.afterImplementerTurn(turn.finalText);
    decisions.push(decision);
    logs.push(`decision: ${decision.action}`);

    if (decision.action === "complete" || decision.action === "paused") {
      break;
    }
  }

  return {
    decisions,
    finalStatus: orch.tracker.status(),
    planPath: orch.tracker.snapshotMut()?.plan_file ?? null,
    logs,
  };
}
