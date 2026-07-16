/**
 * Client-side thinking-tail / thought-loop detector.
 * Mirrors Grok Build's spirit (tail_repetition@thinking) without requiring
 * server SSE doom-loop signals — works on OpenRouter and all providers.
 */

/** Sliding window size (chars) for tail comparison. */
export const THOUGHT_TAIL_CHARS = 400;
/** Same tail this many times → loop. */
export const THOUGHT_LOOP_THRESHOLD = 3;

export interface ThoughtLoopState {
  /** Normalized tails seen this turn (sample-to-sample). */
  sampleTails: string[];
  /** How many recovery reminders already injected this turn. */
  recoveries: number;
}

export function createThoughtLoopState(): ThoughtLoopState {
  return { sampleTails: [], recoveries: 0 };
}

/** Normalize for comparison: collapse whitespace, lowercase. */
export function normalizeThoughtTail(text: string, chars = THOUGHT_TAIL_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (t.length <= chars) return t;
  return t.slice(-chars);
}

/**
 * Inspect finished sample reasoning. Returns true when the tail repeats
 * enough to treat as a thought loop.
 */
export function detectThoughtLoop(
  state: ThoughtLoopState,
  reasoning: string | undefined | null,
): boolean {
  const raw = reasoning?.trim() ?? "";
  if (raw.length < 80) return false;

  // Within-sample: same window appears as a contiguous run ≥3 times
  if (hasInternalTailRepetition(raw)) return true;

  const tail = normalizeThoughtTail(raw);
  if (tail.length < 60) return false;

  state.sampleTails.push(tail);
  if (state.sampleTails.length > 12) {
    state.sampleTails = state.sampleTails.slice(-12);
  }

  // Across samples: last N tails equal
  if (state.sampleTails.length >= THOUGHT_LOOP_THRESHOLD) {
    const last = state.sampleTails.slice(-THOUGHT_LOOP_THRESHOLD);
    if (last.every((t) => t === last[0])) return true;
  }

  // Soft: last two nearly equal (Jaccard-ish on words)
  if (state.sampleTails.length >= 2) {
    const a = state.sampleTails[state.sampleTails.length - 1]!;
    const b = state.sampleTails[state.sampleTails.length - 2]!;
    if (a === b) return true;
    if (nearDuplicateTails(a, b)) {
      // Count near-dup as a soft hit: need 2 soft hits in a row
      const third = state.sampleTails[state.sampleTails.length - 3];
      if (third && (third === a || nearDuplicateTails(third, a))) return true;
    }
  }

  return false;
}

function hasInternalTailRepetition(text: string): boolean {
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 20);
  if (lines.length < 6) return false;
  // Last 3 non-empty lines all equal
  const last3 = lines.slice(-3);
  if (last3.every((l) => l === last3[0])) return true;
  // Count frequency of last line in body
  const last = lines[lines.length - 1]!;
  let count = 0;
  for (const l of lines) {
    if (l === last) count++;
  }
  return count >= THOUGHT_LOOP_THRESHOLD + 1;
}

function nearDuplicateTails(a: string, b: string): boolean {
  if (a.length < 40 || b.length < 40) return false;
  const wa = new Set(a.split(" ").filter((w) => w.length > 2));
  const wb = new Set(b.split(" ").filter((w) => w.length > 2));
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) {
    if (wb.has(w)) inter++;
  }
  const union = wa.size + wb.size - inter;
  return union > 0 && inter / union >= 0.85;
}

export const THOUGHT_LOOP_REMINDER =
  "<system-reminder>\n" +
  "You are repeating the same reasoning. Stop re-planning. " +
  "Either call the tools needed to finish the task, or give the user your best final answer now. " +
  "Do not restate the same plan.\n" +
  "</system-reminder>";

export const DOOM_FORCE_ANSWER_REMINDER =
  "<system-reminder>\n" +
  "Tool doom-loop detected: the same tools/args (or an A↔B oscillation) kept repeating. " +
  "Do not call more tools. Give the user your best final answer from prior results.\n" +
  "</system-reminder>";

export const STUCK_PROGRESS_REMINDER =
  "<system-reminder>\n" +
  "Progress appears stuck (repeated failed edits or identical errors). " +
  "Change strategy, read the relevant file again with a wider window, or answer the user with what you know. " +
  "Do not keep retrying the same failing edit.\n" +
  "</system-reminder>";
