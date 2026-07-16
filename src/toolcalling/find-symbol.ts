/**
 * find_symbol — go-to-definition / references / implementations by symbol name.
 * Primary engine: TypeScript-aware text scan (zero extra deps, reliable).
 * Optional: dynamic typescript package when available for declaration walk.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

export type FindSymbolAction =
  | "definition"
  | "references"
  | "implementations";

export interface SymbolLocation {
  file: string;
  line: number;
  col: number;
  text?: string;
}

export interface FindSymbolResult {
  ok: boolean;
  action: FindSymbolAction;
  symbol: string;
  locations: SymbolLocation[];
  error?: string;
  engine?: string;
}

const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"]);

function walkTsFiles(root: string, max = 400): string[] {
  const out: string[] = [];
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".next",
  ]);
  const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (TS_EXTS.has(extname(name))) out.push(p);
    }
  }
  return out;
}

/**
 * Text search for symbol definitions/references.
 * Pure path used by unit tests and as the production engine.
 */
export function findSymbolByTextScan(
  cwd: string,
  symbol: string,
  action: FindSymbolAction,
  files?: string[],
): FindSymbolResult {
  if (!symbol || !/^[A-Za-z_$][\w$]*$/.test(symbol)) {
    return {
      ok: false,
      action,
      symbol,
      locations: [],
      error: `invalid symbol name: ${symbol}`,
      engine: "text-scan",
    };
  }
  const list = files ?? walkTsFiles(cwd);
  const defRe = new RegExp(
    `\\b(?:export\\s+)?(?:async\\s+)?(?:function|class|interface|type|const|let|var|enum)\\s+${symbol}\\b|\\b${symbol}\\s*[=:(<]`,
  );
  const refRe = new RegExp(`\\b${symbol}\\b`);
  const locations: SymbolLocation[] = [];
  for (const abs of list) {
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (action === "definition" || action === "implementations") {
        const m = line.match(defRe);
        if (!m || m.index == null) continue;
        // implementations: prefer class/interface/implements lines
        if (
          action === "implementations" &&
          !/\b(class|implements|extends)\b/.test(line)
        ) {
          // still accept function/class decls
          if (!/\b(class|function|interface)\b/.test(line)) continue;
        }
        locations.push({
          file: relative(cwd, abs).replace(/\\/g, "/"),
          line: i + 1,
          col: m.index + 1,
          text: line.trim().slice(0, 200),
        });
      } else {
        const m = line.match(refRe);
        if (!m || m.index == null) continue;
        locations.push({
          file: relative(cwd, abs).replace(/\\/g, "/"),
          line: i + 1,
          col: m.index + 1,
          text: line.trim().slice(0, 200),
        });
      }
      if (action === "definition" && locations.length >= 20) break;
      if (action !== "definition" && locations.length >= 100) break;
    }
    if (action === "definition" && locations.length >= 20) break;
    if (action !== "definition" && locations.length >= 100) break;
  }
  return {
    ok: true,
    action,
    symbol,
    locations,
    engine: "text-scan",
  };
}

/** Find symbol by name (definition / references / implementations). */
export async function findSymbol(
  cwd: string,
  symbol: string,
  action: FindSymbolAction = "definition",
  _opts?: { file?: string; line?: number; col?: number },
): Promise<FindSymbolResult> {
  void _opts;
  void existsSync; // keep import for future LS path
  return findSymbolByTextScan(cwd, symbol, action);
}
