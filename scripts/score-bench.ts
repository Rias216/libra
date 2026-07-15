/**
 * Score a finished debug-live-run / bench-run directory.
 *
 * Outcome-first: a green build + green tests with a real package structure
 * should be able to reach 10/10. File-count padding is not required.
 *
 * Usage: bun scripts/score-bench.ts <outDir> [--cwd <workspace>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Pure scorers are exported for unit tests. CLI body only runs as main module.
const isMain =
  typeof process !== "undefined" &&
  Boolean(process.argv[1]?.replace(/\\/g, "/").match(/score-bench\.(ts|js|mjs)$/));

interface Meta {
  ms?: number;
  toolParts?: {
    total: number;
    completed: number;
    error: number;
    names: string[];
  };
  reasoningChars?: number;
  textChars?: number;
  messageCount?: number;
  provider?: string;
  model?: string;
  mode?: string;
  fusion?: {
    phase1Ms?: number;
    summary?: string;
    main?: { chars?: number; error?: string; ms?: number };
    peer?: { chars?: number; error?: string; ms?: number } | null;
  };
}

function loadJson(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf8"));
}

function countSourceFiles(root: string): { ts: number; tests: number; files: string[] } {
  const files: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(root);
  const rel = files.map((f) => f.slice(root.length + 1).replace(/\\/g, "/"));
  return {
    ts: rel.filter((f) => f.endsWith(".ts") && !f.includes(".test.")).length,
    tests: rel.filter((f) => /\.test\.ts$/.test(f)).length,
    files: rel,
  };
}

function runNpm(script: string, cwd: string): { ok: boolean; output: string } {
  const r = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", script],
    {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      shell: process.platform === "win32",
      env: process.env,
    },
  );
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}\n${r.error ? String(r.error) : ""}`;
  return { ok: r.status === 0, output: output.slice(0, 4000) };
}

function runNpmTest(cwd: string): { ok: boolean; output: string } {
  const r = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["test"],
    {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      shell: process.platform === "win32",
      env: process.env,
    },
  );
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}\n${r.error ? String(r.error) : ""}`;
  return { ok: r.status === 0, output: output.slice(0, 4000) };
}

/**
 * Tool success 0–10.
 * When the project is fully verified (tests + build), recovery noise and a few
 * failed shell probes must not block a perfect score if success rate is high.
 */
export function scoreToolSuccess(
  tools: { total: number; completed: number; error: number },
  verified: boolean,
): number {
  if (tools.total <= 0) return verified ? 8 : 0;
  const rate = tools.completed / tools.total;
  let score = Math.round(rate * 10);
  if (verified) {
    // Green ship: ≥85% tool ok → full credit (B 21/24, C 33/38, A 12/13)
    if (rate >= 0.85) score = 10;
    else if (rate >= 0.75) score = Math.max(score, 9);
    else if (rate >= 0.65) score = Math.max(score, 8);
  }
  return Math.min(10, score);
}

/**
 * Deliverables 0–10 — structure + completeness, not file-count padding.
 * Complete verified package (pkg + ts + tests + build/test green) = 10.
 */
export function scoreDeliverables(opts: {
  hasPkg: boolean;
  hasTsconfig: boolean;
  ts: number;
  tests: number;
  testOk: boolean;
  buildOk: boolean;
}): number {
  const { hasPkg, hasTsconfig, ts, tests, testOk, buildOk } = opts;
  // Gold path: real package that builds and tests
  if (hasPkg && ts >= 1 && tests >= 1 && testOk && buildOk) {
    return 10;
  }
  let s = 0;
  if (hasPkg) s += 2;
  if (hasTsconfig) s += 1;
  if (ts >= 1) s += 2;
  if (ts >= 2) s += 1;
  if (ts >= 4) s += 1;
  if (tests >= 1) s += 2;
  if (tests >= 2) s += 1;
  if (testOk) s += 1;
  if (buildOk) s += 1;
  return Math.min(10, s);
}

/**
 * Efficiency 0–10.
 * Multi-file coding often needs 20–40 tools. When the project is verified,
 * only pathological error/step burn is penalized.
 */
export function scoreEfficiency(
  tools: { total: number; error: number },
  verified: boolean,
): number {
  let errPen = 0;
  if (verified) {
    // ≤5 recoverable errors free (C-mdlint had 5 while still shipping green)
    if (tools.error >= 12) errPen = 3;
    else if (tools.error >= 8) errPen = 2;
    else if (tools.error >= 6) errPen = 1;
  } else {
    if (tools.error >= 5) errPen = 3;
    else if (tools.error >= 3) errPen = 2;
    else if (tools.error >= 1) errPen = 1;
  }

  let stepPen = 0;
  if (tools.total > 90) stepPen = 2;
  else if (tools.total > 60) stepPen = 1;
  // ≤60 tools free for heavy coding benches

  return Math.max(0, 10 - errPen - stepPen);
}

/** Reasoning 0–10 including fusion dual-trace bonus. */
export function scoreReasoning(
  reasoningChars: number,
  fusionOk: boolean,
): number {
  const base =
    reasoningChars > 2000
      ? 8
      : reasoningChars > 500
        ? 6
        : reasoningChars > 0
          ? 4
          : 2;
  return Math.min(10, base + (fusionOk ? 2 : 0));
}

async function main(): Promise<void> {
  const outDir = resolve(process.argv[2] ?? ".");
  const cwd = resolve(arg("--cwd") ?? join(outDir, ".."));

  const metaPath = join(outDir, "meta.json");
  const meta = existsSync(metaPath)
    ? (loadJson(metaPath) as Meta)
    : ({} as Meta);

  const tools = meta.toolParts ?? {
    total: 0,
    completed: 0,
    error: 0,
    names: [],
  };
  const src = countSourceFiles(cwd);
  const hasPkg = existsSync(join(cwd, "package.json"));
  const hasTsconfig = existsSync(join(cwd, "tsconfig.json"));

  let testOk = false;
  let buildOk = false;
  let testOut = "";
  let buildOut = "";
  if (hasPkg) {
    const t = runNpmTest(cwd);
    testOk = t.ok;
    testOut = t.output;
    const b = runNpm("build", cwd);
    buildOk = b.ok;
    buildOut = b.output;
  }

  const verified = testOk && buildOk;

  const toolScore = scoreToolSuccess(tools, verified);
  const deliverScore = scoreDeliverables({
    hasPkg,
    hasTsconfig,
    ts: src.ts,
    tests: src.tests,
    testOk,
    buildOk,
  });
  const verifyScore = (testOk ? 5 : 0) + (buildOk ? 5 : 0);
  const efficiencyScore = scoreEfficiency(tools, verified);

  const fusionOk =
    meta.mode === "ultra-fusion" &&
    (meta.fusion?.main?.chars ?? 0) > 50 &&
    (meta.fusion?.peer?.chars ?? 0) > 50 &&
    !meta.fusion?.main?.error &&
    !meta.fusion?.peer?.error;
  const reasoningScore = scoreReasoning(meta.reasoningChars ?? 0, fusionOk);

  const overall = Number(
    (
      (toolScore +
        deliverScore +
        verifyScore +
        efficiencyScore +
        reasoningScore) /
      5
    ).toFixed(1),
  );

  const report = {
    cwd,
    outDir,
    meta: {
      ms: meta.ms,
      provider: meta.provider,
      model: meta.model,
      mode: meta.mode,
      tools,
      reasoningChars: meta.reasoningChars,
      textChars: meta.textChars,
      fusion: meta.fusion ?? null,
    },
    workspace: src,
    verification: { testOk, buildOk },
    scores: {
      toolSuccess: toolScore,
      deliverables: deliverScore,
      verification: verifyScore,
      efficiency: efficiencyScore,
      reasoning: reasoningScore,
      overall,
    },
    notes: [
      testOk ? "tests green" : "tests failed or missing",
      buildOk ? "build green" : "build failed or missing",
      `tool errors: ${tools.error}/${tools.total}`,
      `source ts files: ${src.ts}, test files: ${src.tests}`,
      verified
        ? "outcome-first scoring: verified project eligible for full deliverables"
        : "unverified — structure points only",
    ],
  };

  const md = [
    `# Bench score: ${overall}/10`,
    ``,
    `- cwd: \`${cwd}\``,
    `- duration_ms: ${meta.ms ?? "?"}`,
    `- mode: ${meta.mode ?? "?"}`,
    `- tools: ${tools.completed}/${tools.total} ok (err ${tools.error})`,
    `- reasoning chars: ${meta.reasoningChars ?? 0}`,
    meta.fusion
      ? `- fusion phase1: ${meta.fusion.phase1Ms ?? "?"}ms · mainChars=${meta.fusion.main?.chars ?? 0} peerChars=${meta.fusion.peer?.chars ?? 0}${fusionOk ? " · dual-trace OK" : ""}`
      : `- fusion: n/a`,
    `- test: ${testOk ? "PASS" : "FAIL"} · build: ${buildOk ? "PASS" : "FAIL"}`,
    ``,
    `## Dimension scores`,
    `| Dimension | Score |`,
    `|---|---|`,
    `| Tool success | ${toolScore}/10 |`,
    `| Deliverables | ${deliverScore}/10 |`,
    `| Verification | ${verifyScore}/10 |`,
    `| Efficiency | ${efficiencyScore}/10 |`,
    `| Reasoning | ${reasoningScore}/10 |`,
    `| **Overall** | **${overall}/10** |`,
    ``,
    `## Notes`,
    ...report.notes.map((n) => `- ${n}`),
    ``,
    testOk
      ? ""
      : `### test output (trunc)\n\`\`\`\n${testOut.slice(0, 1500)}\n\`\`\`\n`,
    buildOk
      ? ""
      : `### build output (trunc)\n\`\`\`\n${buildOut.slice(0, 1500)}\n\`\`\`\n`,
  ].join("\n");

  const scorePath = join(outDir, "SCORE.md");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(scorePath, md, "utf8");
  writeFileSync(join(outDir, "score.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(md);
  console.log(`\nWrote ${scorePath}`);
}

if (isMain) {
  await main();
}