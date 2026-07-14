/**
 * Low-level ANSI helpers + color quantization (Grok-style pipeline).
 * Truecolor RGB is the source of truth; we quantize at paint time.
 */

import type { ColorLevel, Rgb } from "./theme.js";

export const ESC = "\x1b";
export const CSI = `${ESC}[`;

export const ansi = {
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  altScreenOn: `${CSI}?1049h`,
  altScreenOff: `${CSI}?1049l`,
  clear: `${CSI}2J${CSI}H`,
  clearLine: `${CSI}2K`,
  home: `${CSI}H`,
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  inverse: `${CSI}7m`,
  /**
   * Mouse tracking:
   * 1000 = button events (wheel + click)
   * 1002 = drag/motion while button held (for text selection)
   * 1006 = SGR encoding (reliable coords / buttons)
   */
  mouseOn: `${CSI}?1000h${CSI}?1002h${CSI}?1006h`,
  mouseOff: `${CSI}?1000l${CSI}?1002l${CSI}?1006l`,
  move(row: number, col: number): string {
    return `${CSI}${row};${col}H`;
  },
  /** OSC 12 — set cursor color */
  cursorColor(rgb: Rgb): string {
    return `${ESC}]12;rgb:${toHex2(rgb.r)}/${toHex2(rgb.g)}/${toHex2(rgb.b)}${ESC}\\`;
  },
  /** OSC 112 — reset cursor color */
  cursorColorReset: `${ESC}]112${ESC}\\`,
};

function toHex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** Map RGB → nearest xterm 256 color index */
export function rgbTo256(rgb: Rgb): number {
  // grayscale ramp 232-255
  if (rgb.r === rgb.g && rgb.g === rgb.b) {
    if (rgb.r < 8) return 16;
    if (rgb.r > 248) return 231;
    return Math.round(((rgb.r - 8) / 247) * 24) + 232;
  }
  const r = Math.round((rgb.r / 255) * 5);
  const g = Math.round((rgb.g / 255) * 5);
  const b = Math.round((rgb.b / 255) * 5);
  return 16 + 36 * r + 6 * g + b;
}

/** Map RGB → basic ANSI 16 color index (30-37 / 90-97) */
export function rgbTo16(rgb: Rgb): number {
  const { r, g, b } = rgb;
  const brightness = (r + g + b) / 3;
  const max = Math.max(r, g, b);
  if (max < 40) return 0; // black
  if (r === g && g === b) return brightness > 180 ? 15 : 8;

  const isBright = brightness > 140 || max > 200;
  let base = 0;
  if (r >= g && r >= b) {
    base = g > 100 && b < 100 ? 3 /* yellow */ : b > 100 ? 5 /* magenta */ : 1; // red
  } else if (g >= r && g >= b) {
    base = b > 100 ? 6 /* cyan */ : 2; // green
  } else {
    base = r > 100 ? 5 /* magenta */ : 4; // blue
  }
  return isBright ? base + 8 : base;
}

export interface Style {
  fg?: Rgb;
  bg?: Rgb;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export function styleOpen(style: Style, level: ColorLevel): string {
  if (level === "mono") {
    let s = "";
    if (style.bold) s += ansi.bold;
    if (style.dim) s += ansi.dim;
    if (style.italic) s += ansi.italic;
    if (style.underline) s += ansi.underline;
    if (style.inverse) s += ansi.inverse;
    return s;
  }

  const parts: string[] = [];
  if (style.bold) parts.push("1");
  if (style.dim) parts.push("2");
  if (style.italic) parts.push("3");
  if (style.underline) parts.push("4");
  if (style.inverse) parts.push("7");

  if (style.fg) {
    if (level === "truecolor") {
      parts.push(`38;2;${style.fg.r};${style.fg.g};${style.fg.b}`);
    } else if (level === "256") {
      parts.push(`38;5;${rgbTo256(style.fg)}`);
    } else {
      const c = rgbTo16(style.fg);
      parts.push(c >= 8 ? String(90 + (c - 8)) : String(30 + c));
    }
  }
  if (style.bg) {
    if (level === "truecolor") {
      parts.push(`48;2;${style.bg.r};${style.bg.g};${style.bg.b}`);
    } else if (level === "256") {
      parts.push(`48;5;${rgbTo256(style.bg)}`);
    } else {
      const c = rgbTo16(style.bg);
      parts.push(c >= 8 ? String(100 + (c - 8)) : String(40 + c));
    }
  }

  return parts.length ? `${CSI}${parts.join(";")}m` : "";
}

export function paint(text: string, style: Style, level: ColorLevel): string {
  if (!text) return "";
  const open = styleOpen(style, level);
  if (!open) return text;
  return `${open}${text}${ansi.reset}`;
}

/** Visible width helpers re-exported for layout code */
export { default as stringWidth } from "string-width";
export { default as stripAnsi } from "strip-ansi";
