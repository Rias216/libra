/**
 * Pure goal state machine — no LLM I/O.
 * Transitions: create / pause / resume / clear / complete / block / cap / stall.
 */

import {
  type GoalClassifierVerdict,
  type GoalEvent,
  type GoalHistoryEntry,
  type GoalOrchestration,
  type GoalPauseReason,
  type GoalPhase,
  type GoalStatus,
  GOAL_CLASSIFIER_STALL_THRESHOLD,
  GOAL_DEFAULT_CLASSIFIER_MAX_RUNS,
  GOAL_HISTORY_MAX,
  GOAL_STRATEGIST_CAP_BONUS,
  GOAL_STRATEGIST_EVERY,
  GOAL_STRATEGIST_STALL_THRESHOLD,
  generateVerifierId,
  historyEntry,
  isCanonicalVerifierId,
  isPausedStatus,
  nowIso,
  pauseReasonHistoryDetail,
  pauseReasonToStatus,
} from "./types.js";
import {
  ensureGoalDir,
  ensureGoalScratch,
  implementerScratchDir,
  planBaselinePath,
  planPath,
  removeGoalScratch,
  rescueClassifierDetails,
  strategyPath,
} from "./paths.js";
import {
  buildDisplaySnapshot,
  formatElapsed,
  statusLine,
} from "./display.js";

export interface CreateGoalOptions {
  goalId?: string;
  objective: string;
  tokenBudget?: number | null;
  tokenBaseline?: number;
  baselineCommit?: string | null;
  classifierMaxRuns?: number | null;
  createdAt?: string;
}

export class GoalTracker {
  private orchestration: GoalOrchestration | null = null;
  private sessionDir: string;
  private activeSinceMs: number | null = null;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }

  get sessionDirectory(): string {
    return this.sessionDir;
  }

  static fromSnapshot(
    sessionDir: string,
    snapshot: GoalOrchestration,
  ): GoalTracker {
    const t = new GoalTracker(sessionDir);
    const o = { ...snapshot };
    // In-flight phases don't survive restart
    if (o.phase === "planning" || o.phase === "executing") {
      o.phase = "idle";
      if (o.status === "active") o.status = "user_paused";
      o.current_subagent_id = null;
      o.current_subagent_role = null;
    }
    o.planning_in_flight = false;
    o.verifying_in_flight = false;
    if (!isCanonicalVerifierId(o.verifier_id)) {
      o.verifier_id = generateVerifierId();
    }
    if (o.status !== "complete" && o.status !== "budget_limited") {
      o.scratch_dir_ready = ensureGoalScratch(o.verifier_id);
    } else {
      o.scratch_dir_ready = false;
    }
    t.orchestration = o;
    t.activeSinceMs = o.status === "active" ? Date.now() : null;
    return t;
  }

  snapshot(): GoalOrchestration | null {
    return this.orchestration ? { ...this.orchestration } : null;
  }

  /** Mutable view for orchestrator (prefer methods for transitions). */
  snapshotMut(): GoalOrchestration | null {
    return this.orchestration;
  }

  isActive(): boolean {
    return this.orchestration?.status === "active";
  }

  hasGoal(): boolean {
    return this.orchestration != null;
  }

  phase(): GoalPhase | null {
    return this.orchestration?.phase ?? null;
  }

  status(): GoalStatus | null {
    return this.orchestration?.status ?? null;
  }

  objective(): string | null {
    return this.orchestration?.objective ?? null;
  }

  planFilePath(): string {
    return planPath(this.sessionDir);
  }

  planBaselineFilePath(): string {
    return planBaselinePath(this.sessionDir);
  }

  strategyFilePath(): string {
    return strategyPath(this.sessionDir);
  }

  implementerScratch(): string | null {
    const o = this.orchestration;
    if (!o?.scratch_dir_ready) return null;
    return implementerScratchDir(o.verifier_id);
  }

  verifierId(): string | null {
    return this.orchestration?.verifier_id ?? null;
  }

  createGoal(opts: CreateGoalOptions): GoalOrchestration {
    ensureGoalDir(this.sessionDir);
    if (this.orchestration) {
      this.rescueAndRemoveScratch();
    }
    const verifier_id = generateVerifierId();
    const scratch_dir_ready = ensureGoalScratch(verifier_id);
    const o: GoalOrchestration = {
      goal_id: opts.goalId ?? `goal_${Date.now().toString(36)}`,
      objective: opts.objective.trim(),
      status: "active",
      phase: "executing",
      token_budget: opts.tokenBudget ?? null,
      elapsed_ms: 0,
      created_at: opts.createdAt ?? nowIso(),
      current_subagent_id: null,
      current_subagent_role: null,
      total_worker_rounds: 0,
      total_verify_rounds: 0,
      token_baseline: opts.tokenBaseline ?? 0,
      history: [],
      pause_message: null,
      verifier_id,
      classifier_runs_attempted: 0,
      rounds_since_verify: 0,
      classifier_max_runs:
        opts.classifierMaxRuns ?? GOAL_DEFAULT_CLASSIFIER_MAX_RUNS,
      last_classifier_verdict: null,
      last_classifier_details_path: null,
      last_classifier_at: null,
      last_classifier_gaps: null,
      first_final_response: null,
      last_gap_fingerprint: null,
      classifier_stall_count: 0,
      consecutive_not_achieved: 0,
      last_strategist_fired_at: 0,
      strategist_cap_bonus: 0,
      last_strategy_path: null,
      last_strategy_recommendation: null,
      changes_baseline_commit: opts.baselineCommit ?? null,
      plan_file: null,
      plan_baseline_file: null,
      scratch_dir_ready,
      planning_in_flight: false,
      verifying_in_flight: false,
    };
    this.orchestration = o;
    this.activeSinceMs = Date.now();
    this.recordEvent("goal_created");
    return o;
  }

  setPhase(phase: GoalPhase): void {
    if (this.orchestration) this.orchestration.phase = phase;
  }

  setPlanFile(path: string): void {
    if (this.orchestration) this.orchestration.plan_file = path;
  }

  setPlanBaseline(path: string): void {
    if (this.orchestration) this.orchestration.plan_baseline_file = path;
  }

  setPlanningInFlight(v: boolean): void {
    if (this.orchestration) this.orchestration.planning_in_flight = v;
  }

  setVerifyingInFlight(v: boolean): void {
    if (this.orchestration) this.orchestration.verifying_in_flight = v;
  }

  pause(reason: GoalPauseReason): boolean {
    return this.pauseInner(reason, null);
  }

  pauseWithMessage(reason: GoalPauseReason, message: string): boolean {
    return this.pauseInner(reason, message);
  }

  private pauseInner(
    reason: GoalPauseReason,
    message: string | null,
  ): boolean {
    const o = this.orchestration;
    if (!o || o.status !== "active") return false;
    this.flushElapsed();
    o.status = pauseReasonToStatus(reason);
    if (message != null) o.pause_message = message;
    this.activeSinceMs = null;
    this.recordEvent("goal_paused", pauseReasonHistoryDetail(reason));
    return true;
  }

  resume(): boolean {
    const o = this.orchestration;
    if (!o || !isPausedStatus(o.status)) return false;
    o.status = "active";
    o.pause_message = null;
    o.classifier_runs_attempted = 0;
    o.rounds_since_verify = 0;
    this.resetStrategistFields(o);
    this.resetClassifierStallFields(o);
    // Re-ensure scratch
    o.scratch_dir_ready = ensureGoalScratch(o.verifier_id);
    this.activeSinceMs = Date.now();
    this.recordEvent("goal_resumed");
    return true;
  }

  complete(): boolean {
    const o = this.orchestration;
    if (!o) return false;
    if (o.status !== "active" && !isPausedStatus(o.status)) return false;
    this.flushElapsed();
    o.status = "complete";
    o.phase = "idle";
    o.current_subagent_id = null;
    o.current_subagent_role = null;
    o.pause_message = null;
    o.plan_baseline_file = null;
    this.resetStrategistFields(o);
    this.rescueAndRemoveScratch();
    o.scratch_dir_ready = false;
    this.activeSinceMs = null;
    this.recordEvent("goal_completed");
    return true;
  }

  budgetLimit(): boolean {
    const o = this.orchestration;
    if (!o) return false;
    if (o.status !== "active" && !isPausedStatus(o.status)) return false;
    this.flushElapsed();
    o.status = "budget_limited";
    o.phase = "idle";
    o.current_subagent_id = null;
    o.current_subagent_role = null;
    o.pause_message = null;
    o.plan_baseline_file = null;
    this.resetStrategistFields(o);
    this.rescueAndRemoveScratch();
    o.scratch_dir_ready = false;
    this.activeSinceMs = null;
    this.recordEvent("budget_exceeded");
    return true;
  }

  clear(): void {
    this.rescueAndRemoveScratch();
    if (this.orchestration) {
      this.recordEvent("goal_cleared");
    }
    this.orchestration = null;
    this.activeSinceMs = null;
  }

  recordWorkerRound(): void {
    const o = this.orchestration;
    if (!o) return;
    o.total_worker_rounds += 1;
    o.rounds_since_verify += 1;
  }

  reserveClassifierAttempt(): boolean {
    const o = this.orchestration;
    if (!o) return false;
    const cap = this.effectiveClassifierCap();
    if (cap != null && o.classifier_runs_attempted >= cap) return false;
    o.classifier_runs_attempted += 1;
    o.rounds_since_verify = 0;
    o.total_verify_rounds += 1;
    return true;
  }

  effectiveClassifierCap(): number | null {
    const o = this.orchestration;
    if (!o) return null;
    const base = o.classifier_max_runs;
    if (base == null) return null;
    return base + (o.strategist_cap_bonus || 0);
  }

  rollbackClassifierAttempt(): void {
    const o = this.orchestration;
    if (!o) return;
    o.classifier_runs_attempted = Math.max(0, o.classifier_runs_attempted - 1);
  }

  /**
   * Record NotAchieved fingerprint; return true if stalled.
   */
  recordClassifierStall(fingerprint: string): boolean {
    const o = this.orchestration;
    if (!o) return false;
    if (o.last_gap_fingerprint === fingerprint) {
      o.classifier_stall_count += 1;
    } else {
      o.last_gap_fingerprint = fingerprint;
      o.classifier_stall_count = 1;
    }
    const threshold =
      o.strategist_cap_bonus > 0
        ? GOAL_STRATEGIST_STALL_THRESHOLD
        : GOAL_CLASSIFIER_STALL_THRESHOLD;
    return o.classifier_stall_count >= threshold;
  }

  resetClassifierStall(): void {
    if (this.orchestration) this.resetClassifierStallFields(this.orchestration);
  }

  /**
   * Bump consecutive NotAchieved; return new streak.
   */
  recordNotAchievedStreak(): number {
    const o = this.orchestration;
    if (!o) return 0;
    o.consecutive_not_achieved += 1;
    return o.consecutive_not_achieved;
  }

  resetNotAchievedStreak(): void {
    if (this.orchestration) this.resetStrategistFields(this.orchestration);
  }

  /**
   * Claim strategist fire if streak warrants it.
   * Returns the streak value at fire, or null if not firing.
   */
  claimStrategistFire(every = GOAL_STRATEGIST_EVERY): number | null {
    const o = this.orchestration;
    if (!o || every <= 0) return null;
    const streak = o.consecutive_not_achieved;
    if (streak < every) return null;
    if (streak < o.last_strategist_fired_at + every) return null;
    o.last_strategist_fired_at = streak;
    if (o.strategist_cap_bonus === 0) {
      o.strategist_cap_bonus = GOAL_STRATEGIST_CAP_BONUS;
    }
    this.recordEvent("strategist_fired", `streak=${streak}`);
    return streak;
  }

  recordStrategyRecommendation(path: string, recommendation: string): void {
    const o = this.orchestration;
    if (!o) return;
    o.last_strategy_path = path;
    o.last_strategy_recommendation = recommendation.slice(0, 1200);
  }

  applyVerifierResult(args: {
    verdict: GoalClassifierVerdict;
    gapsSummary: string | null;
    detailsPath: string | null;
    fingerprint: string;
  }): {
    stalled: boolean;
    capHit: boolean;
    shouldStrategist: boolean;
  } {
    const o = this.orchestration;
    if (!o) {
      return { stalled: false, capHit: false, shouldStrategist: false };
    }
    o.last_classifier_verdict = args.verdict;
    o.last_classifier_at = nowIso();
    o.last_classifier_details_path = args.detailsPath;
    this.recordEvent(
      "verification_completed",
      args.verdict === "achieved" ? "achieved" : "not_achieved",
    );

    if (args.verdict === "achieved") {
      o.last_classifier_gaps = null;
      this.resetStrategistFields(o);
      this.resetClassifierStallFields(o);
      return { stalled: false, capHit: false, shouldStrategist: false };
    }

    // NotAchieved
    o.last_classifier_gaps = args.gapsSummary;
    const stalled = args.fingerprint
      ? this.recordClassifierStall(args.fingerprint)
      : false;
    const streak = this.recordNotAchievedStreak();
    const shouldStrategist =
      streak >= GOAL_STRATEGIST_EVERY &&
      streak >= o.last_strategist_fired_at + GOAL_STRATEGIST_EVERY;

    const cap = this.effectiveClassifierCap();
    const capHit =
      cap != null && o.classifier_runs_attempted >= cap;

    return { stalled, capHit, shouldStrategist };
  }

  setFirstFinalResponse(text: string): void {
    const o = this.orchestration;
    if (!o || o.first_final_response) return;
    o.first_final_response = text.slice(0, 4000);
  }

  recordPrematureStop(pattern: string): void {
    this.recordEvent("premature_stop_detected", pattern);
  }

  formatStatusLines(): string[] {
    const o = this.orchestration;
    if (!o) return ["No active goal."];
    this.accountElapsed();
    const snap = buildDisplaySnapshot(o, {
      verifyCap: this.effectiveClassifierCap(),
      scratchPath: o.scratch_dir_ready
        ? implementerScratchDir(o.verifier_id)
        : null,
    });
    const lines = [
      statusLine(snap),
      o.objective.slice(0, 120) + (o.objective.length > 120 ? "…" : ""),
      `Elapsed ${formatElapsed(snap.elapsedMs)} · worker ${snap.workerRounds} · verify ${snap.verifyAttempted}/${snap.verifyCap ?? "∞"}`,
    ];
    if (o.pause_message) lines.push(`Reason: ${o.pause_message}`);
    if (o.plan_file) lines.push(`Plan: ${o.plan_file}`);
    if (o.last_classifier_verdict) {
      lines.push(`Verdict: ${o.last_classifier_verdict}`);
    }
    if (snap.nextStep) lines.push(`Next: ${snap.nextStep}`);
    if (o.scratch_dir_ready) {
      lines.push(`Scratch: ${implementerScratchDir(o.verifier_id)}`);
    }
    if (o.last_strategy_path) {
      lines.push(`Strategy: ${o.last_strategy_path}`);
    }
    return lines;
  }

  private flushElapsed(): void {
    const o = this.orchestration;
    if (!o || this.activeSinceMs == null) return;
    o.elapsed_ms += Math.max(0, Date.now() - this.activeSinceMs);
    this.activeSinceMs = Date.now();
  }

  accountElapsed(): void {
    this.flushElapsed();
  }

  private recordEvent(event: GoalEvent, detail?: string | null): void {
    const o = this.orchestration;
    if (!o) return;
    const entry = historyEntry(event, detail);
    o.history.push(entry);
    if (o.history.length > GOAL_HISTORY_MAX) {
      o.history = o.history.slice(-GOAL_HISTORY_MAX);
    }
  }

  /** Expose last history entry (tests). */
  lastHistory(): GoalHistoryEntry | null {
    const h = this.orchestration?.history;
    if (!h?.length) return null;
    return h[h.length - 1]!;
  }

  private resetStrategistFields(o: GoalOrchestration): void {
    o.consecutive_not_achieved = 0;
    o.last_strategist_fired_at = 0;
    o.strategist_cap_bonus = 0;
    o.last_strategy_path = null;
    o.last_strategy_recommendation = null;
  }

  private resetClassifierStallFields(o: GoalOrchestration): void {
    o.last_gap_fingerprint = null;
    o.classifier_stall_count = 0;
  }

  private rescueAndRemoveScratch(): void {
    const o = this.orchestration;
    if (!o) return;
    const rescued = rescueClassifierDetails(
      this.sessionDir,
      o.last_classifier_details_path,
    );
    if (rescued) o.last_classifier_details_path = rescued;
    removeGoalScratch(o.verifier_id);
  }
}
