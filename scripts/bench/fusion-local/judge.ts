/**
 * Grok judge call for fusion suite (combined-harness §5).
 */

import { chatComplete } from "../../../src/llm/client.js";
import type { ProviderId } from "../../../src/auth/types.js";
import type { CaseDef } from "./parse.js";
import type { HardChecksResult, ToolTraceEntry } from "./hard-checks.js";

export interface JudgeScore {
  score: number;
  pass: boolean;
  dimensions: Record<string, number | null>;
  rationale: string;
  issues: string[];
  highlights: string[];
}

export interface JudgeInput {
  caseDef: CaseDef;
  hard: HardChecksResult;
  trace: ToolTraceEntry[];
  finalAnswer: string;
  workspaceSnapshot: string;
  agentModel: string;
  turns: number;
  durationMs: number;
  agentStatus: string;
  judgeSystem: string;
  provider: ProviderId;
  model: string;
}

export async function runJudge(input: JudgeInput): Promise<JudgeScore> {
  const packet = buildJudgePacket(input);
  const resp = await chatComplete({
    provider: input.provider,
    model: input.model,
    messages: [
      { role: "system", content: input.judgeSystem },
      { role: "user", content: packet },
    ],
    temperature: 0,
    stream: false,
    applyNativeReasoning: false,
    max_tokens: 2048,
    label: `judge.${input.caseDef.id}`,
  });

  return parseJudgeJson(resp.content, input.caseDef.pass_threshold);
}

export function buildJudgePacket(input: JudgeInput): string {
  const c = input.caseDef;
  return [
    "## Meta",
    `- case_id: ${c.id}`,
    `- title: ${c.title}`,
    `- category: ${c.category}`,
    `- difficulty: ${c.difficulty}`,
    `- pass_threshold: ${c.pass_threshold}`,
    `- agent_model: ${input.agentModel}`,
    `- turns: ${input.turns}`,
    `- duration_ms: ${input.durationMs}`,
    `- agent_status: ${input.agentStatus}`,
    "",
    "## Task (agent saw this)",
    c.task,
    "",
    "## Context (agent saw this)",
    c.context,
    "",
    "## Constraints (agent saw this)",
    c.constraints,
    "",
    "## Success criteria (hidden from agent)",
    c.success_criteria,
    "",
    "## Expected tool pattern (hidden from agent)",
    c.expected_tool_pattern,
    "",
    "## Judge rubric",
    c.judge_rubric,
    "",
    "## Hard check results",
    "```json",
    JSON.stringify(input.hard, null, 2),
    "```",
    "",
    "## Tool trace",
    "```json",
    JSON.stringify(input.trace, null, 2),
    "```",
    "",
    "## Final answer",
    input.finalAnswer || "(empty)",
    "",
    "## Workspace snapshot",
    input.workspaceSnapshot,
    "",
    "Respond with JSON only, matching the score schema.",
  ].join("\n");
}

export function parseJudgeJson(raw: string, passThreshold: number): JudgeScore {
  const text = raw.trim();
  let parsed: unknown;
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    parsed = JSON.parse(fenced?.[1]?.trim() ?? text);
  } catch {
    // Try to extract first {...}
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) {
      return {
        score: 0,
        pass: false,
        dimensions: {},
        rationale: `Failed to parse judge JSON: ${text.slice(0, 200)}`,
        issues: ["judge_parse_error"],
        highlights: [],
      };
    }
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return {
        score: 0,
        pass: false,
        dimensions: {},
        rationale: `Failed to parse judge JSON: ${text.slice(0, 200)}`,
        issues: ["judge_parse_error"],
        highlights: [],
      };
    }
  }

  const o = parsed as Record<string, unknown>;
  const score = clampScore(Number(o.score ?? 0));
  const dimensions =
    o.dimensions && typeof o.dimensions === "object"
      ? (o.dimensions as Record<string, number | null>)
      : {};
  const pass =
    typeof o.pass === "boolean" ? o.pass : score >= passThreshold;

  return {
    score,
    pass,
    dimensions,
    rationale: String(o.rationale ?? ""),
    issues: Array.isArray(o.issues) ? o.issues.map(String) : [],
    highlights: Array.isArray(o.highlights) ? o.highlights.map(String) : [],
  };
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, Math.round(n)));
}

export function combineScores(
  hard: HardChecksResult,
  judge: JudgeScore,
  passThreshold: number,
  hardWeight = 0.4,
  judgeWeight = 0.6,
): { combined_score: number; passed: boolean; hard_rate: number } {
  const total = Math.max(hard.checks.length, 1);
  const passedCount = hard.checks.filter((c) => c.passed).length;
  const hard_rate = hard.checks.length === 0 ? 1 : passedCount / total;
  const judge_norm = judge.score / 10;
  const combined_score =
    Math.round((hardWeight * hard_rate + judgeWeight * judge_norm) * 1000) /
    1000;
  const passed = hard.passed && judge.score >= passThreshold;
  return { combined_score, passed, hard_rate };
}
