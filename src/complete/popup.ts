/**
 * Autocomplete UI — same chrome as full pickers/tabs so / and empty-tab
 * lists look identical.
 */

import type { Style } from "../tui/ansi.js";
import { stringWidth } from "../tui/ansi.js";
import type { Theme } from "../tui/theme.js";
import type { Row } from "../tui/components/parts.js";
import type { CompleteResult, Suggestion } from "./engine.js";

export interface PopupLayout {
  rows: Row[];
  height: number;
}

export function layoutPopup(
  result: CompleteResult,
  selected: number,
  theme: Theme,
  width: number,
  maxItems = 12,
): PopupLayout {
  if (result.items.length === 0 || result.mode === "none") {
    return { rows: [], height: 0 };
  }

  // Same visual width as pickers
  const inner = Math.max(24, Math.min(width, 64));
  const items = result.items.slice(0, maxItems);
  const sel = Math.max(0, Math.min(selected, items.length - 1));
  const rows: Row[] = [];
  const bar = (ch: string) => ch.repeat(inner);

  const title =
    result.mode === "command"
      ? "Commands"
      : result.mode === "param"
        ? "Options"
        : result.mode === "file"
          ? "Files"
          : "Suggestions";

  // Picker-identical chrome
  rows.push({
    segments: [{ text: bar("-"), style: { fg: theme.border } }],
  });
  rows.push({
    segments: [
      {
        text: padCenter(
          ` ${title}  (${sel + 1}/${items.length}) `,
          inner,
        ),
        style: { fg: theme.accent, bold: true, bg: theme.bgElevated },
      },
    ],
  });
  rows.push({
    segments: [{ text: bar("-"), style: { fg: theme.border } }],
  });

  for (let i = 0; i < items.length; i++) {
    rows.push(optionRow(items[i]!, i === sel, theme, inner));
  }

  rows.push({
    segments: [{ text: bar("-"), style: { fg: theme.border } }],
  });
  rows.push({
    segments: [
      {
        text: truncate(
          " hover: arrows/space  tab fill  enter run  esc",
          inner,
        ),
        style: { fg: theme.fgFaint, bg: theme.bgElevated },
      },
    ],
  });

  return { rows, height: rows.length };
}

function optionRow(
  item: Suggestion,
  active: boolean,
  theme: Theme,
  inner: number,
): Row {
  const bg = active ? theme.selection : theme.bgElevated;
  const mark = active ? ">" : " ";
  // Show * on nothing by default (no "current" for ephemeral complete)
  const label = item.label;
  const left = `${mark}  ${label}`;
  const detail = item.detail ?? "";
  const leftW = stringWidth(left);
  const room = Math.max(0, inner - leftW - 1);
  const right = detail ? truncate(detail, room) : "";
  const pad = Math.max(0, inner - leftW - stringWidth(right));

  const segs: Row["segments"] = [
    {
      text: left,
      style: {
        fg: active ? theme.accent : theme.fg,
        bg,
        bold: active,
      },
    },
  ];
  if (pad > 0) segs.push({ text: " ".repeat(pad), style: { bg } });
  if (right) {
    segs.push({
      text: right,
      style: { fg: theme.fgFaint, bg } as Style,
    });
  }
  const used = leftW + pad + stringWidth(right);
  if (used < inner) {
    segs.push({ text: " ".repeat(inner - used), style: { bg } });
  }
  return { segments: segs };
}

export function clampSelected(selected: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(selected, count - 1));
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
