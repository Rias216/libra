/**
 * Self-review / self-upgrade — Libra improves its own source tree
 * using the user's active model. Every run snapshots the install first.
 *
 * Backups: ~/.libra/self-review-backups/<id>/
 * Restore: /self-review restore [id]
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { getVersion } from "../version.js";
import {
  analyzeSessionFriction,
  listSessionLibes,
  type FrictionReport,
} from "../memory/session-store.js";

/** Directory names never copied into a backup or restore target. */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".grok",
  ".cursor",
  ".vscode",
  ".idea",
  "coverage",
  ".turbo",
  ".next",
  "self-review-backups",
]);

/** File name suffixes / names skipped. */
const SKIP_FILE_RE =
  /\.(exe|dll|so|dylib|map|log|tsbuildinfo)$/i;

export interface SelfReviewBackupManifest {
  id: string;
  createdAt: string;
  createdAtMs: number;
  libraRoot: string;
  version: string;
  provider?: string;
  model?: string;
  focus?: string;
  fileCount: number;
  /** Paths relative to libra root, posix-style */
  files: string[];
  note?: string;
}

export interface BackupResult {
  id: string;
  dir: string;
  manifest: SelfReviewBackupManifest;
}

export interface RestoreResult {
  id: string;
  restored: number;
  libraRoot: string;
}

function backupsRoot(): string {
  return (
    process.env.LIBRA_SELF_REVIEW_BACKUPS ??
    join(homedir(), ".libra", "self-review-backups")
  );
}

/**
 * Resolve the on-disk Libra install (source of truth for self-upgrade).
 * Order: LIBRA_HOME → walk from this module → cwd if package name is libra.
 */
export function resolveLibraRoot(start?: string): string {
  const env = process.env.LIBRA_HOME?.trim();
  if (env && isLibraPackageRoot(env)) return resolve(env);

  const seeds: string[] = [];
  if (start) seeds.push(resolve(start));
  try {
    seeds.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* ignore */
  }
  seeds.push(process.cwd());

  for (const seed of seeds) {
    let dir = resolve(seed);
    for (let i = 0; i < 8; i++) {
      if (isLibraPackageRoot(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  throw new Error(
    "Could not find the Libra install root (package.json name \"libra\"). " +
      "Set LIBRA_HOME to the repo path, or run from the Libra checkout.",
  );
}

export function isLibraPackageRoot(dir: string): boolean {
  try {
    const p = join(dir, "package.json");
    if (!existsSync(p)) return false;
    const j = JSON.parse(readFileSync(p, "utf8")) as { name?: string };
    return j.name === "libra";
  } catch {
    return false;
  }
}

function newBackupId(now = new Date()): string {
  // 2026-07-15T14-30-22-123Z style — filesystem-safe
  return now.toISOString().replace(/[:.]/g, "-");
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIR_NAMES.has(name) || name.startsWith(".bench");
}

function shouldSkipFile(name: string): boolean {
  if (SKIP_FILE_RE.test(name)) return true;
  if (name === "libra.exe" || name === "libra") return true;
  return false;
}

/** Collect relative file paths under root (posix separators). */
export function listProjectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "." || name === "..") continue;
      const full = join(abs, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (shouldSkipDir(name)) continue;
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (shouldSkipFile(name)) continue;
      const rel = relative(root, full).split(sep).join("/");
      if (rel && !rel.startsWith("..")) out.push(rel);
    }
  };
  walk(root);
  out.sort();
  return out;
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

/**
 * Snapshot the Libra install into ~/.libra/self-review-backups/<id>/.
 * Always call this before the model is allowed to edit sources.
 */
export function createSelfReviewBackup(opts: {
  libraRoot?: string;
  provider?: string;
  model?: string;
  focus?: string;
  note?: string;
}): BackupResult {
  const libraRoot = resolve(opts.libraRoot ?? resolveLibraRoot());
  if (!isLibraPackageRoot(libraRoot)) {
    throw new Error(`Not a Libra package root: ${libraRoot}`);
  }

  const id = newBackupId();
  const dir = join(backupsRoot(), id);
  ensureDir(dir);

  const files = listProjectFiles(libraRoot);
  let copied = 0;
  for (const rel of files) {
    const src = join(libraRoot, ...rel.split("/"));
    const dest = join(dir, ...rel.split("/"));
    try {
      ensureDir(dirname(dest));
      copyFileSync(src, dest);
      copied++;
    } catch (err) {
      // Skip unreadable files; still record attempt in manifest files list
      void err;
    }
  }

  const now = new Date();
  const manifest: SelfReviewBackupManifest = {
    id,
    createdAt: now.toISOString(),
    createdAtMs: now.getTime(),
    libraRoot,
    version: getVersion(),
    provider: opts.provider,
    model: opts.model,
    focus: opts.focus,
    fileCount: copied,
    files,
    note: opts.note ?? "pre-self-review snapshot",
  };
  writeFileSync(
    join(dir, "MANIFEST.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  return { id, dir, manifest };
}

export function listSelfReviewBackups(): SelfReviewBackupManifest[] {
  const root = backupsRoot();
  if (!existsSync(root)) return [];
  const out: SelfReviewBackupManifest[] = [];
  for (const name of readdirSync(root)) {
    const manPath = join(root, name, "MANIFEST.json");
    if (!existsSync(manPath)) continue;
    try {
      const m = JSON.parse(
        readFileSync(manPath, "utf8"),
      ) as SelfReviewBackupManifest;
      if (m.id) out.push(m);
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
  return out;
}

export function getBackupDir(id: string): string {
  return join(backupsRoot(), id);
}

/**
 * Restore a previous snapshot over the current Libra install.
 * Creates a safety backup of the *current* tree first (unless skipSafetyBackup).
 */
export function restoreSelfReviewBackup(
  id: string,
  opts?: { libraRoot?: string; skipSafetyBackup?: boolean },
): RestoreResult {
  const backupDir = getBackupDir(id);
  const manPath = join(backupDir, "MANIFEST.json");
  if (!existsSync(manPath)) {
    throw new Error(`Backup not found: ${id}`);
  }
  const manifest = JSON.parse(
    readFileSync(manPath, "utf8"),
  ) as SelfReviewBackupManifest;

  const libraRoot = resolve(
    opts?.libraRoot ?? manifest.libraRoot ?? resolveLibraRoot(),
  );
  if (!isLibraPackageRoot(libraRoot)) {
    throw new Error(`Restore target is not a Libra root: ${libraRoot}`);
  }

  if (!opts?.skipSafetyBackup) {
    createSelfReviewBackup({
      libraRoot,
      note: `safety backup before restore of ${id}`,
    });
  }

  let restored = 0;
  for (const rel of manifest.files ?? []) {
    const src = join(backupDir, ...rel.split("/"));
    if (!existsSync(src)) continue;
    const dest = join(libraRoot, ...rel.split("/"));
    try {
      ensureDir(dirname(dest));
      copyFileSync(src, dest);
      restored++;
    } catch {
      /* skip */
    }
  }

  return { id, restored, libraRoot };
}

/** Delete one backup tree (not the live install). */
export function deleteSelfReviewBackup(id: string): void {
  const dir = getBackupDir(id);
  if (!existsSync(dir)) throw new Error(`Backup not found: ${id}`);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Load recent `.libe` sessions and build a friction report for self-review.
 * Always safe: empty report if no sessions yet.
 */
export function collectSelfReviewSessionContext(opts?: {
  limit?: number;
}): {
  friction: FrictionReport;
  sessionListMarkdown: string;
} {
  const limit = opts?.limit ?? 20;
  const listed = listSessionLibes(limit);
  const friction = analyzeSessionFriction({ limit });

  const sessionListMarkdown =
    listed.length === 0
      ? "_No saved `.libe` sessions yet. Sessions auto-save under `~/.libra/sessions/`._"
      : listed
          .map((s, i) => {
            const sum = s.summary;
            const err =
              sum && (sum.toolErrors || sum.statusErrors)
                ? ` · errors tools=${sum.toolErrors} status=${sum.statusErrors}`
                : "";
            return (
              `${i + 1}. \`${s.id}\` ${s.provider}/${s.model} · ` +
              `${sum?.userTurns ?? "?"} user turns · ${sum?.toolCalls ?? "?"} tools${err} · ${s.savedAt}`
            );
          })
          .join("\n");

  return { friction, sessionListMarkdown };
}

/**
 * System-prompt addon: forces the model to treat this as a surgical
 * self-upgrade of Libra, not a greenfield rewrite.
 */
export function buildSelfReviewSystemAddon(opts: {
  libraRoot: string;
  backupId: string;
  backupDir: string;
  provider: string;
  model: string;
  focus?: string;
  /** Recent session friction (from .libe files) */
  frictionMarkdown?: string;
  sessionListMarkdown?: string;
}): string {
  const focusLine = opts.focus?.trim()
    ? `User focus area: ${opts.focus.trim()}`
    : "No special focus — prioritize friction from recent sessions, then high-impact bugs.";

  const sessionBlock =
    opts.sessionListMarkdown || opts.frictionMarkdown
      ? `
## Evidence from recent sessions (.libe)

Sessions are auto-saved as \`~/.libra/sessions/*.libe\`. You MAY open those files
with read_file if you need full transcripts (paths may appear in the list below).

### Recent sessions
${opts.sessionListMarkdown ?? "_none_"}

${opts.frictionMarkdown ?? ""}
`
      : "";

  return `
# Libra self-review / self-upgrade mode (mandatory)

You are upgrading **Libra itself** — the AI coding harness whose source lives at:
\`${opts.libraRoot.replace(/\\/g, "/")}\`

A full source backup was already taken **before this turn**:
- backup id: \`${opts.backupId}\`
- backup dir: \`${opts.backupDir.replace(/\\/g, "/")}\`
- restore later with: \`/self-review restore ${opts.backupId}\`

Active model for this upgrade: **${opts.provider}/${opts.model}**
${focusLine}
${sessionBlock}
## Mission
Literally improve Libra in-place using **real session evidence** first:
1. Fix friction and errors mined from recent \`.libe\` sessions (tools, shell, auth, reasoning UI, empty answers, retries).
2. Then address broader bugs, performance, DX, and port leftovers (Bun / TypeScript 7).
Prefer small, correct, verifiable upgrades over grand rewrites.

## Hard rules
1. **Working directory is the Libra install root above.** Do not edit the user's other projects.
2. Prefer tools: list_dir, grep, read_file, search_replace / write_file, run_terminal_command.
3. Do **not** delete session \`.libe\` files or the backup directory. Do **not** force-push.
4. **Ship gate (mandatory before you stop):** the harness will re-open your turn if these fail. You must leave them green:
   - \`bun run typecheck\`
   - \`bun run build\`
   - smoke: \`bun dist/cli.js --version\` (or \`bun src/cli.ts --version\`)
   Optionally also \`bun run test:harness\` when practical.
5. Keep TypeScript 7 + Bun as the toolchain. Do not reintroduce \`tsx\` or Node-only scripts without cause.
6. Do not put secrets into source. Do not expand scope into unrelated repos.
7. If you change CLI commands or behavior, update help text / slash catalog when needed.
8. End with a short changelog of what you upgraded, which session friction it addresses, and how to roll back (\`/self-review restore ${opts.backupId}\`).
9. **Never claim done while typecheck/build/smoke are red.** Fix until green.

## Suggested review order
1. **Session friction report above** — tool errors, status errors, user retries
2. Agent loop / toolcalling / Windows shell / permissions
3. Reasoning modes (stuck Ultra, effort picker), TUI paint
4. Run typecheck + build + smoke; fix any failures before finishing

You have full tools. Execute — do not only describe a plan.
`.trim();
}

/** User-visible turn prompt (also stored in session history). */
export function buildSelfReviewUserPrompt(opts: {
  backupId: string;
  provider: string;
  model: string;
  focus?: string;
  frictionSummary?: string;
  sessionsScanned?: number;
}): string {
  const focus = opts.focus?.trim()
    ? `\n\n**Focus:** ${opts.focus.trim()}`
    : "";
  const friction =
    opts.sessionsScanned && opts.sessionsScanned > 0
      ? `\n\nMined **${opts.sessionsScanned}** recent \`.libe\` session(s) for friction/errors` +
        (opts.frictionSummary
          ? `:\n${opts.frictionSummary}`
          : ". Use the system report and fix the top issues.")
      : `\n\nNo prior \`.libe\` sessions found yet — still upgrade from code review; future sessions will auto-save.`;

  return (
    `Run a full **self-review and self-upgrade** of Libra using model ` +
    `\`${opts.provider}/${opts.model}\`.\n\n` +
    `A source backup was saved as \`${opts.backupId}\` before you start. ` +
    `**Review recent session transcripts for friction and errors first**, then improve the codebase in-place. ` +
    `Before you finish you MUST leave the install green: \`bun run typecheck\`, \`bun run build\`, and CLI \`--version\` smoke. ` +
    `If those fail, keep fixing — the harness will not exit for relaunch until they pass (or fix budget is exhausted).` +
    friction +
    focus
  );
}

/** Follow-up turn when in-session verify failed — keep working, do not exit. */
export function buildSelfReviewFixPrompt(opts: {
  attempt: number;
  maxAttempts: number;
  failureMarkdown: string;
}): string {
  return [
    `# Self-review verify FAILED (fix round ${opts.attempt}/${opts.maxAttempts})`,
    ``,
    `The install is **not** ready to relaunch. **Do not stop.** Fix the errors below, then re-run:`,
    `- \`bun run typecheck\``,
    `- \`bun run build\``,
    `- smoke: \`bun dist/cli.js --version\` (or \`bun src/cli.ts --version\`)`,
    ``,
    `## Failure`,
    opts.failureMarkdown,
    ``,
    `Apply the smallest correct fix. Prefer search_replace over rewrites. After edits, run the checks yourself with run_terminal_command.`,
  ].join("\n");
}

/** One-line friction blurb for user prompt / status UI. */
export function frictionOneLiner(report: FrictionReport): string {
  const parts = Object.entries(report.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `${k}=${n}`);
  if (!parts.length) return "no recorded errors in recent sessions";
  return parts.join(", ");
}
