/**
 * Zero-dep line-oriented syntax highlighter for TUI code boxes.
 * Not a full parser — good enough for agent transcripts at interactive rates.
 */

import type { Style } from "./ansi.js";
import type { Theme } from "./theme.js";

export type SynKind =
  | "plain"
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "type"
  | "operator"
  | "property";

export interface HlSpan {
  text: string;
  kind: SynKind;
}

const CACHE_MAX = 256;
const cache = new Map<string, HlSpan[]>();

const JS_KW =
  /^(?:const|let|var|function|class|interface|type|enum|import|export|from|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|new|async|await|yield|typeof|instanceof|void|null|undefined|true|false|this|super|extends|implements|static|public|private|protected|readonly|as|of|in|default|with|debugger|delete)\b/;

const PY_KW =
  /^(?:def|class|import|from|as|return|if|elif|else|for|while|try|except|finally|raise|with|yield|async|await|lambda|pass|break|continue|and|or|not|in|is|None|True|False|global|nonlocal|assert|del)\b/;

const RS_KW =
  /^(?:fn|let|mut|const|struct|enum|impl|trait|use|mod|pub|crate|self|super|return|if|else|for|while|loop|match|break|continue|async|await|move|ref|where|type|static|unsafe|as|in|true|false)\b/;

const GO_KW =
  /^(?:func|var|const|type|struct|interface|package|import|return|if|else|for|range|switch|case|break|continue|go|defer|select|map|chan|true|false|nil)\b/;

const SHELL_KW =
  /^(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|readonly|source|alias|true|false)\b/;

export function clearHighlightCache(): void {
  cache.clear();
}

export function highlightLine(line: string, lang: string): HlSpan[] {
  const key = `${lang}|${line}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const spans = highlightLineUncached(line, normalizeLang(lang));
  if (cache.size >= CACHE_MAX) {
    let n = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++n >= 64) break;
    }
  }
  cache.set(key, spans);
  return spans;
}

export function styleForKind(kind: SynKind, theme: Theme): Style {
  switch (kind) {
    case "keyword":
      return { fg: theme.synKeyword, bold: true };
    case "string":
      return { fg: theme.synString };
    case "comment":
      return { fg: theme.synComment, italic: true };
    case "number":
      return { fg: theme.synNumber };
    case "function":
      return { fg: theme.synFunction };
    case "type":
      return { fg: theme.synType };
    case "operator":
      return { fg: theme.synOperator };
    case "property":
      return { fg: theme.synProperty };
    default:
      return { fg: theme.fg };
  }
}

export function spansToSegments(
  spans: HlSpan[],
  theme: Theme,
  bg?: Style["bg"],
): { text: string; style: Style }[] {
  return spans.map((s) => ({
    text: s.text,
    style: { ...styleForKind(s.kind, theme), ...(bg ? { bg } : {}) },
  }));
}

function normalizeLang(lang: string): string {
  const l = lang.trim().toLowerCase();
  if (!l) return "generic";
  if (["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"].includes(l)) {
    return "js";
  }
  if (["py", "python"].includes(l)) return "py";
  if (["rs", "rust"].includes(l)) return "rs";
  if (["go", "golang"].includes(l)) return "go";
  if (["sh", "bash", "zsh", "shell", "ps1", "powershell", "cmd"].includes(l)) {
    return "shell";
  }
  if (["htm", "html", "xml", "svg"].includes(l)) return "html";
  if (["css", "scss", "less"].includes(l)) return "css";
  if (["json", "jsonc"].includes(l)) return "json";
  if (["md", "markdown"].includes(l)) return "md";
  return l;
}

function highlightLineUncached(line: string, lang: string): HlSpan[] {
  if (!line) return [{ text: "", kind: "plain" }];

  // Full-line comments
  if (lang === "js" || lang === "rs" || lang === "go" || lang === "css") {
    if (/^\s*\/\//.test(line) || /^\s*\/\*/.test(line) || /^\s*\*/.test(line)) {
      return [{ text: line, kind: "comment" }];
    }
  }
  if (lang === "py" || lang === "shell") {
    if (/^\s*#/.test(line)) return [{ text: line, kind: "comment" }];
  }
  if (lang === "html" && /^\s*<!--/.test(line)) {
    return [{ text: line, kind: "comment" }];
  }

  if (lang === "json") return highlightJson(line);
  if (lang === "html") return highlightHtml(line);
  if (lang === "css") return highlightCss(line);
  if (lang === "md") return highlightMd(line);

  const kw =
    lang === "py"
      ? PY_KW
      : lang === "rs"
        ? RS_KW
        : lang === "go"
          ? GO_KW
          : lang === "shell"
            ? SHELL_KW
            : lang === "js"
              ? JS_KW
              : null;

  return highlightGeneric(line, kw, lang === "shell");
}

function highlightGeneric(
  line: string,
  kw: RegExp | null,
  hashComment: boolean,
): HlSpan[] {
  const out: HlSpan[] = [];
  let i = 0;
  while (i < line.length) {
    // Line comment
    if (
      (line[i] === "/" && line[i + 1] === "/") ||
      (hashComment && line[i] === "#")
    ) {
      out.push({ text: line.slice(i), kind: "comment" });
      break;
    }
    // Strings
    if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
      const q = line[i]!;
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === q) {
          j++;
          break;
        }
        j++;
      }
      out.push({ text: line.slice(i, j), kind: "string" });
      i = j;
      continue;
    }
    // Numbers
    if (
      /[0-9]/.test(line[i]!) &&
      (i === 0 || /[^\w$]/.test(line[i - 1]!))
    ) {
      let j = i;
      while (j < line.length && /[0-9_xXa-fA-F.n]/.test(line[j]!)) j++;
      out.push({ text: line.slice(i, j), kind: "number" });
      i = j;
      continue;
    }
    // Identifiers / keywords / functions / types
    if (/[A-Za-z_$]/.test(line[i]!)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      let kind: SynKind = "plain";
      if (kw && kw.test(word)) kind = "keyword";
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) kind = "type";
      else {
        // Look ahead for (
        let k = j;
        while (k < line.length && line[k] === " ") k++;
        if (line[k] === "(") kind = "function";
        else if (line[i - 1] === ".") kind = "property";
      }
      out.push({ text: word, kind });
      i = j;
      continue;
    }
    // Operators
    if (/[{}()\[\];=<>!&|+\-*/%?:.,@#\\]/.test(line[i]!)) {
      let j = i + 1;
      // Multi-char ops
      if (
        i + 1 < line.length &&
        /[=<>!&|+\-*/]/.test(line[i]!) &&
        /[=<>&|+\-*/]/.test(line[i + 1]!)
      ) {
        j = i + 2;
        if (
          j < line.length &&
          line[i] === "=" &&
          line[i + 1] === "=" &&
          line[j] === "="
        ) {
          j++;
        }
      }
      out.push({ text: line.slice(i, j), kind: "operator" });
      i = j;
      continue;
    }
    // Whitespace / other
    let j = i + 1;
    while (
      j < line.length &&
      !/[A-Za-z0-9_$"'`#\/{}()\[\];=<>!&|+\-*/%?:.,@\\]/.test(line[j]!)
    ) {
      j++;
    }
    out.push({ text: line.slice(i, j), kind: "plain" });
    i = j;
  }
  return mergePlain(out);
}

function highlightJson(line: string): HlSpan[] {
  return highlightGeneric(line, null, false).map((s) => {
    if (s.kind === "plain" && /^"[^"]+"$/.test(s.text)) {
      // keys vs strings: if followed by : it's property — handled loosely
      return { ...s, kind: "string" as SynKind };
    }
    return s;
  });
}

function highlightHtml(line: string): HlSpan[] {
  const out: HlSpan[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "<") {
      const end = line.indexOf(">", i);
      const j = end === -1 ? line.length : end + 1;
      const tag = line.slice(i, j);
      // crude: color whole tag as keyword, attrs as property/string inside
      out.push(...highlightTag(tag));
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < line.length && line[j] !== "<") j++;
    out.push({ text: line.slice(i, j), kind: "plain" });
    i = j;
  }
  return out.length ? out : [{ text: line, kind: "plain" }];
}

function highlightTag(tag: string): HlSpan[] {
  // <tag attr="val">
  const out: HlSpan[] = [];
  let i = 0;
  while (i < tag.length) {
    if (tag[i] === '"' || tag[i] === "'") {
      const q = tag[i]!;
      let j = i + 1;
      while (j < tag.length && tag[j] !== q) j++;
      if (j < tag.length) j++;
      out.push({ text: tag.slice(i, j), kind: "string" });
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(tag[i]!)) {
      let j = i;
      while (j < tag.length && /[A-Za-z0-9_:-]/.test(tag[j]!)) j++;
      const word = tag.slice(i, j);
      const isTag =
        i === 1 ||
        tag[i - 1] === "<" ||
        tag[i - 1] === "/" ||
        (i > 0 && tag[i - 1] === " " && tag.includes("=") === false);
      // first name after < is keyword
      const afterLt = tag.lastIndexOf("<", i);
      const between = afterLt >= 0 ? tag.slice(afterLt + 1, i).replace(/^\//, "") : "x";
      const kind: SynKind =
        between.trim() === "" ? "keyword" : tag[j] === "=" || tag[j - 1] === "="
          ? "property"
          : /[=]/.test(tag.slice(i - 1, j + 1))
            ? "property"
            : "keyword";
      out.push({
        text: word,
        kind: isTag || between.trim() === "" ? "keyword" : kind === "property" ? "property" : "property",
      });
      i = j;
      continue;
    }
    out.push({ text: tag[i]!, kind: "operator" });
    i++;
  }
  return out;
}

function highlightCss(line: string): HlSpan[] {
  if (/^\s*\/\*/.test(line) || /^\s*\*/.test(line)) {
    return [{ text: line, kind: "comment" }];
  }
  return highlightGeneric(line, null, false).map((s) => {
    if (s.kind === "plain" && s.text.startsWith("--")) {
      return { ...s, kind: "property" as SynKind };
    }
    return s;
  });
}

function highlightMd(line: string): HlSpan[] {
  if (/^\s*#/.test(line)) return [{ text: line, kind: "keyword" }];
  if (/^\s*```/.test(line)) return [{ text: line, kind: "operator" }];
  if (/^\s*[-*+] /.test(line)) {
    return [
      { text: line.slice(0, line.indexOf(" ") + 1), kind: "operator" },
      { text: line.slice(line.indexOf(" ") + 1), kind: "plain" },
    ];
  }
  return [{ text: line, kind: "plain" }];
}

function mergePlain(spans: HlSpan[]): HlSpan[] {
  if (spans.length <= 1) return spans;
  const out: HlSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && last.kind === s.kind && s.kind === "plain") {
      last.text += s.text;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Guess language from path extension for tool results. */
export function langFromPath(path: string | undefined | null): string {
  if (!path) return "";
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "";
  const ext = m[1]!;
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    mjs: "js",
    cjs: "js",
    py: "py",
    rs: "rs",
    go: "go",
    json: "json",
    html: "html",
    htm: "html",
    css: "css",
    scss: "css",
    md: "md",
    sh: "shell",
    bash: "shell",
    ps1: "shell",
    toml: "generic",
    yaml: "generic",
    yml: "generic",
  };
  return map[ext] ?? "";
}
