/**
 * Multiline prompt editor — Grok-style bottom input region.
 * Handles cursor, wrap, history, and slash-command hints.
 */

import { stringWidth } from "./ansi.js";
import type { Theme } from "./theme.js";
import type { Row } from "./components/parts.js";

export interface PromptState {
  text: string;
  cursor: number; // code-unit index into text
  history: string[];
  historyIndex: number; // -1 = live draft
  draftBackup: string;
}

export function createPrompt(): PromptState {
  return {
    text: "",
    cursor: 0,
    history: [],
    historyIndex: -1,
    draftBackup: "",
  };
}

export function promptInsert(p: PromptState, ch: string): void {
  p.text = p.text.slice(0, p.cursor) + ch + p.text.slice(p.cursor);
  p.cursor += ch.length;
}

export function promptBackspace(p: PromptState): void {
  if (p.cursor <= 0) return;
  // delete one code point before cursor
  const before = p.text.slice(0, p.cursor);
  const cp = before.codePointAt([...before].length - 1);
  // simpler: remove last JS char, handling surrogates
  let i = p.cursor - 1;
  if (i > 0 && isLowSurrogate(p.text.charCodeAt(i)) && isHighSurrogate(p.text.charCodeAt(i - 1))) {
    i -= 1;
  }
  p.text = p.text.slice(0, i) + p.text.slice(p.cursor);
  p.cursor = i;
}

export function promptDelete(p: PromptState): void {
  if (p.cursor >= p.text.length) return;
  let end = p.cursor + 1;
  if (
    end < p.text.length &&
    isHighSurrogate(p.text.charCodeAt(p.cursor)) &&
    isLowSurrogate(p.text.charCodeAt(end))
  ) {
    end += 1;
  }
  p.text = p.text.slice(0, p.cursor) + p.text.slice(end);
}

export function promptMove(p: PromptState, delta: number): void {
  if (delta < 0) {
    let i = p.cursor + delta;
    while (i > 0 && isLowSurrogate(p.text.charCodeAt(i))) i--;
    p.cursor = Math.max(0, i);
  } else {
    let i = p.cursor + delta;
    while (i < p.text.length && isLowSurrogate(p.text.charCodeAt(i))) i++;
    p.cursor = Math.min(p.text.length, i);
  }
}

export function promptSubmit(p: PromptState): string | null {
  const trimmed = p.text.trim();
  if (!trimmed) return null;
  p.history.push(p.text);
  if (p.history.length > 200) p.history.shift();
  p.historyIndex = -1;
  p.draftBackup = "";
  const out = p.text;
  p.text = "";
  p.cursor = 0;
  return out;
}

export function promptHistory(p: PromptState, dir: -1 | 1): void {
  if (p.history.length === 0) return;
  if (dir === -1) {
    if (p.historyIndex === -1) {
      p.draftBackup = p.text;
      p.historyIndex = p.history.length - 1;
    } else if (p.historyIndex > 0) {
      p.historyIndex -= 1;
    }
  } else {
    if (p.historyIndex === -1) return;
    if (p.historyIndex < p.history.length - 1) {
      p.historyIndex += 1;
    } else {
      p.historyIndex = -1;
      p.text = p.draftBackup;
      p.cursor = p.text.length;
      return;
    }
  }
  p.text = p.history[p.historyIndex] ?? "";
  p.cursor = p.text.length;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/**
 * Layout the prompt into rows for the frame buffer.
 * Returns rows + cursor position (row, col) relative to the prompt block.
 */
export function layoutPrompt(
  p: PromptState,
  theme: Theme,
  width: number,
  focused: boolean,
  opts?: {
    placeholder?: string;
    /** Inline ghost completion drawn after the cursor */
    ghost?: string;
  },
): { rows: Row[]; cursorRow: number; cursorCol: number; height: number } {
  const placeholder =
    opts?.placeholder ?? "Message libra...  (/ command  @ file  tab complete)";
  const ghost = opts?.ghost ?? "";
  const prefix = focused ? "> " : "  ";
  const prefixW = stringWidth(prefix);
  const inner = Math.max(1, width - prefixW);

  const display = p.text.length === 0 && !focused ? "" : p.text;
  const showPlaceholder = p.text.length === 0;

  // Wrap text into visual lines
  const visual = wrapWithCursor(display, p.cursor, inner);
  const lines = visual.lines.length ? visual.lines : [""];

  const rows: Row[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === 0) {
      if (showPlaceholder) {
        rows.push({
          segments: [
            {
              text: prefix,
              style: { fg: focused ? theme.accent : theme.fgFaint, bold: focused },
            },
            {
              text: placeholder.slice(0, inner),
              style: { fg: theme.fgFaint, italic: true },
            },
          ],
        });
      } else {
        // Split line at cursor for ghost insertion on the cursor's visual line
        const segs: Row["segments"] = [
          {
            text: prefix,
            style: { fg: focused ? theme.accent : theme.fgFaint, bold: focused },
          },
          { text: line, style: { fg: theme.fg } },
        ];
        if (ghost && i === visual.cursorLine && p.cursor === p.text.length) {
          // ghost only when cursor at end of text for simplicity on multi-line
          segs.push({
            text: ghost.slice(0, Math.max(0, inner - stringWidth(line))),
            style: { fg: theme.fgFaint, dim: true, italic: true },
          });
        }
        rows.push({ segments: segs });
      }
    } else {
      const segs: Row["segments"] = [
        { text: " ".repeat(prefixW), style: {} },
        { text: line, style: { fg: theme.fg } },
      ];
      if (ghost && i === visual.cursorLine && p.cursor === p.text.length) {
        segs.push({
          text: ghost.slice(0, Math.max(0, inner - stringWidth(line))),
          style: { fg: theme.fgFaint, dim: true, italic: true },
        });
      }
      rows.push({ segments: segs });
    }
  }

  // If cursor is mid-text but ghost is line-completion, still show on last line end
  // Cap height so prompt doesn't eat the whole screen
  const maxLines = 6;
  const height = Math.min(lines.length, maxLines);

  let cursorRow = visual.cursorLine;
  let cursorCol = prefixW + visual.cursorCol;
  if (showPlaceholder) {
    cursorRow = 0;
    cursorCol = prefixW;
  }
  if (cursorRow >= maxLines) {
    cursorRow = maxLines - 1;
  }

  return { rows: rows.slice(0, height), cursorRow, cursorCol, height };
}

function wrapWithCursor(
  text: string,
  cursor: number,
  width: number,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  if (width < 1) width = 1;
  const lines: string[] = [];
  let line = "";
  let lineW = 0;
  let cursorLine = 0;
  let cursorCol = 0;
  let i = 0;

  const push = () => {
    lines.push(line);
    line = "";
    lineW = 0;
  };

  while (i < text.length) {
    if (i === cursor) {
      cursorLine = lines.length;
      cursorCol = lineW;
    }
    const code = text.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const step = code > 0xffff ? 2 : 1;

    if (ch === "\n") {
      push();
      i += step;
      continue;
    }

    const cw = stringWidth(ch);
    if (lineW + cw > width && lineW > 0) {
      push();
    }
    line += ch;
    lineW += cw;
    i += step;
  }
  if (cursor === text.length) {
    cursorLine = lines.length;
    cursorCol = lineW;
  }
  lines.push(line);
  return { lines, cursorLine, cursorCol };
}
