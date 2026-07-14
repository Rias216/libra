/**
 * Autocomplete — only `/` commands (with params) and `@` files.
 */

import { fuzzyFilter, type FuzzyHit } from "./fuzzy.js";
import {
  getSlashCommand,
  paramHint,
  SLASH_COMMANDS,
  type SlashCommand,
} from "./commands.js";
import type { PathIndex } from "../memory/paths.js";
import type { PromptHistory } from "../memory/history.js";
import {
  extractSessionTokens,
  type SessionTokens,
} from "../memory/session-memory.js";
import type { HarnessState } from "../core/types.js";

export type SuggestKind = "command" | "param" | "file" | "path-session";

export interface Suggestion {
  kind: SuggestKind;
  /** Text inserted when accepted (replaces the active token / arg) */
  insert: string;
  label: string;
  detail?: string;
  score: number;
  positions?: number[];
}

export interface CompleteContext {
  text: string;
  cursor: number;
  state: HarnessState | null;
  paths: PathIndex;
  history: PromptHistory;
}

export interface CompleteResult {
  items: Suggestion[];
  tokenStart: number;
  tokenEnd: number;
  mode: "command" | "param" | "file" | "none";
  ghost: string;
}

export function complete(ctx: CompleteContext, limit = 12): CompleteResult {
  const { text, cursor } = ctx;
  const before = text.slice(0, cursor);
  const session = ctx.state ? extractSessionTokens(ctx.state) : emptySession();

  // /cmd <arg...>  — parameter completion after a known command + space
  const paramMatch = before.match(/(?:^|\n)\/(\S+)\s+(.*)$/);
  if (paramMatch) {
    const cmdName = paramMatch[1] ?? "";
    const argText = paramMatch[2] ?? "";
    const cmd = getSlashCommand(cmdName);
    if (cmd?.params?.length) {
      // Complete the last arg token (space-separated)
      const lastSpace = argText.lastIndexOf(" ");
      const argQuery = lastSpace === -1 ? argText : argText.slice(lastSpace + 1);
      const tokenStart =
        lastSpace === -1
          ? cursor - argText.length
          : cursor - argQuery.length;
      const items = completeParams(cmd, argQuery, limit);
      return {
        items,
        tokenStart,
        tokenEnd: cursor,
        mode: "param",
        ghost: ghostFrom(items[0], before, tokenStart, cursor),
      };
    }
  }

  // /cmd — command name completion (no space yet)
  const cmdMatch = before.match(/(?:^|\n)\/([^\s]*)$/);
  if (cmdMatch) {
    const q = cmdMatch[1] ?? "";
    const tokenStart = cursor - q.length - 1;
    const items = completeCommands(q, limit);
    return {
      items,
      tokenStart,
      tokenEnd: cursor,
      mode: "command",
      ghost: ghostFrom(items[0], before, tokenStart, cursor),
    };
  }

  // @file
  const atMatch = before.match(/@([^\s]*)$/);
  if (atMatch) {
    const q = atMatch[1] ?? "";
    const tokenStart = cursor - q.length - 1;
    const items = completeFiles(q, ctx.paths, session, limit);
    return {
      items,
      tokenStart,
      tokenEnd: cursor,
      mode: "file",
      ghost: ghostFrom(items[0], before, tokenStart, cursor),
    };
  }

  return {
    items: [],
    tokenStart: cursor,
    tokenEnd: cursor,
    mode: "none",
    ghost: "",
  };
}

function emptySession(): SessionTokens {
  return { paths: [], tools: [], words: [], prompts: [] };
}

function toCommandSuggestion(c: SlashCommand, score = 0): Suggestion {
  const hint = paramHint(c);
  const needsSpace = Boolean(c.params?.length);
  return {
    kind: "command",
    insert: `/${c.name}${needsSpace ? " " : ""}`,
    label: `/${c.name}`,
    detail:
      c.description +
      (hint ? `  ${hint}` : "") +
      (c.picker ? "  [picker]" : ""),
    score,
  };
}

function completeCommands(q: string, limit: number): Suggestion[] {
  const query = q.replace(/^\/+/, "").toLowerCase();

  // Empty query (just "/") — full catalog in definition order, like a tab
  if (!query) {
    return SLASH_COMMANDS.slice(0, Math.max(limit, SLASH_COMMANDS.length)).map(
      (c) => toCommandSuggestion(c, 0),
    );
  }

  // Match against primary name + aliases, but always show canonical /name
  type Cand = { key: string; cmd: SlashCommand; primary: boolean };
  const cands: Cand[] = [];
  for (const c of SLASH_COMMANDS) {
    cands.push({ key: c.name, cmd: c, primary: true });
    for (const a of c.aliases ?? []) {
      cands.push({ key: a, cmd: c, primary: false });
    }
  }

  const hits = fuzzyFilter(
    query,
    cands.map((c) => c.key),
    limit * 3,
  );

  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const h of hits) {
    const meta = cands.find((c) => c.key === h.item);
    if (!meta || seen.has(meta.cmd.name)) continue;
    seen.add(meta.cmd.name);
    // Boost primary-name matches over aliases
    const score = h.score + (meta.primary ? 100 : 0);
    out.push(toCommandSuggestion(meta.cmd, score));
    if (out.length >= limit) break;
  }

  // If nothing matched, still show full catalog filtered by simple includes
  if (out.length === 0) {
    for (const c of SLASH_COMMANDS) {
      if (
        c.name.includes(query) ||
        c.description.toLowerCase().includes(query) ||
        (c.aliases ?? []).some((a) => a.includes(query))
      ) {
        out.push(toCommandSuggestion(c, 1));
      }
      if (out.length >= limit) break;
    }
  }

  return out;
}

function completeParams(
  cmd: SlashCommand,
  query: string,
  limit: number,
): Suggestion[] {
  const values = cmd.params?.flatMap((p) => p.values ?? []) ?? [];
  if (values.length === 0) {
    // Freeform param — no enum list; return empty so UI doesn't show junk
    return [];
  }

  // Empty arg query — show full value list in definition order (tab-like)
  if (!query.trim()) {
    return values.slice(0, Math.max(limit, values.length)).map((v) => ({
      kind: "param" as const,
      insert: v.value,
      label: v.value,
      detail: v.description ?? cmd.description,
      score: 0,
    }));
  }

  const keys = values.map((v) => v.value);
  const hits = fuzzyFilter(query, keys, limit);
  return hits.map((h) => {
    const meta = values.find((v) => v.value === h.item)!;
    return {
      kind: "param" as const,
      insert: h.item,
      label: h.item,
      detail: meta.description ?? cmd.description,
      score: h.score,
      positions: h.positions,
    };
  });
}

function completeFiles(
  q: string,
  paths: PathIndex,
  session: SessionTokens,
  limit: number,
): Suggestion[] {
  const entries = paths.all();
  const fromIndex = entries.map((e) => e.path + (e.isDir ? "/" : ""));
  // Session paths first, then index — empty query keeps that order
  const candidates = [...new Set([...session.paths, ...fromIndex])];

  if (!q.trim()) {
    return candidates.slice(0, limit).map((p) => ({
      kind: (session.paths.includes(p.replace(/\/$/, ""))
        ? "path-session"
        : "file") as "file" | "path-session",
      insert: `@${p}`,
      label: p,
      detail: session.paths.includes(p.replace(/\/$/, ""))
        ? "in session"
        : fileDetail(p),
      score: 0,
    }));
  }

  const hits = fuzzyFilter(q, candidates, limit);
  return hits.map((h) => {
    const isSession = session.paths.includes(h.item.replace(/\/$/, ""));
    return {
      kind: isSession ? "path-session" : "file",
      insert: `@${h.item}`,
      label: h.item,
      detail: isSession ? "in session" : fileDetail(h.item),
      score: h.score + (isSession ? 50 : 0),
      positions: h.positions,
    } satisfies Suggestion;
  });
}

function ghostFrom(
  top: Suggestion | undefined,
  before: string,
  tokenStart: number,
  cursor: number,
): string {
  if (!top) return "";
  const token = before.slice(tokenStart, cursor);
  if (top.insert.startsWith(token) && top.insert.length > token.length) {
    return top.insert.slice(token.length);
  }
  if (top.insert.startsWith("@") && token.startsWith("@")) {
    if (top.insert.toLowerCase().startsWith(token.toLowerCase())) {
      return top.insert.slice(token.length);
    }
  }
  // param: token is partial value
  if (
    top.kind === "param" &&
    top.insert.toLowerCase().startsWith(token.toLowerCase()) &&
    top.insert.length > token.length
  ) {
    return top.insert.slice(token.length);
  }
  return "";
}

function fileDetail(path: string): string {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : "";
  if (path.endsWith("/")) return "dir";
  if (ext) return ext;
  return "file";
}

export function applySuggestion(
  text: string,
  _cursor: number,
  result: CompleteResult,
  item: Suggestion,
): { text: string; cursor: number } {
  const before = text.slice(0, result.tokenStart);
  const after = text.slice(result.tokenEnd);
  const insert = item.insert;
  const newText = before + insert + after;
  return { text: newText, cursor: (before + insert).length };
}

export function parseSlashInput(
  text: string,
): { cmd: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.replace(/^\/+/, "");
  if (!body) return { cmd: "", args: "" };
  const sp = body.indexOf(" ");
  const raw = sp === -1 ? body : body.slice(0, sp);
  const args = sp === -1 ? "" : body.slice(sp + 1).trim();
  return { cmd: raw.toLowerCase(), args };
}

export function resolveSlashCommand(cmd: string): string {
  const c = cmd.toLowerCase().replace(/^\/+/, "");
  const def = getSlashCommand(c);
  return def?.name ?? c;
}

export type { FuzzyHit };
