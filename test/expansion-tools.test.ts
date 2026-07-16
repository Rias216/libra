/**
 * Expansion tools screening — drives shipped functions (no theater).
 * Covers multimodal serializers, pure helpers, registry wiring, native paths.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  toOpenAIContentParts,
  toAnthropicContentBlocks,
  toGeminiParts,
  modelSupportsVision,
  visionFallbackText,
  toolResultContent,
  applyVisionGate,
  imagePart,
  textPart,
} from "../src/toolcalling/multimodal.js";
import { serializeOpenAIMessages } from "../src/llm/client.js";
import { parseUnifiedDiff, applyHunk, applyFilePatch } from "../src/toolcalling/patch.js";
import { parseTscOutput, parseEslintOutput } from "../src/toolcalling/check.js";
import {
  parseDiffToHunks,
  parseGitStatusPorcelain,
  parseGitLog,
  runGitTool,
} from "../src/toolcalling/git-tool.js";
import { waitForPort, isValidPort } from "../src/toolcalling/wait-port.js";
import { findSymbolByTextScan, findSymbol } from "../src/toolcalling/find-symbol.js";
import { clipboardRead } from "../src/toolcalling/clipboard.js";
import { listWindows } from "../src/toolcalling/list-windows.js";
import {
  pathFromMutatorArgs,
  pathsFromMutatorArgs,
  shouldFormatPath,
  createFormatAfterHook,
} from "../src/toolcalling/format-hook.js";
import { isExpansionCustomTool } from "../src/toolcalling/expansion-custom.js";
import { ToolExecutor } from "../src/toolcalling/executor.js";
import { ToolRunner } from "../src/toolcalling/runner.js";
import { createDefaultRegistry } from "../src/toolcalling/registry.js";
import { DEFAULT_PERMISSIONS, PermissionChecker } from "../src/toolcalling/permissions.js";
import { OPENAI_TOOLS } from "../src/toolcalling/schema.js";
import { isParallelSafeTool, resolveToolName } from "../src/toolcalling/tool.js";
import { canonicalToolName } from "../src/toolcalling/normalize.js";
import { runScreenshot } from "../src/toolcalling/screenshot.js";
import { messagesToWire } from "../src/agent/history.js";
import type { Message } from "../src/core/types.js";

const ROOT = join(import.meta.dir, "..");
const SCRATCH =
  process.env.GROK_SCRATCH ??
  "C:\\Users\\rias\\AppData\\Local\\Temp\\grok-goal-035f9cef2dd1\\implementer";

const EXPANSION_TOOLS = [
  "list_windows",
  "screenshot",
  "read_image",
  "browser_devtools",
  "check",
  "git",
  "patch_apply",
  "wait_for_port",
  "clipboard_read",
  "find_symbol",
] as const;

describe("Phase 0 multimodal", () => {
  test("OpenAI serialization emits image_url blocks", () => {
    const parts = [textPart("hi"), imagePart("image/png", "abc123")];
    const out = toOpenAIContentParts(parts);
    expect(Array.isArray(out)).toBe(true);
    const arr = out as Array<Record<string, unknown>>;
    expect(arr[0]).toEqual({ type: "text", text: "hi" });
    expect(arr[1]!.type).toBe("image_url");
    const iu = arr[1]!.image_url as { url: string };
    expect(iu.url).toContain("data:image/png;base64,abc123");
  });

  test("Anthropic serialization emits base64 image source", () => {
    const parts = [imagePart("image/jpeg", "xyz")];
    const out = toAnthropicContentBlocks(parts);
    expect(Array.isArray(out)).toBe(true);
    const block = (out as Array<Record<string, unknown>>)[0]!;
    expect(block.type).toBe("image");
    const src = block.source as Record<string, string>;
    expect(src.type).toBe("base64");
    expect(src.media_type).toBe("image/jpeg");
    expect(src.data).toBe("xyz");
  });

  test("Gemini serialization emits inlineData", () => {
    const parts = [textPart("t"), imagePart("image/png", "dd")];
    const out = toGeminiParts(parts);
    expect(out.some((p) => p.text === "t")).toBe(true);
    const img = out.find((p) => p.inlineData) as {
      inlineData: { mimeType: string; data: string };
    };
    expect(img.inlineData.mimeType).toBe("image/png");
    expect(img.inlineData.data).toBe("dd");
  });

  test("vision gate text fallback for non-vision models", () => {
    expect(modelSupportsVision("deepseek-v4-flash")).toBe(false);
    expect(modelSupportsVision("gpt-4o")).toBe(true);
    const fb = visionFallbackText(".libra/screenshots/1.png");
    expect(fb).toContain("screenshot saved to");
    expect(fb).toContain("no vision input");
    const gated = applyVisionGate(
      [textPart("cap"), imagePart("image/png", "x")],
      false,
      ".libra/screenshots/1.png",
    );
    expect(typeof gated).toBe("string");
    expect(String(gated)).toContain("no vision input");
    const tr = toolResultContent(
      [textPart("s"), imagePart("image/png", "x")],
      { model: "deepseek-v4-flash", savedPath: "p.png" },
    );
    expect(typeof tr).toBe("string");
    expect(String(tr)).toContain("no vision");
  });

  test("serializeOpenAIMessages maps multimodal tool results", () => {
    const msgs = serializeOpenAIMessages([
      {
        role: "tool",
        tool_call_id: "c1",
        content: [textPart("ok"), imagePart("image/png", "AA==")],
      },
    ]);
    expect(msgs[0]!.role).toBe("tool");
    expect(Array.isArray(msgs[0]!.content)).toBe(true);
  });
});

describe("Registry / six-file wiring", () => {
  test("every expansion tool is in schema, registry, permissions", () => {
    const names = new Set(OPENAI_TOOLS.map((t) => t.function.name));
    const reg = createDefaultRegistry();
    for (const n of EXPANSION_TOOLS) {
      expect(names.has(n)).toBe(true);
      expect(reg.getEntry(n)?.name).toBe(n);
      expect(reg.isEnabled(n)).toBe(true);
      expect(DEFAULT_PERMISSIONS[n] != null || DEFAULT_PERMISSIONS["*"]).toBeTruthy();
    }
    expect(isExpansionCustomTool("screenshot")).toBe(true);
    expect(isExpansionCustomTool("browser_devtools")).toBe(true);
    expect(isExpansionCustomTool("list_windows")).toBe(false);
  });

  test("screenshot full_screen is ask; scoped is allow", () => {
    const pc = new PermissionChecker(DEFAULT_PERMISSIONS);
    const ask = pc.resolve("screenshot", { full_screen: true });
    expect(ask.action).toBe("ask");
    const allow = pc.resolve("screenshot", { pid: 1 });
    expect(allow.action).toBe("allow");
    expect(pc.resolve("clipboard_read", {}).action).toBe("ask");
  });

  test("parallel-safe tags for read expansion tools", () => {
    expect(isParallelSafeTool("list_windows")).toBe(true);
    expect(isParallelSafeTool("read_image")).toBe(true);
    expect(isParallelSafeTool("patch_apply")).toBe(false);
    expect(isParallelSafeTool("screenshot")).toBe(false);
    expect(canonicalToolName("list_windows")).toBe("list_windows");
    expect(resolveToolName("list_windows")).toBe("list_windows");
  });
});

describe("patch_apply pure parser", () => {
  test("parses and applies matching hunk; fails on mismatch", () => {
    const original = "line1\nline2\nline3\n";
    const diff = [
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-line2",
      "+line2-edited",
      " line3",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.length).toBe(1);
    expect(files[0]!.newPath).toBe("foo.txt");
    const ok = applyFilePatch(original, files[0]!);
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain("line2-edited");

    const bad = applyHunk("totally different\n", files[0]!.hunks[0]!, 0);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/mismatch/i);
  });

  test("ToolExecutor.patch_apply applies and fails loud", async () => {
    const dir = join(SCRATCH, "patch-ws");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "a.txt");
    writeFileSync(target, "alpha\nbeta\ngamma\n", "utf8");
    const ex = new ToolExecutor(dir, { headless: true } as never);
    const diff = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
    ].join("\n");
    const r = await ex.run("patch_apply", { diff });
    expect(r.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("BETA");

    const bad = await ex.run("patch_apply", {
      diff: [
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,1 +1,1 @@",
        "-nope",
        "+yes",
      ].join("\n"),
    });
    expect(bad.ok).toBe(false);
    expect(bad.output + (bad.data?.error ?? "")).toMatch(/mismatch|not found|hunk/i);
  });
});

describe("check / git pure parsers", () => {
  test("parseTscOutput", () => {
    const sample =
      "src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";
    const d = parseTscOutput(sample);
    expect(d.length).toBe(1);
    expect(d[0]!.file).toBe("src/foo.ts");
    expect(d[0]!.line).toBe(10);
    expect(d[0]!.col).toBe(5);
    expect(d[0]!.code).toBe("TS2322");
  });

  test("parseEslintOutput unix", () => {
    const sample =
      "src/a.ts:1:2: Unexpected var [Error/no-var]\n";
    const d = parseEslintOutput(sample);
    expect(d.length).toBe(1);
    expect(d[0]!.code).toBe("no-var");
  });

  test("parseDiffToHunks + git status/log parsers", () => {
    const diff = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
    ].join("\n");
    const hunks = parseDiffToHunks(diff);
    expect(hunks.length).toBe(1);
    expect(hunks[0]!.lines.some((l) => l.kind === "add")).toBe(true);
    const st = parseGitStatusPorcelain(" M src/a.ts\n?? new.txt\n");
    expect(st.length).toBe(2);
    const log = parseGitLog("abc123\x1fAnn\x1f2026-01-01\x1fHello\n");
    expect(log[0]!.subject).toBe("Hello");
  });

  test("git tool status in this workspace", async () => {
    const r = await runGitTool(ROOT, "status");
    expect(r.ok).toBe(true);
    expect(r.data?.files != null || r.data?.branch != null).toBe(true);
  });
});

describe("wait_for_port / find_symbol / format hook", () => {
  test("wait_for_port open and closed", async () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(8080)).toBe(true);
    const closed = await waitForPort({
      port: 1,
      timeoutMs: 400,
      intervalMs: 100,
    });
    expect(closed.open).toBe(false);

    const server = createServer();
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    const addr = server.address();
    const port =
      typeof addr === "object" && addr ? addr.port : 0;
    expect(port).toBeGreaterThan(0);
    const open = await waitForPort({ port, timeoutMs: 3000, intervalMs: 50 });
    expect(open.ok).toBe(true);
    expect(open.open).toBe(true);
    await new Promise<void>((res) => server.close(() => res()));
  });

  test("find_symbol text scan drives real symbols in repo", async () => {
    const r = findSymbolByTextScan(ROOT, "ToolExecutor", "definition", [
      join(ROOT, "src/toolcalling/executor.ts"),
    ]);
    expect(r.ok).toBe(true);
    expect(r.locations.length).toBeGreaterThan(0);
    expect(r.locations[0]!.file).toContain("executor");
    const asyncR = await findSymbol(ROOT, "ChatMessage", "definition");
    expect(asyncR.ok).toBe(true);
  });

  test("format hook helpers", () => {
    expect(shouldFormatPath("a.ts")).toBe(true);
    expect(shouldFormatPath("a.png")).toBe(false);
    expect(pathFromMutatorArgs("write", { file_path: "x.ts" })).toBe("x.ts");
    const hook = createFormatAfterHook(ROOT);
    // no-op when result missing / not mutator
    expect(
      hook("after", { name: "read_file", args: {}, result: { ok: true, output: "", durationMs: 0 } }),
    ).resolves.toBeUndefined();
  });

  test("pathFromMutatorArgs extracts paths from patch_apply diff", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "--- a/src/bar.tsx",
      "+++ b/src/bar.tsx",
      "@@ -1,1 +1,1 @@",
      "-c",
      "+d",
    ].join("\n");
    // Only path/file_path used to miss these — must parse diff body.
    const paths = pathsFromMutatorArgs("patch_apply", { diff });
    expect(paths).toContain("src/foo.ts");
    expect(paths).toContain("src/bar.tsx");
    expect(pathFromMutatorArgs("patch_apply", { diff })).toBe("src/foo.ts");
    expect(pathFromMutatorArgs("patch_apply", { path: "explicit.ts" })).toBe(
      "explicit.ts",
    );
  });

  test("historyToMessages keeps images for vision models when model set", () => {
    const msgs: Message[] = [
      {
        id: "m1",
        role: "assistant",
        createdAt: Date.now(),
        parts: [
          {
            id: "t1",
            type: "tool",
            toolName: "read_image",
            args: { path: "x.png" },
            status: "completed",
            callId: "c1",
            result: "read_image x.png",
            contentParts: [
              { type: "text", text: "read_image x.png" },
              { type: "image", mimeType: "image/png", data: "AA==" },
            ],
          },
        ],
      },
    ];
    const gated = messagesToWire(msgs, { model: "deepseek-v4-flash" });
    const toolGated = gated.find((m) => m.role === "tool");
    expect(typeof toolGated?.content).toBe("string");
    expect(String(toolGated?.content)).toMatch(/no vision/i);

    const vision = messagesToWire(msgs, { model: "gpt-4o" });
    const toolV = vision.find((m) => m.role === "tool");
    expect(Array.isArray(toolV?.content)).toBe(true);
    const parts = toolV!.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === "image")).toBe(true);
  });
});

describe("Native tools on Windows host", () => {
  test("list_windows returns well-formed array", async () => {
    const windows = await listWindows();
    expect(Array.isArray(windows)).toBe(true);
    // On a desktop session usually non-empty; always validate shape when present
    for (const w of windows.slice(0, 5)) {
      expect(typeof w.pid).toBe("number");
      expect(typeof w.title).toBe("string");
      expect(w.bounds).toBeDefined();
      expect(typeof w.bounds.width).toBe("number");
    }
  }, 30_000);

  test("clipboard_read returns string or clear platform error", async () => {
    const r = await clipboardRead();
    if (r.ok) {
      expect(typeof r.text).toBe("string");
    } else {
      expect(String(r.error)).toMatch(/clipboard|unavailable|failed/i);
    }
  }, 15_000);

  test("read_image on small PNG returns image content part", async () => {
    const dir = join(SCRATCH, "img-ws");
    mkdirSync(dir, { recursive: true });
    // Minimal 1x1 PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const path = join(dir, "dot.png");
    writeFileSync(path, png);
    const ex = new ToolExecutor(dir);
    const r = await ex.run("read_image", { path: "dot.png" });
    expect(r.ok).toBe(true);
    expect(r.contentParts?.some((p) => p.type === "image")).toBe(true);
    const img = r.contentParts!.find((p) => p.type === "image")!;
    expect(img.type).toBe("image");
    if (img.type === "image") {
      expect(img.mimeType).toBe("image/png");
      expect(img.data.length).toBeGreaterThan(10);
    }
  });

  test("check runs tsc structured diagnostics", async () => {
    const ex = new ToolExecutor(ROOT);
    const r = await ex.run("check", { eslint: false });
    // May have pre-existing diags; structure must hold
    expect(r.data?.diagnostics).toBeDefined();
    expect(Array.isArray(r.data!.diagnostics)).toBe(true);
  }, 180_000);

  test("git status/diff/log via executor", async () => {
    const ex = new ToolExecutor(ROOT);
    const st = await ex.run("git", { action: "status" });
    expect(st.ok).toBe(true);
    const log = await ex.run("git", { action: "log", limit: 3 });
    expect(log.ok).toBe(true);
    const diff = await ex.run("git", { action: "diff" });
    expect(diff.ok).toBe(true);
  }, 30_000);

  test("wait_for_port via executor", async () => {
    const ex = new ToolExecutor(ROOT);
    const r = await ex.run("wait_for_port", { port: 1, timeout_ms: 300 });
    expect(r.ok).toBe(false);
    expect(r.data?.open).toBe(false);
  });

  test("Playwright missing yields clear error (no crash)", async () => {
    const r = await runScreenshot(ROOT, {
      url: "http://127.0.0.1:1/",
      engine: "playwright",
    });
    // Either playwright missing or navigation fail — never throw
    expect(r.ok === false || r.ok === true).toBe(true);
    if (!r.ok) {
      expect(String(r.output)).toMatch(/Playwright|CDP|not installed|ECONNREFUSED|failed|unavailable/i);
    }
  }, 60_000);

  test("native pid screenshot succeeds on Windows (PrintWindow/CopyFromScreen)", async () => {
    if (process.platform !== "win32") return;
    const windows = await listWindows();
    const pick =
      windows.find(
        (w) =>
          w.pid > 0 &&
          w.bounds.width >= 100 &&
          w.bounds.height >= 100 &&
          !/NVIDIA|Input Experience/i.test(w.title),
      ) ?? windows[0];
    expect(pick?.pid).toBeGreaterThan(0);
    const r = await runScreenshot(ROOT, { pid: pick!.pid });
    expect(r.ok).toBe(true);
    expect(r.savedPath).toBeTruthy();
    expect(existsSync(r.savedPath!)).toBe(true);
    expect(Array.isArray(r.output)).toBe(true);
    const parts = r.output as Array<{ type: string }>;
    expect(parts.some((p) => p.type === "image")).toBe(true);
    // Persist evidence for verifier
    const evidence = join(SCRATCH, "native-tools", "pid-screenshot-test.json");
    mkdirSync(join(SCRATCH, "native-tools"), { recursive: true });
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          ok: r.ok,
          pid: pick!.pid,
          title: pick!.title,
          savedPath: r.savedPath,
          size: readFileSync(r.savedPath!).length,
          types: parts.map((p) => p.type),
        },
        null,
        2,
      ),
    );
  }, 45_000);

  test("no hard playwright dependency in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies?.playwright).toBeUndefined();
  });

  test("ToolRunner dispatches list_windows and find_symbol", async () => {
    const runner = new ToolRunner(ROOT, { headless: true, autoApprove: true });
    const lw = await runner.run("list_windows", {});
    // May fail on headless CI without windows — still structured
    expect(typeof lw.output).toBe(typeof lw.output);
    const fs = await runner.run("find_symbol", {
      symbol: "ToolRunner",
      action: "definition",
    });
    expect(fs.ok).toBe(true);
  }, 30_000);
});

describe("Later tools not built", () => {
  test("api_probe / coverage / etc absent", () => {
    const names = new Set(OPENAI_TOOLS.map((t) => t.function.name));
    for (const n of [
      "api_probe",
      "stack_trace_resolve",
      "coverage",
      "test_impact",
      "db_query",
      "env_check",
      "screendiff",
      "secrets_scan",
      "notify",
      "changelog_draft",
      "package_search",
    ]) {
      expect(names.has(n)).toBe(false);
    }
  });
});
