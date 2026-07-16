/**
 * Verification verdict aggregation + gap fingerprint for stall detection.
 */

import type { GoalClassifierVerdict } from "./types.js";

export interface SkepticVote {
  /** Index in the panel */
  idx: number;
  /** true = refuted (goal NOT achieved) */
  refuted: boolean;
  /** Actionable gap lines */
  gaps: string[];
  /** Optional free-form details */
  details?: string;
  /** True when skeptic classifies gaps as environment contradiction / unblockable */
  contradiction?: boolean;
}

export interface AggregateVerdict {
  verdict: GoalClassifierVerdict;
  gaps: string[];
  gapsSummary: string;
  fingerprint: string;
  /** All skeptics flagged unblockable contradiction */
  allContradiction: boolean;
  votes: SkepticVote[];
}

/**
 * Normalize gap text for fingerprinting (lower, collapse ws, strip bullets).
 */
export function normalizeGapLine(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .replace(/^[-*+]\s+/, "")
    .replace(/\s+/g, " ");
}

/**
 * Stable fingerprint of a gap set — order-independent.
 */
export function gapFingerprint(gaps: string[]): string {
  const norms = gaps
    .map(normalizeGapLine)
    .filter((g) => g.length > 0)
    .sort();
  // Simple stable hash
  const joined = norms.join("|");
  let h = 2166136261;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + ":" + norms.length;
}

/**
 * Aggregate N skeptic votes: any refute → NotAchieved; none → Achieved.
 * Default to NotAchieved when panel is empty (fail-closed).
 */
export function aggregateSkepticVotes(votes: SkepticVote[]): AggregateVerdict {
  if (!votes.length) {
    return {
      verdict: "not_achieved",
      gaps: ["Verification panel returned no votes (fail-closed)."],
      gapsSummary:
        "Verification panel returned no votes — treat as NotAchieved.",
      fingerprint: gapFingerprint([
        "Verification panel returned no votes (fail-closed).",
      ]),
      allContradiction: false,
      votes: [],
    };
  }

  const refuters = votes.filter((v) => v.refuted);
  if (refuters.length === 0) {
    return {
      verdict: "achieved",
      gaps: [],
      gapsSummary: "",
      fingerprint: "",
      allContradiction: false,
      votes,
    };
  }

  const gaps: string[] = [];
  for (const v of refuters) {
    if (v.gaps.length) {
      for (const g of v.gaps) gaps.push(g);
    } else if (v.details?.trim()) {
      gaps.push(v.details.trim().slice(0, 400));
    } else {
      gaps.push(`Skeptic ${v.idx} refuted without specific gaps.`);
    }
  }

  const unique = dedupeGaps(gaps);
  const allContradiction =
    refuters.length > 0 && refuters.every((v) => v.contradiction === true);

  return {
    verdict: "not_achieved",
    gaps: unique,
    gapsSummary: buildGapsSummary(unique, refuters),
    fingerprint: gapFingerprint(unique),
    allContradiction,
    votes,
  };
}

function dedupeGaps(gaps: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of gaps) {
    const k = normalizeGapLine(g);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(g.trim());
  }
  return out;
}

export function buildGapsSummary(
  gaps: string[],
  refuters?: SkepticVote[],
): string {
  const lines: string[] = [];
  lines.push(
    `Verifier panel: ${refuters?.length ?? "?"} refuter(s) — NotAchieved.`,
  );
  for (const g of gaps.slice(0, 12)) {
    lines.push(`- ${g}`);
  }
  if (gaps.length > 12) {
    lines.push(`- …and ${gaps.length - 12} more`);
  }
  return lines.join("\n");
}

/**
 * Parse a skeptic markdown verdict file body.
 * Looks for `refuted: true|false` and bullet gaps under ## Gaps.
 */
export function parseSkepticVerdictBody(body: string): SkepticVote {
  const lower = body.toLowerCase();
  let refuted = true; // fail-closed default
  const refutedMatch = body.match(/refuted\s*:\s*(true|false)/i);
  if (refutedMatch) {
    refuted = refutedMatch[1]!.toLowerCase() === "true";
  } else if (
    /\bnot\s+refuted\b/i.test(body) ||
    /\bachieved\b/i.test(body) ||
    /verdict\s*:\s*pass/i.test(lower)
  ) {
    refuted = false;
  } else if (
    /\brefuted\b/i.test(body) ||
    /verdict\s*:\s*fail/i.test(lower) ||
    /not_achieved|not achieved/i.test(lower)
  ) {
    refuted = true;
  }

  const gaps: string[] = [];
  const gapsSection = body.match(
    /##\s*gaps\b([\s\S]*?)(?=\n##\s|\n---|\s*$)/i,
  );
  if (gapsSection) {
    for (const line of gapsSection[1]!.split(/\r?\n/)) {
      const m = line.match(/^\s*[-*+]\s+(.+)/);
      if (m?.[1]?.trim()) gaps.push(m[1].trim());
    }
  }

  const contradiction =
    /\bcontradiction\b/i.test(body) ||
    /\bunverifiable\b/i.test(body) ||
    /\bunblockable\b/i.test(body) ||
    /\benvironment\s+blocker\b/i.test(body);

  return {
    idx: 0,
    refuted,
    gaps,
    details: body.slice(0, 2000),
    contradiction: contradiction && refuted,
  };
}
