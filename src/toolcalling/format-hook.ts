/**
 * format after-hook — run prettier/biome on write/search_replace/patch_apply paths.
 * Registered via ToolRegistry.addHook(); not a callable tool.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { ToolHook, ToolHookContext } from "./registry.js";
import { parseUnifiedDiff } from "./patch.js";

const FORMAT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".html",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
]);

const MUTATORS = new Set(["write", "search_replace", "patch_apply", "write_file", "edit_file"]);

function hasBin(cwd: string, pkg: string): boolean {
  // node_modules/.bin/prettier or biome
  const bin =
    process.platform === "win32"
      ? join(cwd, "node_modules", ".bin", `${pkg}.cmd`)
      : join(cwd, "node_modules", ".bin", pkg);
  if (existsSync(bin)) return true;
  // Walk parents a bit
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const b =
      process.platform === "win32"
        ? join(dir, "node_modules", ".bin", `${pkg}.cmd`)
        : join(dir, "node_modules", ".bin", pkg);
    if (existsSync(b)) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function runFormatter(
  cwd: string,
  bin: "prettier" | "biome",
  filePath: string,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolvePromise) => {
    const args =
      bin === "prettier"
        ? ["--write", filePath]
        : ["format", "--write", filePath];
    const cmd =
      process.platform === "win32"
        ? join(cwd, "node_modules", ".bin", `${bin}.cmd`)
        : join(cwd, "node_modules", ".bin", bin);
    const useCmd = existsSync(cmd) ? cmd : bin;
    const child = spawn(useCmd, args, {
      cwd,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const t = setTimeout(() => {
      child.kill();
      resolvePromise({ ok: false, detail: "format timeout" });
    }, 20_000);
    child.on("error", (err) => {
      clearTimeout(t);
      resolvePromise({ ok: false, detail: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolvePromise({
        ok: code === 0,
        detail: code === 0 ? `${bin} ok` : stderr || `${bin} exit ${code}`,
      });
    });
  });
}

/**
 * Extract all touched paths from mutator args.
 * patch_apply: parse unified diff for ---/+++ paths (not only args.path).
 */
export function pathsFromMutatorArgs(
  name: string,
  args: Record<string, unknown>,
): string[] {
  if (name === "patch_apply") {
    if (args.path != null && String(args.path).trim()) {
      return [String(args.path)];
    }
    if (args.file_path != null && String(args.file_path).trim()) {
      return [String(args.file_path)];
    }
    const diff = String(args.diff ?? args.patch ?? "");
    if (!diff.trim()) return [];
    const files = parseUnifiedDiff(diff);
    const out: string[] = [];
    for (const f of files) {
      const p =
        f.newPath && f.newPath !== "/dev/null"
          ? f.newPath
          : f.oldPath && f.oldPath !== "/dev/null"
            ? f.oldPath
            : "";
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  }
  const p = args.file_path ?? args.path ?? args.target_file;
  return p != null && String(p).trim() ? [String(p)] : [];
}

/** First touched path (compat helper). */
export function pathFromMutatorArgs(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  return pathsFromMutatorArgs(name, args)[0];
}

export function shouldFormatPath(filePath: string): boolean {
  return FORMAT_EXTS.has(extname(filePath).toLowerCase());
}

/**
 * Create an after-hook that formats files touched by write/search_replace/patch_apply.
 * No-ops cleanly when prettier/biome are absent.
 */
export function createFormatAfterHook(cwd: string): ToolHook {
  return async (phase, ctx: ToolHookContext) => {
    if (phase !== "after") return;
    if (!ctx.result?.ok) return;
    if (!MUTATORS.has(ctx.name)) return;
    const rels = pathsFromMutatorArgs(ctx.name, ctx.args);
    if (!rels.length) return;

    const hasPrettier = hasBin(cwd, "prettier");
    const hasBiome = hasBin(cwd, "biome");
    if (!hasPrettier && !hasBiome) {
      // No-op when formatters absent — plan requires this.
      return;
    }
    for (const rel of rels) {
      if (!shouldFormatPath(rel)) continue;
      const abs = resolve(cwd, rel);
      if (!existsSync(abs)) continue;
      if (hasBiome) {
        await runFormatter(cwd, "biome", abs);
      } else if (hasPrettier) {
        await runFormatter(cwd, "prettier", abs);
      }
    }
  };
}

/** Register format hook on a registry instance. */
export function installFormatHook(
  registry: { addHook: (h: ToolHook) => void },
  cwd: string,
): void {
  registry.addHook(createFormatAfterHook(cwd));
}
