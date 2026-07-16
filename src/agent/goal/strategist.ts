/**
 * Strategist-style restructure after repeated NotAchieved.
 * Writes advisory strategy note; never rewrites frozen acceptance criteria.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GoalTracker } from "./tracker.js";
import { strategistSystemPrompt } from "./prompts.js";

export type StrategistSpawner = (args: {
  objective: string;
  planFile: string;
  strategyFile: string;
  systemPrompt: string;
  gaps: string;
  streak: number;
}) => Promise<{ ok: boolean; body?: string; error?: string }>;

export interface StrategistResult {
  fired: boolean;
  strategyPath: string | null;
  recommendation: string | null;
  error?: string;
}

/**
 * Maybe fire strategist based on tracker streak; write strategy.md.
 */
export async function maybeRunStrategist(
  tracker: GoalTracker,
  spawner: StrategistSpawner | null,
  opts?: { force?: boolean; every?: number },
): Promise<StrategistResult> {
  const strategyPath = tracker.strategyFilePath();
  const claimed = opts?.force
    ? tracker.snapshotMut()?.consecutive_not_achieved ?? 0
    : tracker.claimStrategistFire(opts?.every);

  if (claimed == null && !opts?.force) {
    return { fired: false, strategyPath: null, recommendation: null };
  }

  const streak =
    typeof claimed === "number"
      ? claimed
      : tracker.snapshotMut()?.consecutive_not_achieved ?? 0;

  if (opts?.force && streak > 0) {
    // Ensure cap bonus applies when forced
    tracker.claimStrategistFire(1);
  }

  const o = tracker.snapshotMut();
  if (!o) {
    return { fired: false, strategyPath: null, recommendation: null };
  }

  const gaps = o.last_classifier_gaps ?? "";
  const planFile = o.plan_file ?? tracker.planFilePath();
  const systemPrompt = strategistSystemPrompt({
    objective: o.objective,
    planFile,
    strategyFile: strategyPath,
    gaps,
    streak,
  });

  if (!spawner) {
    const body = defaultStrategyNote(o.objective, gaps, streak);
    mkdirSync(dirname(strategyPath), { recursive: true });
    writeFileSync(strategyPath, body, "utf8");
    const rec = extractRecommendation(body);
    tracker.recordStrategyRecommendation(strategyPath, rec);
    return {
      fired: true,
      strategyPath,
      recommendation: rec,
    };
  }

  try {
    const r = await spawner({
      objective: o.objective,
      planFile,
      strategyFile: strategyPath,
      systemPrompt,
      gaps,
      streak,
    });
    let body = r.body;
    if (!body && existsSync(strategyPath)) {
      body = readFileSync(strategyPath, "utf8");
    }
    if (!body?.trim()) {
      body = defaultStrategyNote(o.objective, gaps, streak);
    }
    mkdirSync(dirname(strategyPath), { recursive: true });
    writeFileSync(strategyPath, body, "utf8");
    const rec = extractRecommendation(body);
    tracker.recordStrategyRecommendation(strategyPath, rec);
    return { fired: true, strategyPath, recommendation: rec };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const body = defaultStrategyNote(o.objective, gaps, streak);
    mkdirSync(dirname(strategyPath), { recursive: true });
    writeFileSync(strategyPath, body, "utf8");
    const rec = extractRecommendation(body);
    tracker.recordStrategyRecommendation(strategyPath, rec);
    return {
      fired: true,
      strategyPath,
      recommendation: rec,
      error: msg,
    };
  }
}

function defaultStrategyNote(
  objective: string,
  gaps: string,
  streak: number,
): string {
  return [
    `# Strategy note (auto)`,
    ``,
    `After ${streak} consecutive NotAchieved verdict(s) on:`,
    `> ${objective.slice(0, 200)}`,
    ``,
    `## What's stuck`,
    gaps.trim() || "- Verifier rejected without specific gaps; re-check acceptance criteria and evidence.",
    ``,
    `## Different approach (same criteria)`,
    `- Re-read the plan acceptance criteria and verification plan line-by-line.`,
    `- Produce honest tests that drive the real shipped entry points.`,
    `- Capture run output under the implementer scratch dir; do not claim complete without evidence.`,
    `- Fix one gap at a time; update the task checklist as you go.`,
    ``,
    `## Stop doing`,
    `- Claiming complete without running the verification plan.`,
    `- Test theater (hardcoded expects, mocking the unit under test).`,
    `- Silently weakening plan criteria.`,
    ``,
  ].join("\n");
}

function extractRecommendation(body: string): string {
  // Prefer ## Different approach section, else first 600 chars
  const m = body.match(
    /##\s*Different approach[\s\S]*?(?=\n##\s|$)/i,
  );
  const chunk = (m?.[0] ?? body).trim();
  return chunk.slice(0, 800);
}
