/**
 * Production spawners for plan-writer / verifier / strategist.
 * Use runHeadlessTurn with the session model when available;
 * injectable chatImpl for tests.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderId } from "../../auth/types.js";
import { chatComplete, type ChatRequest, type ChatResult, type StreamHandlers } from "../../llm/client.js";
import { runHeadlessTurn } from "../turn.js";
import type { PlanWriterSpawner } from "./planner.js";
import type { VerifierSpawner } from "./verifier.js";
import type { StrategistSpawner } from "./strategist.js";
import { sanitizePlanMarkdown } from "./prompts.js";

export type GoalChatImpl = (
  req: ChatRequest,
  handlers?: StreamHandlers,
) => Promise<ChatResult>;

export interface GoalSpawnerContext {
  provider: ProviderId;
  model: string;
  cwd: string;
  chatImpl?: GoalChatImpl;
  /** Abort long planner/verifier runs */
  signal?: AbortSignal;
  /** Extra absolute roots for file tools (goal dir / scratch). */
  allowedRoots?: string[];
}

async function runRoleTurn(args: {
  ctx: GoalSpawnerContext;
  system: string;
  user: string;
  label: string;
  /** read-only roles: no shell/write except allowed write paths handled outside */
  tools?: boolean;
  maxSteps?: number;
  allowedRoots?: string[];
}): Promise<{ ok: boolean; text: string; error?: string }> {
  try {
    const result = await runHeadlessTurn({
      provider: args.ctx.provider,
      model: args.ctx.model,
      cwd: args.ctx.cwd,
      systemPrompt: args.system,
      tools: args.tools !== false,
      headless: true,
      headlessMessages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      maxSteps: args.maxSteps ?? 12,
      label: args.label,
      chatImpl: args.ctx.chatImpl ?? chatComplete,
      abortSignal: args.ctx.signal,
      autoApprove: true,
      allowedRoots: args.allowedRoots ?? args.ctx.allowedRoots,
      // Plan writer / skeptics: prefer fs+search+web; shell allowed for cheap checks
      toolsets:
        args.tools === false
          ? []
          : ["fs", "search", "web", "meta", "shell"],
    });
    if (result.error) {
      return { ok: false, text: result.finalText, error: result.error };
    }
    return { ok: true, text: result.finalText };
  } catch (e) {
    return {
      ok: false,
      text: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function createPlanWriterSpawner(
  ctx: GoalSpawnerContext,
): PlanWriterSpawner {
  return async ({ objective, planPath, systemPrompt }) => {
    mkdirSync(dirname(planPath), { recursive: true });
    const user = [
      `OBJECTIVE:\n${objective}`,
      ``,
      `Write the full structured plan to: ${planPath}`,
      `Use the write tool with ONLY clean Markdown (no tool XML / DSML). Then stop.`,
    ].join("\n");

    const r = await runRoleTurn({
      ctx,
      system: systemPrompt,
      user,
      label: "goal-plan-writer",
      maxSteps: 16,
      allowedRoots: [dirname(planPath), ...(ctx.allowedRoots ?? [])],
    });

    if (existsSync(planPath)) {
      const body = sanitizePlanMarkdown(readFileSync(planPath, "utf8"));
      if (body.trim().length >= 80) {
        writeFileSync(planPath, body, "utf8");
        return { ok: true, body };
      }
    }

    // If model put plan in final text as markdown, salvage
    if (r.text && /acceptance criteria/i.test(r.text)) {
      const start = r.text.search(/^#\s+/m);
      const raw = (start >= 0 ? r.text.slice(start) : r.text).trim();
      const body = sanitizePlanMarkdown(raw);
      if (body.length >= 80) {
        mkdirSync(dirname(planPath), { recursive: true });
        writeFileSync(planPath, body, "utf8");
        return { ok: true, body };
      }
    }

    return {
      ok: false,
      error: r.error ?? "plan writer did not produce plan.md",
      body: r.text,
    };
  };
}

export function createVerifierSpawner(
  ctx: GoalSpawnerContext,
): VerifierSpawner {
  return async (args) => {
    const user = [
      `Run adversarial verification now.`,
      `Write details to: ${args.detailsFile}`,
      `Write verdict to: ${args.verdictFile}`,
      `Verdict file MUST include a line: refuted: true|false and ## Gaps`,
    ].join("\n");

    const roots = [
      dirname(args.detailsFile),
      dirname(args.verdictFile),
      args.implementerScratch,
      args.skepticScratch,
      dirname(args.planFile),
      ...(ctx.allowedRoots ?? []),
    ].filter(Boolean);

    const r = await runRoleTurn({
      ctx,
      system: args.systemPrompt,
      user,
      label: `goal-skeptic-${args.idx}`,
      maxSteps: 14,
      allowedRoots: roots,
    });

    if (existsSync(args.verdictFile)) {
      return { ok: true, body: readFileSync(args.verdictFile, "utf8") };
    }
    if (existsSync(args.detailsFile)) {
      const body = readFileSync(args.detailsFile, "utf8");
      mkdirSync(dirname(args.verdictFile), { recursive: true });
      writeFileSync(args.verdictFile, body, "utf8");
      return { ok: true, body };
    }

    // Salvage from text
    if (r.text && /refuted\s*:/i.test(r.text)) {
      mkdirSync(dirname(args.verdictFile), { recursive: true });
      writeFileSync(args.verdictFile, r.text, "utf8");
      writeFileSync(args.detailsFile, r.text, "utf8");
      return { ok: true, body: r.text };
    }

    return {
      ok: false,
      error: r.error ?? "skeptic produced no verdict",
      body: r.text,
    };
  };
}

export function createStrategistSpawner(
  ctx: GoalSpawnerContext,
): StrategistSpawner {
  return async (args) => {
    const user = [
      `Write the advisory strategy note to: ${args.strategyFile}`,
      `Do NOT edit the plan's acceptance criteria.`,
    ].join("\n");

    const r = await runRoleTurn({
      ctx,
      system: args.systemPrompt,
      user,
      label: "goal-strategist",
      maxSteps: 10,
      allowedRoots: [
        dirname(args.strategyFile),
        dirname(args.planFile),
        ...(ctx.allowedRoots ?? []),
      ],
    });

    if (existsSync(args.strategyFile)) {
      return { ok: true, body: readFileSync(args.strategyFile, "utf8") };
    }
    if (r.text?.trim()) {
      mkdirSync(dirname(args.strategyFile), { recursive: true });
      writeFileSync(args.strategyFile, r.text, "utf8");
      return { ok: true, body: r.text };
    }
    return {
      ok: false,
      error: r.error ?? "strategist produced no note",
    };
  };
}

/**
 * Structural multi-skeptic fallback when no LLM (or as skeptic-1 backup).
 * Fail-closed: empty scratch / missing plan → refute.
 */
export function createStructuralVerifierSpawner(): VerifierSpawner {
  return async (args) => {
    const gaps: string[] = [];
    try {
      if (!existsSync(args.planFile)) {
        gaps.push("Plan file missing on disk.");
      } else {
        const body = readFileSync(args.planFile, "utf8");
        if (!/acceptance criteria/i.test(body)) {
          gaps.push("Plan lacks acceptance criteria section.");
        }
        if (!/verification plan/i.test(body)) {
          gaps.push("Plan lacks verification plan section.");
        }
      }
    } catch {
      gaps.push("Could not read plan file.");
    }

    try {
      const { readdirSync } = await import("node:fs");
      const entries = readdirSync(args.implementerScratch);
      if (!entries.length) {
        gaps.push(
          "Implementer scratch is empty — capture verification output there.",
        );
      }
    } catch {
      gaps.push("Implementer scratch not readable.");
    }

    // Skeptic diversity: odd indices are slightly stricter about FINAL_RESPONSE
    if (args.idx % 2 === 1 && !args.finalResponse.trim()) {
      gaps.push("No final implementer response to audit.");
    }

    const refuted = gaps.length > 0;
    const body = [
      `refuted: ${refuted}`,
      ``,
      `## Gaps`,
      ...(refuted ? gaps.map((g) => `- ${g}`) : ["- (none)"]),
      ``,
      `## Notes`,
      `Structural skeptic ${args.idx} (audit-only, fail-closed).`,
    ].join("\n");

    mkdirSync(dirname(args.verdictFile), { recursive: true });
    writeFileSync(args.verdictFile, body, "utf8");
    writeFileSync(args.detailsFile, body, "utf8");
    return { ok: true, body };
  };
}

/**
 * Hybrid panel: skeptic 0 = LLM (when ctx provided), others structural
 * OR all structural when no LLM ctx.
 */
export function createHybridVerifierSpawner(
  ctx: GoalSpawnerContext | null,
): VerifierSpawner {
  const structural = createStructuralVerifierSpawner();
  const llm = ctx ? createVerifierSpawner(ctx) : null;
  return async (args) => {
    if (llm && args.idx === 0) {
      const r = await llm(args);
      if (r.ok && r.body?.trim()) return r;
      // Fall back to structural if LLM skeptic fails
    }
    return structural(args);
  };
}
