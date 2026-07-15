/**
 * Offline tests for Codex/OpenCode-shaped agent turn + history pairing.
 * Drives shipped AgentLoop / ToolCallRuntime / history — not reimplemented logic.
 * Run: npx tsx src/agent/turn.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessStore } from "../core/store.js";
import type {
  ChatMessage,
  ChatResult,
  ChatRequest,
  StreamHandlers,
  ToolCall,
} from "../llm/client.js";
import { historyToMessages } from "./history.js";
import { AgentLoop } from "./loop.js";
import {
  runHeadlessTurn,
  runStoreTurn,
  runTurnCore,
  MAX_STEPS_PROMPT,
  DEFAULT_CHILD_MAX_STEPS,
} from "./turn.js";
import {
  buildDispatchCalls,
  normalizeToolCallsForWire,
} from "../toolcalling/router.js";
import { resolveToolName } from "../toolcalling/tool.js";
import { softCompactMessages } from "./compaction.js";
import {
  ToolCallRuntime,
  DOOM_LOOP_THRESHOLD,
} from "../toolcalling/runtime.js";
import { ToolRunner } from "../toolcalling/runner.js";
import { formatShellOutputForModel } from "../toolcalling/truncate.js";
import { buildSystemPrompt } from "./prompt.js";

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`  ✓ ${name}`);
}

const root = process.cwd();

// ── structural: broken policies gone + SINGLE shared core ─
{
  const loopSrc = readFileSync(join(root, "src/agent/loop.ts"), "utf8");
  const turnSrc = readFileSync(join(root, "src/agent/turn.ts"), "utf8");
  const childSrc = readFileSync(
    join(root, "src/agent/subagent/child-loop.ts"),
    "utf8",
  );
  const clientSrc = readFileSync(join(root, "src/llm/client.ts"), "utf8");
  const histSrc = readFileSync(join(root, "src/agent/history.ts"), "utf8");

  assert.ok(!/forceFinalAnswer/.test(loopSrc + turnSrc));
  assert.ok(!/MAX_CACHED_TOOL_ROUNDS/.test(loopSrc + turnSrc));
  assert.ok(!/summarizeFromCache/.test(loopSrc + turnSrc));
  assert.ok(!/spokenSoFar/.test(loopSrc + turnSrc));
  assert.ok(!/hist_\$\{|hist_\$|"hist_"|'hist_'/.test(histSrc));

  // Exactly one while-loop in turn.ts (the core) — parent/child must not fork loops
  const whileMatches = turnSrc.match(/\bwhile\s*\(/g) ?? [];
  assert.equal(
    whileMatches.length,
    1,
    `expected exactly 1 while-loop in turn.ts (shared core), found ${whileMatches.length}`,
  );
  // Both entry points must await runTurnCore (not reimplement the loop)
  assert.ok(
    /export async function runStoreTurn[\s\S]*?await runTurnCore\(/.test(turnSrc),
    "runStoreTurn must await runTurnCore",
  );
  assert.ok(
    /export async function runHeadlessTurn[\s\S]*?await runTurnCore\(/.test(
      turnSrc,
    ),
    "runHeadlessTurn must await runTurnCore",
  );
  // MAX_STEPS_PROMPT used only from core path (single definition + core inject)
  assert.ok(
    turnSrc.includes("export const MAX_STEPS_PROMPT"),
    "MAX_STEPS_PROMPT must be exported for shared use",
  );
  const maxPromptInjects = (
    turnSrc.match(/content:\s*MAX_STEPS_PROMPT/g) ?? []
  ).length;
  assert.equal(
    maxPromptInjects,
    1,
    "MAX_STEPS_PROMPT must be injected exactly once (in runTurnCore)",
  );

  assert.ok(/runStoreTurn/.test(loopSrc), "AgentLoop → runStoreTurn");
  assert.ok(
    /runHeadlessTurn/.test(childSrc),
    "child-loop → runHeadlessTurn",
  );
  assert.ok(typeof runTurnCore === "function");
  assert.ok(typeof runStoreTurn === "function");
  assert.ok(typeof runHeadlessTurn === "function");
  assert.ok(
    /Gemini tool calling is not implemented/.test(clientSrc) &&
      /Anthropic tool calling is not implemented/.test(clientSrc),
    "Gemini/Anthropic must fail closed on tools",
  );
  ok(
    "structural: single while in runTurnCore; parent+child await it; fail-closed adapters",
  );
}

// ── aliases ──────────────────────────────────────────
assert.equal(resolveToolName("read"), "read_file");
assert.equal(resolveToolName("bash"), "run_terminal_command");
assert.equal(resolveToolName("edit"), "search_replace");
assert.equal(resolveToolName("Shell"), "run_terminal_command");
assert.equal(resolveToolName("todowrite"), "todo_write");
ok("tool aliases resolve");

// ── router ───────────────────────────────────────────
const rawCalls: ToolCall[] = [
  {
    id: "call_a",
    type: "function",
    function: { name: "list_dir", arguments: "{}" },
  },
  {
    id: "call_b",
    type: "function",
    function: {
      name: "read",
      arguments: JSON.stringify({ target_file: "package.json" }),
    },
  },
];
const dispatch = buildDispatchCalls(rawCalls);
assert.equal(dispatch.length, 2);
assert.equal(dispatch[1]!.name, "read_file");
assert.equal(dispatch[0]!.callId, "call_a");
const wire = normalizeToolCallsForWire(rawCalls);
assert.equal(wire[1]!.function.name, "read_file");
ok("router maps aliases + preserves call ids");

// ── shell framing (Codex) ────────────────────────────
{
  const framed = formatShellOutputForModel({
    exitCode: 0,
    durationMs: 1234,
    output: "hello\n",
  });
  assert.ok(framed.includes("Exit code: 0"));
  assert.ok(framed.includes("Wall time:"));
  assert.ok(framed.includes("Output:"));
  assert.ok(framed.includes("hello"));
  ok("shell output framing for model");
}

// ── history pairing ──────────────────────────────────
const store = new HarnessStore({
  cwd: process.cwd(),
  model: "test",
  provider: "openrouter",
});
store.appendUser("list files");
const asst = store.startAssistant();
store.appendPart(asst.id, {
  id: "p1",
  type: "tool",
  toolName: "list_dir",
  args: { target_directory: "." },
  callId: "call_hist_1",
  status: "completed",
  result: "package.json\nsrc/",
});
store.appendPart(asst.id, {
  id: "p2",
  type: "text",
  content: "Here are the files.",
});
const hist = historyToMessages(store);
const toolMsgs = hist.filter((m) => m.role === "tool");
const asstWithTools = hist.filter(
  (m) => m.role === "assistant" && m.tool_calls?.length,
);
assert.equal(asstWithTools.length, 1);
assert.equal(toolMsgs.length, 1);
assert.equal(toolMsgs[0]!.tool_call_id, "call_hist_1");
assert.equal(asstWithTools[0]!.tool_calls![0]!.id, "call_hist_1");
ok("history tool_call_id pairing");

// Incomplete tool (no callId) must be dropped
const store2 = new HarnessStore();
store2.appendUser("x");
const a2 = store2.startAssistant();
store2.appendPart(a2.id, {
  id: "p3",
  type: "tool",
  toolName: "list_dir",
  args: {},
  status: "pending",
});
const hist2 = historyToMessages(store2);
assert.equal(hist2.filter((m) => m.role === "tool").length, 0);
ok("history drops incomplete tools without inventing ids");

// ── compaction ───────────────────────────────────────
const msgs: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "u1" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "list_dir", arguments: "{}" },
      },
    ],
  },
  { role: "tool", tool_call_id: "c1", content: "x".repeat(5000) },
  { role: "user", content: "u2" },
  { role: "assistant", content: "done" },
];
const changed = softCompactMessages(msgs, {
  tokenBudget: 10,
  keepRecent: 2,
  digestChars: 50,
});
assert.equal(changed, true);
assert.ok((msgs[3]!.content as string).includes("compacted"));
assert.equal(msgs[2]!.tool_calls![0]!.id, "c1");
assert.equal(msgs[3]!.tool_call_id, "c1");
ok("soft compact preserves tool pairing");

// ── runtime: doom-loop ───────────────────────────────
{
  const runner = new ToolRunner(process.cwd(), {
    headless: true,
    autoApprove: true,
  });
  const runtime = new ToolCallRuntime(runner);
  const sameArgs = { target_directory: "." };
  const makeCall = (id: string) =>
    buildDispatchCalls([
      {
        id,
        type: "function",
        function: {
          name: "list_dir",
          arguments: JSON.stringify(sameArgs),
        },
      },
    ])[0]!;

  // Run threshold times successfully
  for (let i = 0; i < DOOM_LOOP_THRESHOLD; i++) {
    const r = await runtime.dispatchAll([makeCall(`doom_${i}`)]);
    assert.equal(r[0]!.ok, true, `doom run ${i} should ok`);
    assert.ok(!r[0]!.doomLoop);
  }
  // Next identical call → doom-loop non-empty output
  const blocked = await runtime.dispatchAll([makeCall("doom_blocked")]);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.ok, false);
  assert.equal(blocked[0]!.doomLoop, true);
  assert.ok(blocked[0]!.output.includes("Doom-loop"));
  assert.equal(blocked[0]!.callId, "doom_blocked");
  ok("runtime doom-loop returns tool output for same fingerprint");
}

// ── runtime: cancel ──────────────────────────────────
{
  const runner = new ToolRunner(process.cwd(), {
    headless: true,
    autoApprove: true,
  });
  const runtime = new ToolCallRuntime(runner);
  const ac = new AbortController();
  ac.abort();
  const calls = buildDispatchCalls([
    {
      id: "cancel_1",
      type: "function",
      function: {
        name: "list_dir",
        arguments: JSON.stringify({ target_directory: "." }),
      },
    },
    {
      id: "cancel_2",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ target_file: "package.json" }),
      },
    },
  ]);
  const outs = await runtime.dispatchAll(calls, { signal: ac.signal });
  assert.equal(outs.length, 2);
  for (const o of outs) {
    assert.equal(o.aborted, true);
    assert.ok(o.output.includes("aborted"));
    assert.ok(o.callId === "cancel_1" || o.callId === "cancel_2");
  }
  ok("runtime cancel yields aborted output for every call_id");
}

// ── runtime: invalid args still produce tool output ──
{
  const runner = new ToolRunner(process.cwd(), {
    headless: true,
    autoApprove: true,
  });
  const runtime = new ToolCallRuntime(runner);
  const calls = buildDispatchCalls([
    {
      id: "bad_1",
      type: "function",
      function: {
        name: "search_replace",
        arguments: JSON.stringify({ file_path: "nope.ts" }), // missing required
      },
    },
  ]);
  const outs = await runtime.dispatchAll(calls);
  assert.equal(outs.length, 1);
  assert.equal(outs[0]!.callId, "bad_1");
  assert.equal(outs[0]!.ok, false);
  assert.ok(outs[0]!.output.length > 0);
  ok("invalid tool args produce non-empty tool output");
}

// ── full loop: tool then final (finish_reason=stop WITH tools) ─
async function mockChat(
  req: ChatRequest,
  handlers?: StreamHandlers,
): Promise<ChatResult> {
  const toolRounds = req.messages.filter((m) => m.role === "tool").length;
  if (toolRounds === 0) {
    const tc: ToolCall = {
      id: "call_loop_1",
      type: "function",
      function: {
        name: "list_dir",
        arguments: JSON.stringify({ target_directory: "." }),
      },
    };
    handlers?.onToolCallDelta?.(0, tc);
    handlers?.onText?.("Looking around…");
    return {
      content: "Looking around…",
      tool_calls: [tc],
      finish_reason: "stop", // must still execute
    };
  }
  // Wire must include our tool result
  const toolMsg = req.messages.find(
    (m) => m.role === "tool" && m.tool_call_id === "call_loop_1",
  );
  assert.ok(toolMsg, "second sample must receive tool result for call_loop_1");
  assert.ok(
    typeof toolMsg.content === "string" && toolMsg.content.length > 0,
    "tool result non-empty",
  );
  handlers?.onText?.("Found package.json and src.");
  return {
    content: "Found package.json and src.",
    tool_calls: [],
    finish_reason: "stop",
  };
}

const liveStore = new HarnessStore({
  cwd: process.cwd(),
  model: "mock",
  provider: "openrouter",
});
const loop = new AgentLoop(liveStore);
await loop.handle("list the repo", {
  provider: "openrouter",
  model: "mock-model",
  cwd: process.cwd(),
  tools: true,
  subagents: false,
  autoApprove: true,
  chatImpl: mockChat,
});

const tools = liveStore.state.messages
  .flatMap((m) => m.parts)
  .filter((p) => p.type === "tool");
assert.ok(tools.length >= 1, "expected tool part");
const completed = tools.find(
  (p) => p.type === "tool" && p.status === "completed",
);
assert.ok(completed, "tool should complete despite finish_reason=stop");
if (completed && completed.type === "tool") {
  assert.equal(completed.callId, "call_loop_1");
}
const texts = liveStore.state.messages
  .flatMap((m) => m.parts)
  .filter((p) => p.type === "text")
  .map((p) => (p.type === "text" ? p.content : ""))
  .join(" ");
// Text channel must not be wiped just because tools ran
assert.ok(
  texts.includes("Looking around") || texts.includes("Found"),
  `expected streamed/final text kept, got: ${texts.slice(0, 200)}`,
);
assert.ok(
  texts.includes("package.json") || texts.includes("Found"),
  `expected final text, got: ${texts.slice(0, 200)}`,
);
ok("loop: finish_reason=stop with tool_calls still executes; text not wiped");

// ── two tools in one sample (pairing both) ───────────
{
  let samples = 0;
  async function twoTools(
    req: ChatRequest,
    handlers?: StreamHandlers,
  ): Promise<ChatResult> {
    samples++;
    const toolN = req.messages.filter((m) => m.role === "tool").length;
    if (toolN === 0) {
      const tcs: ToolCall[] = [
        {
          id: "t_list",
          type: "function",
          function: {
            name: "list_dir",
            arguments: JSON.stringify({ target_directory: "." }),
          },
        },
        {
          id: "t_read",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ target_file: "package.json" }),
          },
        },
      ];
      return { content: "", tool_calls: tcs, finish_reason: "tool_calls" };
    }
    const ids = req.messages
      .filter((m) => m.role === "tool")
      .map((m) => m.tool_call_id)
      .sort();
    assert.deepEqual(ids, ["t_list", "t_read"]);
    handlers?.onText?.("both done");
    return { content: "both done", tool_calls: [], finish_reason: "stop" };
  }
  const s = new HarnessStore();
  const l = new AgentLoop(s);
  await l.handle("do both", {
    provider: "openrouter",
    model: "m",
    cwd: process.cwd(),
    tools: true,
    subagents: false,
    autoApprove: true,
    chatImpl: twoTools,
  });
  assert.ok(samples >= 2);
  const toolParts = s.state.messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "tool");
  assert.ok(toolParts.length >= 2);
  ok("loop: parallel tool batch pairs both call ids before next sample");
}

// ── pure chat ────────────────────────────────────────
const chatStore = new HarnessStore();
const chatLoop = new AgentLoop(chatStore);
await chatLoop.handle("hi", {
  provider: "openrouter",
  model: "mock",
  tools: false,
  chatImpl: async (_req, h) => {
    h?.onText?.("hello");
    return { content: "hello", tool_calls: [], finish_reason: "stop" };
  },
});
const chatText = chatStore.state.messages
  .flatMap((m) => m.parts)
  .filter((p) => p.type === "text")
  .map((p) => (p.type === "text" ? p.content : ""))
  .join("");
assert.ok(chatText.includes("hello"));
ok("loop: pure chat without tools");

// ── headless shared turn (child path) ────────────────
{
  let steps = 0;
  const result = await runHeadlessTurn({
    provider: "openrouter",
    model: "mock",
    cwd: process.cwd(),
    tools: true,
    maxSteps: 6,
    headless: true,
    headlessMessages: [
      { role: "system", content: "You are a helper." },
      { role: "user", content: "list dir" },
    ],
    chatImpl: async (req) => {
      steps++;
      const toolN = req.messages.filter((m) => m.role === "tool").length;
      if (toolN === 0) {
        return {
          content: "",
          tool_calls: [
            {
              id: "child_c1",
              type: "function",
              function: {
                name: "list_dir",
                arguments: JSON.stringify({ target_directory: "." }),
              },
            },
          ],
          finish_reason: "tool_calls",
        };
      }
      const tm = req.messages.find(
        (m) => m.role === "tool" && m.tool_call_id === "child_c1",
      );
      assert.ok(tm && String(tm.content).length > 0);
      return {
        content: "child done",
        tool_calls: [],
        finish_reason: "stop",
      };
    },
  });
  assert.equal(result.finalText, "child done");
  assert.ok(result.toolsUsed.includes("list_dir"));
  assert.ok(steps >= 2);
  ok("headless turn (child path) shares tool pairing rules");
}

// ── max-steps nudge: parent AND child inject MAX_STEPS_PROMPT ─
{
  // Child: maxSteps=1 forces isLast on first sample
  let sawChildNudge = false;
  let childToolsEnabled: boolean | undefined;
  await runHeadlessTurn({
    provider: "openrouter",
    model: "mock",
    cwd: process.cwd(),
    tools: true,
    maxSteps: 1,
    headless: true,
    headlessMessages: [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
    ],
    chatImpl: async (req) => {
      childToolsEnabled = Boolean(req.tools?.length);
      sawChildNudge = req.messages.some(
        (m) =>
          m.role === "assistant" &&
          typeof m.content === "string" &&
          m.content.includes(MAX_STEPS_PROMPT.slice(0, 40)),
      );
      // Even if we emit tools, core must not run them on last step
      return {
        content: "forced final",
        tool_calls: [
          {
            id: "should_not_run",
            type: "function",
            function: {
              name: "list_dir",
              arguments: JSON.stringify({ target_directory: "." }),
            },
          },
        ],
        finish_reason: "tool_calls",
      };
    },
  });
  assert.equal(sawChildNudge, true, "child max-steps must inject MAX_STEPS_PROMPT");
  assert.equal(
    childToolsEnabled,
    false,
    "child last step must disable tools",
  );
  ok("child max-steps uses MAX_STEPS_PROMPT and disables tools");

  // Parent via runStoreTurn with maxSteps=1 (same core as AgentLoop)
  let sawParentNudge = false;
  let parentToolsEnabled: boolean | undefined;
  const pStore2 = new HarnessStore();
  pStore2.appendUser("go");
  const mid = pStore2.startAssistant().id;
  await runStoreTurn(
    { store: pStore2, messageId: mid, abort: () => false },
    {
      provider: "openrouter",
      model: "mock",
      cwd: process.cwd(),
      tools: true,
      subagents: false,
      autoApprove: true,
      maxSteps: 1,
      chatImpl: async (req) => {
        parentToolsEnabled = Boolean(req.tools?.length);
        sawParentNudge = req.messages.some(
          (m) =>
            m.role === "assistant" &&
            typeof m.content === "string" &&
            m.content.includes(MAX_STEPS_PROMPT.slice(0, 40)),
        );
        return {
          content: "parent final",
          tool_calls: [
            {
              id: "p_skip",
              type: "function",
              function: {
                name: "list_dir",
                arguments: JSON.stringify({ target_directory: "." }),
              },
            },
          ],
          finish_reason: "tool_calls",
        };
      },
    },
  );
  assert.equal(
    sawParentNudge,
    true,
    "parent max-steps must inject MAX_STEPS_PROMPT",
  );
  assert.equal(
    parentToolsEnabled,
    false,
    "parent last step must disable tools",
  );
  const ran = pStore2.state.messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "tool" && p.status === "completed");
  assert.equal(ran.length, 0, "last-step tools must not execute");
  ok("parent max-steps uses same MAX_STEPS_PROMPT and disables tools");
  assert.ok(DEFAULT_CHILD_MAX_STEPS > 0);
}

// ── system prompt env block ──────────────────────────
{
  const p = buildSystemPrompt({
    model: "test-model",
    provider: "openrouter",
    cwd: process.cwd(),
    skipProjectInstructions: true,
  });
  assert.ok(p.includes("Working directory:"));
  assert.ok(p.includes("Is directory a git repo:"));
  assert.ok(p.includes("test-model"));
  assert.ok(!/You are Libra/i.test(p));
  assert.ok(!/You are OpenCode/i.test(p));
  ok("system prompt env + no product branding");
}

console.log(`\n${passed} tests passed`);
