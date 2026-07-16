/**
 * Grok-port easy wins — drive real shipped modules (tools, subagent, fusion).
 * Run: bun test/grok-port.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ChatRequest, ChatResult } from "../src/llm/client.js";
import {
  formatFusionReasoningDisplay,
  prepareFusionForMain,
} from "../src/agent/fusion.js";
import { HarnessStore } from "../src/core/store.js";
import { ToolExecutor } from "../src/toolcalling/executor.js";
import { stripLineNumberPrefixes } from "../src/toolcalling/normalize.js";
import { OPENAI_TOOLS } from "../src/toolcalling/schema.js";
import { slimToolSchemas } from "../src/toolcalling/slim-schema.js";
import { SubagentRuntime } from "../src/agent/subagent/runtime.js";
import {
  applyCapabilityMode,
  listSpawnableRoles,
  resolveRole,
} from "../src/agent/subagent/roles.js";
import {
  buildMultiAgentSystemAddon,
  buildMultiAgentTools,
} from "../src/agent/subagent/tools.js";
import {
  formatCompletionNotices,
  formatResumeFooter,
} from "../src/agent/subagent/types.js";
import { PermissionChecker } from "../src/toolcalling/permissions.js";

type TestFn = () => void | Promise<void>;
const tests: { name: string; fn: TestFn }[] = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

let passed = 0;
let failed = 0;

function okResult(
  partial: Partial<ChatResult> & { content?: string },
): ChatResult {
  return {
    content: partial.content ?? "",
    reasoning: partial.reasoning,
    tool_calls: partial.tool_calls ?? [],
    finish_reason: partial.finish_reason ?? "stop",
    usage: partial.usage ?? { prompt_tokens: 10, completion_tokens: 5 },
  };
}

// ─── Wave 1 ─────────────────────────────────────────────────────────

test("read_file interactive uses N→ lines; json unnumbered; negative offset", async () => {
  const dir = join(tmpdir(), `libra-read-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sample.ts"),
    ["line-one", "line-two", "line-three", "line-four", "line-five"].join("\n"),
    "utf8",
  );

  const textEx = new ToolExecutor(dir, { resultStyle: "text" });
  const full = await textEx.run("read_file", { target_file: "sample.ts" });
  assert.equal(full.ok, true);
  assert.match(full.output, /^1→line-one/m);
  assert.match(full.output, /^2→line-two/m);
  assert.ok(!/^\s*\d+\|/.test(full.output), "must not use padded | format");

  const tail = await textEx.run("read_file", {
    target_file: "sample.ts",
    offset: -2,
    limit: 2,
  });
  assert.equal(tail.ok, true);
  assert.match(tail.output, /line-four/);
  assert.match(tail.output, /line-five/);
  assert.ok(!tail.output.includes("line-one"));

  const jsonEx = new ToolExecutor(dir, { resultStyle: "json" });
  const json = await jsonEx.run("read_file", { target_file: "sample.ts" });
  assert.equal(json.ok, true);
  const parsed = JSON.parse(json.output) as { content: string };
  assert.equal(parsed.content.includes("line-one"), true);
  assert.ok(
    !parsed.content.includes("→"),
    "json style full read stays unnumbered",
  );

  rmSync(dir, { recursive: true, force: true });
});

test("search_replace strips pasted N→ prefixes; re-read hint on miss/ambiguous", async () => {
  assert.equal(
    stripLineNumberPrefixes("12→  foo\n13→  bar"),
    "  foo\n  bar",
  );
  assert.equal(stripLineNumberPrefixes("  plain"), "  plain");

  const dir = join(tmpdir(), `libra-edit-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.ts"), "  foo\n  bar\n  foo\n", "utf8");

  const ex = new ToolExecutor(dir, { resultStyle: "text" });
  // Pasted numbered lines: strip makes unique "  foo\n  bar" match once
  const ok = await ex.run("search_replace", {
    file_path: "a.ts",
    old_string: "12→  foo\n13→  bar",
    new_string: "99→  baz\n100→  bar",
    replace_all: false,
  });
  assert.equal(ok.ok, true, ok.output);
  const after = readFileSync(join(dir, "a.ts"), "utf8");
  assert.equal(after.startsWith("  baz\n  bar\n"), true);
  assert.ok(after.includes("  foo\n"), "trailing foo remains");

  const miss = await ex.run("search_replace", {
    file_path: "a.ts",
    old_string: "NO_SUCH_STRING_XYZ",
    new_string: "x",
  });
  assert.equal(miss.ok, false);
  assert.match(miss.output, /re-read with read_file/i);

  writeFileSync(join(dir, "a.ts"), "  foo\n  bar\n  foo\n", "utf8");
  const amb2 = await ex.run("search_replace", {
    file_path: "a.ts",
    old_string: "  foo",
    new_string: "  qux",
    replace_all: false,
  });
  assert.equal(amb2.ok, false);
  assert.match(amb2.output, /matched \d+ times/i);
  assert.match(amb2.output, /re-read with read_file/i);

  rmSync(dir, { recursive: true, force: true });
});

test("schema describes Windows shell + line-number edit guidance", () => {
  const read = OPENAI_TOOLS.find((t) => t.function.name === "read_file");
  const edit = OPENAI_TOOLS.find((t) => t.function.name === "search_replace");
  const shell = OPENAI_TOOLS.find(
    (t) => t.function.name === "run_terminal_command",
  );
  assert.ok(read && edit && shell);
  assert.match(read!.function.description, /LINE_NUMBER→LINE_CONTENT/);
  assert.match(read!.function.description, /negative/i);
  assert.match(edit!.function.description, /LINE_NUMBER→/);
  assert.match(edit!.function.description, /re-read/i);
  assert.match(shell!.function.description, /Windows/i);
  assert.match(shell!.function.description, /sleep/i);

  const slim = slimToolSchemas();
  const slimShell = slim.find((t) => t.function.name === "run_terminal_command");
  assert.match(slimShell!.function.description, /Windows|unix|sleep/i);
});

// ─── Wave 2 ─────────────────────────────────────────────────────────

test("spawn_agent applies reasoning_effort and capability_mode", async () => {
  const worker = resolveRole("worker", []);
  const ro = applyCapabilityMode(worker, "read-only");
  const checker = new PermissionChecker(ro.permissions, undefined, true);
  assert.equal(
    checker.resolve("write", { file_path: "x", content: "y" }).action,
    "deny",
  );
  assert.equal(
    checker.resolve("run_terminal_command", { command: "echo hi" }).action,
    "deny",
  );

  const rw = applyCapabilityMode(worker, "read-write");
  const rwCheck = new PermissionChecker(rw.permissions, undefined, true);
  assert.equal(
    rwCheck.resolve("write", { file_path: "x", content: "y" }).action,
    "allow",
  );
  assert.equal(
    rwCheck.resolve("run_terminal_command", { command: "echo hi" }).action,
    "deny",
  );

  const seenEfforts: string[] = [];
  const chatImpl = async (req: ChatRequest): Promise<ChatResult> => {
    if (req.reasoning_effort) seenEfforts.push(String(req.reasoning_effort));
    return okResult({
      content: "child done high effort",
      finish_reason: "stop",
    });
  };

  const rt = new SubagentRuntime({
    parentProvider: "openai",
    parentModel: "gpt-test",
    cwd: process.cwd(),
    depth: 0,
    config: {
      enabled: true,
      maxConcurrent: 4,
      maxDepth: 1,
      jobMaxRuntimeSeconds: 30,
      autoSpawn: false,
      roles: [],
    },
    chatImpl,
  });
  rt.beginTurn("turn_effort");

  const spawn = await rt.spawn({
    agent_type: "worker",
    message: "implement tiny fix",
    reasoning_effort: "high",
    capability_mode: "read-only",
    description: "test worker",
  });
  assert.equal(spawn.ok, true, JSON.stringify(spawn));
  assert.equal(spawn.reasoning_effort, "high");
  assert.equal(spawn.capability_mode, "read-only");

  const wait = await rt.wait({
    agent_ids: [String(spawn.agent_id)],
    timeout_ms: 15_000,
  });
  assert.equal(wait.ok, true, JSON.stringify(wait));
  assert.ok(
    seenEfforts.includes("high"),
    `expected high in child requests, got ${JSON.stringify(seenEfforts)}`,
  );

  const thread = rt.getThread(String(spawn.agent_id));
  assert.equal(thread?.reasoningEffort, "high");
  assert.equal(thread?.capabilityMode, "read-only");
  assert.match(String(thread?.result ?? ""), /resume_from=/);
});

test("resume_from continues history; notices dedupe; turn cancel scoped", async () => {
  assert.match(formatResumeFooter("agent_x"), /resume_from="agent_x"/);
  const notice = formatCompletionNotices([
    {
      id: "a1",
      agentType: "explorer",
      status: "completed",
      resultPreview: "found X",
    },
  ]);
  assert.match(notice, /subagent_completed/);
  assert.match(notice, /a1/);

  let round = 0;
  const chatImpl = async (req: ChatRequest): Promise<ChatResult> => {
    round++;
    const users = req.messages.filter((m) => m.role === "user").length;
    return okResult({
      content: `reply_r${round}_users${users}`,
      finish_reason: "stop",
    });
  };

  const rt = new SubagentRuntime({
    parentProvider: "openai",
    parentModel: "gpt-test",
    cwd: process.cwd(),
    depth: 0,
    config: {
      enabled: true,
      maxConcurrent: 6,
      maxDepth: 1,
      jobMaxRuntimeSeconds: 30,
      autoSpawn: false,
      roles: [],
    },
    chatImpl,
  });

  const t1 = rt.beginTurn("turn_A");
  const s1 = await rt.spawn({
    agent_type: "explorer",
    message: "first pass explore",
    description: "exp1",
  });
  assert.equal(s1.ok, true);
  const id = String(s1.agent_id);
  await rt.wait({ agent_ids: [id], timeout_ms: 15_000 });
  const th1 = rt.getThread(id)!;
  assert.equal(th1.status, "completed");
  assert.equal(th1.turnId, t1);
  const histLen1 = th1.history.length;
  assert.ok(histLen1 >= 2, "user+assistant");

  const n1 = rt.drainCompletionNotices();
  assert.match(n1, /subagent_completed/);
  assert.match(n1, new RegExp(id));
  const n2 = rt.drainCompletionNotices();
  assert.equal(n2, "", "deduped — second drain empty");

  const s2 = await rt.spawn({
    resume_from: id,
    message: "second pass refine",
    model: "openai/should-be-ignored",
  });
  assert.equal(s2.ok, true, JSON.stringify(s2));
  assert.equal(s2.agent_id, id);
  await rt.wait({ agent_ids: [id], timeout_ms: 15_000 });
  const th2 = rt.getThread(id)!;
  assert.equal(th2.status, "completed");
  assert.ok(
    th2.history.length > histLen1,
    `history grew: ${histLen1} -> ${th2.history.length}`,
  );
  const userMsgs = th2.history
    .filter((h) => h.role === "user")
    .map((h) => h.content);
  assert.ok(userMsgs.includes("first pass explore"));
  assert.ok(userMsgs.includes("second pass refine"));
  assert.match(String(th2.result ?? ""), /resume_from=/);

  // Abort-aware hang: cancelTurn must only cancel matching turnId
  const hangChat = async (req: ChatRequest): Promise<ChatResult> => {
    await new Promise<void>((resolve, reject) => {
      if (req.signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        clearInterval(tick);
        req.signal?.removeEventListener("abort", onAbort);
      };
      // Poll so we also exit if abort fired before listener attach
      const tick = setInterval(() => {
        if (req.signal?.aborted) onAbort();
      }, 15);
      req.signal?.addEventListener("abort", onAbort, { once: true });
    });
    return okResult({ content: "late", finish_reason: "stop" });
  };
  const rt2 = new SubagentRuntime({
    parentProvider: "openai",
    parentModel: "gpt-test",
    cwd: process.cwd(),
    depth: 0,
    config: {
      enabled: true,
      maxConcurrent: 6,
      maxDepth: 1,
      jobMaxRuntimeSeconds: 10,
      autoSpawn: false,
      roles: [],
    },
    chatImpl: hangChat,
  });
  rt2.beginTurn("old_turn");
  const oldSpawn = await rt2.spawn({
    agent_type: "worker",
    message: "old work",
  });
  const oldId = String(oldSpawn.agent_id);
  rt2.beginTurn("new_turn");
  const newSpawn = await rt2.spawn({
    agent_type: "worker",
    message: "new work",
  });
  const newId = String(newSpawn.agent_id);
  assert.equal(rt2.getThread(oldId)?.turnId, "old_turn");
  assert.equal(rt2.getThread(newId)?.turnId, "new_turn");

  rt2.cancelTurn("new_turn");
  await new Promise((r) => setTimeout(r, 80));
  const oldTh = rt2.getThread(oldId)!;
  const newTh = rt2.getThread(newId)!;
  assert.equal(newTh.status, "cancelled");
  assert.equal(
    oldTh.status,
    "running",
    "cancelTurn(new) must leave old_turn agents alone",
  );

  rt2.cancelTurn("old_turn");
  await rt2.wait({ timeout_ms: 2000 }).catch(() => undefined);
});

test("multi-agent system addon separates planning vs parallel execution", () => {
  const roles = listSpawnableRoles([]);
  const tools = buildMultiAgentTools(roles);
  const spawn = tools.find((t) => t.function.name === "spawn_agent")!;
  assert.match(spawn.function.description, /capability_mode/);
  assert.match(spawn.function.description, /resume_from/);
  assert.match(spawn.function.description, /reasoning_effort/);
  const props = (
    spawn.function.parameters as { properties: Record<string, unknown> }
  ).properties;
  assert.ok(props.capability_mode);
  assert.ok(props.resume_from);

  const proactive = buildMultiAgentSystemAddon({
    roles,
    maxThreads: 6,
    maxDepth: 1,
    proactive: true,
  });
  assert.match(
    proactive,
    /spawn N agents|keep working|Do not idle after spawn|background/i,
  );
  assert.match(proactive, /planning only|parallel execution/i);
  assert.match(proactive, /resume_from|capability_mode/i);
  assert.match(spawn.function.description, /Do NOT idle-wait|background/i);
  // Multi-agent addon is product-neutral
  assert.ok(!/Codex multi-agent/i.test(proactive));
  assert.ok(!/Codex CLI/i.test(spawn.function.description));
  assert.ok(!/\bYou are Libra\b/i.test(proactive));
});

test("spawn_agent returns immediately; send_input queues while running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let childStarted = 0;
  const chatImpl = async (): Promise<ChatResult> => {
    childStarted++;
    // First invocation blocks until parent releases (proves spawn is non-blocking).
    // Later auto-chain rounds pass immediately (gate already resolved).
    await gate;
    return okResult({ content: `child round ${childStarted}`, finish_reason: "stop" });
  };

  const rt = new SubagentRuntime({
    parentProvider: "openai",
    parentModel: "gpt-test",
    cwd: process.cwd(),
    depth: 0,
    config: {
      enabled: true,
      maxConcurrent: 4,
      maxDepth: 1,
      jobMaxRuntimeSeconds: 30,
      autoSpawn: false,
      roles: [],
    },
    chatImpl,
  });
  rt.beginTurn("turn_bg");

  const t0 = Date.now();
  const spawn = await rt.spawn({
    agent_type: "explorer",
    message: "slow explore",
    description: "bg",
  });
  const spawnMs = Date.now() - t0;
  assert.equal(spawn.ok, true, JSON.stringify(spawn));
  assert.equal(spawn.status, "running");
  assert.ok(
    spawnMs < 500,
    `spawn should return immediately, took ${spawnMs}ms`,
  );
  assert.match(String(spawn.hint ?? ""), /background|Continue other/i);

  // Parent can queue follow-up without blocking on the still-running child
  const queued = await rt.sendInput({
    agent_id: String(spawn.agent_id),
    message: "extra note from parent",
  });
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(queued.queued, true);
  assert.match(String(queued.hint ?? ""), /queued|Continue other/i);

  const thread = rt.getThread(String(spawn.agent_id));
  assert.equal(thread?.status, "running");
  // Parent kept working while child still blocked on gate
  assert.ok(childStarted >= 1, "child should have started");

  release();
  const wait = await rt.wait({
    agent_ids: [String(spawn.agent_id)],
    timeout_ms: 15_000,
  });
  assert.equal(wait.ok, true, JSON.stringify(wait));
  const done = rt.getThread(String(spawn.agent_id));
  assert.ok(
    done?.status === "completed" || done?.status === "failed",
    `expected settled status, got ${done?.status}`,
  );
});

test("scheduleToolWaves defers wait_agent after spawn and other tools", async () => {
  const { scheduleToolWaves } = await import(
    "../src/toolcalling/concurrency.js"
  );
  const waves = scheduleToolWaves([
    { id: "w1", name: "wait_agent", args: { agent_ids: ["a"] } },
    { id: "s1", name: "spawn_agent", args: { message: "x" } },
    { id: "r1", name: "read_file", args: { target_file: "a.ts" } },
    { id: "w2", name: "wait_agent", args: { agent_ids: ["b"] } },
  ]);
  assert.ok(waves.length >= 2, `expected barrier, got ${waves.length} waves`);
  const flatBeforeWait = waves.slice(0, -1).flat().map((c) => c.name);
  assert.ok(flatBeforeWait.includes("spawn_agent"));
  assert.ok(flatBeforeWait.includes("read_file"));
  assert.ok(!flatBeforeWait.includes("wait_agent"));
  const last = waves[waves.length - 1]!;
  assert.deepEqual(
    last.map((c) => c.name).sort(),
    ["wait_agent", "wait_agent"],
  );
});

// ─── Reasoning modes per provider ───────────────────────────────────

test("reasoning caps match provider families", async () => {
  const {
    resolveCapsForModel,
    clearReasoningCapsCache,
    buildReasoningApiFields,
    setEffortForModel,
  } = await import("../src/agent/reasoning.js");
  clearReasoningCapsCache();

  const openai = resolveCapsForModel("openai", "gpt-5.5", true);
  assert.equal(openai.style, "openai_effort");
  assert.ok(openai.efforts.includes("high"));

  const xai = resolveCapsForModel("xai", "grok-4.5", true);
  assert.equal(xai.style, "openai_effort");
  assert.deepEqual(xai.efforts, ["low", "medium", "high"]);

  const ant = resolveCapsForModel("anthropic", "claude-sonnet-4-6", true);
  assert.equal(ant.style, "anthropic_thinking");

  const gem = resolveCapsForModel("gemini", "gemini-2.5-pro", true);
  assert.equal(gem.style, "gemini_thinking");

  const zen = resolveCapsForModel("opencode", "gpt-5.5", true);
  assert.equal(zen.supported, true);
  assert.ok(zen.efforts.includes("high"));

  const go = resolveCapsForModel("opencode-go", "kimi-k2.7-code", true);
  assert.equal(go.style, "openai_effort");
  assert.equal(go.supported, true);

  const dsChat = resolveCapsForModel("deepseek", "deepseek-chat", false);
  assert.equal(dsChat.supported, false);
  const dsR = resolveCapsForModel("deepseek", "deepseek-reasoner", true);
  assert.equal(dsR.supported, true);

  const groq = resolveCapsForModel("groq", "llama-3.3-70b", false);
  assert.equal(groq.supported, false);

  setEffortForModel("opencode", "gpt-5.5", "high");
  const fields = buildReasoningApiFields("opencode", "gpt-5.5");
  assert.ok(
    fields.reasoning_effort === "high" ||
      (fields.reasoning as { effort?: string })?.effort === "high",
  );
});

// ─── Multi-agent v2 peer chat ───────────────────────────────────────

test("message_agent delivers peer handoffs; children get peer tools", async () => {
  const { SubagentRuntime } = await import("../src/agent/subagent/runtime.js");
  const {
    buildPeerTools,
    buildMultiAgentTools,
    isPeerTool,
    buildMultiAgentSystemAddon,
  } = await import("../src/agent/subagent/tools.js");
  const { listSpawnableRoles } = await import("../src/agent/subagent/roles.js");
  const { saveAgentSettings, loadAgentSettings } = await import(
    "../src/agent/config.js"
  );

  const peers = buildPeerTools();
  assert.ok(peers.every((t) => isPeerTool(t.function.name)));
  assert.ok(peers.some((t) => t.function.name === "message_agent"));
  assert.ok(
    buildMultiAgentTools([]).some((t) => t.function.name === "message_agent"),
  );

  const addon = buildMultiAgentSystemAddon({
    roles: listSpawnableRoles([]),
    maxThreads: 6,
    maxDepth: 2,
    proactive: true,
    peerMessaging: true,
  });
  assert.match(addon, /message_agent/i);
  assert.match(addon, /Ultra multi-agent — REQUIRED|REQUIRED for Ultra|Proactive multi-agent/i);
  assert.match(addon, /reason/i);

  // Ultra enables peer + depth 2 + forced reasoner slots
  const prevCustom = loadAgentSettings().reasoning.custom;
  saveAgentSettings({
    reasoning: { custom: "ultra" },
  });
  const s = loadAgentSettings();
  assert.equal(s.subagents.enabled, true);
  assert.equal(s.subagents.autoSpawn, true);
  assert.equal(s.subagents.peerMessaging, true);
  assert.ok((s.subagents.maxDepth ?? 0) >= 2);
  assert.ok((s.subagents.maxConcurrent ?? 0) >= 8);
  assert.ok(
    s.subagents.roles.some(
      (r) => r.id === "reason" && r.enabled,
    ),
    "ultra should enable reason role",
  );
  // restore harness profile so we don't stick the user on ultra
  saveAgentSettings({
    reasoning: { custom: prevCustom },
  });

  let n = 0;
  const chatImpl = async (req: ChatRequest): Promise<ChatResult> => {
    n++;
    const last = [...req.messages].reverse().find((m) => m.role === "user");
    const content = String(last?.content ?? "");
    return okResult({
      content: content.includes("[peer message")
        ? `got-peer ${content.slice(0, 60)}`
        : `done-${n}`,
      finish_reason: "stop",
    });
  };

  const rt = new SubagentRuntime({
    parentProvider: "openai",
    parentModel: "gpt-test",
    cwd: process.cwd(),
    depth: 0,
    config: {
      enabled: true,
      maxConcurrent: 6,
      maxDepth: 2,
      jobMaxRuntimeSeconds: 15,
      autoSpawn: true,
      peerMessaging: true,
      roles: [],
    },
    chatImpl,
  });
  rt.beginTurn("peer_test");
  const a = await rt.spawn({
    agent_type: "explorer",
    message: "explore",
  });
  const b = await rt.spawn({
    agent_type: "worker",
    message: "implement",
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const idA = String(a.agent_id);
  const idB = String(b.agent_id);
  await rt.wait({ agent_ids: [idA, idB], timeout_ms: 10_000 });

  const handoff = await rt.messageAgent(
    { agent_id: idB, message: "findings at src/x.ts:10" },
    idA,
  );
  assert.equal(handoff.ok, true, JSON.stringify(handoff));
  await rt.wait({ agent_ids: [idB], timeout_ms: 10_000 });
  const thB = rt.getThread(idB)!;
  assert.match(String(thB.result ?? ""), /got-peer|findings|peer/i);
});

test("ultra forces reason+explorer subagents to extend reasoning", async () => {
  const {
    forceUltraReasoningExtension,
    ULTRA_REASON_ANGLES,
  } = await import("../src/agent/ultra-reason.js");
  const { SubagentRuntime } = await import("../src/agent/subagent/runtime.js");
  const { resolveRole } = await import("../src/agent/subagent/roles.js");
  const { runStoreTurn } = await import("../src/agent/turn.js");
  const { saveAgentSettings, loadAgentSettings } = await import(
    "../src/agent/config.js"
  );

  assert.ok(ULTRA_REASON_ANGLES.length >= 3);
  assert.equal(ULTRA_REASON_ANGLES[0]!.agent_type, "reason");
  assert.equal(ULTRA_REASON_ANGLES[1]!.agent_type, "reason");
  assert.equal(ULTRA_REASON_ANGLES[2]!.agent_type, "explorer");

  const reasonRole = resolveRole("reason", []);
  assert.equal(reasonRole.sandbox, "read-only");
  assert.equal(reasonRole.reasoningEffort, "max");

  let childCalls = 0;
  const childChat: ChatRequest[] = [];
  const chatImpl = async (req: ChatRequest): Promise<ChatResult> => {
    childCalls++;
    childChat.push(req);
    const last = [...req.messages].reverse().find((m) => m.role === "user");
    const content = String(last?.content ?? "");
    if (content.includes("ULTRA REASONING EXTENSION")) {
      const angle = content.includes("adversarial")
        ? "adversarial"
        : content.includes("evidence map")
          ? "evidence"
          : "primary";
      return okResult({
        content: `BRIEF_${angle}: plan for ${content.slice(0, 40)}`,
        finish_reason: "stop",
      });
    }
    // Parent main sample after forced extension
    const sys = req.messages.find((m) => m.role === "system");
    assert.match(
      String(sys?.content ?? ""),
      /Ultra forced reasoning extension/i,
      "parent system must include forced briefs",
    );
    assert.match(String(sys?.content ?? ""), /BRIEF_primary|BRIEF_adversarial|BRIEF_evidence/);
    return okResult({
      content: "done after ultra force",
      finish_reason: "stop",
    });
  };

  // Direct force API
  const rt = new SubagentRuntime({
    parentProvider: "openai",
    parentModel: "gpt-test",
    cwd: process.cwd(),
    depth: 0,
    config: {
      enabled: true,
      maxConcurrent: 8,
      maxDepth: 2,
      jobMaxRuntimeSeconds: 30,
      autoSpawn: true,
      peerMessaging: true,
      roles: [],
    },
    chatImpl,
  });
  rt.beginTurn("ultra_force_test");
  const ext = await forceUltraReasoningExtension(
    rt,
    "implement feature X safely",
    { timeoutMs: 15_000 },
  );
  assert.ok(ext.agentIds.length >= 2, `expected spawns, got ${ext.agentIds.length}`);
  assert.ok(ext.okCount >= 2, `expected ok briefs, got ${ext.okCount}`);
  assert.match(ext.systemAddon, /Ultra forced reasoning extension/i);
  assert.match(ext.displayReasoning, /BRIEF_/);
  assert.ok(ext.parts.length >= 2);
  assert.ok(childCalls >= 2);

  // Full parent turn under ultra harness profile
  const prev = loadAgentSettings().reasoning.custom;
  saveAgentSettings({ reasoning: { custom: "ultra" } });
  try {
    const store = new HarnessStore({
      model: "gpt-test",
      provider: "openai",
    });
    store.appendUser("implement feature X safely");
    const mid = store.startAssistant().id;
    const result = await runStoreTurn(
      {
        store,
        messageId: mid,
        abort: () => false,
      },
      {
        provider: "openai",
        model: "gpt-test",
        cwd: process.cwd(),
        tools: true,
        autoApprove: true,
        chatImpl,
        label: "ultra-force",
      },
    );
    assert.match(result.finalText, /done after ultra force/);
    // Thought parts for forced angles should be on the assistant message
    const asst = store.state.messages.find((m) => m.id === mid);
    const reasonParts =
      asst?.parts.filter((p) => p.type === "reasoning") ?? [];
    assert.ok(
      reasonParts.length >= 2,
      `expected ultra Thought parts, got ${reasonParts.length}`,
    );
    assert.ok(
      reasonParts.some((p) => {
        if (p.type !== "reasoning") return false;
        const title = "title" in p ? String(p.title ?? "") : "";
        return /Ultra ·|BRIEF_/i.test(`${title} ${p.content}`);
      }),
    );
  } finally {
    saveAgentSettings({ reasoning: { custom: prev } });
  }
});

// ─── Wave 3 ─────────────────────────────────────────────────────────

test("fusion partial peer failure still produces execute addon", async () => {
  const store = new HarnessStore({
    model: "main-model",
    provider: "openai",
  });

  const chatImpl = async (req: ChatRequest): Promise<ChatResult> => {
    if (req.model === "peer-model") {
      throw new Error("peer 503 unavailable");
    }
    return okResult({
      content: "",
      reasoning: "MAIN_ONLY_PLAN: edit src/x.ts",
      finish_reason: "stop",
    });
  };

  const prep = await prepareFusionForMain(
    store,
    "fix the bug in src/x.ts",
    "openai",
    "main-model",
    {
      chatImpl,
      secondaryKeys: ["xai/peer-model"],
    },
  );

  assert.ok(prep.systemAddon.length > 50);
  assert.match(prep.systemAddon, /fix the bug/);
  assert.match(prep.systemAddon, /phase 2|execute/i);
  assert.ok(prep.mainReasoning.text.includes("MAIN_ONLY_PLAN"));
  assert.ok(prep.secondaries[0]?.error, "peer should have error");
  assert.match(prep.systemAddon, /failed|surviving|proceed|peer/i);
  assert.match(prep.systemAddon, /planning only|parallel execution/i);

  const display = formatFusionReasoningDisplay(
    prep.mainReasoning,
    prep.secondaries,
    "openai/main-model",
  );
  assert.match(display, /MAIN_ONLY_PLAN|error/i);
});

// ─── runner ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`grok-port tests: ${tests.length} cases`);
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok  - ${t.name}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      console.log(`  FAIL - ${t.name}`);
      console.log(msg);
    }
  }
  console.log("");
  console.log(`result: ${passed} passed, ${failed} failed, ${tests.length} total`);
  if (failed > 0) process.exitCode = 1;
}

await main();
