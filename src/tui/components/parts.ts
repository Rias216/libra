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

export interface Row {
  segments: { text: string; style: Style }[];
  /** Optional full-line background */
  bg?: Style["bg"];
}

const SPINNER = ["|", "/", "-", "\\"];

export function spinnerFrame(tick: number): string {
  return SPINNER[tick % SPINNER.length]!;
}

export function renderPart(
  part: Part,
  theme: Theme,
  opts: {
    width: number;
    showToolDetails: boolean;
    showThinking: boolean;
    tick: number;
  },
): Row[] {
  switch (part.type) {
    case "text":
      return renderText(part, theme, opts.width);
    case "reasoning":
      return opts.showThinking
        ? renderReasoning(part, theme, opts.width, opts.tick)
        : [];
    case "tool":
      return renderTool(part, theme, opts);
    case "diff":
      return renderDiff(part, theme, opts.width);
    case "file":
      return renderFile(part, theme, opts.width);
    case "status":
      return renderStatus(part, theme, opts.width);
    default:
      return [];
  }
}

function segsToRows(lines: RenderLine[]): Row[] {
  return lines.map((l) => ({ segments: l.segments }));
}

function renderText(part: TextPart, theme: Theme, width: number): Row[] {
  const rows = segsToRows(renderMarkdown(part.content, theme, width));
  if (part.streaming) {
    // caret on last line
    if (rows.length === 0) {
      rows.push({
        segments: [{ text: "|", style: { fg: theme.accentAssistant } }],
      });
    } else {
      const last = rows[rows.length - 1]!;
      last.segments = [
        ...last.segments,
        { text: "|", style: { fg: theme.accentAssistant } },
      ];
    }
  }
  return rows;
}

function renderReasoning(
  part: ReasoningPart,
  theme: Theme,
  width: number,
  tick: number,
): Row[] {
  const rows: Row[] = [];
  const icon = part.streaming ? spinnerFrame(tick) : "*";
  const label = part.streaming ? "thinking" : "thought";
  const collapsed = part.collapsed ?? (!part.streaming && part.content.length > 400);

  rows.push({
    segments: [
      { text: `${icon} `, style: { fg: theme.thinking } },
      {
        text: label,
        style: { fg: theme.thinking, italic: true, dim: true },
      },
      {
        text: collapsed ? "  (folded)" : "",
        style: { fg: theme.fgFaint, dim: true },
      },
    ],
  });

  if (collapsed) return rows;

  const bodyWidth = Math.max(1, width - 2);
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
  if (part.streaming) {
    const last = rows[rows.length - 1];
    if (last) {
      last.segments.push({
        text: "|",
        style: { fg: theme.thinking },
      });
    }
  }
  return rows;
}

function renderTool(
  part: ToolPart,
  theme: Theme,
  opts: {
    width: number;
    showToolDetails: boolean;
    tick: number;
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
  const header = `${icon} ${part.toolName}`;
  const rest = summary ? `  ${summary}` : "";
  const trail = `${duration}`;

  rows.push({
    segments: [
      { text: header, style: { ...statusStyle, bold: true } },
      { text: rest, style: { fg: theme.fgMuted } },
      { text: trail, style: { fg: theme.fgFaint } },
    ],
  });

  const collapsed = part.collapsed ?? !opts.showToolDetails;
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

  // Result / error
  if (part.error) {
    for (const line of wrapPlain(part.error, opts.width - 4).slice(0, 8)) {
      rows.push({
        segments: [
          { text: "  x ", style: { fg: theme.toolError } },
          { text: line, style: { fg: theme.toolError } },
        ],
      });
    }
  } else if (part.result && (part.status === "completed" || opts.showToolDetails)) {
    const preview = wrapPlain(part.result, opts.width - 4).slice(0, 12);
    for (const line of preview) {
      rows.push({
        segments: [
          { text: "  | ", style: { fg: theme.border } },
          { text: line, style: { fg: theme.fgMuted } },
        ],
      });
    }
    const total = wrapPlain(part.result, opts.width - 4).length;
    if (total > 12) {
      rows.push({
        segments: [
          {
            text: `  | ... ${total - 12} more lines`,
            style: { fg: theme.fgFaint },
          },
        ],
      });
    }
  }

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

function renderDiff(part: DiffPart, theme: Theme, width: number): Row[] {
  const rows: Row[] = [];
  const stats = `+${part.additions} -${part.deletions}`;
  rows.push({
    segments: [
      { text: "# ", style: { fg: theme.diffMeta } },
      { text: part.path, style: { fg: theme.fg, bold: true } },
      { text: `  ${stats}`, style: { fg: theme.fgMuted } },
    ],
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
