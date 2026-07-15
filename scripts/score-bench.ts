/**
 * Score a finished debug-live-run / bench-run directory.
 * Usage: tsx scripts/score-bench.ts <outDir> [--cwd <workspace>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const outDir = resolve(process.argv[2] ?? ".");
const cwd = resolve(arg("--cwd") ?? join(outDir, ".."));

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

function runNpm(script: string): { ok: boolean; output: string } {
  // shell:true on Windows so PATHEXT finds npm.cmd reliably
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

function runNpmTest(): { ok: boolean; output: string } {
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
  const t = runNpmTest();
  testOk = t.ok;
  testOut = t.output;
  const b = runNpm("build");
  buildOk = b.ok;
  buildOut = b.output;
}

// Score dimensions 0-10
const toolSuccessRate =
  tools.total > 0 ? tools.completed / tools.total : 0;
const toolScore = Math.round(toolSuccessRate * 10);

const deliverScore = Math.min(
  10,
  (hasPkg ? 2 : 0) +
    (hasTsconfig ? 1 : 0) +
    Math.min(4, src.ts) +
    Math.min(3, src.tests * 2),
);

const verifyScore = (testOk ? 5 : 0) + (buildOk ? 5 : 0);

const efficiencyPenalty =
  tools.error >= 5 ? 3 : tools.error >= 3 ? 2 : tools.error >= 1 ? 1 : 0;
const stepBurn =
  tools.total > 40 ? 2 : tools.total > 28 ? 1 : 0;
const efficiencyScore = Math.max(0, 10 - efficiencyPenalty - stepBurn);

const reasoningScore =
  (meta.reasoningChars ?? 0) > 2000
    ? 8
    : (meta.reasoningChars ?? 0) > 500
      ? 6
      : (meta.reasoningChars ?? 0) > 0
        ? 4
        : 2;

const overall = Number(
  (
    (toolScore + deliverScore + verifyScore + efficiencyScore + reasoningScore) /
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
    tools,
    reasoningChars: meta.reasoningChars,
    textChars: meta.textChars,
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
  ],
};

const md = [
  `# Bench score: ${overall}/10`,
  ``,
  `- cwd: \`${cwd}\``,
  `- duration_ms: ${meta.ms ?? "?"}`,
  `- tools: ${tools.completed}/${tools.total} ok (err ${tools.error})`,
  `- reasoning chars: ${meta.reasoningChars ?? 0}`,
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
