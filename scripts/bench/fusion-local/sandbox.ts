/**
 * Per-case sandbox prep for fusion suite.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { CaseDef } from "./parse.js";
import { resolveFixturesDir } from "./parse.js";

export interface Sandbox {
  runRoot: string;
  workspace: string;
}

export function prepareSandbox(
  runsRoot: string,
  suiteRoot: string,
  caseDef: CaseDef,
): Sandbox {
  const runRoot = join(runsRoot, caseDef.id);
  if (existsSync(runRoot)) {
    rmSync(runRoot, { recursive: true, force: true });
  }
  const workspace = join(runRoot, "workspace");
  mkdirSync(workspace, { recursive: true });

  const mode = caseDef.workspace_mode;
  const fixtures = resolveFixturesDir(suiteRoot, caseDef);

  if ((mode === "copy" || mode === "overlay") && fixtures) {
    copyDirContents(fixtures, workspace);
  }
  // empty: leave workspace empty

  writeFileSync(join(runRoot, "tool_trace.json"), "[]\n", "utf8");
  writeFileSync(join(runRoot, "final_answer.txt"), "", "utf8");
  writeFileSync(join(runRoot, "transcript.jsonl"), "", "utf8");

  return { runRoot, workspace };
}

function copyDirContents(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    const st = statSync(from);
    if (st.isDirectory()) {
      cpSync(from, to, { recursive: true });
    } else {
      cpSync(from, to);
    }
  }
}

export function workspaceSnapshot(
  workspace: string,
  maxFiles = 24,
  maxBytes = 4000,
): string {
  const lines: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (lines.length > maxFiles * 3 || depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        lines.push(`${r}/`);
        walk(abs, r, depth + 1);
      } else {
        lines.push(`${r} (${st.size}b)`);
        if (st.size <= maxBytes && st.size > 0) {
          try {
            const text = readFileSync(abs, "utf8");
            if (!/[\x00-\x08\x0e-\x1f]/.test(text)) {
              lines.push("```");
              lines.push(text.length > 1500 ? text.slice(0, 1500) + "\n…" : text);
              lines.push("```");
            }
          } catch {
            /* */
          }
        }
      }
    }
  };
  walk(workspace, "", 0);
  return lines.join("\n") || "(empty workspace)";
}

export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function writeText(path: string, data: string): void {
  writeFileSync(path, data, "utf8");
}

export function appendJsonl(path: string, row: unknown): void {
  writeFileSync(path, JSON.stringify(row) + "\n", {
    encoding: "utf8",
    flag: "a",
  });
}
