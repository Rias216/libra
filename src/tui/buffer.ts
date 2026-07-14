/**
 * Cell-based frame buffer with dirty-line diffing.
 * Inspired by OpenTUI's frame-diff approach: only rewrite lines that changed.
 */

import { ansi, paint, stringWidth, type Style } from "./ansi.js";
import type { ColorLevel, Rgb, Theme } from "./theme.js";

export interface Cell {
  ch: string;
  style: Style;
}

export class FrameBuffer {
  width: number;
  height: number;
  private cells: Cell[];
  private prevLines: string[] = [];
  private level: ColorLevel;
  private bg: Rgb;

  constructor(width: number, height: number, level: ColorLevel, bg: Rgb) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.level = level;
    this.bg = bg;
    this.cells = this.alloc();
  }

  private alloc(): Cell[] {
    const n = this.width * this.height;
    const cells = new Array<Cell>(n);
    for (let i = 0; i < n; i++) {
      cells[i] = { ch: " ", style: { bg: this.bg } };
    }
    return cells;
  }

  resize(width: number, height: number, bg?: Rgb): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (bg) this.bg = bg;
    this.cells = this.alloc();
    this.prevLines = [];
  }

  setLevel(level: ColorLevel): void {
    this.level = level;
  }

  clear(bg?: Rgb): void {
    if (bg) this.bg = bg;
    for (const cell of this.cells) {
      cell.ch = " ";
      cell.style = { bg: this.bg };
    }
  }

  private idx(x: number, y: number): number {
    return y * this.width + x;
  }

  put(x: number, y: number, ch: string, style: Style = {}): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const cell = this.cells[this.idx(x, y)]!;
    cell.ch = ch || " ";
    cell.style = {
      ...style,
      bg: style.bg ?? this.bg,
    };
  }

  /**
   * Write a string at (x,y), advancing by display width.
   * Truncates at the right edge. Returns columns written.
   */
  write(x: number, y: number, text: string, style: Style = {}): number {
    if (y < 0 || y >= this.height || x >= this.width) return 0;
    let col = x;
    let i = 0;
    while (i < text.length && col < this.width) {
      const code = text.codePointAt(i)!;
      const ch = String.fromCodePoint(code);
      i += code > 0xffff ? 2 : 1;
      const w = stringWidth(ch);
      if (w <= 0) continue;
      if (col + w > this.width) break;
      this.put(col, y, ch, style);
      // Pad wide glyphs
      for (let p = 1; p < w; p++) {
        this.put(col + p, y, " ", style);
      }
      col += w;
    }
    return col - x;
  }

  /** Fill a horizontal run */
  fill(x: number, y: number, width: number, ch: string, style: Style = {}): void {
    for (let i = 0; i < width; i++) {
      this.put(x + i, y, ch, style);
    }
  }

  /** Draw a horizontal rule */
  hline(y: number, x: number, width: number, style: Style, ch = "─"): void {
    this.fill(x, y, width, ch, style);
  }

  /** Clip-write with optional ellipsis when truncated */
  writeClip(
    x: number,
    y: number,
    text: string,
    maxWidth: number,
    style: Style = {},
    ellipsis = true,
  ): void {
    if (maxWidth <= 0) return;
    const w = stringWidth(text);
    if (w <= maxWidth) {
      this.write(x, y, text, style);
      return;
    }
    if (!ellipsis || maxWidth < 2) {
      // hard cut
      let col = 0;
      let i = 0;
      let out = "";
      while (i < text.length) {
        const code = text.codePointAt(i)!;
        const ch = String.fromCodePoint(code);
        i += code > 0xffff ? 2 : 1;
        const cw = stringWidth(ch);
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
      const cw = stringWidth(ch);
      if (col + cw > budget) break;
      out += ch;
      col += cw;
    }
    this.write(x, y, out + "…", style);
  }

  /** Encode a single row to ANSI string */
  private encodeLine(y: number): string {
    let out = "";
    let lastKey = "";
    for (let x = 0; x < this.width; x++) {
      const cell = this.cells[this.idx(x, y)]!;
      const key = styleKey(cell.style);
      if (key !== lastKey) {
        out += paint(cell.ch, cell.style, this.level);
        // paint() resets; for runs we re-open. Optimize consecutive same-style:
        lastKey = "";
        // better: open once per run
        // redo run-length below
      }
    }
    // Proper RLE encode
    out = "";
    let runStyle: Style | null = null;
    let run = "";
    const flush = () => {
      if (!run) return;
      out += paint(run, runStyle ?? { bg: this.bg }, this.level);
      run = "";
    };
    for (let x = 0; x < this.width; x++) {
      const cell = this.cells[this.idx(x, y)]!;
      if (!runStyle || !stylesEqual(runStyle, cell.style)) {
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

  /**
   * Diff against previous frame and write only changed lines.
   * Returns the ANSI payload to flush to stdout.
   */
  flushDiff(): string {
    let out = "";
    for (let y = 0; y < this.height; y++) {
      const line = this.encodeLine(y);
      if (this.prevLines[y] !== line) {
        out += ansi.move(y + 1, 1) + ansi.clearLine + line;
        this.prevLines[y] = line;
      }
    }
    // Trim prevLines if height shrank
    if (this.prevLines.length > this.height) {
      this.prevLines.length = this.height;
    }
    return out;
  }

  /** Full repaint (e.g. after resize) */
  flushFull(): string {
    this.prevLines = [];
    let out = ansi.home;
    for (let y = 0; y < this.height; y++) {
      const line = this.encodeLine(y);
      out += ansi.move(y + 1, 1) + ansi.clearLine + line;
      this.prevLines[y] = line;
    }
    return out;
  }
}

function styleKey(s: Style): string {
  const f = s.fg ? `${s.fg.r},${s.fg.g},${s.fg.b}` : "-";
  const b = s.bg ? `${s.bg.r},${s.bg.g},${s.bg.b}` : "-";
  return `${f}|${b}|${s.bold ? 1 : 0}${s.dim ? 1 : 0}${s.italic ? 1 : 0}${s.underline ? 1 : 0}${s.inverse ? 1 : 0}`;
}

function stylesEqual(a: Style, b: Style): boolean {
  return styleKey(a) === styleKey(b);
}

export function applyThemeBg(buf: FrameBuffer, theme: Theme): void {
  buf.clear(theme.bg);
}
