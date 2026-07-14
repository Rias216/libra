/**
 * Prompt / command history memory — persists recent user inputs for
 * up/down navigation and deep autocomplete ranking.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_LIMIT = 500;

export class PromptHistory {
  private items: string[] = [];
  private path: string;
  private limit: number;

  constructor(opts?: { path?: string; limit?: number }) {
    this.limit = opts?.limit ?? DEFAULT_LIMIT;
    this.path =
      opts?.path ?? join(homedir(), ".libra", "prompt_history.jsonl");
    this.load();
  }

  private load(): void {
    try {
      if (!this.path || !existsSync(this.path)) return;
      const raw = readFileSync(this.path, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      this.items = lines
        .map((l) => {
          try {
            const j = JSON.parse(l) as { text?: string };
            return j.text ?? "";
          } catch {
            return l;
          }
        })
        .filter(Boolean)
        .slice(-this.limit);
    } catch {
      this.items = [];
    }
  }

  private persist(): void {
    try {
      if (!this.path) return;
      mkdirSync(dirname(this.path), { recursive: true });
      const body = this.items
        .map((text) => JSON.stringify({ text, ts: Date.now() }))
        .join("\n");
      writeFileSync(this.path, body + (body ? "\n" : ""), "utf8");
    } catch {
      // best-effort
    }
  }

  push(text: string): void {
    const t = text.trim();
    if (!t) return;
    // de-dupe consecutive
    if (this.items[this.items.length - 1] === t) return;
    this.items.push(t);
    if (this.items.length > this.limit) {
      this.items = this.items.slice(-this.limit);
    }
    this.persist();
  }

  all(): string[] {
    return [...this.items];
  }

  /** Most recent first */
  recent(n = 50): string[] {
    return this.items.slice(-n).reverse();
  }
}
