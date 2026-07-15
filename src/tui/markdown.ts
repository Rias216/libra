/**
 * Lightweight inline markdown → styled segments for the scrollback.
 * Handles bold, italic, code, headers, lists, and fenced code blocks.
 * Bare multi-line code is auto-wrapped into fences so the TUI stays compact.
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
  // Auto-fence bare code so it never dumps as a wall of plain text
  const lines = ensureCodeFences(source).replace(/\r\n/g, "\n").split("\n");
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
                text: codeLang ? `┌── ${codeLang} ` : "┌── code ",
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
          makeLine(
            [{ text: "└────────", style: { fg: theme.fgFaint } }],
            maxWidth,
          ),
        );
      }
      continue;
    }

    if (inCode) {
      // Fixed-width code body: no markdown, dim mono-ish style + gutter
      out.push(
        ...wrapSegments(
          [
            { text: "│ ", style: { fg: theme.border } },
            { text: raw, style: { fg: theme.tool, bg: theme.bgSubtle } },
          ],
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
            { text: "│ ", style: { fg: theme.border } },
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

/**
 * Wrap bare multi-line code (and 4-space indented blocks) in markdown fences
 * so the renderer always paints compact code boxes.
 * Existing ``` fences are left untouched.
 */
export function ensureCodeFences(source: string): string {
  if (!source) return source;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let inFence = false;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }

    if (inFence) {
      out.push(line);
      i++;
      continue;
    }

    // Indented code block (4 spaces or tab) — CommonMark style
    if (/^(?: {4}|\t)/.test(line) && line.trim().length > 0) {
      const block: string[] = [];
      while (i < lines.length) {
        const L = lines[i]!;
        if (L.trimStart().startsWith("```")) break;
        if (/^(?: {4}|\t)/.test(L) || (L.trim() === "" && peekIndented(lines, i + 1))) {
          block.push(L.replace(/^(?: {4}|\t)/, ""));
          i++;
          continue;
        }
        break;
      }
      // Drop trailing blank lines inside the block
      while (block.length && block[block.length - 1]!.trim() === "") block.pop();
      if (block.length >= 1) {
        out.push("```");
        out.push(...block);
        out.push("```");
      }
      continue;
    }

    // Bare code run: 2+ consecutive code-looking lines
    if (looksLikeCodeLine(line)) {
      const block: string[] = [];
      let j = i;
      while (j < lines.length) {
        const L = lines[j]!;
        if (L.trimStart().startsWith("```")) break;
        if (L.trim() === "") {
          // Allow a single blank inside a code run if more code follows
          if (j + 1 < lines.length && looksLikeCodeLine(lines[j + 1]!)) {
            block.push(L);
            j++;
            continue;
          }
          break;
        }
        if (!looksLikeCodeLine(L) && !looksLikeCodeContinuation(L)) break;
        block.push(L);
        j++;
      }
      const meaningful = block.filter((l) => l.trim().length > 0);
      if (meaningful.length >= 2 || (meaningful.length === 1 && isStrongCodeLine(meaningful[0]!))) {
        const lang = guessLang(block.join("\n"));
        out.push(lang ? `\`\`\`${lang}` : "```");
        out.push(...block);
        out.push("```");
        i = j;
        continue;
      }
    }

    out.push(line);
    i++;
  }

  return out.join("\n");
}

function peekIndented(lines: string[], at: number): boolean {
  if (at >= lines.length) return false;
  return /^(?: {4}|\t)/.test(lines[at]!);
}

/** Single-line "this is definitely code" (fenced alone if strong). */
function isStrongCodeLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 8) return false;
  return (
    /^(import|export|from|const|let|var|function|class|interface|type|def|async|await|return|package|using|#include)\b/.test(
      t,
    ) ||
    /[{};]\s*$/.test(t) ||
    /=>|:=|::|->/.test(t) ||
    /^\s*<\/?[A-Za-z][^>]*>/.test(t) ||
    /^\$\s+\S/.test(t) ||
    /^(npm|npx|yarn|pnpm|git|cargo|go|python|node|tsx)\s+\S/.test(t)
  );
}

function looksLikeCodeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Skip pure prose markers
  if (/^(#{1,6}\s|[-*•]\s|\d+[.)]\s|>\s)/.test(t)) return false;
  if (isStrongCodeLine(t)) return true;
  // High symbol density
  const symbols = (t.match(/[{}()\[\];=<>|&\\/`.]/g) ?? []).length;
  if (t.length >= 6 && symbols / t.length >= 0.18) return true;
  // Common code patterns
  if (
    /^(if|else|for|while|switch|case|try|catch|finally|throw|new|public|private|protected|static|void|int|string|bool)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/^[A-Za-z_][\w.]*\s*\(.*\)\s*[{;]?\s*$/.test(t)) return true;
  if (/^\s*(\/\/|#|\/\*|\*\/|\* )/.test(line)) return true;
  if (/^\s*[{}()\[\]]+\s*$/.test(t)) return true;
  return false;
}

function looksLikeCodeContinuation(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Closing braces, continued args, decorators, etc.
  return (
    /^[)}\]],?$/.test(t) ||
    /^[)}\]].*[;,]?\s*$/.test(t) ||
    /^[@.]/.test(t) ||
    /[,\\]\s*$/.test(t) ||
    looksLikeCodeLine(line)
  );
}

function guessLang(code: string): string {
  if (/\b(import|export|const|let|interface|type)\b/.test(code) && /[{;]/.test(code)) {
    if (/:\s*(string|number|boolean|void|Promise)/.test(code) || /from ['"]/.test(code)) {
      return "ts";
    }
    return "js";
  }
  if (/\bdef\s+\w+\(|\bimport\s+\w+|print\(/.test(code)) return "py";
  if (/^#include|std::|int main\s*\(/.test(code)) return "cpp";
  if (/\bfn\s+\w+|let mut\b|println!/.test(code)) return "rs";
  if (/<\/?[A-Za-z][\w:-]*[\s>]/.test(code)) return "html";
  if (/^\s*(\.|#|@media)\w*[^{]*\{/m.test(code)) return "css";
  if (/^\s*\{[\s\S]*"[\w-]+"\s*:/.test(code.trim())) return "json";
  if (
    /^(npm|npx|yarn|git|cd|ls|dir|echo|Remove-Item|Get-ChildItem)\b/m.test(code) ||
    /^\$\s+/m.test(code)
  ) {
    return "shell";
  }
  return "";
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
        text: " " + tok.slice(1, -1) + " ",
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
    return {
      text: text.slice(0, lastSpace),
      width: stringWidth(text.slice(0, lastSpace)),
    };
  }
  return { text: text.slice(0, i), width: w };
}
