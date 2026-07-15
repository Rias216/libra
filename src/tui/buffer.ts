/**
 * Cell-based frame buffer with dirty-line diffing.
 * Optimized for high-frequency agent streaming paints.
 *
 * Hot-path rules:
 *  - Only mark a row dirty when a cell's glyph or style *actually* changes.
 *    During stream follow the status + last 1–2 lines change; the rest of the
 *    viewport must not be re-encoded / re-written to the terminal.
 *  - ASCII text uses a 1-cell width fast path (no string-width package).
 */

import { ansi, paint, stringWidth, styleOpen, type Style } from "./ansi.js";
import type { ColorLevel, Rgb, Theme } from "./theme.js";

export interface Cell {
  ch: string;
  style: Style;
}

/** Cache of styleOpen() results — styles repeat heavily across a frame */
const styleOpenCache = new Map<string, string>();
const STYLE_CACHE_MAX = 512;

export class FrameBuffer {
  width: number;
  height: number;
  private cells: Cell[];
  private prevLines: string[] = [];
  private level: ColorLevel;
  private bg: Rgb;
  /** Shared default bg style — avoid per-cell allocations on clear */
  private bgStyle: Style;
  /** Rows whose encoded ANSI may need rewrite */
  private dirty: Uint8Array;
  /** Rows that received content this frame (for clearUntouched) */
  private rowTouched: Uint8Array;
  /** Weak memo: Style without bg → Style with this.bg attached */
  private styleWithBgCache = new WeakMap<Style, Style>();

  constructor(width: number, height: number, level: ColorLevel, bg: Rgb) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.level = level;
    this.bg = bg;
    this.bgStyle = { bg };
    this.cells = this.alloc();
    this.dirty = new Uint8Array(this.height);
    this.rowTouched = new Uint8Array(this.height);
    this.dirty.fill(1);
  }

  private alloc(): Cell[] {
    const n = this.width * this.height;
    const cells = new Array<Cell>(n);
    const bg = this.bgStyle;
    for (let i = 0; i < n; i++) {
      cells[i] = { ch: " ", style: bg };
    }
    return cells;
  }

  resize(width: number, height: number, bg?: Rgb): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (bg) {
      this.bg = bg;
      this.bgStyle = { bg };
      this.styleWithBgCache = new WeakMap();
    }
    this.cells = this.alloc();
    this.prevLines = [];
    this.dirty = new Uint8Array(this.height);
    this.rowTouched = new Uint8Array(this.height);
    this.dirty.fill(1);
  }

  setLevel(level: ColorLevel): void {
    if (this.level !== level) {
      this.level = level;
      styleOpenCache.clear();
      this.dirty.fill(1);
    }
  }

  /** Start a frame — track which rows get content */
  beginFrame(bg?: Rgb): void {
    if (bg && (bg.r !== this.bg.r || bg.g !== this.bg.g || bg.b !== this.bg.b)) {
      this.bg = bg;
      this.bgStyle = { bg };
      this.styleWithBgCache = new WeakMap();
    }
    this.rowTouched.fill(0);
  }

  /**
   * Clear only rows that were not rewritten this frame (and mark dirty
   * only when they actually held content).
   */
  clearUntouched(): void {
    const bg = this.bgStyle;
    const w = this.width;
    for (let y = 0; y < this.height; y++) {
      if (this.rowTouched[y]) continue;
      const prev = this.prevLines[y];
      if (prev === undefined || prev.length === 0) continue;
      const base = y * w;
      let changed = false;
      for (let x = 0; x < w; x++) {
        const cell = this.cells[base + x]!;
        if (cell.ch !== " " || cell.style !== bg) {
          cell.ch = " ";
          cell.style = bg;
          changed = true;
        }
      }
      if (changed) this.dirty[y] = 1;
    }
  }

  /** Legacy full clear (resize / needsFull) */
  clear(bg?: Rgb): void {
    if (bg) {
      this.bg = bg;
      this.bgStyle = { bg };
      this.styleWithBgCache = new WeakMap();
    }
    const s = this.bgStyle;
    for (const cell of this.cells) {
      cell.ch = " ";
      cell.style = s;
    }
    this.dirty.fill(1);
    this.rowTouched.fill(0);
  }

  private idx(x: number, y: number): number {
    return y * this.width + x;
  }

  /** Mark row as painted this frame without forcing re-encode. */
  touchRow(y: number): void {
    if (y >= 0 && y < this.height) this.rowTouched[y] = 1;
  }

  markRow(y: number): void {
    if (y >= 0 && y < this.height) {
      this.rowTouched[y] = 1;
      this.dirty[y] = 1;
    }
  }

  /** Attach theme bg to a style, memoized by object identity. */
  withBg(style: Style): Style {
    if (style.bg !== undefined) return style;
    if (
      !style.fg &&
      !style.bold &&
      !style.dim &&
      !style.italic &&
      !style.underline &&
      !style.inverse
    ) {
      return this.bgStyle;
    }
    let hit = this.styleWithBgCache.get(style);
    if (!hit) {
      hit = { ...style, bg: this.bg };
      this.styleWithBgCache.set(style, hit);
    }
    return hit;
  }

  put(x: number, y: number, ch: string, style: Style = {}): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.rowTouched[y] = 1;
    const cell = this.cells[this.idx(x, y)]!;
    const glyph = ch || " ";
    const st = this.normalizeStyle(style);
    if (cell.ch === glyph && stylesEqualFast(cell.style, st)) return;
    cell.ch = glyph;
    cell.style = st;
    this.dirty[y] = 1;
  }

  write(x: number, y: number, text: string, style: Style = {}): number {
    if (y < 0 || y >= this.height || x >= this.width || !text) return 0;
    this.rowTouched[y] = 1;
    const st = this.normalizeStyle(style);

    let col = x;
    let i = 0;
    const wmax = this.width;
    let anyDirty = false;
    const base = y * this.width;

    // Fast path: pure ASCII printable — 1 cell per byte, no stringWidth
    if (isAsciiPrintable(text)) {
      const limit = Math.min(text.length, wmax - col);
      for (let k = 0; k < limit; k++) {
        const ch = text[k]!;
        const cell = this.cells[base + col]!;
        if (cell.ch !== ch || !stylesEqualFast(cell.style, st)) {
          cell.ch = ch;
          cell.style = st;
          anyDirty = true;
        }
        col++;
      }
      if (anyDirty) this.dirty[y] = 1;
      return col - x;
    }

    while (i < text.length && col < wmax) {
      const code = text.codePointAt(i)!;
      const cpLen = code > 0xffff ? 2 : 1;
      const ch = text.slice(i, i + cpLen);
      i += cpLen;
      const w = asciiOrWidth(code, ch);
      if (w <= 0) continue;
      if (col + w > wmax) break;
      const cell = this.cells[base + col]!;
      if (cell.ch !== ch || !stylesEqualFast(cell.style, st)) {
        cell.ch = ch;
        cell.style = st;
        anyDirty = true;
      }
      for (let p = 1; p < w; p++) {
        const pad = this.cells[base + col + p]!;
        if (pad.ch !== " " || !stylesEqualFast(pad.style, st)) {
          pad.ch = " ";
          pad.style = st;
          anyDirty = true;
        }
      }
      col += w;
    }
    if (anyDirty) this.dirty[y] = 1;
    return col - x;
  }

  /** Fill rest of row with bg after writing content (avoids stale glyphs) */
  clearRowRest(x: number, y: number): void {
    if (y < 0 || y >= this.height) return;
    this.rowTouched[y] = 1;
    const bg = this.bgStyle;
    const base = y * this.width;
    let anyDirty = false;
    for (let col = Math.max(0, x); col < this.width; col++) {
      const cell = this.cells[base + col]!;
      if (cell.ch !== " " || cell.style !== bg) {
        cell.ch = " ";
        cell.style = bg;
        anyDirty = true;
      }
    }
    if (anyDirty) this.dirty[y] = 1;
  }

  fill(x: number, y: number, width: number, ch: string, style: Style = {}): void {
    this.rowTouched[y] = 1;
    for (let i = 0; i < width; i++) {
      this.put(x + i, y, ch, style);
    }
  }

  hline(y: number, x: number, width: number, style: Style, ch = "─"): void {
    this.fill(x, y, width, ch, style);
  }

  writeClip(
    x: number,
    y: number,
    text: string,
    maxWidth: number,
    style: Style = {},
    ellipsis = true,
  ): void {
    if (maxWidth <= 0) return;
    if (isAsciiPrintable(text) && text.length <= maxWidth) {
      this.write(x, y, text, style);
      return;
    }
    const w = stringWidth(text);
    if (w <= maxWidth) {
      this.write(x, y, text, style);
      return;
    }
    if (!ellipsis || maxWidth < 2) {
      let col = 0;
      let i = 0;
      let out = "";
      while (i < text.length) {
        const code = text.codePointAt(i)!;
        const ch = String.fromCodePoint(code);
        i += code > 0xffff ? 2 : 1;
        const cw = asciiOrWidth(code, ch);
        if (col + cw > maxWidth) break;
        out += ch;
        col += cw;
      }
      this.write(x, y, out, style);
      return;
    }
    const budget = maxWidth - 1;
    let col = 0;
    let i = 0;
    let out = "";
    while (i < text.length) {
      const code = text.codePointAt(i)!;
      const ch = String.fromCodePoint(code);
      i += code > 0xffff ? 2 : 1;
      const cw = asciiOrWidth(code, ch);
      if (col + cw > budget) break;
      out += ch;
      col += cw;
    }
    this.write(x, y, out + "…", style);
  }

  private normalizeStyle(style: Style): Style {
    if (
      !style.fg &&
      !style.bold &&
      !style.dim &&
      !style.italic &&
      !style.underline &&
      !style.inverse &&
      (style.bg === undefined || style.bg === this.bg)
    ) {
      return this.bgStyle;
    }
    if (style.bg === undefined) return this.withBg(style);
    return style;
  }

  private encodeLine(y: number): string {
    const w = this.width;
    const base = y * w;
    let out = "";
    let runStyle: Style | null = null;
    let run = "";
    const level = this.level;

    const flush = () => {
      if (!run) return;
      out += paintCached(run, runStyle ?? this.bgStyle, level);
      run = "";
    };

    for (let x = 0; x < w; x++) {
      const cell = this.cells[base + x]!;
      if (!runStyle || !stylesEqualFast(runStyle, cell.style)) {
        flush();
        runStyle = cell.style;
        run = cell.ch;
      } else {
        run += cell.ch;
      }
    }
    flush();
    return out;
  }

  flushDiff(): string {
    this.clearUntouched();
    let out = "";
    for (let y = 0; y < this.height; y++) {
      if (!this.dirty[y] && this.prevLines[y] !== undefined) continue;
      const line = this.encodeLine(y);
      if (this.prevLines[y] !== line) {
        out += ansi.move(y + 1, 1) + ansi.clearLine + line;
        this.prevLines[y] = line;
      }
      this.dirty[y] = 0;
    }
    if (this.prevLines.length > this.height) {
      this.prevLines.length = this.height;
    }
    return out;
  }

  flushFull(): string {
    this.prevLines = [];
    this.dirty.fill(1);
    let out = ansi.home;
    for (let y = 0; y < this.height; y++) {
      const line = this.encodeLine(y);
      out += ansi.move(y + 1, 1) + ansi.clearLine + line;
      this.prevLines[y] = line;
      this.dirty[y] = 0;
    }
    return out;
  }

  /** How many rows are dirty (for perf probes). */
  dirtyCount(): number {
    let n = 0;
    for (let i = 0; i < this.height; i++) if (this.dirty[i]) n++;
    return n;
  }
}

function isAsciiPrintable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

function asciiOrWidth(code: number, ch: string): number {
  if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return 0;
  if (code < 0x7f) return 1;
  return stringWidth(ch);
}

function paintCached(text: string, style: Style, level: ColorLevel): string {
  if (!text) return "";
  const key = styleCacheKey(style, level);
  let open = styleOpenCache.get(key);
  if (open === undefined) {
    open = styleOpen(style, level);
    if (styleOpenCache.size >= STYLE_CACHE_MAX) {
      let n = 0;
      for (const k of styleOpenCache.keys()) {
        styleOpenCache.delete(k);
        if (++n >= STYLE_CACHE_MAX / 2) break;
      }
    }
    styleOpenCache.set(key, open);
  }
  if (!open) return text;
  return `${open}${text}${ansi.reset}`;
}

function styleCacheKey(s: Style, level: ColorLevel): string {
  const f = s.fg ? `${s.fg.r},${s.fg.g},${s.fg.b}` : "";
  const b = s.bg ? `${s.bg.r},${s.bg.g},${s.bg.b}` : "";
  return `${level}|${f}|${b}|${s.bold ? 1 : 0}${s.dim ? 1 : 0}${s.italic ? 1 : 0}${s.underline ? 1 : 0}${s.inverse ? 1 : 0}`;
}

function stylesEqualFast(a: Style, b: Style): boolean {
  if (a === b) return true;
  if (a.bold !== b.bold || a.dim !== b.dim || a.italic !== b.italic) return false;
  if (a.underline !== b.underline || a.inverse !== b.inverse) return false;
  const af = a.fg;
  const bf = b.fg;
  if (af !== bf) {
    if (!af || !bf) return false;
    if (af.r !== bf.r || af.g !== bf.g || af.b !== bf.b) return false;
  }
  const ab = a.bg;
  const bb = b.bg;
  if (ab !== bb) {
    if (!ab || !bb) return false;
    if (ab.r !== bb.r || ab.g !== bb.g || ab.b !== bb.b) return false;
  }
  return true;
}

export function applyThemeBg(buf: FrameBuffer, theme: Theme): void {
  buf.clear(theme.bg);
}
