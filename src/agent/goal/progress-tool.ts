/**
 * update_goal progress tool — model-facing completed / message / blocked_reason.
 * Claiming completed:true does NOT end the goal; the harness runs verification.
 */

import type { OpenAITool } from "../../toolcalling/schema.js";
import { GOAL_TOOL_NAME } from "./prompts.js";
import type { GoalTracker } from "./tracker.js";

export { GOAL_TOOL_NAME };

export interface UpdateGoalInput {
  completed?: boolean | null;
  message?: string | null;
  blocked_reason?: string | null;
}

export type UpdateGoalAck =
  | { kind: "progress"; summary: string }
  | { kind: "blocked"; summary: string; reason: string }
  | { kind: "completed_queued"; summary: string }
  | { kind: "rejected"; summary: string; code: string };

export const UPDATE_GOAL_SCHEMA: OpenAITool = {
  type: "function",
  function: {
    name: GOAL_TOOL_NAME,
    description: [
      "Report progress on the active goal. Use the parameters to log a status message,",
      "mark the goal completed, or flag that you're blocked.",
      "",
      "Usage notes:",
      "- Set completed: true ONLY when the goal is fully achieved. This does not end",
      "  the goal on its own — the harness runs adversarial verification against the plan.",
      "- Use message for progress notes or a completion summary.",
      "- Set blocked_reason only when truly stuck after 3+ consecutive failed attempts.",
      "  blocked_reason is a FAILURE signal — never put success text there.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        completed: {
          type: "boolean",
          description:
            "Set to true ONLY when the goal is fully achieved. The harness verifies before ending goal mode.",
        },
        message: {
          type: "string",
          description:
            "Optional short message logged as progress. Use with completed:true for a completion summary.",
        },
        blocked_reason: {
          type: "string",
          description:
            "Set only when truly stuck after multiple failed attempts. Pauses the goal as blocked.",
        },
      },
      required: [],
    },
  },
};

export function isGoalTool(name: string): boolean {
  const k = name.trim().toLowerCase();
  return k === GOAL_TOOL_NAME || k === "updategoal" || k === "goal_update";
}

export function parseUpdateGoalInput(
  args: Record<string, unknown>,
): UpdateGoalInput {
  const completed =
    args.completed === true
      ? true
      : args.completed === false
        ? false
        : undefined;
  const message =
    args.message != null
      ? String(args.message)
      : args.status != null
        ? String(args.status)
        : undefined;
  const blocked_reason =
    args.blocked_reason != null
      ? String(args.blocked_reason)
      : args.blockedReason != null
        ? String(args.blockedReason)
        : undefined;
  return { completed, message, blocked_reason };
}

export function buildUpdateGoalSummary(input: UpdateGoalInput): string {
  if (input.blocked_reason?.trim()) {
    const base = `Goal blocked: ${input.blocked_reason.trim()}`;
    return input.message?.trim()
      ? `${base} (${input.message.trim()})`
      : `${base}.`;
  }
  if (input.completed === true) {
    return input.message?.trim()
      ? `Completion claimed: ${input.message.trim()}`
      : "Completion claimed; harness will verify against the plan.";
  }
  if (input.message?.trim()) {
    return `Progress: ${input.message.trim()}`;
  }
  return "Goal update recorded (no fields set).";
}

/**
 * Apply update_goal against tracker.
 * completed:true returns completed_queued — caller must run verifier.
 * Does NOT call tracker.complete() here.
 */
export function applyUpdateGoal(
  tracker: GoalTracker,
  input: UpdateGoalInput,
): UpdateGoalAck {
  if (!tracker.hasGoal()) {
    return {
      kind: "rejected",
      summary: "No active goal — update_goal is only available in goal mode.",
      code: "no_goal",
    };
  }

  const status = tracker.status();
  const summary = buildUpdateGoalSummary(input);

  if (input.blocked_reason?.trim()) {
    if (status !== "active") {
      return {
        kind: "rejected",
        summary: `blocked_reason ignored: goal is ${status}, not active.`,
        code: "goal_update_blocked_against_non_active",
      };
    }
    const reason = input.blocked_reason.trim();
    tracker.pauseWithMessage("verification", reason);
    return { kind: "blocked", summary, reason };
  }

  if (input.completed === true) {
    if (status !== "active") {
      return {
        kind: "rejected",
        summary: `completed:true ignored: goal is ${status}, not active.`,
        code: "goal_update_completed_against_non_active",
      };
    }
    // Queue for adversarial verification — do not trust the model alone.
    return {
      kind: "completed_queued",
      summary:
        summary +
        " Verification panel will run; do not assume the goal is finished until you receive a verdict.",
    };
  }

  // Progress message only
  return { kind: "progress", summary };
}

export function formatUpdateGoalToolResult(ack: UpdateGoalAck): {
  ok: boolean;
  output: string;
} {
  if (ack.kind === "rejected") {
    return { ok: false, output: JSON.stringify(ack) };
  }
  return {
    ok: true,
    output: JSON.stringify({
      success: true,
      kind: ack.kind,
      summary: ack.summary,
    }),
  };
}
