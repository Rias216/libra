/**
 * Session-level goal spawner binding + auth-gate helpers.
 * Extracted so CLI and tests share the same rebind path.
 */

import type { ProviderId } from "../../auth/types.js";
import type { GoalOrchestrator } from "./orchestrator.js";
import {
  createHybridVerifierSpawner,
  createPlanWriterSpawner,
  createStrategistSpawner,
  type GoalSpawnerContext,
} from "./spawners.js";

export interface SessionAuthSnapshot {
  provider: ProviderId | string;
  model: string;
  /** True when a live token exists for the provider. */
  hasToken: boolean;
}

/**
 * Build spawner context from current session auth, or null when unauthed.
 */
export function resolveGoalSpawnerContext(
  auth: SessionAuthSnapshot,
  cwd = process.cwd(),
): GoalSpawnerContext | null {
  const model = auth.model?.trim() ?? "";
  const provider = auth.provider as ProviderId;
  if (
    !auth.hasToken ||
    !model ||
    model === "unset" ||
    model === "libra-mock" ||
    model === "libra-demo" ||
    !provider ||
    provider === ("none" as ProviderId)
  ) {
    return null;
  }
  return { provider, model, cwd };
}

/**
 * Rebind plan / verifier / strategist spawners from the current auth snapshot.
 * Always call on resume and before continuation so post-login upgrades work.
 */
export function rebindGoalSpawners(
  orch: GoalOrchestrator,
  ctx: GoalSpawnerContext | null,
): {
  hasLlmPlan: boolean;
  hasLlmStrategist: boolean;
  hasHybridVerifier: boolean;
} {
  orch.setSpawners({
    plan: ctx ? createPlanWriterSpawner(ctx) : null,
    verifier: createHybridVerifierSpawner(ctx),
    strategist: ctx ? createStrategistSpawner(ctx) : null,
  });
  return {
    hasLlmPlan: ctx != null,
    hasLlmStrategist: ctx != null,
    hasHybridVerifier: true,
  };
}

/**
 * After a successful plan write without live auth: pause so `/goal resume`
 * is the documented next step (resume no-ops on already-active goals).
 * Returns the status lines / user message for the surface.
 */
export function pauseGoalAwaitingAuth(
  orch: GoalOrchestrator,
  reason =
    "No live model — /login + /model, then /goal resume to start the loop.",
): { paused: boolean; message: string } {
  if (!orch.hasGoal()) {
    return { paused: false, message: "No goal to pause." };
  }
  if (orch.isActive()) {
    const ok = orch.pause("user", reason);
    return {
      paused: ok,
      message: ok
        ? reason
        : "Could not pause goal while awaiting auth.",
    };
  }
  // Already paused — refresh pause message if possible
  return {
    paused: true,
    message: reason,
  };
}

/**
 * Prepare resume / re-kick after login:
 * 1. Rebind spawners from current auth
 * 2. If paused, resume
 * 3. Report whether the autonomous loop should start
 *
 * When the goal is already active (legacy / race), still rebinds and
 * requests loop start so post-login is not a dead end.
 */
export function prepareGoalContinue(
  orch: GoalOrchestrator,
  auth: SessionAuthSnapshot,
  cwd = process.cwd(),
): {
  ok: boolean;
  shouldStartLoop: boolean;
  rebound: ReturnType<typeof rebindGoalSpawners>;
  message: string;
  spawnerCtx: GoalSpawnerContext | null;
} {
  const spawnerCtx = resolveGoalSpawnerContext(auth, cwd);
  const rebound = rebindGoalSpawners(orch, spawnerCtx);

  if (!orch.hasGoal()) {
    return {
      ok: false,
      shouldStartLoop: false,
      rebound,
      message: "No goal to resume.",
      spawnerCtx,
    };
  }

  if (!spawnerCtx) {
    // Still no auth — ensure paused so user can resume later
    pauseGoalAwaitingAuth(orch);
    return {
      ok: false,
      shouldStartLoop: false,
      rebound,
      message:
        "Still no live model — /login + /model, then /goal resume.",
      spawnerCtx,
    };
  }

  if (!orch.isActive()) {
    if (!orch.resume()) {
      return {
        ok: false,
        shouldStartLoop: false,
        rebound,
        message: "Could not resume goal (terminal state?).",
        spawnerCtx,
      };
    }
    return {
      ok: true,
      shouldStartLoop: true,
      rebound,
      message: "Goal resumed — continuing…",
      spawnerCtx,
    };
  }

  // Already active: rebind was the critical fix; start loop if not running.
  return {
    ok: true,
    shouldStartLoop: true,
    rebound,
    message: "Goal active — starting / continuing autonomous loop…",
    spawnerCtx,
  };
}

/**
 * Status suffix after createGoal depending on auth.
 */
export function goalCreateStatusSuffix(args: {
  createdOk: boolean;
  hasAuth: boolean;
}): string {
  if (!args.createdOk) {
    return "\n\nGoal did not start (fail-closed plan).";
  }
  if (!args.hasAuth) {
    return (
      "\n\nPlan ready; goal paused awaiting auth. " +
      "`/login` + `/model`, then `/goal resume` to enter the execute→verify loop."
    );
  }
  return "\n\nEntering autonomous execute→verify loop…";
}

/** Test/inspection: whether orchestrator currently has bound spawners. */
export function inspectSpawners(orch: GoalOrchestrator): {
  plan: boolean;
  strategist: boolean;
  verifier: boolean;
} {
  return orch.spawnerPresence();
}
