/**
 * Goal display polish — status labels, footer chips, detail cards.
 * Mirrors grok-build goal_detail / agent_status presentation without ACP wire.
 */

import type {
  GoalEvent,
  GoalHistoryEntry,
  GoalOrchestration,
  GoalPhase,
  GoalStatus,
} from "./types.js";
import { isPausedStatus } from "./types.js";
import { extractFirstUnchecked, GENERIC_NEXT_STEP } from "./next-step.js";
import { existsSync, readFileSync } from "node:fs";

/** Snapshot pushed to HarnessState for TUI chrome. */
export interface GoalDisplaySnapshot {
  objective: string;
  status: GoalStatus;
  phase: GoalPhase;
  goalId: string;
  elapsedMs: number;
  workerRounds: number;
  verifyAttempted: number;
  verifyCap: number | null;
  planning: boolean;
  verifying: boolean;
  pauseMessage: string | null;
  lastVerdict: "achieved" | "not_achieved" | null;
  nextStep: string | null;
  planPath: string | null;
  scratchPath: string | null;
  progressNote: string | null;
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mRem = m % 60;
  return mRem > 0 ? `${h}h ${mRem}m` : `${h}h`;
}

/** Compact elapsed for footer chip. */
export function formatElapsedCompact(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/**
 * Human pause/status label (grok pause_label spirit).
 */
export function statusDisplayLabel(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "user_paused":
      return "Paused";
    case "back_off_paused":
      return "Back-off";
    case "no_progress_paused":
      return "No progress";
    case "infra_paused":
      return "Infra paused";
    case "blocked":
      return "Blocked";
    case "budget_limited":
      return "Budget limited";
    case "complete":
      return "Complete";
  }
}

/** Short footer chip label for non-active states. */
export function statusChipLabel(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "user_paused":
      return "Paused";
    case "back_off_paused":
      return "Back-off";
    case "no_progress_paused":
      return "Stalled";
    case "infra_paused":
      return "Infra";
    case "blocked":
      return "Blocked";
    case "budget_limited":
      return "Budget";
    case "complete":
      return "Done";
  }
}

/**
 * Live phase suffix for Active goals — verifying wins over planning.
 * Shared by footer chip and detail card (grok active_phase_label).
 */
export function activePhaseLabel(snap: {
  planning?: boolean;
  verifying?: boolean;
  phase?: GoalPhase;
  verifyAttempted?: number;
  verifyCap?: number | null;
}): string {
  if (snap.verifying) {
    const att = snap.verifyAttempted ?? 0;
    const cap = snap.verifyCap;
    if (cap != null && cap > 0) {
      return `Verifying (${att}/${cap})`;
    }
    return att > 0 ? `Verifying (${att})` : "Verifying";
  }
  if (snap.planning || snap.phase === "planning") {
    return "Planning";
  }
  if (snap.phase === "idle") return "Idle";
  return "Executing";
}

/** Full status line: `Active — Verifying (2/8)` or `Paused`. */
export function statusLine(snap: GoalDisplaySnapshot): string {
  if (snap.status === "active") {
    return `Active — ${activePhaseLabel(snap)}`;
  }
  return statusDisplayLabel(snap.status);
}

/**
 * Footer chip: `[Goal: Executing · 3m]` or `[Goal: Paused]`.
 */
export function footerGoalChip(snap: GoalDisplaySnapshot): string {
  const phase =
    snap.status === "active"
      ? activePhaseLabel(snap)
      : statusChipLabel(snap.status);
  const elapsed = formatElapsedCompact(snap.elapsedMs);
  return `[Goal: ${phase} · ${elapsed}]`;
}

/**
 * Truncate for narrow status bars.
 */
export function footerGoalChipCompact(
  snap: GoalDisplaySnapshot,
  maxWidth: number,
): string {
  const full = footerGoalChip(snap);
  if (full.length <= maxWidth) return full;
  const short = `[G:${statusChipLabel(snap.status)}]`;
  return short.length <= maxWidth ? short : "Goal";
}

export function humanizeGoalEvent(
  event: GoalEvent | string,
  detail?: string | null,
): string {
  const d = detail?.trim();
  switch (event) {
    case "goal_created":
      return "Goal created";
    case "planning_started":
      return "Planning started";
    case "planning_completed":
      return "Planning completed";
    case "planning_failed":
      return d ? `Planning failed: ${d}` : "Planning failed";
    case "worker_started":
      return "Worker started";
    case "worker_completed":
      return "Worker completed";
    case "worker_failed":
      return d ? `Worker failed: ${d}` : "Worker failed";
    case "goal_paused":
      if (d && d !== "user") return `Paused: ${d}`;
      return "Paused";
    case "goal_resumed":
      return "Resumed";
    case "goal_completed":
      return "Completed";
    case "goal_cleared":
      return "Cleared";
    case "budget_exceeded":
      return "Budget limited";
    case "premature_stop_detected":
      return d
        ? `Premature stop re-nudged (${d})`
        : "Premature stop re-nudged";
    case "verification_started":
      return "Verification started";
    case "verification_completed":
      if (d === "achieved") return "Verification: Achieved";
      if (d === "not_achieved") return "Verification: NotAchieved";
      return "Verification completed";
    case "strategist_fired":
      return d ? `Strategist fired (${d})` : "Strategist fired";
    default:
      return d ? `${String(event)}: ${d}` : String(event);
  }
}

export function humanizeHistory(entries: GoalHistoryEntry[], limit = 8): string[] {
  const slice = entries.slice(-limit);
  return slice.map((e) => {
    const label = humanizeGoalEvent(e.event, e.detail);
    const ts = e.timestamp ? relativeTime(e.timestamp) : "";
    return ts ? `· ${label}  ${ts}` : `· ${label}`;
  });
}

function relativeTime(iso: string): string {
  try {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  } catch {
    return "";
  }
}

/**
 * Build display snapshot from orchestration + optional next-step.
 */
export function buildDisplaySnapshot(
  o: GoalOrchestration,
  opts?: {
    nextStep?: string | null;
    progressNote?: string | null;
    scratchPath?: string | null;
    verifyCap?: number | null;
  },
): GoalDisplaySnapshot {
  let nextStep = opts?.nextStep ?? null;
  if (nextStep == null && o.plan_file && existsSync(o.plan_file)) {
    try {
      const body = readFileSync(o.plan_file, "utf8");
      nextStep = extractFirstUnchecked(body);
    } catch {
      nextStep = null;
    }
  }

  return {
    objective: o.objective,
    status: o.status,
    phase: o.phase,
    goalId: o.goal_id,
    elapsedMs: o.elapsed_ms,
    workerRounds: o.total_worker_rounds,
    verifyAttempted: o.classifier_runs_attempted,
    verifyCap: opts?.verifyCap ?? o.classifier_max_runs,
    planning: Boolean(o.planning_in_flight) || o.phase === "planning",
    verifying: Boolean(o.verifying_in_flight),
    pauseMessage: o.pause_message,
    lastVerdict: o.last_classifier_verdict,
    nextStep,
    planPath: o.plan_file,
    scratchPath: opts?.scratchPath ?? null,
    progressNote: opts?.progressNote ?? null,
  };
}

/**
 * Rich `/goal status` card (markdown) — grok goal_detail content, TUI-native.
 */
export function formatGoalDetailCard(
  o: GoalOrchestration,
  opts?: {
    nextStep?: string | null;
    progressNote?: string | null;
    scratchPath?: string | null;
    verifyCap?: number | null;
  },
): string {
  const snap = buildDisplaySnapshot(o, opts);
  const lines: string[] = [];

  lines.push(`### Goal`);
  lines.push("");
  lines.push(`**${statusLine(snap)}** · ${formatElapsed(snap.elapsedMs)}`);
  lines.push("");
  lines.push(`> ${truncate(snap.objective, 200)}`);
  lines.push("");

  if (isPausedStatus(snap.status) && snap.pauseMessage) {
    lines.push(`**Reason:** ${snap.pauseMessage}`);
    lines.push("");
    if (snap.status === "blocked") {
      lines.push(
        `_Blocked goals are resumable after the environment changes — \`/goal resume\`._`,
      );
    } else {
      lines.push(`_\`/goal resume\` to continue · \`/goal clear\` to discard._`);
    }
    lines.push("");
  }

  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| Id | \`${snap.goalId}\` |`);
  lines.push(
    `| Rounds | worker ${snap.workerRounds} · verify ${snap.verifyAttempted}${snap.verifyCap != null ? `/${snap.verifyCap}` : ""} |`,
  );
  if (snap.lastVerdict) {
    lines.push(
      `| Last verdict | ${snap.lastVerdict === "achieved" ? "Achieved ✓" : "NotAchieved"} |`,
    );
  }
  if (snap.planPath) {
    lines.push(`| Plan | \`${snap.planPath}\` |`);
  }
  if (snap.scratchPath) {
    lines.push(`| Scratch | \`${snap.scratchPath}\` |`);
  }
  lines.push("");

  const next = snap.nextStep ?? GENERIC_NEXT_STEP;
  lines.push(`**Next step**`);
  lines.push(`- ${next}`);
  lines.push("");

  if (snap.progressNote) {
    lines.push(`**Latest progress**`);
    lines.push(`- ${snap.progressNote}`);
    lines.push("");
  }

  if (o.last_classifier_gaps?.trim()) {
    lines.push(`**Open verifier gaps**`);
    for (const g of o.last_classifier_gaps.split("\n").slice(0, 10)) {
      if (g.trim()) lines.push(g.startsWith("-") ? g : `- ${g}`);
    }
    lines.push("");
  }

  if (o.last_strategy_recommendation?.trim() || o.last_strategy_path) {
    lines.push(`**Strategist (advisory)**`);
    if (o.last_strategy_path) {
      lines.push(`- Note: \`${o.last_strategy_path}\``);
    }
    if (o.last_strategy_recommendation?.trim()) {
      lines.push(
        `> ${truncate(o.last_strategy_recommendation.trim(), 400)}`,
      );
    }
    lines.push("");
  }

  if (o.history.length) {
    lines.push(`**Recent history**`);
    for (const h of humanizeHistory(o.history, 8)) {
      lines.push(h);
    }
    lines.push("");
  }

  lines.push(
    `_Controls: \`/goal pause\` · \`/goal resume\` · \`/goal clear\` · \`/goal status\`_`,
  );

  return lines.join("\n");
}

/**
 * Short toast/notification bodies (grok chat notifications).
 */
export function formatGoalToast(
  kind:
    | "created"
    | "paused"
    | "resumed"
    | "complete"
    | "blocked"
    | "cleared"
    | "planning"
    | "verifying"
    | "not_achieved",
  detail?: string,
): string {
  switch (kind) {
    case "created":
      return detail
        ? `Goal set — ${truncate(detail, 80)}`
        : "Goal set";
    case "paused":
      return detail ? `Goal paused — ${detail}` : "Goal paused";
    case "resumed":
      return "Goal resumed";
    case "complete":
      return detail
        ? `Goal complete ✓ — ${truncate(detail, 100)}`
        : "Goal complete ✓";
    case "blocked":
      return detail
        ? `Goal blocked — ${detail}`
        : "Goal blocked";
    case "cleared":
      return "Goal cleared";
    case "planning":
      return "Goal · writing plan…";
    case "verifying":
      return detail
        ? `Goal · verifying ${detail}`
        : "Goal · verifying…";
    case "not_achieved":
      return detail
        ? `NotAchieved — ${truncate(detail, 100)}`
        : "NotAchieved — continuing with gaps";
  }
}

export function formatBlockedNotification(
  reason: string,
  detail?: string | null,
): string {
  const head = `Goal blocked: ${reason.trim()}`;
  if (detail?.trim()) return `${head}\n${detail.trim()}`;
  return head;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** Theme-ish severity for status chip color routing in chrome. */
export type GoalChromeTone = "active" | "paused" | "done" | "error" | "none";

export function goalChromeTone(
  status: GoalStatus | null | undefined,
): GoalChromeTone {
  if (!status) return "none";
  if (status === "active") return "active";
  if (status === "complete") return "done";
  if (status === "budget_limited" || status === "blocked") return "error";
  if (isPausedStatus(status)) return "paused";
  return "none";
}
