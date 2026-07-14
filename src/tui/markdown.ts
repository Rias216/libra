/**
 * Lightweight inline markdown → styled segments for the scrollback.
 * Handles bold, italic, code, headers, lists, and fenced code blocks.
 * Not a full CommonMark parser — tuned for agent transcripts.
 */

import type { Style } from "./ansi.js";
import { stringWidth } from "./ansi.js";
import type { Theme } from "./theme.js";

export interface Segment {
  text: string;
  style: Style;
}

export interface RenderLine {
  segments: Segment[];
  /** Full plain text of the line (for width calc) */
  plain: string;
}

export function renderMarkdown(
  source: string,
  theme: Theme,
  maxWidth: number,
): RenderLine[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: RenderLine[] = [];
  let inCode = false;
  let codeLang = "";

  for (const raw of lines) {
    if (raw.startsWith("```")) {
      if (!inCode) {
        inCode = true;
        codeLang = raw.slice(3).trim();
        out.push(
          makeLine(
            [
              {
                text: codeLang ? `+-- ${codeLang} ` : "+-- code ",
                style: { fg: theme.fgFaint },
              },
            ],
            maxWidth,
          ),
        );
      } else {
        inCode = false;
        codeLang = "";
        out.push(
          makeLine([{ text: "+--------", style: { fg: theme.fgFaint } }], maxWidth),
        );
      }
      continue;
    }

    if (inCode) {
      out.push(
        ...wrapSegments(
          [{ text: "| " + raw, style: { fg: theme.fgMuted } }],
          maxWidth,
        ),
      );
      continue;
    }

    // Headers
    const h = raw.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      const body = h[2]!;
      out.push(
        ...wrapSegments(
          [
            {
              text: body,
              style: {
                fg: theme.accent,
                bold: true,
                underline: level === 1,
              },
            },
          ],
          maxWidth,
        ),
      );
      continue;
    }

    // Unordered list
    const ul = raw.match(/^(\s*)([-*•])\s+(.*)$/);
    if (ul) {
      const indent = ul[1]!.length;
      const body = ul[3]!;
      const prefix = " ".repeat(Math.min(indent, 4)) + "* ";
      out.push(
        ...wrapSegments(
          [
            { text: prefix, style: { fg: theme.accent } },
            ...parseInline(body, theme),
          ],
          maxWidth,
        ),
      );
      continue;
    }

    // Ordered list
    const ol = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ol) {
      const prefix = `${ol[2]}. `;
      out.push(
        ...wrapSegments(
          [
            { text: prefix, style: { fg: theme.fgMuted } },
            ...parseInline(ol[3]!, theme),
          ],
          maxWidth,
        ),
      );
      continue;
    }

    // Blockquote
    if (raw.startsWith(">")) {
      const body = raw.replace(/^>\s?/, "");
      out.push(
        ...wrapSegments(
          [
            { text: "| ", style: { fg: theme.border } },
            ...parseInline(body, theme, { italic: true, fg: theme.fgMuted }),
          ],
          maxWidth,
        ),
      );
      continue;
    }

    // Empty line
    if (!raw.trim()) {
      out.push({ segments: [], plain: "" });
      continue;
    }

    out.push(...wrapSegments(parseInline(raw, theme), maxWidth));
  }

  return out;
}

function parseInline(
  text: string,
  theme: Theme,
  base: Style = { fg: theme.fg },
): Segment[] {
  const segments: Segment[] = [];
  // Patterns: `code`, **bold**, *italic*, remaining text
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ text: text.slice(last, m.index), style: { ...base } });
    }
    const tok = m[0]!;
    if (tok.startsWith("`")) {
      segments.push({
        text: tok.slice(1, -1),
        style: { fg: theme.tool, bg: theme.bgSubtle },
      });
    } else if (tok.startsWith("**")) {
      segments.push({
        text: tok.slice(2, -2),
        style: { ...base, bold: true },
      });
    } else if (tok.startsWith("*")) {
      segments.push({
        text: tok.slice(1, -1),
        style: { ...base, italic: true },
      });
    }
    last = m.index + tok.length;
  }
  if (last < text.length) {
    segments.push({ text: text.slice(last), style: { ...base } });
  }
  if (segments.length === 0) {
    segments.push({ text, style: { ...base } });
  }
  return segments;
}

function makeLine(segments: Segment[], maxWidth: number): RenderLine {
  return wrapSegments(segments, maxWidth)[0] ?? { segments: [], plain: "" };
}

function wrapSegments(segments: Segment[], maxWidth: number): RenderLine[] {
  if (maxWidth < 1) maxWidth = 1;
  const lines: RenderLine[] = [];
  let current: Segment[] = [];
  let width = 0;
  let plain = "";

  const pushLine = () => {
    lines.push({ segments: current, plain });
    current = [];
    width = 0;
    plain = "";
  };

  for (const seg of segments) {
    let remaining = seg.text;
    while (remaining.length > 0) {
      const room = maxWidth - width;
      if (room <= 0) {
        pushLine();
        continue;
      }
      const chunk = takeWidth(remaining, room);
      if (!chunk.text && width > 0) {
        pushLine();
        continue;
      }
      if (!chunk.text) {
        // single glyph wider than line — force it
        const forced = remaining[0] ?? "";
        current.push({ text: forced, style: seg.style });
        plain += forced;
        pushLine();
        remaining = remaining.slice(forced.length);
        continue;
      }
      current.push({ text: chunk.text, style: seg.style });
      plain += chunk.text;
      width += chunk.width;
      remaining = remaining.slice(chunk.text.length);
      // Prefer breaking at spaces
      if (remaining.startsWith(" ") && width >= maxWidth) {
        remaining = remaining.slice(1);
        pushLine();
      } else if (width >= maxWidth) {
        pushLine();
      }
    }
  }
  if (current.length > 0 || lines.length === 0) pushLine();
  return lines;
}

function takeWidth(
  text: string,
  max: number,
): { text: string; width: number } {
  let w = 0;
  let i = 0;
  let lastSpace = -1;
  while (i < text.length) {
    const code = text.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const cw = stringWidth(ch);
    if (w + cw > max) break;
    if (ch === " ") lastSpace = i;
    w += cw;
    i += code > 0xffff ? 2 : 1;
  }
  // soft-wrap at last space if we didn't consume all
  if (i < text.length && lastSpace > 0) {
    return { text: text.slice(0, lastSpace), width: stringWidth(text.slice(0, lastSpace)) };
  }
  return { text: text.slice(0, i), width: w };
}
