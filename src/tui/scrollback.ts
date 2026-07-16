/**
 * Virtualized scrollback — builds a flat list of painted rows from
 * messages/parts, then windows them into the visible viewport.
 *
 * Perf:
 *  - Finished parts cached by content signature
 *  - Stable message prefix cached (only live tail re-laid out)
 */

import type { HarnessState, Message, Part } from "../core/types.js";
import type { Theme } from "./theme.js";
import { formatCompactCount } from "./chrome.js";
import {
  clearStreamBodyCache,
  renderPart,
  renderRoleHeader,
  type Row,
} from "./components/parts.js";
import {
  clearStreamLayouts,
  gcStreamLayouts,
} from "./stream-layout.js";
import { clearMarkdownCache } from "./markdown.js";
import type { GlyphSet } from "./font.js";

export interface ScrollModel {
  rows: Row[];
  offset: number;
}

const partCache = new Map<string, { sig: string; rows: Row[] }>();
const PART_CACHE_MAX = 400;

/** Stable transcript prefix (messages before the live tail) */
let prefixCache: {
  key: string;
  rows: Row[];
  plain: string[];
} | null = null;

/**
 * Reused document array — avoids allocating prefix.concat(tail) every paint
 * (that alone was multi-ms and GC pressure at 60k+ token transcripts).
 */
let docScratch: Row[] = [];

export interface ScrollDocument {
  rows: Row[];
  plain: string[];
  hits: (import("./components/parts.js").RowHit | null)[];
  /** Live content fingerprint for tick-only short-circuit in the renderer */
  liveSig: string;
}

export function buildScrollRows(
  state: HarnessState,
  theme: Theme,
  contentWidth: number,
  tick: number,
  glyphs?: GlyphSet,
): Row[] {
  return buildScrollDocument(state, theme, contentWidth, tick, { glyphs }).rows;
}

export function buildScrollDocument(
  state: HarnessState,
  theme: Theme,
  contentWidth: number,
  tick: number,
  opts?: { needPlain?: boolean; glyphs?: GlyphSet },
): ScrollDocument {
  const needPlain = opts?.needPlain ?? false;
  const glyphs = opts?.glyphs;
  const liveIds = new Set<string>();
  const layoutOpts = {
    width: contentWidth,
    showToolDetails: state.showToolDetails,
    showThinking: state.showThinking,
    tick,
    themeName: theme.name,
    compact: state.compact,
    glyphs,
  };

  if (state.messages.length === 0) {
    const rows = emptyStateRows(theme, contentWidth, glyphs);
    return {
      rows,
      plain: needPlain ? rowsToPlain(rows) : [],
      hits: [],
      liveSig: "empty",
    };
  }

  const split = findLiveSplit(state);
  const glyphKey = glyphs
    ? `${glyphs.assistant}${glyphs.toolOk}${glyphs.chevronOpen}`
    : "";
  const prefixKey = makePrefixKey(state, theme, contentWidth, split, glyphKey);

  let prefixRows: Row[];
  let prefixPlain: string[];

  if (prefixCache && prefixCache.key === prefixKey) {
    prefixRows = prefixCache.rows;
    prefixPlain = prefixCache.plain;
    // Still register part ids for GC
    for (let mi = 0; mi < split; mi++) {
      for (const p of state.messages[mi]!.parts) liveIds.add(p.id);
    }
  } else {
    prefixRows = [];
    for (let mi = 0; mi < split; mi++) {
      appendMessage(
        prefixRows,
        state.messages[mi]!,
        mi > 0,
        theme,
        layoutOpts,
        liveIds,
      );
    }
    prefixPlain = rowsToPlain(prefixRows);
    prefixCache = { key: prefixKey, rows: prefixRows, plain: prefixPlain };
  }

  const tailRows: Row[] = [];
  for (let mi = split; mi < state.messages.length; mi++) {
    appendMessage(
      tailRows,
      state.messages[mi]!,
      mi > 0 || split > 0,
      theme,
      layoutOpts,
      liveIds,
    );
  }

  // Phase/activity (e.g. "streaming · step 1") lives only in chrome
  // renderStatus — do not mirror it into the scroll document or it
  // appears twice (transcript footer + status bar) for no reason.

  if (partCache.size > liveIds.size + 32) {
    for (const id of partCache.keys()) {
      if (!liveIds.has(id)) partCache.delete(id);
    }
  }
  gcStreamLayouts(liveIds);

  // Assemble into reusable scratch — no new giant array per paint
  const n = prefixRows.length + tailRows.length;
  if (docScratch.length < n) {
    // Grow only; never shrink (keep capacity)
    docScratch.length = n;
  }
  for (let i = 0; i < prefixRows.length; i++) {
    docScratch[i] = prefixRows[i]!;
  }
  for (let i = 0; i < tailRows.length; i++) {
    docScratch[prefixRows.length + i] = tailRows[i]!;
  }
  docScratch.length = n;
  const rows = docScratch;

  const liveSig = makeLiveSig(state, split, n);

  if (!needPlain) {
    return { rows, plain: [], hits: [], liveSig };
  }

  const plain =
    tailRows.length === 0
      ? prefixPlain
      : prefixPlain.concat(rowsToPlain(tailRows));
  return { rows, plain, hits: [], liveSig };
}

/**
 * Cheap fingerprint of the live tail so the renderer can skip full rebuilds.
 * Rolling FNV hash — no growing string keys on multi-part assistant messages.
 */
function makeLiveSig(
  state: HarnessState,
  split: number,
  docLen: number,
): string {
  let h = 2166136261 >>> 0;
  h = mixStr(h, state.phase);
  h = mixStr(h, state.activityLabel ?? "");
  h = mixNum(h, docLen);
  h = mixNum(h, split);
  let lastId = "";
  for (let mi = split; mi < state.messages.length; mi++) {
    const m = state.messages[mi]!;
    lastId = m.id;
    h = mixStr(h, m.id);
    for (const p of m.parts) {
      h = mixStr(h, p.id);
      if (p.type === "text" || p.type === "reasoning") {
        h = mixNum(h, p.content.length);
        h = mixNum(h, p.streaming ? 1 : 0);
        // Collapse toggle must invalidate live tail (expand mid-stream)
        if (p.type === "reasoning") {
          h = mixNum(
            h,
            p.collapsed === true ? 1 : p.collapsed === false ? 2 : 0,
          );
        }
        // Sample content so mid-stream length-stable edits still invalidate
        if (p.content.length > 0) {
          h = mixNum(h, p.content.charCodeAt(p.content.length - 1));
        }
      } else if (p.type === "tool") {
        h = mixStr(h, p.status);
        h = mixNum(h, p.result?.length ?? 0);
        h = mixNum(
          h,
          p.collapsed === true ? 1 : p.collapsed === false ? 2 : 0,
        );
      } else {
        h = mixStr(h, p.type);
      }
    }
  }
  // Bounded key: phase + sizes + hash (no O(parts) string thrash)
  return `${state.phase}|${docLen}|${split}|${lastId}|${(h >>> 0).toString(36)}`;
}

/**
 * Prefix cache key — hash finished messages instead of joining every
 * messageStableKey (that alone allocated multi-KB strings on long transcripts).
 */
function makePrefixKey(
  state: HarnessState,
  theme: Theme,
  contentWidth: number,
  split: number,
  glyphKey = "",
): string {
  let h = 2166136261 >>> 0;
  h = mixStr(h, theme.name);
  h = mixStr(h, glyphKey);
  h = mixNum(h, contentWidth);
  h = mixNum(h, state.compact ? 1 : 0);
  h = mixNum(h, state.showToolDetails ? 1 : 0);
  h = mixNum(h, state.showThinking ? 1 : 0);
  h = mixNum(h, split);
  let lastId = "";
  for (let i = 0; i < split; i++) {
    const m = state.messages[i]!;
    lastId = m.id;
    h = mixStr(h, messageStableKey(m));
  }
  return `${theme.name}|${glyphKey}|${contentWidth}|${state.compact ? 1 : 0}|${state.showToolDetails ? 1 : 0}|${state.showThinking ? 1 : 0}|${split}|${lastId}|${(h >>> 0).toString(36)}`;
}

function mixStr(h: number, s: string): number {
  let x = h >>> 0;
  for (let i = 0; i < s.length; i++) {
    x = Math.imul(x ^ s.charCodeAt(i), 16777619) >>> 0;
  }
  // length salt so "ab"/"a"+"b" style collisions are less likely across concat
  return Math.imul(x ^ s.length, 16777619) >>> 0;
}

function mixNum(h: number, n: number): number {
  return Math.imul((h >>> 0) ^ (n >>> 0), 16777619) >>> 0;
}

/** First index that must be re-laid out every frame (streaming/running). */
function findLiveSplit(state: HarnessState): number {
  const messages = state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const p of messages[i]!.parts) {
      if (
        ((p.type === "text" || p.type === "reasoning") && p.streaming) ||
        (p.type === "tool" && p.status === "running")
      ) {
        return i;
      }
    }
  }
  // While agent is busy, keep last message out of the prefix so new parts
  // don't invalidate the whole history cache.
  if (state.phase !== "idle" && state.phase !== "error" && messages.length > 0) {
    return messages.length - 1;
  }
  return messages.length;
}

function messageStableKey(m: Message): string {
  let k = m.id;
  for (const p of m.parts) k += "," + p.id + ":" + partQuickSig(p);
  if (m.usage) k += `,u${m.usage.input + m.usage.output}`;
  return k;
}

function partQuickSig(p: Part): string {
  switch (p.type) {
    case "text":
      return `t${p.content.length}:${hashStr(p.content)}`;
    case "reasoning":
      return `r${p.content.length}:${p.collapsed === true ? 1 : p.collapsed === false ? 0 : "d"}:${hashStr(p.content)}`;
    case "tool":
      return `T${p.status}:${p.collapsed === true ? 1 : p.collapsed === false ? 0 : "d"}:${p.result?.length ?? 0}:${p.error?.length ?? 0}`;
    case "diff":
      return `d${p.path}:${p.additions}:${p.collapsed ? 1 : 0}`;
    case "file":
      return `f${p.path}`;
    case "status":
      return `s${p.message.length}`;
    default:
      return "?";
  }
}

function appendMessage(
  rows: Row[],
  msg: Message,
  padBefore: boolean,
  theme: Theme,
  opts: {
    width: number;
    showToolDetails: boolean;
    showThinking: boolean;
    tick: number;
    themeName: string;
    compact: boolean;
    glyphs?: GlyphSet;
  },
  liveIds: Set<string>,
): void {
  if (padBefore && !opts.compact) {
    rows.push({ segments: [] });
  }

  if (msg.role === "user" || msg.role === "assistant") {
    const meta =
      msg.usage != null
        ? formatCompactCount(msg.usage.input + msg.usage.output)
        : undefined;
    rows.push(renderRoleHeader(msg.role, theme, meta, opts.glyphs));
  }

  for (const part of msg.parts) {
    liveIds.add(part.id);
    const partRows = renderPartCached(part, theme, {
      width: opts.width,
      showToolDetails: opts.showToolDetails,
      showThinking: opts.showThinking,
      tick: opts.tick,
      themeName: opts.themeName,
      messageId: msg.id,
      glyphs: opts.glyphs,
    });
    // Push one-by-one — avoid spread allocating an intermediate arg array
    // for multi-thousand-line reasoning/tool bodies.
    for (let i = 0; i < partRows.length; i++) {
      rows.push(partRows[i]!);
    }
  }
}

function renderPartCached(
  part: Part,
  theme: Theme,
  opts: {
    width: number;
    showToolDetails: boolean;
    showThinking: boolean;
    tick: number;
    themeName: string;
    messageId?: string;
    glyphs?: GlyphSet;
  },
): Row[] {
  const streaming =
    (part.type === "text" || part.type === "reasoning") && part.streaming;
  const toolRunning = part.type === "tool" && part.status === "running";

  if (streaming || toolRunning) {
    return renderPart(part, theme, opts);
  }

  const sig = partSignature(part, opts);
  const hit = partCache.get(part.id);
  if (hit && hit.sig === sig) return hit.rows;

  const rows = renderPart(part, theme, opts);
  if (partCache.size >= PART_CACHE_MAX) {
    let n = 0;
    const drop = Math.floor(PART_CACHE_MAX / 4);
    for (const k of partCache.keys()) {
      partCache.delete(k);
      if (++n >= drop) break;
    }
  }
  partCache.set(part.id, { sig, rows });
  return rows;
}

function partSignature(
  part: Part,
  opts: {
    width: number;
    showToolDetails: boolean;
    showThinking: boolean;
    themeName: string;
    messageId?: string;
    glyphs?: GlyphSet;
  },
): string {
  const gk = opts.glyphs
    ? `${opts.glyphs.assistant}${opts.glyphs.toolOk}${opts.glyphs.chevronOpen}`
    : "";
  const base = `${opts.themeName}|${gk}|${opts.width}|${opts.showToolDetails ? 1 : 0}|${opts.showThinking ? 1 : 0}|${opts.messageId ?? ""}`;
  switch (part.type) {
    case "text":
      return `${base}|t|${part.content.length}|${hashStr(part.content)}`;
    case "reasoning":
      // Include effective collapsed default (undefined → fold when done) + title
      return `${base}|r|${part.collapsed === true ? 1 : part.collapsed === false ? 0 : "d"}|${part.title ?? ""}|${part.content.length}|${hashStr(part.content)}`;
    case "tool":
      return `${base}|tool|${part.toolName}|${part.status}|${part.collapsed === true ? 1 : part.collapsed === false ? 0 : "d"}|${part.result?.length ?? 0}|${part.error?.length ?? 0}|${hashStr(JSON.stringify(part.args ?? {}))}`;
    case "diff":
      return `${base}|diff|${part.path}|${part.additions}|${part.deletions}|${part.hunks?.length ?? 0}|${part.collapsed ? 1 : 0}`;
    case "file":
      return `${base}|file|${part.path}|${part.excerpt?.length ?? 0}`;
    case "status":
      return `${base}|status|${part.level}|${part.message}`;
    default:
      return `${base}|?`;
  }
}

function hashStr(s: string): string {
  let h = 2166136261;
  const step = s.length > 4000 ? Math.ceil(s.length / 2000) : 1;
  for (let i = 0; i < s.length; i += step) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= s.length;
  return (h >>> 0).toString(36);
}

function rowsToPlain(rows: Row[]): string[] {
  return rows.map((row) => row.segments.map((s) => s.text).join(""));
}

export function clearScrollCache(): void {
  partCache.clear();
  prefixCache = null;
  clearStreamLayouts();
  clearStreamBodyCache();
  clearMarkdownCache();
}

function emptyStateRows(
  theme: Theme,
  width: number,
  glyphs?: GlyphSet,
): Row[] {
  const title = "libra";
  const subtitle = "AI harness TUI — inspired by OpenCode & Grok CLI";
  const mark = glyphs?.assistant ?? "*";
  const hints = [
    "Type a message and press Enter to send",
    "Tab  focus scrollback   Ctrl+C  quit   Ctrl+L  clear",
    "/help  ·  Ctrl+T thinking  ·  Ctrl+E collapse all thoughts  ·  click to expand",
  ];
  const rows: Row[] = [
    { segments: [] },
    {
      segments: [
        { text: `  ${mark} `, style: { fg: theme.accent } },
        { text: title, style: { fg: theme.accent, bold: true } },
      ],
    },
    {
      segments: [
        {
          text: "  " + subtitle.slice(0, Math.max(0, width - 2)),
          style: { fg: theme.fgMuted },
        },
      ],
    },
    { segments: [] },
  ];
  for (const h of hints) {
    rows.push({
      segments: [
        { text: "  ", style: {} },
        { text: h, style: { fg: theme.fgFaint } },
      ],
    });
  }
  return rows;
}

export function clampOffset(
  offset: number,
  totalRows: number,
  viewH: number,
): number {
  const max = Math.max(0, totalRows - viewH);
  return Math.max(0, Math.min(offset, max));
}

export function isFollowing(
  offset: number,
  totalRows: number,
  viewH: number,
): boolean {
  return offset >= Math.max(0, totalRows - viewH);
}
