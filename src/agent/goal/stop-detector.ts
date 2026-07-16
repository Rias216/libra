/**
 * Heuristic premature-stop detector for goal mode.
 * Matches the last non-empty paragraph against bail / hand-off patterns.
 */

export const PATTERN_UNABLE_TO_PROCEED = "unable_to_proceed";
export const PATTERN_GIVING_UP = "giving_up";
export const PATTERN_STOPPING_HERE = "stopping_here";
export const PATTERN_AGENTS_IN_FLIGHT = "agents_in_flight";
export const PATTERN_CHECK_BACK_LATER = "check_back_later";
export const PATTERN_VERDICT_LINE = "verdict_line";
export const PATTERN_COMMIT_PUSH_PR = "commit_push_pr";
export const PATTERN_READY_FOR_REVIEW = "ready_for_review";
export const PATTERN_PLEASE_DEFLECTION = "please_deflection";

const PATTERN_LABELS = [
  PATTERN_UNABLE_TO_PROCEED,
  PATTERN_GIVING_UP,
  PATTERN_STOPPING_HERE,
  PATTERN_AGENTS_IN_FLIGHT,
  PATTERN_CHECK_BACK_LATER,
  PATTERN_VERDICT_LINE,
  PATTERN_COMMIT_PUSH_PR,
  PATTERN_READY_FOR_REVIEW,
  PATTERN_PLEASE_DEFLECTION,
] as const;

const RE_UNABLE =
  /^I (?:can(?:'?t|not)|am unable to) (?:proceed|continue|make (?:any )?progress|complete|fix this)\b/i;
const RE_GIVING_UP =
  /^(?:Giving up|I(?:'m| am) giving up|The task is not actionable)\b/i;
const RE_STOPPING =
  /^(?:Stopping here|I've stopped here|Parked (?:the|this) branch|Paused here)(?:\.|,|;|$| for | —| -| until| pending| since| because)/i;
const RE_AGENTS =
  /^(?:(?:\*\*)?[1-9]\d* (?:agent|cron|task|fork|job|worker|PR|check)s? (?:in flight|remaining|active|still (?:running|working)|pending|running|launched)\b|(?:Continuous )?(?:[Ll]oop|[Cc]rons?|[Bb]abysit) (?:active|healthy|continuing|running|will keep|continues)\b|Waiting for (?:the )?(?:agent|cron|task|fork|worker|job|remaining|them)s?\b|Agents? will report back\b|Waiting\.?$)/i;
const RE_CHECK_BACK =
  /^(?:I will|I'll|Will) (?:check back|re-?check|poll|look again|retry|re-?run|try again) (?:in\b|again\b|(?:when|once|after|until)\s+(\S+))/i;
const RE_VERDICT = /^VERDICT: (?:PASS|FAIL)\b/i;
const RE_COMMIT =
  /^(?:Pushed (?:to `|`[0-9a-f]{7,})|Committed as `?[0-9a-f]{7,}\b|Commit: `?[0-9a-f]{7,}\b|(?:Opened|Created) PR #?\d)/i;
const RE_READY = /^Ready (?:for review|to (?:upload|merge|ship|land))\b/i;
const RE_PLEASE =
  /^Please (?:start|run|provide|grant|export|add|install|configure|give me|paste|point me|set (?:the |up |`?[A-Z][A-Z0-9_]+\b))/i;

function isUserPronoun(token: string): boolean {
  const lower = token.toLowerCase();
  for (const stem of ["your", "you"]) {
    if (lower.startsWith(stem)) {
      const rest = lower.slice(stem.length);
      const next = rest[0];
      if (next == null || (!/[a-z0-9_]/i.test(next))) return true;
    }
  }
  return false;
}

function checkBackLaterMatches(line: string): boolean {
  const m = line.match(RE_CHECK_BACK);
  if (!m) return false;
  const target = m[1];
  if (target == null) return true; // in / again branches
  return !isUserPronoun(target);
}

function lineMatches(label: string, line: string): boolean {
  switch (label) {
    case PATTERN_UNABLE_TO_PROCEED:
      return RE_UNABLE.test(line);
    case PATTERN_GIVING_UP:
      return RE_GIVING_UP.test(line);
    case PATTERN_STOPPING_HERE:
      return RE_STOPPING.test(line);
    case PATTERN_AGENTS_IN_FLIGHT:
      return RE_AGENTS.test(line);
    case PATTERN_CHECK_BACK_LATER:
      return checkBackLaterMatches(line);
    case PATTERN_VERDICT_LINE:
      return RE_VERDICT.test(line);
    case PATTERN_COMMIT_PUSH_PR:
      return RE_COMMIT.test(line);
    case PATTERN_READY_FOR_REVIEW:
      return RE_READY.test(line);
    case PATTERN_PLEASE_DEFLECTION:
      return RE_PLEASE.test(line);
    default:
      return false;
  }
}

function normaliseLineEndings(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function lastNonEmptyParagraph(text: string): string | null {
  const parts = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length ? parts[parts.length - 1]! : null;
}

/**
 * Returns the first matched pattern label when the last non-empty
 * paragraph of `text` contains a bail/hand-off line. Order is fixed.
 */
export function matchedStopPattern(text: string): string | null {
  const normalised = normaliseLineEndings(text);
  const last = lastNonEmptyParagraph(normalised);
  if (!last) return null;
  for (const line of last.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const label of PATTERN_LABELS) {
      if (lineMatches(label, trimmed)) return label;
    }
  }
  return null;
}

export function looksLikePrematureStop(text: string): boolean {
  return matchedStopPattern(text) != null;
}
