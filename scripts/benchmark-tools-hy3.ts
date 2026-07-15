/**
 * Headless live tool-coverage benchmark — tencent/hy3:free via OpenRouter.
 *
 * One simple task per built-in tool so every toolcall path is exercised:
 *   list_dir · read_file · write · search_replace · grep · glob
 *   run_terminal_command · web_fetch
 *
 *   npx tsx scripts/benchmark-tools-hy3.ts
 *   npm run bench:tools:hy3
 *   LIBRA_DEBUG=1 npx tsx scripts/benchmark-tools-hy3.ts --only=list_dir,grep
 *
 * Requires OPENROUTER_API_KEY or a key saved via /login openrouter.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { saveApiKey, resolveToken } from "../src/auth/api-key.js";
import { saveConfig } from "../src/config/store.js";
import { HarnessStore } from "../src/core/store.js";
import type { Part, ToolPart } from "../src/core/types.js";
import { AgentLoop } from "../src/agent/loop.js";
import { initDebug, getDebugLogPath, dbg } from "../src/agent/debug.js";
import { toolNamesFromSchema } from "../src/toolcalling/schema.js";

const MODEL = "tencent/hy3:free";
const PROVIDER = "openrouter" as const;
const KEY =
  process.env.OPENROUTER_API_KEY || resolveToken("openrouter") || "";

interface TaskDef {
  id: string;
  /** Tool name that must complete successfully */
  tool: string;
  /** Optional extra tools allowed / expected */
  alsoOk?: string[];
  prompt: string;
  /** Workspace checks after the turn */
  verify?: (cwd: string, tools: ToolPart[], text: string) => string | null;
}

interface TaskResult {
  id: string;
  tool: string;
  ok: boolean;
  ms: number;
  toolsSeen: string[];
  toolsCompleted: string[];
  textPreview: string;
  error?: string;
  phase: string;
}

function argList(name: string): string[] | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit
    .split("=")
    .slice(1)
    .join("=")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function makeWorkspace(): string {
  const dir = join(
    tmpdir(),
    `libra-tools-hy3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "hello.txt"), "hello-from-fixture\nline-two\n", "utf8");
  writeFileSync(
    join(dir, "src", "util.ts"),
    "export function add(a: number, b: number) {\n  return a + b;\n}\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "replace_me.txt"),
    "alpha beta alpha\n",
    "utf8",
  );
  writeFileSync(join(dir, "notes.md"), "# Notes\nfindme-token-xyz\n", "utf8");
  return dir;
}

const TASKS: TaskDef[] = [
  {
    id: "list_dir",
    tool: "list_dir",
    prompt:
      "Use the list_dir tool on the workspace root (target_directory \".\"). " +
      "Then briefly list the top-level names you saw. Do not call other tools.",
    verify: (_cwd, tools) =>
      tools.some((t) => t.toolName === "list_dir" && t.status === "completed")
        ? null
        : "list_dir did not complete",
  },
  {
    id: "read_file",
    tool: "read_file",
    prompt:
      "Use read_file on hello.txt. Quote the first line of the file in your answer. " +
      "Do not edit anything.",
    verify: (_cwd, tools, text) => {
      if (!tools.some((t) => t.toolName === "read_file" && t.status === "completed")) {
        return "read_file did not complete";
      }
      if (!/hello-from-fixture/i.test(text) && !tools.some((t) =>
        t.toolName === "read_file" &&
        t.status === "completed" &&
        String(t.result ?? "").includes("hello-from-fixture"),
      )) {
        return "hello-from-fixture not observed";
      }
      return null;
    },
  },
  {
    id: "write",
    tool: "write",
    prompt:
      "Use the write tool to create a file named out/created.txt with exact content: " +
      "CREATED_BY_BENCH\n" +
      "Then stop. No other tools needed after write.",
    verify: (cwd, tools) => {
      if (!tools.some((t) => t.toolName === "write" && t.status === "completed")) {
        return "write did not complete";
      }
      const p = join(cwd, "out", "created.txt");
      if (!existsSync(p)) return "out/created.txt missing";
      const body = readFileSync(p, "utf8");
      if (!body.includes("CREATED_BY_BENCH")) return "content mismatch";
      return null;
    },
  },
  {
    id: "search_replace",
    tool: "search_replace",
    prompt:
      "In replace_me.txt, use search_replace to change the first occurrence of " +
      "\"alpha\" to \"ALPHA\". Do not replace all unless needed. Then stop.",
    verify: (cwd, tools) => {
      if (
        !tools.some(
          (t) => t.toolName === "search_replace" && t.status === "completed",
        )
      ) {
        return "search_replace did not complete";
      }
      const body = readFileSync(join(cwd, "replace_me.txt"), "utf8");
      if (!body.includes("ALPHA")) return "ALPHA not found after replace";
      return null;
    },
  },
  {
    id: "grep",
    tool: "grep",
    prompt:
      "Use the grep tool to search the workspace for the pattern findme-token-xyz. " +
      "Report the matching file path. Do not edit files.",
    verify: (_cwd, tools) =>
      tools.some((t) => t.toolName === "grep" && t.status === "completed")
        ? null
        : "grep did not complete",
  },
  {
    id: "glob",
    tool: "glob",
    prompt:
      "Use the glob tool with pattern **/*.ts to find TypeScript files. " +
      "Report the paths you found. Do not edit files.",
    verify: (_cwd, tools) =>
      tools.some((t) => t.toolName === "glob" && t.status === "completed")
        ? null
        : "glob did not complete",
  },
  {
    id: "run_terminal_command",
    tool: "run_terminal_command",
    prompt:
      process.platform === "win32"
        ? "Use run_terminal_command once with command: echo BENCH_SHELL_OK\n" +
          "Then quote the command output in your answer. No other tools."
        : "Use run_terminal_command once with command: echo BENCH_SHELL_OK\n" +
          "Then quote the command output in your answer. No other tools.",
    verify: (_cwd, tools) => {
      const t = tools.find(
        (x) =>
          x.toolName === "run_terminal_command" && x.status === "completed",
      );
      if (!t) return "run_terminal_command did not complete";
      const out = String(t.result ?? "");
      if (!/BENCH_SHELL_OK/i.test(out)) {
        return `shell output missing BENCH_SHELL_OK: ${out.slice(0, 120)}`;
      }
      return null;
    },
  },
  {
    id: "web_fetch",
    tool: "web_fetch",
    prompt:
      "Use web_fetch on https://example.com and tell me the HTTP status or " +
      "whether the page title mentions Example. One tool call is enough.",
    verify: (_cwd, tools) =>
      tools.some((t) => t.toolName === "web_fetch" && t.status === "completed")
        ? null
        : "web_fetch did not complete",
  },
];

async function runTask(task: TaskDef, cwd: string): Promise<TaskResult> {
  const store = new HarnessStore({
    provider: PROVIDER,
    model: MODEL,
    title: `tools-hy3:${task.id}`,
  });
  // Drain events so we do not leak listeners
  store.subscribe(() => {
    /* headless */
  });

  const agent = new AgentLoop(store);
  const t0 = Date.now();
  let err: string | undefined;

  try {
    await agent.handle(task.prompt, {
      provider: PROVIDER,
      model: MODEL,
      cwd,
      tools: true,
      lightReasoning: true,
      label: `tools.${task.id}`,
    });
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }

  const ms = Date.now() - t0;
  const assistant = [...store.state.messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const parts: Part[] = assistant?.parts ?? [];
  const toolParts = parts.filter((p): p is ToolPart => p.type === "tool");
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.content : ""))
    .join("\n");

  const toolsSeen = toolParts.map((t) => t.toolName);
  const toolsCompleted = toolParts
    .filter((t) => t.status === "completed")
    .map((t) => t.toolName);

  let verifyErr: string | null = null;
  if (!err && task.verify) {
    try {
      verifyErr = task.verify(cwd, toolParts, text);
    } catch (e) {
      verifyErr = e instanceof Error ? e.message : String(e);
    }
  }

  const targetOk = toolParts.some(
    (t) => t.toolName === task.tool && t.status === "completed",
  );
  const ok =
    !err &&
    !verifyErr &&
    store.state.phase !== "error" &&
    targetOk;

  return {
    id: task.id,
    tool: task.tool,
    ok,
    ms,
    toolsSeen,
    toolsCompleted,
    textPreview: text.replace(/\s+/g, " ").trim().slice(0, 160),
    error:
      err ||
      verifyErr ||
      (store.state.phase === "error" ? store.state.activityLabel : undefined) ||
      (!targetOk ? `expected completed ${task.tool}` : undefined),
    phase: store.state.phase,
  };
}

async function main(): Promise<void> {
  initDebug(process.env.LIBRA_DEBUG ? undefined : "info");

  if (!KEY) {
    console.error(
      "No OpenRouter key. Set OPENROUTER_API_KEY or run /login openrouter",
    );
    process.exit(1);
  }
  saveApiKey("openrouter", KEY, { label: "tools-hy3-bench" });
  saveConfig({
    provider: PROVIDER,
    model: MODEL,
    modelKey: `${PROVIDER}/${MODEL}`,
  });

  const only = argList("only");
  const tasks = only
    ? TASKS.filter((t) => only.includes(t.id) || only.includes(t.tool))
    : TASKS;

  if (tasks.length === 0) {
    console.error(
      `No tasks matched. Available: ${TASKS.map((t) => t.id).join(", ")}`,
    );
    process.exit(2);
  }

  const schemaTools = new Set(toolNamesFromSchema());
  const covered = new Set(tasks.map((t) => t.tool));
  const missingSchema = [...schemaTools].filter((t) => !covered.has(t));

  console.log("═══ Libra tool coverage · hy3:free (headless) ═══\n");
  console.log(`model:    ${PROVIDER}/${MODEL}`);
  console.log(`tasks:    ${tasks.map((t) => t.id).join(", ")}`);
  console.log(`schema:   ${[...schemaTools].join(", ")}`);
  if (missingSchema.length) {
    console.log(`note:     schema tools not in this run: ${missingSchema.join(", ")}`);
  }
  if (getDebugLogPath()) console.log(`debug:    ${getDebugLogPath()}`);
  console.log("");

  const cwd = makeWorkspace();
  console.log(`workspace: ${cwd}\n`);

  const results: TaskResult[] = [];
  for (const task of tasks) {
    process.stdout.write(`→ ${task.id.padEnd(22)} `);
    dbg("tools-bench", "task.start", { id: task.id, tool: task.tool });
    const r = await runTask(task, cwd);
    results.push(r);
    dbg("tools-bench", "task.end", {
      id: r.id,
      ok: r.ok,
      ms: r.ms,
      tools: r.toolsCompleted,
      error: r.error,
    });
    if (r.ok) {
      console.log(
        `PASS  ${String(r.ms).padStart(5)}ms  tools=[${r.toolsCompleted.join(",")}]`,
      );
    } else {
      console.log(
        `FAIL  ${String(r.ms).padStart(5)}ms  ${r.error ?? "unknown"}  seen=[${r.toolsSeen.join(",")}]`,
      );
    }
    if (r.textPreview) {
      console.log(`       text: ${r.textPreview}`);
    }
  }

  // cleanup
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* */
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const toolsHit = new Set(results.flatMap((r) => r.toolsCompleted));

  console.log("\n════════ SUMMARY ════════");
  console.log(`passed=${passed} failed=${failed} totalMs=${results.reduce((a, b) => a + b.ms, 0)}`);
  console.log(
    `tools completed at least once: ${[...toolsHit].sort().join(", ") || "(none)"}`,
  );
  const missing = tasks
    .map((t) => t.tool)
    .filter((t) => !toolsHit.has(t));
  if (missing.length) {
    console.log(`tools never completed: ${missing.join(", ")}`);
  }

  // Persist report
  try {
    const dir = join(homedir(), ".libra", "debug");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "bench-tools-hy3-latest.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          model: `${PROVIDER}/${MODEL}`,
          startedAt: new Date().toISOString(),
          results,
          passed,
          failed,
          toolsHit: [...toolsHit],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(`\nReport → ${path}`);
  } catch {
    /* */
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
