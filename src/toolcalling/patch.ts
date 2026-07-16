/**
 * patch_apply — parse unified diffs and apply hunks (fail-loud on mismatch).
 */

export interface ParsedHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Lines including leading ' ', '+', '-', or '\\' */
  lines: string[];
}

export interface ParsedFilePatch {
  oldPath: string;
  newPath: string;
  hunks: ParsedHunk[];
}

export interface ApplyHunkResult {
  ok: boolean;
  content?: string;
  error?: string;
  hunkIndex?: number;
}

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

/** Parse a unified diff string into per-file patches. */
export function parseUnifiedDiff(diff: string): ParsedFilePatch[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const files: ParsedFilePatch[] = [];
  let cur: ParsedFilePatch | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("--- ")) {
      const oldPath = stripPathPrefix(line.slice(4).trim());
      let newPath = oldPath;
      if (i + 1 < lines.length && lines[i + 1]!.startsWith("+++ ")) {
        newPath = stripPathPrefix(lines[i + 1]!.slice(4).trim());
        i += 2;
      } else {
        i += 1;
      }
      cur = { oldPath, newPath, hunks: [] };
      files.push(cur);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      // Optional git header — next ---/+++ set paths
      i += 1;
      continue;
    }
    const hm = line.match(HUNK_RE);
    if (hm && cur) {
      const hunk: ParsedHunk = {
        header: line,
        oldStart: Number(hm[1]),
        oldCount: hm[2] != null ? Number(hm[2]) : 1,
        newStart: Number(hm[3]),
        newCount: hm[4] != null ? Number(hm[4]) : 1,
        lines: [],
      };
      i += 1;
      while (i < lines.length) {
        const hl = lines[i]!;
        if (
          hl.startsWith("@@ ") ||
          hl.startsWith("--- ") ||
          hl.startsWith("diff --git ")
        ) {
          break;
        }
        if (
          hl.startsWith(" ") ||
          hl.startsWith("+") ||
          hl.startsWith("-") ||
          hl.startsWith("\\")
        ) {
          hunk.lines.push(hl);
          i += 1;
          continue;
        }
        // Empty line in hunk body is context-ish; treat as end if next is header
        if (hl === "" && i + 1 < lines.length) {
          const n = lines[i + 1]!;
          if (
            n.startsWith("@@ ") ||
            n.startsWith("--- ") ||
            n.startsWith("diff --git ")
          ) {
            break;
          }
        }
        // Non-hunk line → stop hunk
        if (
          !hl.startsWith(" ") &&
          !hl.startsWith("+") &&
          !hl.startsWith("-") &&
          !hl.startsWith("\\")
        ) {
          break;
        }
        i += 1;
      }
      cur.hunks.push(hunk);
      continue;
    }
    i += 1;
  }
  return files;
}

function stripPathPrefix(p: string): string {
  // Drop a/ b/ prefixes and timestamps
  let s = p.replace(/\t.*$/, "").trim();
  if (s === "/dev/null") return s;
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return s;
}

/**
 * Apply a single hunk to file content. Fails if context doesn't match.
 * oldStart is 1-based.
 */
export function applyHunk(
  content: string,
  hunk: ParsedHunk,
  hunkIndex = 0,
): ApplyHunkResult {
  const fileLines = content.split("\n");
  // Build expected old lines and new lines from hunk
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const hl of hunk.lines) {
    if (hl.startsWith("\\")) continue; // "\ No newline at end of file"
    const tag = hl[0];
    const body = hl.slice(1);
    if (tag === " " || tag === undefined) {
      oldLines.push(body);
      newLines.push(body);
    } else if (tag === "-") {
      oldLines.push(body);
    } else if (tag === "+") {
      newLines.push(body);
    }
  }

  // Locate: prefer oldStart-1, allow small fuzzy window if exact match fails
  const start0 = Math.max(0, hunk.oldStart - 1);
  let matchAt = -1;
  const tryOffsets = [0, -1, 1, -2, 2, -3, 3];
  for (const off of tryOffsets) {
    const at = start0 + off;
    if (at < 0 || at + oldLines.length > fileLines.length + (oldLines.length ? 0 : 0)) {
      // Allow empty old (pure insert) at end
      if (oldLines.length === 0 && at >= 0 && at <= fileLines.length) {
        matchAt = at;
        break;
      }
      continue;
    }
    if (oldLines.length === 0) {
      matchAt = Math.min(at, fileLines.length);
      break;
    }
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (fileLines[at + j] !== oldLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matchAt = at;
      break;
    }
  }

  // Pure insert at EOF when oldCount is 0
  if (matchAt < 0 && oldLines.length === 0) {
    matchAt = fileLines.length;
  }

  if (matchAt < 0) {
    return {
      ok: false,
      error:
        `hunk ${hunkIndex} context mismatch near line ${hunk.oldStart}: expected ${JSON.stringify(oldLines.slice(0, 3))}. ` +
        `Re-read the file with read_file, copy exact current lines into the unified diff context, then retry patch_apply (do not guess).`,
      hunkIndex,
    };
  }

  const next = [
    ...fileLines.slice(0, matchAt),
    ...newLines,
    ...fileLines.slice(matchAt + oldLines.length),
  ];
  return { ok: true, content: next.join("\n") };
}

/** Apply all hunks for one file in order. */
export function applyFilePatch(
  content: string,
  patch: ParsedFilePatch,
): ApplyHunkResult {
  let cur = content;
  for (let i = 0; i < patch.hunks.length; i++) {
    const r = applyHunk(cur, patch.hunks[i]!, i);
    if (!r.ok) return r;
    cur = r.content!;
  }
  return { ok: true, content: cur };
}

/** Convert applied diff to DiffHunk/DiffLine for DiffPart UI. */
export function hunksToDiffParts(hunks: ParsedHunk[]): Array<{
  header: string;
  lines: Array<{ kind: "context" | "add" | "del"; text: string }>;
}> {
  return hunks.map((h) => ({
    header: h.header,
    lines: h.lines
      .filter((l) => !l.startsWith("\\"))
      .map((l) => {
        const tag = l[0];
        const text = l.slice(1);
        if (tag === "+") return { kind: "add" as const, text };
        if (tag === "-") return { kind: "del" as const, text };
        return { kind: "context" as const, text };
      }),
  }));
}
