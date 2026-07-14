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
import {
  renderPart,
  renderRoleHeader,
  type Row,
} from "./components/parts.js";

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

export function buildScrollRows(
  state: HarnessState,
  theme: Theme,
  contentWidth: number,
  tick: number,
): Row[] {
  return buildScrollDocument(state, theme, contentWidth, tick).rows;
}

export function buildScrollDocument(
  state: HarnessState,
  theme: Theme,
  contentWidth: number,
  tick: number,
  opts?: { needPlain?: boolean },
): { rows: Row[]; plain: string[] } {
  const needPlain = opts?.needPlain ?? false;
  const liveIds = new Set<string>();
  const layoutOpts = {
    width: contentWidth,
    showToolDetails: state.showToolDetails,
    showThinking: state.showThinking,
    tick,
    themeName: theme.name,
    compact: state.compact,
  };

  if (state.messages.length === 0) {
    const rows = emptyStateRows(theme, contentWidth);
    return { rows, plain: needPlain ? rowsToPlain(rows) : [] };
  }

  const split = findLiveSplit(state);
  const prefixKey = makePrefixKey(state, theme, contentWidth, split);

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

  if (state.phase !== "idle" && state.phase !== "error") {
    tailRows.push({ segments: [] });
    tailRows.push({
      segments: [
        {
          text: activityGlyph(state.phase, tick),
          style: { fg: theme.spinner },
        },
        {
          text: ` ${state.activityLabel ?? phaseLabel(state.phase)}`,
          style: { fg: theme.fgMuted, italic: true },
        },
      ],
    });
  }

  if (partCache.size > liveIds.size + 32) {
    for (const id of partCache.keys()) {
      if (!liveIds.has(id)) partCache.delete(id);
    }
  }

  const rows =
    tailRows.length === 0 ? prefixRows : prefixRows.concat(tailRows);

  if (!needPlain) return { rows, plain: [] };

  const plain =
    tailRows.length === 0
      ? prefixPlain
      : prefixPlain.concat(rowsToPlain(tailRows));
  return { rows, plain };
}

function makePrefixKey(
  state: HarnessState,
  theme: Theme,
  contentWidth: number,
  split: number,
): string {
  let k = `${theme.name}|${contentWidth}|${state.compact ? 1 : 0}|${state.showToolDetails ? 1 : 0}|${state.showThinking ? 1 : 0}|${split}`;
  for (let i = 0; i < split; i++) {
    k += "|" + messageStableKey(state.messages[i]!);
  }
  return k;
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
      return `r${p.content.length}:${hashStr(p.content)}`;
    case "tool":
      return `T${p.status}:${p.result?.length ?? 0}:${p.error?.length ?? 0}`;
    case "diff":
      return `d${p.path}:${p.additions}`;
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
  },
  liveIds: Set<string>,
): void {
  if (padBefore && !opts.compact) {
    rows.push({ segments: [] });
  }

  if (msg.role === "user" || msg.role === "assistant") {
    const meta =
      msg.usage != null
        ? `${msg.usage.input + msg.usage.output} tok`
        : undefined;
    rows.push(renderRoleHeader(msg.role, theme, meta));
  }

  for (const part of msg.parts) {
    liveIds.add(part.id);
    rows.push(...renderPartCached(part, theme, opts));
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
  },
): string {
  const base = `${opts.themeName}|${opts.width}|${opts.showToolDetails ? 1 : 0}|${opts.showThinking ? 1 : 0}`;
  switch (part.type) {
    case "text":
      return `${base}|t|${part.content.length}|${hashStr(part.content)}`;
    case "reasoning":
      return `${base}|r|${part.collapsed ? 1 : 0}|${part.content.length}|${hashStr(part.content)}`;
    case "tool":
      return `${base}|tool|${part.toolName}|${part.status}|${part.collapsed ? 1 : 0}|${part.result?.length ?? 0}|${part.error?.length ?? 0}|${hashStr(JSON.stringify(part.args ?? {}))}`;
    case "diff":
      return `${base}|diff|${part.path}|${part.additions}|${part.deletions}|${part.hunks?.length ?? 0}`;
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
}

function emptyStateRows(theme: Theme, width: number): Row[] {
  const title = "libra";
  const subtitle = "AI harness TUI — inspired by OpenCode & Grok CLI";
  const hints = [
    "Type a message and press Enter to send",
    "Tab  focus scrollback   Ctrl+C  quit   Ctrl+L  clear",
    "/help  slash commands   Ctrl+T  toggle thinking",
  ];
  const rows: Row[] = [
    { segments: [] },
    {
      segments: [
        { text: "  * ", style: { fg: theme.accent } },
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

function activityGlyph(phase: string, tick: number): string {
  const frames = ["|", "/", "-", "\\"];
  if (phase === "waiting") return "...";
  return frames[tick % frames.length]!;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "thinking":
      return "thinking…";
    case "streaming":
      return "streaming…";
    case "tool":
      return "running tools…";
    case "waiting":
      return "waiting…";
    default:
      return phase;
  }
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
