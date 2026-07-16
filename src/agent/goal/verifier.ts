/**
 * Adversarial multi-skeptic verification panel.
 * Independent votes aggregated; NotAchieved feeds gaps back; Achieved completes.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { GoalTracker } from "./tracker.js";
import {
  aggregateSkepticVotes,
  parseSkepticVerdictBody,
  type AggregateVerdict,
  type SkepticVote,
} from "./verdict.js";
import { verifierSystemPrompt } from "./prompts.js";
import {
  ensureSkepticScratch,
  goalScratchRoot,
  implementerScratchDir,
} from "./paths.js";

export interface VerifierSpawnerArgs {
  idx: number;
  systemPrompt: string;
  objective: string;
  planFile: string;
  implementerScratch: string;
  skepticScratch: string;
  detailsFile: string;
  verdictFile: string;
  priorGaps: string;
  finalResponse: string;
}

export type VerifierSpawner = (
  args: VerifierSpawnerArgs,
) => Promise<{ ok: boolean; body?: string; error?: string }>;

export interface RunVerifierPanelOptions {
  /** Number of skeptics (default 2; min 1). */
  panelSize?: number;
  /** Final implementer response text. */
  finalResponse?: string;
  spawner: VerifierSpawner;
}

export interface VerifierPanelResult {
  aggregate: AggregateVerdict;
  detailsPath: string;
  attempt: number;
}

/**
 * Run N independent skeptics and aggregate.
 */
export async function runVerifierPanel(
  tracker: GoalTracker,
  opts: RunVerifierPanelOptions,
): Promise<VerifierPanelResult | null> {
  const o = tracker.snapshotMut();
  if (!o || o.status !== "active") return null;

  if (!tracker.reserveClassifierAttempt()) {
    // Cap already hit
    return null;
  }

  const attempt = o.classifier_runs_attempted;
  const panelSize = Math.max(1, Math.min(opts.panelSize ?? 2, 5));
  const vid = o.verifier_id;
  const planFile = o.plan_file ?? tracker.planFilePath();
  const implScratch = implementerScratchDir(vid);
  const priorGaps = o.last_classifier_gaps ?? "";
  const finalResponse = opts.finalResponse ?? o.first_final_response ?? "";

  tracker.setVerifyingInFlight(true);
  tracker.setPhase("executing");

  const votes: SkepticVote[] = [];
  const root = goalScratchRoot(vid);
  mkdirSync(root, { recursive: true });

  for (let idx = 0; idx < panelSize; idx++) {
    const skepticScratch =
      ensureSkepticScratch(vid, idx) ?? join(root, `skeptic-${idx}`);
    const detailsFile = join(
      root,
      `goal-classifier-${vid}-${attempt}-skeptic-${idx}.md`,
    );
    const verdictFile = join(
      root,
      `goal-verifier-${vid}-${attempt}-skeptic-${idx}-verdict.md`,
    );

    const systemPrompt = verifierSystemPrompt({
      objective: o.objective,
      planFile,
      implementerScratch: implScratch,
      skepticScratch,
      detailsFile,
      verdictFile,
      priorGaps,
      finalResponse,
    });

    try {
      const r = await opts.spawner({
        idx,
        systemPrompt,
        objective: o.objective,
        planFile,
        implementerScratch: implScratch,
        skepticScratch,
        detailsFile,
        verdictFile,
        priorGaps,
        finalResponse,
      });

      let body = r.body;
      if (!body && existsSync(verdictFile)) {
        body = readFileSync(verdictFile, "utf8");
      } else if (!body && existsSync(detailsFile)) {
        body = readFileSync(detailsFile, "utf8");
      }

      if (!body?.trim()) {
        // Fail-closed: missing skeptic output = refute
        votes.push({
          idx,
          refuted: true,
          gaps: [
            `Skeptic ${idx} produced no verdict (fail-closed): ${r.error ?? "empty"}`,
          ],
        });
        writeFailClosed(detailsFile, verdictFile, idx, r.error);
        continue;
      }

      // Ensure verdict file exists for rescue
      if (!existsSync(verdictFile)) {
        mkdirSync(dirname(verdictFile), { recursive: true });
        writeFileSync(verdictFile, body, "utf8");
      }

      const vote = parseSkepticVerdictBody(body);
      vote.idx = idx;
      votes.push(vote);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      votes.push({
        idx,
        refuted: true,
        gaps: [`Skeptic ${idx} errored (fail-closed): ${msg}`],
      });
    }
  }

  const aggregate = aggregateSkepticVotes(votes);

  // Write canonical panel details
  const detailsPath = join(
    root,
    `goal-classifier-${vid}-${attempt}-panel.md`,
  );
  writeFileSync(
    detailsPath,
    formatPanelDetails(aggregate, attempt, panelSize),
    "utf8",
  );

  tracker.setVerifyingInFlight(false);
  return { aggregate, detailsPath, attempt };
}

function writeFailClosed(
  detailsFile: string,
  verdictFile: string,
  idx: number,
  error?: string,
): void {
  try {
    mkdirSync(dirname(detailsFile), { recursive: true });
    const body = [
      `# Skeptic ${idx} fail-closed`,
      ``,
      `refuted: true`,
      ``,
      `## Gaps`,
      `- Skeptic produced no usable verdict${error ? `: ${error}` : ""}`,
      ``,
    ].join("\n");
    writeFileSync(detailsFile, body, "utf8");
    writeFileSync(verdictFile, body, "utf8");
  } catch {
    /* ignore */
  }
}

function formatPanelDetails(
  agg: AggregateVerdict,
  attempt: number,
  panelSize: number,
): string {
  const lines = [
    `# Verifier panel — attempt ${attempt}`,
    ``,
    `Panel size: ${panelSize}`,
    `Verdict: ${agg.verdict}`,
    `Fingerprint: ${agg.fingerprint || "(none)"}`,
    ``,
    `## Gaps`,
    ...(agg.gaps.length
      ? agg.gaps.map((g) => `- ${g}`)
      : ["- (none)"]),
    ``,
    `## Votes`,
    ...agg.votes.map(
      (v) =>
        `- skeptic-${v.idx}: ${v.refuted ? "REFUTED" : "not refuted"}${v.contradiction ? " (contradiction)" : ""}`,
    ),
    ``,
    agg.gapsSummary,
  ];
  return lines.join("\n");
}

/**
 * Mock spawner factory for tests — returns fixed votes by index.
 */
export function mockVerifierSpawner(
  voteForIdx: (idx: number) => SkepticVote,
): VerifierSpawner {
  return async (args) => {
    const vote = voteForIdx(args.idx);
    const body = [
      `refuted: ${vote.refuted}`,
      ``,
      `## Gaps`,
      ...(vote.gaps.length ? vote.gaps.map((g) => `- ${g}`) : ["- (none)"]),
      vote.contradiction ? `\ncontradiction: true` : "",
    ].join("\n");
    mkdirSync(dirname(args.verdictFile), { recursive: true });
    writeFileSync(args.verdictFile, body, "utf8");
    writeFileSync(args.detailsFile, body, "utf8");
    return { ok: true, body };
  };
}
