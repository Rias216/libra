/**
 * Virtualized scrollback — builds a flat list of painted rows from
 * messages/parts, then windows them into the visible viewport.
 * Inspired by Grok's scrollback pane + OpenCode's part composition.
 */

import type { HarnessState } from "../core/types.js";
import type { Theme } from "./theme.js";
import {
  renderPart,
  renderRoleHeader,
  type Row,
} from "./components/parts.js";

export interface ScrollModel {
  /** All rows in document order */
  rows: Row[];
  /** Index of first visible row */
  offset: number;
}

export function buildScrollRows(
  state: HarnessState,
  theme: Theme,
  contentWidth: number,
  tick: number,
): Row[] {
  const rows: Row[] = [];
  const pad = state.compact ? 0 : 1;

  if (state.messages.length === 0) {
    rows.push(...emptyStateRows(theme, contentWidth));
    return rows;
  }

  for (let mi = 0; mi < state.messages.length; mi++) {
    const msg = state.messages[mi]!;
    if (pad && mi > 0) {
      rows.push({ segments: [] });
    }

    // Role header for user / assistant (skip pure tool-role messages)
    if (msg.role === "user" || msg.role === "assistant") {
      const meta =
        msg.usage != null
          ? `${msg.usage.input + msg.usage.output} tok`
          : undefined;
      rows.push(renderRoleHeader(msg.role, theme, meta));
    }

    for (const part of msg.parts) {
      const partRows = renderPart(part, theme, {
        width: contentWidth,
        showToolDetails: state.showToolDetails,
        showThinking: state.showThinking,
        tick,
      });
      // Indent assistant body slightly for visual rhythm
      if (msg.role === "assistant" && part.type === "text") {
        for (const r of partRows) {
          rows.push(r);
        }
      } else {
        rows.push(...partRows);
      }
    }
  }

  // Trailing activity line when agent is busy with no streaming caret yet
  if (state.phase !== "idle" && state.phase !== "error") {
    rows.push({ segments: [] });
    rows.push({
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

  return rows;
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

/** Clamp scroll offset so the window stays in range */
export function clampOffset(
  offset: number,
  totalRows: number,
  viewHeight: number,
): number {
  const max = Math.max(0, totalRows - viewHeight);
  return Math.max(0, Math.min(offset, max));
}

/** Stick to bottom if previously pinned */
export function followTail(
  offset: number,
  totalRows: number,
  viewHeight: number,
  wasFollowing: boolean,
): number {
  if (wasFollowing) {
    return Math.max(0, totalRows - viewHeight);
  }
  return clampOffset(offset, totalRows, viewHeight);
}

export function isFollowing(
  offset: number,
  totalRows: number,
  viewHeight: number,
): boolean {
  return offset >= Math.max(0, totalRows - viewHeight);
}
