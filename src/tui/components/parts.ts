/**
 * Polymorphic part renderers — OpenCode-style tool cards, Grok-style blocks.
 * Each part type produces a list of visual rows for the scrollback.
 */

import type { Style } from "../ansi.js";
import { stringWidth } from "../ansi.js";
import { renderMarkdown, type RenderLine } from "../markdown.js";
import type { Theme } from "../theme.js";
import type {
  DiffPart,
  FilePart,
  Part,
  ReasoningPart,
  StatusPart,
  TextPart,
  ToolPart,
} from "../../core/types.js";
import { wrapStreamPlain } from "../stream-layout.js";

/**
 * Cache of fully materialised streaming body rows (borders + styles).
 * Invalidated only when content length / width / theme role changes —
 * tick-only paints (spinner) reuse the body so large traces don't re-layout.
 * On append, finished lines are kept and only the open tail is rewritten.
 */
const streamBodyCache = new Map<
  string,
  {
    width: number;
    contentLen: number;
    finishedLineCount: number;
    kind: "text" | "reasoning";
    themeKey: string;
    /** Finished lines only (no open/caret row). */
    finished: Row[];
    /** Full body including open + caret — stable between content changes. */
    body: Row[];
    /**
     * Stable [header, ...body] pack for reasoning — mutated in place so
     * tick-only paints don't allocate a thousands-long spread array.
     */
    packed?: Row[];
    /** Last spinner tick written into packed[0] */
    packedTick?: number;
  }
>();

export function clearStreamBodyCache(): void {
  streamBodyCache.clear();
}

/** Click / keyboard target for collapsible rows (reasoning, tools, diffs). */
export interface RowHit {
  action: "toggle-collapse";
  messageId: string;
  partId: string;
}

export interface Row {
  segments: { text: string; style: Style }[];
  /** Optional full-line background */
  bg?: Style["bg"];
  /** When set, a click on this row toggles the part (OpenCode-style). */
  hit?: RowHit;
}

/**
 * OpenCode-style braille loading spinner (default).
 * Override via setSpinnerGlyphs() when a font profile supplies its own frames.
 */
export const BRAILLE_SPINNER = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

let SPINNER: readonly string[] = BRAILLE_SPINNER;

/** Install spinner frames from the active glyph profile (or reset to braille). */
export function setSpinnerGlyphs(frames?: readonly string[] | null): void {
  if (frames && frames.length > 0) {
    SPINNER = frames;
  } else {
    SPINNER = BRAILLE_SPINNER;
  }
}

export function spinnerFrame(tick: number): string {
  const frames = SPINNER.length > 0 ? SPINNER : BRAILLE_SPINNER;
  return frames[tick % frames.length]!;
}

/** Active spinner frames (for tests / diagnostics). */
export function getSpinnerGlyphs(): readonly string[] {
  return SPINNER;
}

export function renderPart(
  part: Part,
  theme: Theme,
  opts: {
    width: number;
    showToolDetails: boolean;
    showThinking: boolean;
    tick: number;
    /** Required for click-to-expand hit targets */
    messageId?: string;
  },
): Row[] {
  switch (part.type) {
    case "text":
      return renderText(part, theme, opts.width);
    case "reasoning":
      return opts.showThinking
        ? renderReasoning(part, theme, opts.width, opts.tick, opts.messageId)
        : [];
    case "tool":
      return renderTool(part, theme, opts);
    case "diff":
      return renderDiff(part, theme, opts.width, opts.messageId);
    case "file":
      return renderFile(part, theme, opts.width);
    case "status":
      return renderStatus(part, theme, opts.width);
    default:
      return [];
  }
}

/** OpenCode default: expanded while streaming, folded when finished. */
export function isReasoningCollapsed(part: ReasoningPart): boolean {
  if (part.collapsed != null) return part.collapsed;
  return !part.streaming;
}

export function isToolCollapsed(
  part: ToolPart,
  showToolDetails: boolean,
): boolean {
  if (part.collapsed != null) return part.collapsed;
  return !showToolDetails;
}

function segsToRows(lines: RenderLine[]): Row[] {
  return lines.map((l) => ({ segments: l.segments }));
}

function renderText(part: TextPart, theme: Theme, width: number): Row[] {
  // Streaming: plain wrap only — full markdown (with auto code fences) once finished.
  if (!part.streaming) {
    return segsToRows(renderMarkdown(part.content, theme, width));
  }
  return streamingTextRows(part, theme, width);
}

function streamingTextRows(
  part: TextPart,
  theme: Theme,
  width: number,
): Row[] {
  const themeKey = theme.name;
  const hit = streamBodyCache.get(part.id);
  if (
    hit &&
    hit.kind === "text" &&
    hit.width === width &&
    hit.contentLen === part.content.length &&
    hit.themeKey === themeKey
  ) {
    return hit.body;
  }

  const { lines, open } = wrapStreamPlain(part.id, part.content, width);
  const fg = theme.fg;
  const caretStyle = { fg: theme.accentAssistant };

  let finished = hit?.kind === "text" &&
    hit.width === width &&
    hit.themeKey === themeKey &&
    hit.contentLen <= part.content.length
    ? hit.finished
    : [];
  let finishedLineCount =
    hit?.kind === "text" &&
    hit.width === width &&
    hit.themeKey === themeKey &&
    hit.contentLen <= part.content.length
      ? hit.finishedLineCount
      : 0;

  // Append only newly completed visual lines
  if (finishedLineCount > lines.length) {
    finished = [];
    finishedLineCount = 0;
  }
  // How many finished slots body already holds from the previous frame.
  // Captured before we grow finishedLineCount so the body copy stays O(delta).
  const prevFinishedLineCount = finishedLineCount;
  for (let i = finishedLineCount; i < lines.length; i++) {
    const line = lines[i]!;
    finished.push({
      segments: line ? [{ text: line, style: { fg } }] : [],
    });
  }
  finishedLineCount = lines.length;
  if (finished.length > finishedLineCount) {
    finished.length = finishedLineCount;
  }

  // Mutate a stable body array: finished refs + one open/caret row.
  // Only assign newly finished indices. Re-sync one prior slot so a
  // caret-on-last-finished overlay from the previous frame is restored
  // to the plain finished row before we write the new open/caret tail.
  const body = hit?.kind === "text" && hit.body ? hit.body : [];
  const copyFrom =
    body.length === 0 || prevFinishedLineCount <= 0
      ? 0
      : prevFinishedLineCount - 1;
  for (let i = copyFrom; i < finishedLineCount; i++) {
    body[i] = finished[i]!;
  }
  const openRow: Row = open
    ? {
        segments: [
          { text: open, style: { fg } },
          { text: "│", style: caretStyle },
        ],
      }
    : finishedLineCount === 0
      ? { segments: [{ text: "│", style: caretStyle }] }
      : {
          segments: [
            ...finished[finishedLineCount - 1]!.segments,
            { text: "│", style: caretStyle },
          ],
        };
  if (open || finishedLineCount === 0) {
    body[finishedLineCount] = openRow;
    body.length = finishedLineCount + 1;
  } else {
    // Caret lives on a copy of the last finished line
    body[finishedLineCount - 1] = openRow;
    body.length = finishedLineCount;
  }

  streamBodyCache.set(part.id, {
    width,
    contentLen: part.content.length,
    finishedLineCount,
    kind: "text",
    themeKey,
    finished,
    body,
  });
  return body;
}

function renderReasoning(
  part: ReasoningPart,
  theme: Theme,
  width: number,
  tick: number,
  messageId?: string,
): Row[] {
  const collapsed = isReasoningCollapsed(part);
  // OpenCode-style chevron: collapsed ▶ / expanded ▼ (ASCII fallback)
  const chevron = part.streaming
    ? spinnerFrame(tick)
    : collapsed
      ? ">"
      : "v";
  const baseLabel = part.streaming ? "Thinking" : "Thought";
  const label = part.title?.trim()
    ? `${baseLabel} · ${part.title.trim()}`
    : baseLabel;
  const sizeHint = formatSizeHint(part.content);
  const meta = part.streaming
    ? " streaming"
    : collapsed
      ? sizeHint
        ? `  ${sizeHint}  click to expand`
        : "  click to expand"
      : sizeHint
        ? `  ${sizeHint}  click to collapse`
        : "  click to collapse";

  const hit: RowHit | undefined =
    messageId && !part.streaming
      ? { action: "toggle-collapse", messageId, partId: part.id }
      : undefined;

  const header: Row = {
    segments: [
      { text: `${chevron} `, style: { fg: theme.thinking, bold: true } },
      {
        text: label,
        style: { fg: theme.thinking, italic: true },
      },
      {
        text: meta,
        style: { fg: theme.fgFaint, dim: true },
      },
    ],
    hit,
  };

  if (collapsed) return [header];

  const bodyWidth = Math.max(1, width - 2);
  // Streaming thoughts: incremental plain wrap; finished: markdown
  if (part.streaming) {
    return streamingReasoningPacked(part, theme, bodyWidth, header, tick);
  }

  const rows: Row[] = [header];
  const body = renderMarkdown(part.content || "...", theme, bodyWidth);
  for (const line of body) {
    rows.push({
      segments: [
        { text: "| ", style: { fg: theme.border } },
        ...line.segments.map((s) => ({
          text: s.text,
          style: { ...s.style, fg: theme.fgMuted, italic: true },
        })),
      ],
    });
  }
  return rows;
}

/**
 * Pack header + body into a stable array. Tick-only updates rewrite
 * packed[0] without spreading thousands of body rows.
 */
function streamingReasoningPacked(
  part: ReasoningPart,
  theme: Theme,
  bodyWidth: number,
  header: Row,
  tick: number,
): Row[] {
  const body = streamingReasoningBody(part, theme, bodyWidth);
  const cached = streamBodyCache.get(part.id);
  const packed = cached?.packed ?? [];
  const prevBodySlots = Math.max(0, packed.length - 1);
  packed[0] = header;
  // Body is mutated in place; unchanged finished slots keep the same row
  // refs. Only re-sync from the previous tail (caret/open may have moved)
  // through the new end — O(delta) instead of O(n) per content frame.
  // Full resync when packed is empty, body shrank, or body[0] was rebuilt
  // (theme/width invalidation replaces finished row objects).
  const needsFullSync =
    body.length > 0 &&
    (packed.length <= 1 ||
      body.length < prevBodySlots ||
      packed[1] !== body[0]);
  const syncFrom = needsFullSync ? 0 : Math.max(0, prevBodySlots - 1);
  for (let i = syncFrom; i < body.length; i++) {
    packed[i + 1] = body[i]!;
  }
  packed.length = body.length + 1;
  if (cached) {
    cached.packed = packed;
    cached.packedTick = tick;
  }
  return packed;
}

/**
 * Incremental layout for live reasoning traces. Body rows are cached by
 * content length so spinner/tick paints don't re-walk 100k+ chars, and
 * finished visual lines are only materialised once as the stream grows.
 */
function streamingReasoningBody(
  part: ReasoningPart,
  theme: Theme,
  bodyWidth: number,
): Row[] {
  const themeKey = theme.name;
  const cached = streamBodyCache.get(part.id);
  if (
    cached &&
    cached.kind === "reasoning" &&
    cached.width === bodyWidth &&
    cached.contentLen === part.content.length &&
    cached.themeKey === themeKey
  ) {
    return cached.body;
  }

  const source = part.content || "...";
  const { lines, open } = wrapStreamPlain(part.id, source, bodyWidth);
  const fg = theme.fgMuted;
  const border = theme.border;
  const caret = { text: "|", style: { fg: theme.thinking } };

  let finished =
    cached?.kind === "reasoning" &&
    cached.width === bodyWidth &&
    cached.themeKey === themeKey &&
    cached.contentLen <= part.content.length
      ? cached.finished
      : [];
  let finishedLineCount =
    cached?.kind === "reasoning" &&
    cached.width === bodyWidth &&
    cached.themeKey === themeKey &&
    cached.contentLen <= part.content.length
      ? cached.finishedLineCount
      : 0;

  if (finishedLineCount > lines.length) {
    finished = [];
    finishedLineCount = 0;
  }
  // How many finished slots body already holds from the previous frame.
  // Captured before we grow finishedLineCount so the body copy stays O(delta).
  const prevFinishedLineCount = finishedLineCount;
  for (let i = finishedLineCount; i < lines.length; i++) {
    finished.push({
      segments: [
        { text: "| ", style: { fg: border } },
        { text: lines[i]!, style: { fg, italic: true } },
      ],
    });
  }
  finishedLineCount = lines.length;
  if (finished.length > finishedLineCount) {
    finished.length = finishedLineCount;
  }

  // Reuse cached body; only write new finished rows (+ one prior slot to
  // clear a caret-on-last-finished overlay from the previous frame).
  // finished[] grows by push only and never mutates earlier entries, so
  // body[0..prev-1] already point at the correct finished refs.
  const body =
    cached?.kind === "reasoning" && cached.body ? cached.body : [];
  const copyFrom =
    body.length === 0 || prevFinishedLineCount <= 0
      ? 0
      : prevFinishedLineCount - 1;
  for (let i = copyFrom; i < finishedLineCount; i++) {
    body[i] = finished[i]!;
  }

  if (open) {
    body[finishedLineCount] = {
      segments: [
        { text: "| ", style: { fg: border } },
        { text: open, style: { fg, italic: true } },
        caret,
      ],
    };
    body.length = finishedLineCount + 1;
  } else if (finishedLineCount > 0) {
    const last = finished[finishedLineCount - 1]!;
    body[finishedLineCount - 1] = {
      segments: [...last.segments, caret],
    };
    body.length = finishedLineCount;
  } else {
    body[0] = {
      segments: [
        { text: "| ", style: { fg: border } },
        { text: "...", style: { fg, italic: true } },
        caret,
      ],
    };
    body.length = 1;
  }

  streamBodyCache.set(part.id, {
    width: bodyWidth,
    contentLen: part.content.length,
    finishedLineCount,
    kind: "reasoning",
    themeKey,
    finished,
    body,
    packed: cached?.packed,
    packedTick: cached?.packedTick,
  });
  return body;
}

function formatSizeHint(content: string): string {
  const n = content.length;
  if (n <= 0) return "";
  if (n < 1000) return `${n} chars`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k chars`;
  return `${Math.round(n / 1000)}k chars`;
}

function renderTool(
  part: ToolPart,
  theme: Theme,
  opts: {
    width: number;
    showToolDetails: boolean;
    tick: number;
    messageId?: string;
  },
): Row[] {
  const rows: Row[] = [];
  const statusStyle = toolStatusStyle(part, theme);
  const icon = toolIcon(part, opts.tick);
  const duration =
    part.startedAt && part.finishedAt
      ? ` ${formatMs(part.finishedAt - part.startedAt)}`
      : part.startedAt && part.status === "running"
        ? ` ${formatMs(Date.now() - part.startedAt)}`
        : "";

  const summary = toolSummary(part);
  const collapsed = isToolCollapsed(part, opts.showToolDetails);
  const chevron =
    part.status === "running"
      ? ""
      : collapsed
        ? "> "
        : "v ";
  const header = `${chevron}${icon} ${part.toolName}`;
  const rest = summary ? `  ${summary}` : "";
  const trail = `${duration}`;

  const hit: RowHit | undefined =
    opts.messageId && part.status !== "running" && part.status !== "pending"
      ? {
          action: "toggle-collapse",
          messageId: opts.messageId,
          partId: part.id,
        }
      : undefined;

  rows.push({
    segments: [
      { text: header, style: { ...statusStyle, bold: true } },
      { text: rest, style: { fg: theme.fgMuted } },
      { text: trail, style: { fg: theme.fgFaint } },
    ],
    hit,
  });

  if (collapsed && part.status !== "error") return rows;

  // Args preview
  const argLines = formatArgs(part.args, Math.max(1, opts.width - 4));
  for (const line of argLines.slice(0, 6)) {
    rows.push({
      segments: [
        { text: "  > ", style: { fg: theme.fgFaint } },
        { text: line, style: { fg: theme.fgMuted } },
      ],
    });
  }
  if (argLines.length > 6) {
    rows.push({
      segments: [
        {
          text: `  > ... +${argLines.length - 6} more`,
          style: { fg: theme.fgFaint },
        },
      ],
    });
  }

  // Result / error — always as a compact code block (not a wall of raw text)
  if (part.error) {
    rows.push(...renderCodeBlock(part.error, theme, opts.width, {
      label: "error",
      maxLines: 10,
      error: true,
    }));
  } else if (part.result && (part.status === "completed" || opts.showToolDetails)) {
    rows.push(
      ...renderCodeBlock(part.result, theme, opts.width, {
        label: "result",
        maxLines: 14,
      }),
    );
  }

  return rows;
}

/** Compact fenced-style block for tool output / errors. */
function renderCodeBlock(
  body: string,
  theme: Theme,
  width: number,
  opts: { label: string; maxLines: number; error?: boolean },
): Row[] {
  const rows: Row[] = [];
  const innerW = Math.max(1, width - 4);
  const lines = wrapPlain(body, innerW);
  const shown = lines.slice(0, opts.maxLines);
  const fg = opts.error ? theme.toolError : theme.fgMuted;
  const headFg = opts.error ? theme.toolError : theme.fgFaint;

  rows.push({
    segments: [
      { text: "  ┌── ", style: { fg: headFg } },
      { text: opts.label + " ", style: { fg: headFg } },
    ],
  });
  for (const line of shown) {
    rows.push({
      segments: [
        { text: "  │ ", style: { fg: theme.border } },
        {
          text: line,
          style: opts.error
            ? { fg }
            : { fg: theme.tool, bg: theme.bgSubtle },
        },
      ],
    });
  }
  if (lines.length > opts.maxLines) {
    rows.push({
      segments: [
        {
          text: `  │ … ${lines.length - opts.maxLines} more lines`,
          style: { fg: theme.fgFaint },
        },
      ],
    });
  }
  rows.push({
    segments: [{ text: "  └────────", style: { fg: headFg } }],
  });
  return rows;
}

function toolStatusStyle(part: ToolPart, theme: Theme): Style {
  switch (part.status) {
    case "pending":
      return { fg: theme.fgFaint };
    case "running":
      return { fg: theme.toolRunning };
    case "completed":
      return { fg: theme.toolOk };
    case "error":
      return { fg: theme.toolError };
    case "cancelled":
      return { fg: theme.fgMuted, dim: true };
  }
}

function toolIcon(part: ToolPart, tick: number): string {
  switch (part.status) {
    case "pending":
      return "o";
    case "running":
      return spinnerFrame(tick);
    case "completed":
      return "+";
    case "error":
      return "x";
    case "cancelled":
      return "-";
  }
}

function toolSummary(part: ToolPart): string {
  const a = part.args;
  if (typeof a.path === "string") return truncate(a.path, 60);
  if (typeof a.file_path === "string") return truncate(a.file_path, 60);
  if (typeof a.target_file === "string") return truncate(a.target_file, 60);
  if (typeof a.command === "string") return truncate(a.command, 60);
  if (typeof a.query === "string") return truncate(a.query, 60);
  if (typeof a.pattern === "string") return truncate(a.pattern, 60);
  return "";
}

function formatArgs(
  args: Record<string, unknown>,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    let val: string;
    if (typeof v === "string") val = v;
    else if (typeof v === "number" || typeof v === "boolean") val = String(v);
    else val = JSON.stringify(v);
    val = val.replace(/\n/g, "\\n");
    lines.push(...wrapPlain(`${k}: ${val}`, maxWidth));
  }
  return lines;
}

function renderDiff(
  part: DiffPart,
  theme: Theme,
  width: number,
  messageId?: string,
): Row[] {
  const rows: Row[] = [];
  const stats = `+${part.additions} -${part.deletions}`;
  const chevron = part.collapsed ? "> " : "v ";
  const hit: RowHit | undefined = messageId
    ? { action: "toggle-collapse", messageId, partId: part.id }
    : undefined;
  rows.push({
    segments: [
      { text: chevron, style: { fg: theme.diffMeta } },
      { text: "# ", style: { fg: theme.diffMeta } },
      { text: part.path, style: { fg: theme.fg, bold: true } },
      { text: `  ${stats}`, style: { fg: theme.fgMuted } },
    ],
    hit,
  });

  if (part.collapsed) return rows;

  for (const hunk of part.hunks) {
    rows.push({
      segments: [
        { text: "  " + hunk.header, style: { fg: theme.diffMeta, dim: true } },
      ],
    });
    for (const line of hunk.lines) {
      const prefix =
        line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      const style: Style =
        line.kind === "add"
          ? { fg: theme.diffAdd }
          : line.kind === "del"
            ? { fg: theme.diffDel }
            : { fg: theme.fgMuted };
      const text = truncate(`${prefix}${line.text}`, width - 2);
      rows.push({
        segments: [{ text: "  " + text, style }],
      });
    }
  }
  return rows;
}

function renderFile(part: FilePart, theme: Theme, width: number): Row[] {
  const range =
    part.lineStart != null
      ? `:${part.lineStart}${part.lineEnd != null ? `-${part.lineEnd}` : ""}`
      : "";
  const rows: Row[] = [
    {
      segments: [
        { text: "@ ", style: { fg: theme.info } },
        {
          text: truncate(part.path + range, width - 4),
          style: { fg: theme.accentUser },
        },
      ],
    },
  ];
  if (part.excerpt) {
    for (const line of wrapPlain(part.excerpt, width - 4).slice(0, 6)) {
      rows.push({
        segments: [
          { text: "   ", style: {} },
          { text: line, style: { fg: theme.fgMuted } },
        ],
      });
    }
  }
  return rows;
}

function renderStatus(part: StatusPart, theme: Theme, width: number): Row[] {
  const color =
    part.level === "error"
      ? theme.error
      : part.level === "warn"
        ? theme.warn
        : part.level === "success"
          ? theme.success
          : theme.info;
  const icon =
    part.level === "error"
      ? "!"
      : part.level === "warn"
        ? "!"
        : part.level === "success"
          ? "+"
          : "i";
  return [
    {
      segments: [
        { text: `${icon} `, style: { fg: color } },
        {
          text: truncate(part.message, width - 3),
          style: { fg: color },
        },
      ],
    },
  ];
}

export function renderRoleHeader(
  role: string,
  theme: Theme,
  meta?: string,
): Row {
  if (role === "user") {
    return {
      segments: [
        { text: "> ", style: { fg: theme.accentUser, bold: true } },
        { text: "you", style: { fg: theme.accentUser, bold: true } },
        {
          text: meta ? `  ${meta}` : "",
          style: { fg: theme.fgFaint },
        },
      ],
    };
  }
  if (role === "assistant") {
    return {
      segments: [
        { text: "* ", style: { fg: theme.accentAssistant, bold: true } },
        { text: "libra", style: { fg: theme.accentAssistant, bold: true } },
        {
          text: meta ? `  ${meta}` : "",
          style: { fg: theme.fgFaint },
        },
      ],
    };
  }
  return {
    segments: [
      { text: "- ", style: { fg: theme.accentSystem } },
      { text: role, style: { fg: theme.accentSystem } },
    ],
  };
}

function wrapPlain(text: string, width: number): string[] {
  if (width < 1) width = 1;
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!raw) {
      lines.push("");
      continue;
    }
    let rest = raw;
    while (rest.length > 0) {
      if (stringWidth(rest) <= width) {
        lines.push(rest);
        break;
      }
      // cut by code points to approximate width
      let w = 0;
      let i = 0;
      while (i < rest.length) {
        const code = rest.codePointAt(i)!;
        const ch = String.fromCodePoint(code);
        const cw = stringWidth(ch);
        if (w + cw > width) break;
        w += cw;
        i += code > 0xffff ? 2 : 1;
      }
      if (i === 0) i = 1;
      lines.push(rest.slice(0, i));
      rest = rest.slice(i);
    }
  }
  return lines;
}

function truncate(s: string, max: number): string {
  if (stringWidth(s) <= max) return s;
  if (max <= 3) return s.slice(0, max);
  let w = 0;
  let i = 0;
  const budget = max - 3;
  while (i < s.length) {
    const code = s.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const cw = stringWidth(ch);
    if (w + cw > budget) break;
    w += cw;
    i += code > 0xffff ? 2 : 1;
  }
  return s.slice(0, i) + "...";
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
