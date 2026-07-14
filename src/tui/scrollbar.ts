/**
 * Scrollbar for the scrollback pane — track + thumb on the right edge.
 * Grok/OpenCode style: thin gutter that only lights up when content overflows.
 */

import type { Theme } from "./theme.js";
import type { Style } from "./ansi.js";

export interface ScrollbarMetrics {
  /** Absolute top row of the scroll viewport */
  top: number;
  /** Viewport height in rows */
  height: number;
  /** Total document rows */
  total: number;
  /** First visible row index */
  offset: number;
  /** Column to paint the scrollbar (usually cols - 1 or pad edge) */
  col: number;
}

export interface ScrollbarCell {
  y: number;
  ch: string;
  style: Style;
}

/**
 * Compute per-row scrollbar glyphs.
 * Returns empty when everything fits (no overflow).
 */
export function computeScrollbar(
  m: ScrollbarMetrics,
  theme: Theme,
  focused: boolean,
  chars?: { thumb?: string; track?: string },
): ScrollbarCell[] {
  if (m.height <= 0 || m.total <= m.height) {
    return [];
  }

  const track = m.height;
  const ratio = m.height / m.total;
  const thumbSize = Math.max(1, Math.round(track * ratio));
  const maxOffset = Math.max(1, m.total - m.height);
  const thumbTravel = Math.max(0, track - thumbSize);
  const thumbTop = Math.round((m.offset / maxOffset) * thumbTravel);
  const thumbCh = chars?.thumb ?? "#";
  const trackCh = chars?.track ?? "|";

  const cells: ScrollbarCell[] = [];
  const trackFg = focused ? theme.border : theme.fgFaint;
  const thumbFg = focused ? theme.accent : theme.fgMuted;

  for (let i = 0; i < track; i++) {
    const inThumb = i >= thumbTop && i < thumbTop + thumbSize;
    cells.push({
      y: m.top + i,
      ch: inThumb ? thumbCh : trackCh,
      style: {
        fg: inThumb ? thumbFg : trackFg,
        bg: theme.bg,
        dim: !inThumb,
      },
    });
  }
  return cells;
}

/** Human-readable scroll position for status bar */
export function scrollPercent(offset: number, total: number, view: number): string {
  if (total <= view) return "all";
  const max = total - view;
  if (offset <= 0) return "top";
  if (offset >= max) return "bot";
  return `${Math.round((offset / max) * 100)}%`;
}
