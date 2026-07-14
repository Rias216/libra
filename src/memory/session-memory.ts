/**
 * Session memory — extracts tokens, paths, and tool names from the
 * live conversation so autocomplete can rank "things already in play".
 */

import type { HarnessState, Message } from "../core/types.js";

export interface SessionTokens {
  /** Paths seen in tool args / file parts / @ mentions */
  paths: string[];
  /** Tool names used this session */
  tools: string[];
  /** Significant words from user messages */
  words: string[];
  /** Full user prompts */
  prompts: string[];
}

const PATH_RE = /(?:^|[\s`"'(])((?:[\w.-]+\/)+[\w.-]+(?:\.\w+)?)/g;
const WORD_RE = /\b[a-zA-Z_][\w-]{2,}\b/g;

export function extractSessionTokens(state: HarnessState): SessionTokens {
  const paths = new Set<string>();
  const tools = new Set<string>();
  const words = new Set<string>();
  const prompts: string[] = [];

  for (const msg of state.messages) {
    harvestMessage(msg, paths, tools, words, prompts);
  }

  return {
    paths: [...paths],
    tools: [...tools],
    words: [...words].slice(0, 200),
    prompts,
  };
}

function harvestMessage(
  msg: Message,
  paths: Set<string>,
  tools: Set<string>,
  words: Set<string>,
  prompts: string[],
): void {
  for (const part of msg.parts) {
    if (part.type === "text") {
      if (msg.role === "user") {
        prompts.push(part.content);
        for (const w of part.content.match(WORD_RE) ?? []) {
          if (w.length >= 3) words.add(w);
        }
      }
      let m: RegExpExecArray | null;
      const re = new RegExp(PATH_RE.source, "g");
      while ((m = re.exec(part.content)) !== null) {
        paths.add(m[1]!);
      }
      // @path mentions
      for (const at of part.content.match(/@([\w./\\-]+)/g) ?? []) {
        paths.add(at.slice(1).replace(/\\/g, "/"));
      }
    } else if (part.type === "tool") {
      tools.add(part.toolName);
      for (const [k, v] of Object.entries(part.args)) {
        if (typeof v !== "string" || !v.trim()) continue;
        const s = v.replace(/\\/g, "/").trim();
        // Path-like keys always harvest (even single segment: "src", "package.json")
        if (
          /(?:file|path|dir|directory|glob|target)/i.test(k) ||
          s.includes("/") ||
          s.includes(".") ||
          s === "."
        ) {
          if (s !== "." && s !== "./") paths.add(s);
          else if (s === "." || s === "./") paths.add(".");
        }
      }
    } else if (part.type === "file" || part.type === "diff") {
      paths.add(part.path.replace(/\\/g, "/"));
    }
  }
}
