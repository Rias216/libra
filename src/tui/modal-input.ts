/**
 * Modal text input — used for API keys and xAI device codes.
 */

import type { Style } from "./ansi.js";
import { stringWidth } from "./ansi.js";
import type { Theme } from "./theme.js";
import type { Row } from "./components/parts.js";

export interface ModalInputSpec {
  title: string;
  /** Lines of help text above the field */
  lines?: string[];
  /** Highlighted banner (e.g. user code) */
  highlight?: string;
  placeholder?: string;
  /** Mask characters (API keys) */
  secret?: boolean;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}

export interface ModalInputState {
  spec: ModalInputSpec;
  value: string;
  cursor: number;
  error?: string;
}

export function createModalInput(spec: ModalInputSpec): ModalInputState {
  return { spec, value: "", cursor: 0 };
}

export function modalInsert(m: ModalInputState, ch: string): void {
  m.value = m.value.slice(0, m.cursor) + ch + m.value.slice(m.cursor);
  m.cursor += ch.length;
  m.error = undefined;
}

export function modalBackspace(m: ModalInputState): void {
  if (m.cursor <= 0) return;
  m.value = m.value.slice(0, m.cursor - 1) + m.value.slice(m.cursor);
  m.cursor -= 1;
  m.error = undefined;
}

export function modalMove(m: ModalInputState, delta: number): void {
  m.cursor = Math.max(0, Math.min(m.value.length, m.cursor + delta));
}

export function layoutModalInput(
  m: ModalInputState,
  theme: Theme,
  width: number,
): { rows: Row[]; height: number; cursorCol: number; cursorRow: number } {
  const inner = Math.max(24, Math.min(width, 64));
  const rows: Row[] = [];
  const bar = "-".repeat(inner);
  const bg = theme.bgElevated;

  rows.push({
    segments: [{ text: bar, style: { fg: theme.border } }],
  });
  rows.push({
    segments: [
      {
        text: padCenter(` ${m.spec.title} `, inner),
        style: { fg: theme.accent, bold: true, bg },
      },
    ],
  });
  rows.push({
    segments: [{ text: bar, style: { fg: theme.border } }],
  });

  for (const line of m.spec.lines ?? []) {
    rows.push({
      segments: [
        {
          text: truncate(` ${line}`, inner),
          style: { fg: theme.fgMuted, bg },
        },
      ],
    });
  }

  if (m.spec.highlight) {
    rows.push({
      segments: [
        {
          text: padCenter(` ${m.spec.highlight} `, inner),
          style: { fg: theme.toolRunning, bold: true, bg: theme.bgSubtle },
        },
      ],
    });
  }

  const display = m.spec.secret
    ? "*".repeat(m.value.length)
    : m.value || (m.spec.placeholder ?? "");
  const fieldStyle: Style = m.value
    ? { fg: theme.fg, bg: theme.bgSubtle }
    : { fg: theme.fgFaint, italic: true, bg: theme.bgSubtle };
  const field = ` > ${truncate(display, inner - 4)}`;
  rows.push({
    segments: [
      {
        text: field + " ".repeat(Math.max(0, inner - stringWidth(field))),
        style: fieldStyle,
      },
    ],
  });

  if (m.error) {
    rows.push({
      segments: [
        {
          text: truncate(` ! ${m.error}`, inner),
          style: { fg: theme.error, bg },
        },
      ],
    });
  }

  rows.push({
    segments: [{ text: bar, style: { fg: theme.border } }],
  });
  rows.push({
    segments: [
      {
        text: truncate(" enter confirm   esc cancel", inner),
        style: { fg: theme.fgFaint, bg },
      },
    ],
  });

  // Cursor sits on the field row
  const cursorRow =
    3 +
    (m.spec.lines?.length ?? 0) +
    (m.spec.highlight ? 1 : 0);
  const cursorCol = 3 + (m.spec.secret ? m.cursor : m.cursor);

  return { rows, height: rows.length, cursorCol, cursorRow };
}

function padCenter(s: string, width: number): string {
  const w = stringWidth(s);
  if (w >= width) return truncate(s, width);
  const left = Math.floor((width - w) / 2);
  return " ".repeat(left) + s + " ".repeat(width - w - left);
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
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
