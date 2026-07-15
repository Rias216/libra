/**
 * Incremental plain-text wrap for live stream tokens.
 *
 * Why this exists: while reasoning/text streams, the TUI used to re-wrap the
 * *entire* part content on every paint. At ~100k reasoning chars a single wrap
 * is ~200ms+ — well past a 30fps frame budget — so FPS collapses and the UI
 * feels lagged. Append-only streaming means we only need to wrap the new
 * suffix and keep finished visual lines cached.
 *
 * Also uses a fast ASCII width path: agent traces are overwhelmingly ASCII,
 * and calling `string-width` per code point dominates CPU on large wraps.
 */

import { stringWidth } from "./ansi.js";

export interface StreamLayout {
  width: number;
  /** Bytes of `content` already folded into lines/open. */
  contentLen: number;
  /** Completed visual lines (no open fragment). */
  lines: string[];
  /** Incomplete last visual line. */
  open: string;
  /** Display columns of `open`. */
  openCol: number;
}

const layouts = new Map<string, StreamLayout>();

/** Drop cached layouts (theme/width change, session reset, GC). */
export function clearStreamLayouts(ids?: Iterable<string>): void {
  if (!ids) {
    layouts.clear();
    return;
  }
  for (const id of ids) layouts.delete(id);
}

export function streamLayoutSize(): number {
  return layouts.size;
}

/**
 * Visible column width for one code point. Fast path for ASCII (the bulk of
 * reasoning traces); falls back to `string-width` for CJK / emoji / etc.
 */
export function displayWidth(code: number, ch: string): number {
  // C0 / DEL / C1 controls — not printable in the TUI
  if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
    return 0;
  }
  // Printable ASCII
  if (code < 0x7f) return 1;
  // Tab → 1 cell (stream wrap doesn't expand tabs)
  if (code === 0x09) return 1;
  return stringWidth(ch);
}

/**
 * Wrap (or extend) a streaming part's plain content into visual lines.
 * Pure append of `content` reuses prior work; shrink / width change rebuilds.
 */
export function wrapStreamPlain(
  partId: string,
  content: string,
  width: number,
): { lines: string[]; open: string } {
  const w = Math.max(1, width);
  let state = layouts.get(partId);

  if (!state || state.width !== w || content.length < state.contentLen) {
    state = {
      width: w,
      contentLen: 0,
      lines: [],
      open: "",
      openCol: 0,
    };
    layouts.set(partId, state);
  }

  if (content.length === state.contentLen) {
    return { lines: state.lines, open: state.open };
  }

  // Process only the newly appended slice.
  const delta = content.slice(state.contentLen);
  feedDelta(state, delta);
  state.contentLen = content.length;
  return { lines: state.lines, open: state.open };
}

/**
 * Full non-cached wrap — used for finished content paths / tests.
 * Same width rules as the stream path so layout stays consistent.
 */
export function wrapPlainLines(content: string, width: number): string[] {
  const w = Math.max(1, width);
  if (!content) return [];
  const state: StreamLayout = {
    width: w,
    contentLen: 0,
    lines: [],
    open: "",
    openCol: 0,
  };
  feedDelta(state, content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  if (state.open) state.lines.push(state.open);
  else if (content.endsWith("\n")) {
    // trailing newline already produced an empty open via \n handling
  }
  // feedDelta on trailing \n pushes "" into lines and clears open
  return state.lines;
}

function feedDelta(state: StreamLayout, delta: string): void {
  const w = state.width;
  let open = state.open;
  let openCol = state.openCol;
  const lines = state.lines;

  for (let i = 0; i < delta.length; ) {
    const code = delta.codePointAt(i)!;
    const cpLen = code > 0xffff ? 2 : 1;
    if (code === 0x0a) {
      // hard line break
      lines.push(open);
      open = "";
      openCol = 0;
      i += cpLen;
      continue;
    }
    if (code === 0x0d) {
      // ignore bare CR; \r\n already normalized by callers when needed
      i += cpLen;
      continue;
    }
    const ch = delta.slice(i, i + cpLen);
    i += cpLen;
    const cw = displayWidth(code, ch);
    if (cw <= 0) continue;
    if (openCol + cw > w && open) {
      lines.push(open);
      open = ch;
      openCol = cw;
    } else {
      open += ch;
      openCol += cw;
    }
  }

  state.open = open;
  state.openCol = openCol;
}

/**
 * GC helper: drop layouts for part ids no longer in the live set.
 * Keeps a small grace buffer so mid-frame churn doesn't thrash.
 */
export function gcStreamLayouts(liveIds: Set<string>): void {
  if (layouts.size <= liveIds.size + 32) return;
  for (const id of layouts.keys()) {
    if (!liveIds.has(id)) layouts.delete(id);
  }
}
