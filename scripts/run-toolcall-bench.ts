/**
 * Moderate coding tool-calling benchmark.
 * Compares free models on the same prompts with plain agent loop (no fusion).
 *
 * Usage:
 *   bun scripts/run-toolcall-bench.ts
 *   bun scripts/run-toolcall-bench.ts --models opencode/deepseek-v4-flash-free,openrouter/tencent/hy3:free
 *   bun scripts/run-toolcall-bench.ts --only A-sum-cli --models openrouter/tencent/hy3:free
 *
 * Env:
 *   LIBRA_BENCH_ROOT   default Desktop/libra-bench-toolcall
 *   LIBRA_BENCH_TIMEOUT_MS  default 480000
 *   LIBRA_BENCH_MAX_STEPS   default 28
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIBRA = resolve(__dirname, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

interface BenchCase {
  id: string;
  label: string;
  /** Relative prompt file under prompts/ or absolute */
  promptFile: string;
  /** If set, seed workspace from this template dir (relative to bench root or abs) */
  seedDir?: string;
  /** Empty workspace (create from scratch) */
  empty?: boolean;
}

const CASES: BenchCase[] = [
  {
    id: "A-sum-cli",
    label: "sum-cli",
    promptFile: "prompts/A-sum-cli.md",
    empty: true,
  },
  {
    id: "B-lru-cache",
    label: "lru-cache",
    promptFile: "prompts/B-lru-cache.md",
    empty: true,
  },
  {
    id: "C-todo-api",
    label: "todo-api",
    promptFile: "prompts/C-todo-api.md",
    empty: true,
  },
];

interface ModelSpec {
  provider: string;
  model: string;
  key: string;
}

function parseModels(s: string): ModelSpec[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((key) => {
      // provider/rest... where rest may contain slashes (tencent/hy3:free)
      const i = key.indexOf("/");
      if (i < 0) {
        return { provider: "opencode", model: key, key: `opencode/${key}` };
      }
      return {
        provider: key.slice(0, i),
        model: key.slice(i + 1),
        key,
      };
    });
}

function safeDirName(s: string): string {
  return s.replace(/[^\w.\-:@+]+/g, "_").replace(/[:/\\]/g, "_");
}

function runLive(opts: {
  provider: string;
  model: string;
  cwd: string;
  promptFile: string;
  outDir: string;
  label: string;
  maxSteps: number;
  timeoutMs: number;
}): { ok: boolean; ms: number; log: string } {
  mkdirSync(opts.outDir, { recursive: true });
  const logPath = join(opts.outDir, "runner.log");
  const t0 = Date.now();
  const r = spawnSync(
    "bun",
    [
      join(LIBRA, "scripts/debug-live-run.ts"),
      "--plain",
      "--provider",
      opts.provider,
      "--model",
      opts.model,
      "--cwd",
      opts.cwd,
      "--prompt-file",
      opts.promptFile,
      "--out",
      opts.outDir,
      "--label",
      opts.label,
      "--max-steps",
      String(opts.maxSteps),
      "--timeout-ms",
      String(opts.timeoutMs),
      "--profile",
      "full",
    ],
    {
      cwd: LIBRA,
      encoding: "utf8",
      // overall wall: timeout + buffer
      timeout: opts.timeoutMs + 60_000,
      env: {
        ...process.env,
        PATH: process.env.PATH,
        LIBRA_DEBUG: process.env.LIBRA_DEBUG ?? "info",
        LIBRA_DEBUG_FULL: process.env.LIBRA_DEBUG_FULL ?? "1",
        LIBRA_PERF: "1",
        LIBRA_DEBUG_FILE: join(opts.outDir, "harness-debug.log"),
      },
      shell: process.platform === "win32",
    },
  );
  const log = `${r.stdout ?? ""}\n${r.stderr ?? ""}\n${r.error ? String(r.error) : ""}`;
  writeFileSync(logPath, log, "utf8");
  return { ok: r.status === 0, ms: Date.now() - t0, log };
}

function scoreOut(outDir: string, cwd: string): {
  overall: number | null;
  scores?: Record<string, number>;
  verification?: { testOk: boolean; buildOk: boolean };
  tools?: { total: number; completed: number; error: number };
} {
  const r = spawnSync(
    "bun",
    [join(LIBRA, "scripts/score-bench.ts"), outDir, "--cwd", cwd],
    {
      cwd: LIBRA,
      encoding: "utf8",
      timeout: 300_000,
      shell: process.platform === "win32",
      env: process.env,
    },
  );
  writeFileSync(join(outDir, "score-runner.log"), `${r.stdout ?? ""}\n${r.stderr ?? ""}`, "utf8");
  const scorePath = join(outDir, "score.json");
  if (!existsSync(scorePath)) {
    return { overall: null };
  }
  try {
    const j = JSON.parse(readFileSync(scorePath, "utf8")) as {
      scores?: {
        overall?: number;
        toolSuccess?: number;
        deliverables?: number;
        verification?: number;
        efficiency?: number;
        reasoning?: number;
      };
      verification?: { testOk: boolean; buildOk: boolean };
      meta?: { tools?: { total: number; completed: number; error: number } };
    };
    return {
      overall: j.scores?.overall ?? null,
      scores: j.scores as Record<string, number> | undefined,
      verification: j.verification,
      tools: j.meta?.tools,
    };
  } catch {
    return { overall: null };
  }
}

function analyzeOut(outDir: string): void {
  spawnSync(
    "bun",
    [join(LIBRA, "scripts/analyze-agent-loop.ts"), outDir, "--write", join(outDir, "LOOP_ANALYSIS.md")],
    {
      cwd: LIBRA,
      encoding: "utf8",
      timeout: 60_000,
      shell: process.platform === "win32",
    },
  );
}

async function main(): Promise<void> {
  const root = resolve(
    arg("--root") ??
      process.env.LIBRA_BENCH_ROOT ??
      join(homedir(), "Desktop", "libra-bench-toolcall"),
  );
  const models = parseModels(
    arg("--models") ??
      process.env.LIBRA_BENCH_MODELS ??
      "opencode/deepseek-v4-flash-free,openrouter/tencent/hy3:free",
  );
  const only = arg("--only");
  const maxSteps = Number(
    arg("--max-steps") ?? process.env.LIBRA_BENCH_MAX_STEPS ?? 28,
  );
  const timeoutMs = Number(
    arg("--timeout-ms") ?? process.env.LIBRA_BENCH_TIMEOUT_MS ?? 480_000,
  );
  const skipScore = hasFlag("--skip-score");

  // Ensure prompt pack exists under bench root (copy from repo if missing)
  const repoPrompts = join(LIBRA, "scripts/bench-prompts");
  const rootPrompts = join(root, "prompts");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "workspaces"), { recursive: true });
  mkdirSync(join(root, "results"), { recursive: true });
  if (existsSync(repoPrompts)) {
    mkdirSync(rootPrompts, { recursive: true });
    for (const f of readdirSync(repoPrompts)) {
      cpSync(join(repoPrompts, f), join(rootPrompts, f));
    }
  }

  const cases = CASES.filter((c) => !only || c.id === only || c.label === only);
  if (!cases.length) {
    console.error(`No cases matched --only ${only}`);
    process.exit(1);
  }

  console.error(`=== Toolcall moderate bench ===`);
  console.error(`root=${root}`);
  console.error(`models=${models.map((m) => m.key).join(", ")}`);
  console.error(`cases=${cases.map((c) => c.id).join(", ")}`);
  console.error(`maxSteps=${maxSteps} timeoutMs=${timeoutMs}`);

  type Row = {
    caseId: string;
    modelKey: string;
    ms: number;
    overall: number | null;
    toolOk: string;
    testOk?: boolean;
    buildOk?: boolean;
    outDir: string;
    error?: string;
  };
  const rows: Row[] = [];

  for (const model of models) {
    for (const c of cases) {
      const modelDir = safeDirName(model.key);
      const cwd = join(root, "workspaces", modelDir, c.id);
      const outDir = join(root, "results", modelDir, c.id);
      const promptPath = c.promptFile.startsWith("/") || /^[A-Za-z]:/.test(c.promptFile)
        ? c.promptFile
        : join(root, c.promptFile);

      if (!existsSync(promptPath)) {
        console.error(`MISSING prompt ${promptPath} — skip ${c.id}`);
        continue;
      }

      // Fresh workspace each run
      if (existsSync(cwd)) {
        rmSync(cwd, { recursive: true, force: true });
      }
      mkdirSync(cwd, { recursive: true });
      if (c.seedDir) {
        const seed = c.seedDir.startsWith("/") || /^[A-Za-z]:/.test(c.seedDir)
          ? c.seedDir
          : join(root, c.seedDir);
        if (existsSync(seed)) {
          cpSync(seed, cwd, { recursive: true });
        }
      }
      // Drop a copy of the task into the workspace for the agent to find
      writeFileSync(join(cwd, "TASK.md"), readFileSync(promptPath, "utf8"), "utf8");

      if (existsSync(outDir)) {
        rmSync(outDir, { recursive: true, force: true });
      }
      mkdirSync(outDir, { recursive: true });

      console.error(`\n>>> START ${model.key} · ${c.id}`);
      const live = runLive({
        provider: model.provider,
        model: model.model,
        cwd,
        promptFile: promptPath,
        outDir,
        label: `bench-${c.label}`,
        maxSteps,
        timeoutMs,
      });
      console.error(
        `<<< LIVE ${model.key} · ${c.id} ok=${live.ok} wall=${live.ms}ms`,
      );

      analyzeOut(outDir);

      let scored: ReturnType<typeof scoreOut> = { overall: null };
      if (!skipScore) {
        scored = scoreOut(outDir, cwd);
        console.error(
          `<<< SCORE ${model.key} · ${c.id} overall=${scored.overall ?? "?"} ` +
            `test=${scored.verification?.testOk} build=${scored.verification?.buildOk}`,
        );
      }

      const metaPath = join(outDir, "meta.json");
      let metaErr: string | undefined;
      let toolParts = scored.tools;
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
            error?: string | null;
            toolParts?: { total: number; completed: number; error: number };
            ms?: number;
          };
          metaErr = meta.error ?? undefined;
          toolParts = toolParts ?? meta.toolParts;
        } catch {
          /* */
        }
      }

      rows.push({
        caseId: c.id,
        modelKey: model.key,
        ms: live.ms,
        overall: scored.overall,
        toolOk: toolParts
          ? `${toolParts.completed}/${toolParts.total} (err ${toolParts.error})`
          : "?",
        testOk: scored.verification?.testOk,
        buildOk: scored.verification?.buildOk,
        outDir,
        error: metaErr,
      });
    }
  }

  // Comparison report
  const reportLines: string[] = [];
  reportLines.push(`# Toolcall moderate bench report`);
  reportLines.push("");
  reportLines.push(`Generated: ${new Date().toISOString()}`);
  reportLines.push(`Root: \`${root}\``);
  reportLines.push(`Models: ${models.map((m) => "`" + m.key + "`").join(", ")}`);
  reportLines.push(`Cases: ${cases.map((c) => c.id).join(", ")}`);
  reportLines.push(`maxSteps=${maxSteps} timeoutMs=${timeoutMs}`);
  reportLines.push("");
  reportLines.push(`## Results`);
  reportLines.push("");
  reportLines.push(
    `| Case | Model | Overall | Tools | Test | Build | Wall ms | Error |`,
  );
  reportLines.push(`|------|-------|--------:|-------|------|-------|--------:|-------|`);
  for (const r of rows) {
    reportLines.push(
      `| ${r.caseId} | \`${r.modelKey}\` | ${r.overall ?? "—"} | ${r.toolOk} | ${r.testOk == null ? "—" : r.testOk ? "PASS" : "FAIL"} | ${r.buildOk == null ? "—" : r.buildOk ? "PASS" : "FAIL"} | ${r.ms} | ${r.error ? r.error.slice(0, 40) : ""} |`,
    );
  }
  reportLines.push("");

  // Per-model averages
  reportLines.push(`## Model averages`);
  reportLines.push("");
  for (const m of models) {
    const rs = rows.filter((r) => r.modelKey === m.key);
    const scored = rs.filter((r) => r.overall != null);
    const avg =
      scored.length > 0
        ? (
            scored.reduce((a, b) => a + (b.overall as number), 0) / scored.length
          ).toFixed(2)
        : "—";
    const avgMs = rs.length
      ? Math.round(rs.reduce((a, b) => a + b.ms, 0) / rs.length)
      : 0;
    const testsPass = rs.filter((r) => r.testOk).length;
    reportLines.push(
      `- **\`${m.key}\`**: avg overall=${avg} · avg wall=${avgMs}ms · tests pass ${testsPass}/${rs.length}`,
    );
  }
  reportLines.push("");
  reportLines.push(`## Artifact paths`);
  reportLines.push("");
  for (const r of rows) {
    reportLines.push(
      `- \`${r.caseId}\` / \`${r.modelKey}\` → \`${r.outDir}\` (transcript, loop-events.jsonl, LOOP_ANALYSIS.md, SCORE.md)`,
    );
  }
  reportLines.push("");
  reportLines.push(`## How to re-analyze`);
  reportLines.push("");
  reportLines.push("```bash");
  reportLines.push("bun scripts/analyze-agent-loop.ts <outDir>");
  reportLines.push("bun scripts/score-bench.ts <outDir> --cwd <workspace>");
  reportLines.push("```");

  const reportPath = join(root, "results", "COMPARISON.md");
  writeFileSync(reportPath, reportLines.join("\n"), "utf8");
  writeFileSync(
    join(root, "results", "comparison.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), models, cases: cases.map((c) => c.id), rows }, null, 2),
    "utf8",
  );

  console.log(reportLines.join("\n"));
  console.error(`\nWrote ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
