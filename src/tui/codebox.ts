/**
 * Full-width code box for markdown fences and tool results.
 * Solid codeBg panel, optional line gutters, syntax highlight.
 */

import type { Style } from "./ansi.js";
import { stringWidth } from "./ansi.js";
import type { Theme } from "./theme.js";
import {
  highlightLine,
  spansToSegments,
  langFromPath,
} from "./highlight.js";

export interface CodeBoxRow {
  segments: { text: string; style: Style }[];
  bg?: Style["bg"];
}

export interface CodeBoxOptions {
  /** Language token (ts, py, …) */
  lang?: string;
  /** Header label (e.g. "result", path) */
  label?: string;
  /** Max body lines to show (rest truncated) */
  maxLines?: number;
  /** Indent prefix (e.g. "  " for tool cards) */
  indent?: string;
  /** Error styling */
  error?: boolean;
  /** Parse `N→` / `N|` line gutters from body */
  parseLineGutters?: boolean;
  /** Path for lang guess when lang empty */
  path?: string;
}

const LINE_GUTTER_RE = /^(\s*)(\d+)(→|\|)\s?/;

/**
 * Render a fenced-style code card that fills `width` columns.
 */
export function renderCodeBox(
  body: string,
  theme: Theme,
  width: number,
  opts: CodeBoxOptions = {},
): CodeBoxRow[] {
  const indent = opts.indent ?? "";
  const indentW = stringWidth(indent);
  const innerW = Math.max(8, width - indentW);
  const lang =
    (opts.lang || "").trim() ||
    langFromPath(opts.path) ||
    "";
  const label = (opts.label || "").trim();
  const maxLines = opts.maxLines ?? 200;
  const codeBg = opts.error ? undefined : theme.codeBg;
  const borderFg = opts.error ? theme.toolError : theme.fgFaint;
  const headFg = opts.error ? theme.toolError : theme.fgFaint;

  const rawLines = body.replace(/\r\n/g, "\n").split("\n");
  // Drop single trailing empty line (common after fences)
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  type Parsed = { gutter?: string; text: string };
  const parsed: Parsed[] = rawLines.map((line) => {
    if (opts.parseLineGutters !== false) {
      const m = line.match(LINE_GUTTER_RE);
      if (m) {
        return { gutter: m[2], text: line.slice(m[0].length) };
      }
    }
    return { text: line };
  });

  const hasGutter = parsed.some((p) => p.gutter != null);
  const gutterWidth = hasGutter
    ? Math.max(
        3,
        ...parsed.map((p) => (p.gutter ? p.gutter.length : 0)),
      )
    : 0;

  // Body content width inside │ … │
  // layout: indent + │ + sp + [gutter + sp] + code + pad + │
  const side = 1; // │
  const padSides = 1; // space after left │
  const gutterCol = hasGutter ? gutterWidth + 1 : 0;
  const contentW = Math.max(
    1,
    innerW - side * 2 - padSides - gutterCol,
  );

  const rows: CodeBoxRow[] = [];

  // ── Header ──────────────────────────────────────────────
  const leftTitle = buildHeaderLeft(lang, label);
  const totalLines = parsed.length;
  const rightMeta =
    totalLines > 0 ? ` ${totalLines} line${totalLines === 1 ? "" : "s"} ` : "";
  rows.push(
    boxHeaderRow(indent, leftTitle, rightMeta, innerW, headFg, codeBg, theme),
  );

  // ── Body ────────────────────────────────────────────────
  const shown = parsed.slice(0, maxLines);
  for (const p of shown) {
    const textLines = wrapPlain(p.text, contentW);
    for (let li = 0; li < textLines.length; li++) {
      const chunk = textLines[li]!;
      const segs: { text: string; style: Style }[] = [];
      segs.push({
        text: indent,
        style: {},
      });
      segs.push({
        text: "│",
        style: { fg: theme.border, bg: codeBg },
      });
      segs.push({
        text: " ",
        style: { bg: codeBg },
      });
      if (hasGutter) {
        const g =
          li === 0 && p.gutter
            ? p.gutter.padStart(gutterWidth)
            : " ".repeat(gutterWidth);
        segs.push({
          text: g + " ",
          style: { fg: theme.codeGutter, bg: codeBg },
        });
      }

      if (opts.error) {
        segs.push({
          text: chunk,
          style: { fg: theme.toolError, bg: codeBg },
        });
      } else {
        const spans = highlightLine(chunk, lang);
        segs.push(...spansToSegments(spans, theme, codeBg));
      }

      // Pad to full width then right border
      const used = segs.reduce((w, s) => w + stringWidth(s.text), 0);
      // target end = indent + innerW
      const target = indentW + innerW;
      const pad = Math.max(0, target - used - 1); // -1 for right │
      if (pad > 0) {
        segs.push({
          text: " ".repeat(pad),
          style: { bg: codeBg },
        });
      }
      segs.push({
        text: "│",
        style: { fg: theme.border, bg: codeBg },
      });

      rows.push({ segments: segs, bg: codeBg });
    }
  }

  if (parsed.length > maxLines) {
    const more = ` … ${parsed.length - maxLines} more lines `;
    rows.push(
      boxBodyMetaRow(indent, more, innerW, theme.fgFaint, codeBg, theme),
    );
  }

  // ── Footer ──────────────────────────────────────────────
  rows.push(boxFooterRow(indent, innerW, borderFg, codeBg));

  return rows;
}

function buildHeaderLeft(lang: string, label: string): string {
  if (lang && label) return ` ${lang} · ${label} `;
  if (lang) return ` ${lang} `;
  if (label) return ` ${label} `;
  return " code ";
}

function boxHeaderRow(
  indent: string,
  left: string,
  right: string,
  innerW: number,
  headFg: Style["fg"],
  codeBg: Style["bg"],
  _theme: Theme,
): CodeBoxRow {
  // ┌─ left ──── right ─┐
  const midBudget = Math.max(0, innerW - 2 - stringWidth(left) - stringWidth(right));
  const fill = "─".repeat(midBudget);
  const line = `┌${left.startsWith(" ") ? "─" : "─"}${left.trimEnd() ? left.replace(/^\s/, "─ ") : ""}${fill}${right}┐`;
  // Rebuild carefully for correct width
  const open = "┌";
  const close = "┐";
  const leftPart = left.length ? `─${left}` : "─";
  // leftPart may be too long — truncate
  let lp = leftPart;
  let rp = right;
  while (stringWidth(open + lp + rp + close) > innerW && lp.length > 2) {
    lp = lp.slice(0, -1);
  }
  while (stringWidth(open + lp + rp + close) > innerW && rp.length > 1) {
    rp = rp.slice(1);
  }
  const fillW = Math.max(
    0,
    innerW - stringWidth(open) - stringWidth(lp) - stringWidth(rp) - stringWidth(close),
  );
  const text = open + lp + "─".repeat(fillW) + rp + close;
  return {
    segments: [
      { text: indent, style: {} },
      { text: padOrClip(text, innerW), style: { fg: headFg, bg: codeBg } },
    ],
    bg: codeBg,
  };
}

function boxFooterRow(
  indent: string,
  innerW: number,
  borderFg: Style["fg"],
  codeBg: Style["bg"],
): CodeBoxRow {
  const text =
    "└" + "─".repeat(Math.max(0, innerW - 2)) + "┘";
  return {
    segments: [
      { text: indent, style: {} },
      {
        text: padOrClip(text, innerW),
        style: { fg: borderFg, bg: codeBg },
      },
    ],
    bg: codeBg,
  };
}

function boxBodyMetaRow(
  indent: string,
  meta: string,
  innerW: number,
  fg: Style["fg"],
  codeBg: Style["bg"],
  theme: Theme,
): CodeBoxRow {
  const open = "│";
  const close = "│";
  const mid = padOrClip(meta, Math.max(0, innerW - 2));
  return {
    segments: [
      { text: indent, style: {} },
      { text: open, style: { fg: theme.border, bg: codeBg } },
      { text: mid, style: { fg, bg: codeBg, dim: true } },
      { text: close, style: { fg: theme.border, bg: codeBg } },
    ],
    bg: codeBg,
  };
}

function padOrClip(text: string, width: number): string {
  const w = stringWidth(text);
  if (w === width) return text;
  if (w < width) return text + " ".repeat(width - w);
  // clip
  let out = "";
  let used = 0;
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (used + cw > width) break;
    out += ch;
    used += cw;
  }
  if (used < width) out += " ".repeat(width - used);
  return out;
}

function wrapPlain(text: string, width: number): string[] {
  if (width < 1) width = 1;
  if (!text) return [""];
  const lines: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (stringWidth(rest) <= width) {
      lines.push(rest);
      break;
    }
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
  return lines.length ? lines : [""];
}

export { langFromPath };
