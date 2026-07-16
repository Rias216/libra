/**
 * Goal mode types — status machine, history, orchestration snapshot.
 * Ported from grok-build's goal_tracker (observable contract, not every internal).
 */

export type GoalPhase = "idle" | "planning" | "executing";

/**
 * Lifecycle status. Paused variants encode the reason.
 * Wire form is snake_case.
 */
export type GoalStatus =
  | "active"
  | "user_paused"
  | "back_off_paused"
  | "no_progress_paused"
  | "infra_paused"
  | "blocked"
  | "budget_limited"
  | "complete";

export type GoalPauseReason =
  | "user"
  | "back_off"
  | "no_progress"
  | "verification"
  | "infra";

export type GoalClassifierVerdict = "achieved" | "not_achieved";

export type GoalEvent =
  | "goal_created"
  | "planning_started"
  | "planning_completed"
  | "planning_failed"
  | "worker_started"
  | "worker_completed"
  | "worker_failed"
  | "goal_paused"
  | "goal_resumed"
  | "goal_completed"
  | "goal_cleared"
  | "budget_exceeded"
  | "premature_stop_detected"
  | "verification_started"
  | "verification_completed"
  | "strategist_fired"
  | "unknown";

export interface GoalHistoryEntry {
  timestamp: string;
  event: GoalEvent;
  detail?: string;
  round?: number;
  tokens_used?: number;
  unmet?: string[];
}

export interface GoalOrchestration {
  goal_id: string;
  objective: string;
  status: GoalStatus;
  phase: GoalPhase;
  token_budget: number | null;
  elapsed_ms: number;
  created_at: string;
  current_subagent_id: string | null;
  current_subagent_role: string | null;
  total_worker_rounds: number;
  total_verify_rounds: number;
  token_baseline: number;
  history: GoalHistoryEntry[];
  pause_message: string | null;
  /** 12-hex id scoping private scratch */
  verifier_id: string;
  classifier_runs_attempted: number;
  rounds_since_verify: number;
  classifier_max_runs: number | null;
  last_classifier_verdict: GoalClassifierVerdict | null;
  last_classifier_details_path: string | null;
  last_classifier_at: string | null;
  last_classifier_gaps: string | null;
  first_final_response: string | null;
  last_gap_fingerprint: string | null;
  classifier_stall_count: number;
  consecutive_not_achieved: number;
  last_strategist_fired_at: number;
  strategist_cap_bonus: number;
  last_strategy_path: string | null;
  last_strategy_recommendation: string | null;
  changes_baseline_commit: string | null;
  plan_file: string | null;
  plan_baseline_file: string | null;
  /** True when implementer scratch exists on disk */
  scratch_dir_ready: boolean;
  /** Transient UI flags */
  planning_in_flight?: boolean;
  verifying_in_flight?: boolean;
}

/** Consecutive identical gap fingerprints that trip stall early-exit. */
export const GOAL_CLASSIFIER_STALL_THRESHOLD = 2;

/** Extra verifier rounds granted once when strategist fires. */
export const GOAL_STRATEGIST_CAP_BONUS = 3;

/** Relaxed stall threshold while strategist restructure is in flight. */
export const GOAL_STRATEGIST_STALL_THRESHOLD =
  GOAL_CLASSIFIER_STALL_THRESHOLD + GOAL_STRATEGIST_CAP_BONUS;

/** Default max verifier runs before back_off pause. */
export const GOAL_DEFAULT_CLASSIFIER_MAX_RUNS = 8;

/** Strategist fires every N consecutive NotAchieved. */
export const GOAL_STRATEGIST_EVERY = 2;

/** Max retained history entries. */
export const GOAL_HISTORY_MAX = 64;

export const PAUSED_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "user_paused",
  "back_off_paused",
  "no_progress_paused",
  "infra_paused",
  "blocked",
]);

export function isPausedStatus(s: GoalStatus): boolean {
  return PAUSED_STATUSES.has(s);
}

export function isTerminalStatus(s: GoalStatus): boolean {
  return s === "complete" || s === "budget_limited";
}

export function pauseReasonToStatus(reason: GoalPauseReason): GoalStatus {
  switch (reason) {
    case "user":
      return "user_paused";
    case "back_off":
      return "back_off_paused";
    case "no_progress":
      return "no_progress_paused";
    case "verification":
      return "blocked";
    case "infra":
      return "infra_paused";
  }
}

export function pauseReasonHistoryDetail(reason: GoalPauseReason): string {
  switch (reason) {
    case "user":
      return "user";
    case "back_off":
      return "back_off";
    case "no_progress":
      return "no_progress";
    case "verification":
      return "blocked";
    case "infra":
      return "infra";
  }
}

export function parseGoalStatus(s: string): GoalStatus {
  const k = s.trim().toLowerCase();
  switch (k) {
    case "active":
      return "active";
    case "user_paused":
    case "paused":
    case "doom_loop_paused":
      return "user_paused";
    case "back_off_paused":
      return "back_off_paused";
    case "no_progress_paused":
      return "no_progress_paused";
    case "infra_paused":
      return "infra_paused";
    case "blocked":
      return "blocked";
    case "budget_limited":
      return "budget_limited";
    case "complete":
      return "complete";
    default:
      // Unknown → safe resumable pause, never auto-drive
      return "user_paused";
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function historyEntry(
  event: GoalEvent,
  detail?: string | null,
): GoalHistoryEntry {
  return {
    timestamp: nowIso(),
    event,
    ...(detail ? { detail } : {}),
  };
}

/** 12-char hex verifier id (~48 bits). */
export function generateVerifierId(): string {
  const hex = Array.from({ length: 12 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return hex;
}

export function isCanonicalVerifierId(id: string): boolean {
  return id.length === 12 && /^[0-9a-f]+$/i.test(id);
}
