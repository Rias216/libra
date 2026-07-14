/**
 * OpenCode-style settings picker — searchable, scrollable.
 *
 * Keys:
 *   up/down/j/k     move hover
 *   space           activate / toggle value (stay open)
 *   left/right      cycle value on row, or activate
 *   enter           activate and close (unless closeOnSelect=false)
 *   type-to-search  filter options (when searchable)
 *   backspace       delete search char
 *   esc             back (clear search → parent picker → close)
 */

import type { Style } from "./ansi.js";
import { stringWidth } from "./ansi.js";
import type { Theme } from "./theme.js";
import type { Row } from "./components/parts.js";
import { fuzzyFilter } from "../complete/fuzzy.js";

export interface PickerOption {
  value: string;
  label: string;
  description?: string;
  /**
   * Optional cycle values for left/right on this row.
   * E.g. ["on","off"] or ["1","2","3","4"].
   */
  cycleValues?: string[];
  /** Display labels parallel to cycleValues */
  cycleLabels?: string[];
  /** Current cycle index (for display) */
  cycleIndex?: number;
}

export interface PickerSpec {
  title: string;
  options: PickerOption[];
  current?: string;
  /** Enter confirms. Default true — set false for multi-select / toggle lists. */
  closeOnSelect?: boolean;
  /** Enable type-to-filter (default true when options.length > 12) */
  searchable?: boolean;
  onSelect: (value: string) => void;
  /**
   * Space / soft-activate without requiring close.
   * Defaults to onSelect when omitted.
   */
  onActivate?: (value: string) => void;
  /**
   * Left/right on a row — change setting value without leaving.
   * dir: -1 left, +1 right.
   */
  onCycle?: (value: string, dir: -1 | 1) => void;
  onCancel?: () => void;
  onPreview?: (value: string) => void;
}

export interface PickerState {
  spec: PickerSpec;
  selected: number;
  scroll: number;
  /** Type-to-search query */
  query: string;
}

export function createPicker(spec: PickerSpec): PickerState {
  let selected = 0;
  if (spec.current) {
    const idx = spec.options.findIndex((o) => o.value === spec.current);
    if (idx >= 0) selected = idx;
  }
  const state: PickerState = { spec, selected, scroll: 0, query: "" };
  const first = filteredOptions(state)[selected] ?? filteredOptions(state)[0];
  if (first && spec.onPreview) spec.onPreview(first.value);
  // Re-find selected in full list
  ensureVisible(state, visibleCapacity(12));
  return state;
}

/** Replace options in-place (for multi-select rebuild without new modal). */
export function pickerSetOptions(
  p: PickerState,
  options: PickerOption[],
  current?: string,
): void {
  p.spec = { ...p.spec, options, current: current ?? p.spec.current };
  const filtered = filteredOptions(p);
  if (p.selected >= filtered.length) p.selected = Math.max(0, filtered.length - 1);
  if (current) {
    const idx = filtered.findIndex((o) => o.value === current);
    if (idx >= 0) p.selected = idx;
  }
}

export function visibleCapacity(maxRows: number): number {
  // top bar, title, search?, mid bar, bottom bar, footer ≈ 6
  return Math.max(3, maxRows - 6);
}

export function filteredOptions(p: PickerState): PickerOption[] {
  const q = p.query.trim();
  if (!q) return p.spec.options;
  const keys = p.spec.options.map(
    (o) => `${o.label} ${o.description ?? ""} ${o.value}`,
  );
  const hits = fuzzyFilter(q, keys, p.spec.options.length);
  const out: PickerOption[] = [];
  const used = new Set<number>();
  for (const h of hits) {
    const idx = keys.findIndex((k, i) => !used.has(i) && k === h.item);
    if (idx < 0) continue;
    used.add(idx);
    out.push(p.spec.options[idx]!);
  }
  // Fallback: simple includes
  if (out.length === 0) {
    const lq = q.toLowerCase();
    return p.spec.options.filter(
      (o) =>
        o.label.toLowerCase().includes(lq) ||
        o.value.toLowerCase().includes(lq) ||
        (o.description ?? "").toLowerCase().includes(lq),
    );
  }
  return out;
}

export function isSearchable(p: PickerState): boolean {
  if (p.spec.searchable === false) return false;
  if (p.spec.searchable === true) return true;
  return p.spec.options.length > 12;
}

export function pickerMove(p: PickerState, delta: number, viewSize = 10): void {
  const opts = filteredOptions(p);
  const n = opts.length;
  if (n === 0) return;
  p.selected = (p.selected + delta + n * 10) % n;
  ensureVisible(p, viewSize);
  const opt = opts[p.selected];
  if (opt && p.spec.onPreview) p.spec.onPreview(opt.value);
}

export function pickerPage(p: PickerState, dir: -1 | 1, viewSize = 10): void {
  const opts = filteredOptions(p);
  const n = opts.length;
  if (n === 0) return;
  const step = Math.max(1, viewSize - 1);
  p.selected = Math.max(0, Math.min(n - 1, p.selected + dir * step));
  ensureVisible(p, viewSize);
  const opt = opts[p.selected];
  if (opt && p.spec.onPreview) p.spec.onPreview(opt.value);
}

export function pickerGoto(
  p: PickerState,
  index: number,
  viewSize = 10,
): void {
  const opts = filteredOptions(p);
  const n = opts.length;
  if (n === 0) return;
  p.selected = Math.max(0, Math.min(n - 1, index));
  ensureVisible(p, viewSize);
  const opt = opts[p.selected];
  if (opt && p.spec.onPreview) p.spec.onPreview(opt.value);
}

/** Enter — activate; returns whether picker should close */
export function pickerAccept(p: PickerState): boolean {
  const opts = filteredOptions(p);
  const opt = opts[p.selected];
  if (!opt) return true;
  p.spec.onSelect(opt.value);
  return p.spec.closeOnSelect !== false;
}

/** Space — activate/toggle without closing */
export function pickerActivate(p: PickerState): void {
  const opts = filteredOptions(p);
  const opt = opts[p.selected];
  if (!opt) return;
  if (p.spec.onActivate) p.spec.onActivate(opt.value);
  else p.spec.onSelect(opt.value);
}

/** Left/right — cycle value on row or call onCycle */
export function pickerCycle(p: PickerState, dir: -1 | 1): boolean {
  const opts = filteredOptions(p);
  const opt = opts[p.selected];
  if (!opt) return false;

  if (p.spec.onCycle) {
    p.spec.onCycle(opt.value, dir);
    return true;
  }

  // Built-in cycleValues on the option
  if (opt.cycleValues && opt.cycleValues.length > 0) {
    const n = opt.cycleValues.length;
    const cur = opt.cycleIndex ?? 0;
    const next = (cur + dir + n * 10) % n;
    const nextVal = opt.cycleValues[next]!;
    // Encode as value|cycle so callers can parse, or use onActivate with next
    if (p.spec.onActivate) p.spec.onActivate(`${opt.value}::${nextVal}`);
    else p.spec.onSelect(`${opt.value}::${nextVal}`);
    return true;
  }

  // Default: treat as soft activate (toggle) so left/right still do something useful
  if (p.spec.onActivate) {
    p.spec.onActivate(opt.value);
    return true;
  }
  return false;
}

export function pickerType(p: PickerState, ch: string, viewSize = 10): void {
  if (!isSearchable(p) && p.query.length === 0 && ch === " ") {
    // space handled elsewhere as activate when not searching
    return;
  }
  p.query += ch;
  p.selected = 0;
  p.scroll = 0;
  ensureVisible(p, viewSize);
  const opt = filteredOptions(p)[0];
  if (opt && p.spec.onPreview) p.spec.onPreview(opt.value);
}

export function pickerBackspace(p: PickerState, viewSize = 10): void {
  if (!p.query) return;
  p.query = p.query.slice(0, -1);
  p.selected = 0;
  p.scroll = 0;
  ensureVisible(p, viewSize);
  const opt = filteredOptions(p)[0];
  if (opt && p.spec.onPreview) p.spec.onPreview(opt.value);
}

export function pickerSelectedValue(p: PickerState): string | undefined {
  return filteredOptions(p)[p.selected]?.value;
}

export function ensureVisible(p: PickerState, viewSize: number): void {
  const n = filteredOptions(p).length;
  const cap = Math.max(1, viewSize);
  if (n <= cap) {
    p.scroll = 0;
    return;
  }
  if (p.selected < p.scroll) {
    p.scroll = p.selected;
  } else if (p.selected >= p.scroll + cap) {
    p.scroll = p.selected - cap + 1;
  }
  p.scroll = Math.max(0, Math.min(p.scroll, Math.max(0, n - cap)));
}

export function layoutPicker(
  p: PickerState,
  theme: Theme,
  width: number,
  maxRows = 16,
  canGoBack = false,
): { rows: Row[]; height: number; viewSize: number } {
  const inner = Math.max(20, Math.min(width, 72));
  const rows: Row[] = [];
  const bar = (ch: string) => ch.repeat(inner);
  const opts = filteredOptions(p);
  const total = opts.length;
  const searchable = isSearchable(p);
  const chrome = searchable ? 7 : 5;
  const viewSize = Math.max(3, maxRows - chrome);
  ensureVisible(p, viewSize);

  const moreAbove = p.scroll > 0;
  const moreBelow = p.scroll + viewSize < total;
  let listCap = viewSize;
  if (moreAbove) listCap -= 1;
  if (moreBelow) listCap -= 1;
  listCap = Math.max(1, listCap);
  ensureVisible(p, listCap);

  const end = Math.min(total, p.scroll + listCap);
  const slice = opts.slice(p.scroll, end);

  rows.push({
    segments: [{ text: bar("-"), style: { fg: theme.border } }],
  });

  const countLabel =
    total !== p.spec.options.length
      ? ` ${p.spec.title}  (${total}/${p.spec.options.length}) `
      : total > listCap
        ? ` ${p.spec.title}  (${p.selected + 1}/${total}) `
        : ` ${p.spec.title} `;
  rows.push({
    segments: [
      {
        text: padCenter(countLabel, inner),
        style: { fg: theme.accent, bold: true, bg: theme.bgElevated },
      },
    ],
  });

  if (searchable) {
    const q = p.query;
    const searchLine = q
      ? ` filter: ${q}|`
      : ` filter: type to search...`;
    rows.push({
      segments: [
        {
          text: truncate(` ${searchLine}`, inner),
          style: {
            fg: q ? theme.accentUser : theme.fgFaint,
            bg: theme.bgSubtle,
            italic: !q,
          },
        },
      ],
    });
  }

  rows.push({
    segments: [{ text: bar("-"), style: { fg: theme.border } }],
  });

  if (p.scroll > 0) {
    rows.push({
      segments: [
        {
          text: padCenter(` ^ ${p.scroll} more `, inner),
          style: { fg: theme.fgFaint, bg: theme.bgElevated },
        },
      ],
    });
  }

  if (slice.length === 0) {
    rows.push({
      segments: [
        {
          text: padCenter(" (no matches) ", inner),
          style: { fg: theme.fgFaint, bg: theme.bgElevated },
        },
      ],
    });
  }

  for (let i = 0; i < slice.length; i++) {
    const opt = slice[i]!;
    const absIndex = p.scroll + i;
    const active = absIndex === p.selected;
    const isCurrent = p.spec.current === opt.value;
    const mark = active ? ">" : " ";
    const cur = isCurrent ? "*" : " ";
    let label = opt.label;
    // Show cycle state inline
    if (opt.cycleValues && opt.cycleValues.length > 0) {
      const idx = opt.cycleIndex ?? 0;
      const cv =
        opt.cycleLabels?.[idx] ?? opt.cycleValues[idx] ?? "";
      label = `${opt.label}  [${cv}]`;
    }
    const left = `${mark}${cur} ${label}`;
    const detail = opt.description ?? "";
    const bg = active ? theme.selection : theme.bgElevated;
    const leftStyle: Style = {
      fg: active ? theme.accent : theme.fg,
      bg,
      bold: active,
    };
    const room = Math.max(0, inner - stringWidth(left) - 1);
    const right = detail ? truncate(detail, room) : "";
    const pad = Math.max(0, inner - stringWidth(left) - stringWidth(right));
    const segs: Row["segments"] = [
      { text: left, style: leftStyle },
      { text: " ".repeat(pad), style: { bg } },
    ];
    if (right) {
      segs.push({ text: right, style: { fg: theme.fgFaint, bg } });
    }
    const used = stringWidth(left) + pad + stringWidth(right);
    if (used < inner) {
      segs.push({ text: " ".repeat(inner - used), style: { bg } });
    }
    rows.push({ segments: segs });
  }

  if (end < total) {
    rows.push({
      segments: [
        {
          text: padCenter(` v ${total - end} more `, inner),
          style: { fg: theme.fgFaint, bg: theme.bgElevated },
        },
      ],
    });
  }

  rows.push({
    segments: [{ text: bar("-"), style: { fg: theme.border } }],
  });
  const escHint = canGoBack || p.query ? "esc back" : "esc close";
  rows.push({
    segments: [
      {
        text: truncate(
          searchable
            ? ` up/down  space  left/right  type=search  enter  ${escHint}`
            : ` up/down  space  left/right  enter  ${escHint}`,
          inner,
        ),
        style: { fg: theme.fgFaint, bg: theme.bgElevated },
      },
    ],
  });

  return { rows, height: rows.length, viewSize: listCap };
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
