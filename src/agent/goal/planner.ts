/**
 * Fail-closed plan-writer path.
 * Injectable spawner for production (subagent) or mocks (tests).
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GoalTracker } from "./tracker.js";
import {
  fallbackPlanMarkdown,
  plannerSystemPrompt,
  sanitizePlanMarkdown,
} from "./prompts.js";
import { snapshotPlanBaseline, planPath } from "./paths.js";

export interface PlanWriterResult {
  ok: boolean;
  planPath: string;
  /** true when fallback plan was used */
  fallback: boolean;
  error?: string;
  body?: string;
}

/**
 * Spawner writes a plan by any means and returns the plan body
 * (or writes directly to planPath).
 */
export type PlanWriterSpawner = (args: {
  objective: string;
  planPath: string;
  systemPrompt: string;
}) => Promise<{ ok: boolean; body?: string; error?: string }>;

/**
 * Run plan-writer. Fail-closed: missing/empty plan → fallback plan or abort.
 * When `allowFallback` is true (default), a fallback plan is written so the
 * goal can proceed; when false, returns ok:false without writing.
 */
export async function runPlanWriter(
  tracker: GoalTracker,
  spawner: PlanWriterSpawner | null,
  opts?: { allowFallback?: boolean },
): Promise<PlanWriterResult> {
  const allowFallback = opts?.allowFallback !== false;
  const objective = tracker.objective() ?? "";
  const pPath = tracker.planFilePath();
  const systemPrompt = plannerSystemPrompt(pPath);

  tracker.setPhase("planning");
  tracker.setPlanningInFlight(true);

  let body: string | undefined;
  let error: string | undefined;
  let usedFallback = false;

  try {
    if (spawner) {
      const r = await spawner({ objective, planPath: pPath, systemPrompt });
      if (r.ok && r.body?.trim()) {
        body = sanitizePlanMarkdown(r.body);
      } else if (r.ok && existsSync(pPath)) {
        // Spawner wrote the file directly
        const { readFileSync } = await import("node:fs");
        body = sanitizePlanMarkdown(readFileSync(pPath, "utf8"));
      } else {
        error = r.error ?? "plan writer returned empty";
      }
    } else {
      error = "no plan writer spawner";
    }

    if (body?.trim()) {
      body = sanitizePlanMarkdown(body);
    }

    if (!body?.trim() || !looksLikePlan(body)) {
      if (!allowFallback) {
        tracker.setPlanningInFlight(false);
        tracker.setPhase("idle");
        tracker.pauseWithMessage(
          "infra",
          error ?? "Plan writer produced empty/invalid plan (fail-closed).",
        );
        return {
          ok: false,
          planPath: pPath,
          fallback: false,
          error: error ?? "empty plan",
        };
      }
      body = fallbackPlanMarkdown(objective);
      usedFallback = true;
    }

    mkdirSync(dirname(pPath), { recursive: true });
    writeFileSync(pPath, body, "utf8");
    tracker.setPlanFile(pPath);

    const baseline = snapshotPlanBaseline(
      tracker.sessionDirectory,
      pPath,
    );
    if (baseline) tracker.setPlanBaseline(baseline);

    tracker.setPlanningInFlight(false);
    tracker.setPhase("executing");
    return {
      ok: true,
      planPath: pPath,
      fallback: usedFallback,
      body,
      error: usedFallback ? error : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    tracker.setPlanningInFlight(false);
    if (allowFallback) {
      const fb = fallbackPlanMarkdown(objective);
      mkdirSync(dirname(pPath), { recursive: true });
      writeFileSync(pPath, fb, "utf8");
      tracker.setPlanFile(pPath);
      const baseline = snapshotPlanBaseline(tracker.sessionDirectory, pPath);
      if (baseline) tracker.setPlanBaseline(baseline);
      tracker.setPhase("executing");
      return {
        ok: true,
        planPath: pPath,
        fallback: true,
        body: fb,
        error: msg,
      };
    }
    tracker.setPhase("idle");
    tracker.pauseWithMessage("infra", `Plan writer failed: ${msg}`);
    return { ok: false, planPath: pPath, fallback: false, error: msg };
  }
}

/** Structural check: plan has acceptance criteria + verification sections. */
export function looksLikePlan(body: string): boolean {
  const lower = body.toLowerCase();
  const hasCriteria =
    lower.includes("acceptance criteria") ||
    /##\s*acceptance/i.test(body);
  const hasVerify =
    lower.includes("verification plan") ||
    /##\s*verification/i.test(body);
  return hasCriteria && hasVerify && body.trim().length >= 80;
}

/** Sync helper for tests: write plan body and wire tracker. */
export function installPlanForTests(
  tracker: GoalTracker,
  body: string,
): string {
  const pPath = planPath(tracker.sessionDirectory);
  mkdirSync(dirname(pPath), { recursive: true });
  writeFileSync(pPath, sanitizePlanMarkdown(body), "utf8");
  tracker.setPlanFile(pPath);
  const baseline = snapshotPlanBaseline(tracker.sessionDirectory, pPath);
  if (baseline) tracker.setPlanBaseline(baseline);
  return pPath;
}
