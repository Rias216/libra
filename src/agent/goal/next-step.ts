/**
 * Mine the next concrete step from the planner plan file.
 * Only `- [ ]` checkboxes; never numbered acceptance criteria.
 * When `## Task checklist` exists, only that section is mined.
 */

import { existsSync, readFileSync } from "node:fs";

export const MAX_PLAN_READ_BYTES = 8 * 1024;

const EXCLUDED_SECTIONS = ["non-goals", "deviations"] as const;

export function isSectionHeader(line: string, name: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("#")) return false;
  const title = trimmed.replace(/^#+\s*/, "").trim();
  return title.toLowerCase() === name.toLowerCase();
}

export function isAnyHeader(line: string): boolean {
  return line.trimStart().startsWith("#");
}

export function headerLevel(line: string): number {
  const t = line.trimStart();
  let n = 0;
  while (n < t.length && t[n] === "#") n++;
  return n;
}

function stripBulletMarker(trimmed: string): string | null {
  if (trimmed.startsWith("- ")) return trimmed.slice(2).trimStart();
  if (trimmed.startsWith("* ")) return trimmed.slice(2).trimStart();
  if (trimmed.startsWith("+ ")) return trimmed.slice(2).trimStart();
  return null;
}

/**
 * Parse `- [ ] foo`. Checked boxes and plain bullets return null.
 */
export function parseCheckboxItem(trimmed: string): string | null {
  const afterMarker = stripBulletMarker(trimmed);
  if (afterMarker == null) return null;
  if (!afterMarker.startsWith("[ ]")) return null;
  const text = afterMarker.slice(3).trim();
  return text.length > 0 ? text : null;
}

function firstUncheckedInChecklist(body: string): string | null {
  let sectionLevel: number | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (isSectionHeader(line, "task checklist")) {
      sectionLevel = headerLevel(line);
      continue;
    }
    if (sectionLevel == null) continue;
    if (isAnyHeader(line) && headerLevel(line) <= sectionLevel) {
      return null;
    }
    const item = parseCheckboxItem(line.trimStart());
    if (item) return item;
  }
  return null;
}

/**
 * Extract first unchecked checkbox from plan body.
 */
export function extractFirstUnchecked(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const hasChecklist = lines.some((l) => isSectionHeader(l, "task checklist"));
  if (hasChecklist) return firstUncheckedInChecklist(body);

  let excluded = false;
  for (const line of lines) {
    if (isAnyHeader(line)) {
      excluded = EXCLUDED_SECTIONS.some((name) => isSectionHeader(line, name));
      continue;
    }
    if (excluded) continue;
    const item = parseCheckboxItem(line.trimStart());
    if (item) return item;
  }
  return null;
}

/**
 * Read plan file (capped) and return first unchecked item, or null.
 */
export function readPlanCapped(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    if (buf.length >= MAX_PLAN_READ_BYTES) {
      const str = buf.subarray(0, MAX_PLAN_READ_BYTES).toString("utf8");
      const lastNl = str.lastIndexOf("\n");
      return lastNl >= 0 ? str.slice(0, lastNl) : str;
    }
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * @param bodyOrPath plan markdown body, or a filesystem path when opts.isPath
 */
export function firstUncheckedPlanItem(
  bodyOrPath: string,
  opts?: { isPath?: boolean; readFile?: (p: string) => string | null },
): string | null {
  let body: string;
  if (opts?.isPath) {
    const raw = (opts.readFile ?? readPlanCapped)(bodyOrPath);
    if (raw == null) return null;
    body = raw;
  } else {
    body = bodyOrPath;
  }
  return extractFirstUnchecked(body);
}

/** Friendly fallback when no checklist item remains. */
export const GENERIC_NEXT_STEP =
  "Check your todo list and the plan's acceptance criteria; finish remaining open work.";
