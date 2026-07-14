/**
 * Workspace path index for @-file autocomplete.
 * Walks the tree with ignore rules and keeps a flat, scoreable list.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);

export interface PathEntry {
  /** Relative path using forward slashes */
  path: string;
  isDir: boolean;
  name: string;
}

export class PathIndex {
  private entries: PathEntry[] = [];
  private root: string;
  private maxFiles: number;

  constructor(root = process.cwd(), maxFiles = 4000) {
    this.root = root;
    this.maxFiles = maxFiles;
  }

  getRoot(): string {
    return this.root;
  }

  /** Rebuild the index (call on start and occasionally) */
  rebuild(): void {
    this.entries = [];
    this.walk(this.root, 0);
  }

  private walk(dir: string, depth: number): void {
    if (this.entries.length >= this.maxFiles) return;
    if (depth > 12) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    // Prefer source-looking files first for better UX
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (this.entries.length >= this.maxFiles) return;
      if (name.startsWith(".") && name !== ".env.example") {
        if (IGNORE_DIRS.has(name) || name === ".git") continue;
      }
      if (IGNORE_DIRS.has(name)) continue;
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      const rel = relative(this.root, full).split(sep).join("/");
      this.entries.push({ path: rel, isDir, name });
      if (isDir) this.walk(full, depth + 1);
    }
  }

  all(): PathEntry[] {
    if (this.entries.length === 0) this.rebuild();
    return this.entries;
  }

  files(): PathEntry[] {
    return this.all().filter((e) => !e.isDir);
  }
}
