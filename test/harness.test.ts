/**
 * Frontier harness tests — drive real shipped modules with injected chat.
 * No re-implementation of the loop; no hardcoded oracles for control flow.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  attachInTurnReasoning,
  buildAssistantToolRoundMessage,
  ensureToolCallPairing,
  hasBrokenToolCallArgs,
  isIncompleteToolArguments,
  isLengthFinish,
  lengthContinuationNudge,
  normalizeToolCalls,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type StreamHandlers,
  type ToolCall,
} from "../src/llm/client.js";
import { withRetry } from "../src/llm/retry.js";
import {
  runTurnCore,
  MAX_STEPS_PROMPT,
  type TurnCoreInput,
} from "../src/agent/turn.js";
import {
  buildSystemPrompt,
  resolvePromptPackId,
} from "../src/agent/prompt.js";
import { selectPromptPackId } from "../src/agent/prompts/packs.js";
import {
  buildReasoningApiFields,
  clearReasoningCapsCache,
  resolveEffortForModel,
  setReasoningCaps,
  type ModelReasoningCaps,
} from "../src/agent/reasoning.js";
import {
  createSampleProcessor,
} from "../src/agent/processor.js";
import { historyToMessages } from "../src/agent/history.js";
import {
  alignKeepRecentStart,
  softCompactMessages,
} from "../src/agent/compaction.js";
import {
  formatFusionReasoningDisplay,
  prepareFusionForMain,
} from "../src/agent/fusion.js";
import { HarnessStore } from "../src/core/store.js";
import { ToolRunner } from "../src/toolcalling/runner.js";
import { ToolCallRuntime } from "../src/toolcalling/runtime.js";
import type { OpenAITool } from "../src/toolcalling/schema.js";
import {
  prepareShellCommand,
  rewriteNodePackageBins,
  resolveShellHost,
  shellEnvHint,
} from "../src/toolcalling/shell-win.js";

// ─── minimal test harness ───────────────────────────────────────────

type TestFn = () => void | Promise<void>;
const tests: { name: string; fn: TestFn }[] = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

let passed = 0;
let failed = 0;
const lines: string[] = [];

function log(s: string): void {
  lines.push(s);
  console.log(s);
}

// ─── fixtures ───────────────────────────────────────────────────────

const LIST_DIR_SCHEMA: OpenAITool = {
  type: "function",
  function: {
    name: "list_dir",
    description: "list",
    parameters: {
      type: "object",
      properties: { target_directory: { type: "string" } },
    },
  },
};

function tc(
  id: string,
  name: string,
  args: string,
): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: args },
  };
}

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

function makeCore(
  chat: TurnCoreInput["chat"],
  opts: Partial<TurnCoreInput> = {},
): TurnCoreInput {
  const runner = new ToolRunner(process.cwd(), {
    headless: true,
    autoApprove: true,
  });
  const runtime = new ToolCallRuntime(runner);
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "test system" },
      { role: "user", content: "do the task" },
    ],
    toolSchemas: [LIST_DIR_SCHEMA],
    runner,
    runtime,
    maxSteps: 8,
    lightReasoning: false,
    toolsEnabledInitially: true,
    isAborted: () => false,
    label: "test",
    chat,
    hooks: {
      isCustomTool: () => true,
      customDispatch: async (call) => ({
        ok: true,
        output: `CUSTOM_OK:${call.name}:${JSON.stringify(call.args)}`,
        durationMs: 1,
      }),
    },
    ...opts,
  };
}

// ─── pure helpers ───────────────────────────────────────────────────

test("isLengthFinish recognizes provider caps", () => {
  assert.equal(isLengthFinish("length"), true);
  assert.equal(isLengthFinish("max_tokens"), true);
  assert.equal(isLengthFinish("max_output_tokens"), true);
  assert.equal(isLengthFinish("stop"), false);
  assert.equal(isLengthFinish(null), false);
});

test("isIncompleteToolArguments / hasBrokenToolCallArgs", () => {
  assert.equal(isIncompleteToolArguments(""), true);
  assert.equal(isIncompleteToolArguments("   "), true);
  assert.equal(isIncompleteToolArguments('{"a":1}'), false);
  assert.equal(isIncompleteToolArguments('{"a":'), true);
  assert.equal(isIncompleteToolArguments("{path:"), true);
  assert.equal(
    hasBrokenToolCallArgs([
      { function: { arguments: '{"ok":true}' } },
      { function: { arguments: '{"path":"/x' } },
    ]),
    true,
  );
  assert.equal(
    hasBrokenToolCallArgs([{ function: { arguments: '{"ok":true}' } }]),
    false,
  );
});

test("normalizeToolCalls preserves raw incomplete args (no silent repair)", () => {
  const out = normalizeToolCalls([
    {
      id: "c1",
      function: { name: "read_file", arguments: '{"target_file":"/x' },
    },
    {
      function: { name: "list_dir", arguments: "" },
    },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.function.arguments, '{"target_file":"/x');
  assert.equal(out[1]!.function.arguments, "");
  assert.equal(hasBrokenToolCallArgs(out), true);
});

test("attachInTurnReasoning + buildAssistantToolRoundMessage", () => {
  const bare = attachInTurnReasoning(
    { role: "assistant", content: "hi" },
    "  ",
  );
  assert.equal(bare.reasoning, undefined);

  const withR = buildAssistantToolRoundMessage({
    content: "plan",
    tool_calls: [tc("id1", "list_dir", '{"target_directory":"."}')],
    reasoning: "thinking hard",
  });
  assert.equal(withR.role, "assistant");
  assert.equal(withR.reasoning, "thinking hard");
  assert.equal(withR.reasoning_content, "thinking hard");
  assert.equal(withR.tool_calls?.length, 1);
  assert.equal(withR.content, "plan");
});

test("ensureToolCallPairing inserts aborted + drops orphans", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "s" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        tc("a", "list_dir", "{}"),
        tc("b", "read_file", '{"target_file":"x"}'),
      ],
    },
    // only "a" has a result — "b" missing
    { role: "tool", tool_call_id: "a", content: "ok-a" },
    // orphan tool result
    { role: "tool", tool_call_id: "orphan", content: "ghost" },
    { role: "user", content: "continue" },
  ];
  ensureToolCallPairing(msgs);
  const toolIds = msgs
    .filter((m) => m.role === "tool")
    .map((m) => m.tool_call_id);
  assert.deepEqual(toolIds.sort(), ["a", "b"]);
  const b = msgs.find((m) => m.role === "tool" && m.tool_call_id === "b");
  assert.equal(b?.content, "aborted");
  assert.ok(!msgs.some((m) => m.tool_call_id === "orphan"));
});

test("lengthContinuationNudge includes tail when partial present", () => {
  const n = lengthContinuationNudge("hello world ".repeat(30));
  assert.match(n, /cut off/i);
  assert.match(n, /Last visible tail/);
  const empty = lengthContinuationNudge("");
  assert.match(empty, /cut off/i);
});

// ─── prompts ────────────────────────────────────────────────────────

test("selectPromptPackId routes provider/model pairs", () => {
  assert.equal(selectPromptPackId("anthropic", "claude-sonnet-4"), "anthropic");
  assert.equal(selectPromptPackId("openai", "gpt-4o"), "beast");
  assert.equal(selectPromptPackId("openai", "gpt-5.1"), "gpt");
  assert.equal(selectPromptPackId("openai", "codex-mini"), "codex");
  assert.equal(selectPromptPackId("gemini", "gemini-2.5-pro"), "gemini");
  assert.equal(selectPromptPackId("xai", "grok-4"), "grok");
  assert.equal(selectPromptPackId("openrouter", "moonshot/kimi-k2"), "kimi");
  assert.equal(selectPromptPackId(undefined, "muse-spark"), "meta");
  assert.equal(selectPromptPackId("custom", "unknown-model"), "default");
});

test("resolvePromptPackId slim override wins; pack force works", () => {
  assert.equal(resolvePromptPackId({ profile: "slim", pack: "beast" }), "slim");
  assert.equal(
    resolvePromptPackId({ pack: "codex", provider: "xai", model: "grok" }),
    "codex",
  );
});

test("buildSystemPrompt non-empty + project inject/skip", () => {
  const dir = join(tmpdir(), `libra-prompt-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# Project rules\nAlways use tabs.\n");
  try {
    const withProj = buildSystemPrompt({
      provider: "openai",
      model: "gpt-4o",
      cwd: dir,
      profile: "full",
      skipProjectInstructions: false,
    });
    assert.ok(withProj.length > 200);
    assert.match(withProj, /Project instructions/);
    assert.match(withProj, /Always use tabs/);
    assert.match(withProj, /gpt-4o/);

    const skip = buildSystemPrompt({
      provider: "openai",
      model: "gpt-4o",
      cwd: dir,
      skipProjectInstructions: true,
    });
    assert.ok(!skip.includes("Always use tabs"));

    const slim = buildSystemPrompt({
      provider: "anthropic",
      model: "claude-3",
      cwd: dir,
      profile: "slim",
      skipProjectInstructions: true,
    });
    assert.ok(slim.length > 40);
    assert.ok(slim.length < withProj.length);
    assert.equal(resolvePromptPackId({ profile: "slim" }), "slim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── reasoning effort ───────────────────────────────────────────────

test("resolveEffortForModel + buildReasoningApiFields clamp to caps", () => {
  clearReasoningCapsCache();
  const caps: ModelReasoningCaps = {
    supported: true,
    efforts: ["low", "medium", "high"],
    style: "openai_effort",
    source: "api",
  };
  setReasoningCaps("openai", "test-reason-model", caps);

  // forceMax always uses the highest supported effort regardless of user default
  const fieldsMax = buildReasoningApiFields("openai", "test-reason-model", {
    forceMax: true,
  });
  assert.equal(fieldsMax.reasoning_effort, "high");

  // unsupported model → empty fields
  clearReasoningCapsCache();
  setReasoningCaps("openai", "plain-model", {
    supported: false,
    efforts: [],
    style: "none",
    source: "api",
  });
  assert.deepEqual(buildReasoningApiFields("openai", "plain-model"), {});
  assert.deepEqual(
    buildReasoningApiFields("openai", "plain-model", { forceMax: true }),
    {},
  );

  // resolveEffortForModel returns caps; when unsupported, effort is null
  const r = resolveEffortForModel("openai", "plain-model");
  assert.equal(r.effort, null);
  assert.equal(r.caps.supported, false);

  // OpenRouter-style caps produce reasoning: { effort }
  clearReasoningCapsCache();
  setReasoningCaps("openrouter", "or-model", {
    supported: true,
    efforts: ["none", "low", "high"],
    style: "openrouter_reasoning",
    source: "api",
  });
  const orMax = buildReasoningApiFields("openrouter", "or-model", {
    forceMax: true,
  });
  assert.deepEqual(orMax, { reasoning: { effort: "high" } });
  clearReasoningCapsCache();
});

// ─── history / compaction pairing ───────────────────────────────────

test("historyToMessages pairs tool parts with callIds only", () => {
  const store = new HarnessStore({ model: "m", provider: "openai" });
  store.appendUser("list things");
  const a = store.startAssistant();
  store.appendPart(a.id, {
    id: "p1",
    type: "reasoning",
    content: "I should list",
    collapsed: true,
  });
  store.appendPart(a.id, {
    id: "p2",
    type: "text",
    content: "listing…",
  });
  store.appendPart(a.id, {
    id: "p3",
    type: "tool",
    toolName: "list_dir",
    args: { target_directory: "." },
    callId: "call_abc",
    status: "completed",
    result: "file1.ts\nfile2.ts",
  });
  // incomplete tool (no callId) must not invent ids
  store.appendPart(a.id, {
    id: "p4",
    type: "tool",
    toolName: "read_file",
    args: { target_file: "x" },
    status: "pending",
  });

  const wire = historyToMessages(store);
  const assistant = wire.find((m) => m.role === "assistant" && m.tool_calls);
  assert.ok(assistant);
  assert.equal(assistant!.tool_calls!.length, 1);
  assert.equal(assistant!.tool_calls![0]!.id, "call_abc");
  assert.equal(assistant!.reasoning, "I should list");
  const tools = wire.filter((m) => m.role === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.tool_call_id, "call_abc");
});

test("alignKeepRecentStart does not bisect tool results", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "u1" },
    {
      role: "assistant",
      content: null,
      tool_calls: [tc("c1", "list_dir", "{}")],
    },
    { role: "tool", tool_call_id: "c1", content: "out" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "done" },
  ];
  // keep=2 would naively cut at index 4 (user u2); keep=3 at tool
  const cut = alignKeepRecentStart(msgs, 3, 1);
  // must not start on the tool row
  assert.notEqual(msgs[cut]?.role, "tool");
  // tool and its assistant stay together in recent
  const recent = msgs.slice(cut);
  if (recent.some((m) => m.role === "tool")) {
    assert.ok(recent.some((m) => m.role === "assistant" && m.tool_calls));
  }
});

test("softCompactMessages preserves tool_call_id pairing", () => {
  const longTool = "x".repeat(5000);
  const msgs: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    {
      role: "assistant",
      content: null,
      tool_calls: [tc("z1", "list_dir", "{}")],
    },
    { role: "tool", tool_call_id: "z1", content: longTool },
    { role: "user", content: "next" },
    { role: "assistant", content: "y".repeat(3000) },
  ];
  softCompactMessages(msgs, { tokenBudget: 100, keepRecent: 2, digestChars: 40 });
  const tool = msgs.find((m) => m.role === "tool");
  assert.ok(tool);
  assert.equal(tool!.tool_call_id, "z1");
  // should have been digested if outside keep window
  if (typeof tool!.content === "string" && tool!.content.includes("compacted")) {
    assert.ok(tool!.content.length < longTool.length);
  }
});

// ─── sample processor retry reset ───────────────────────────────────

test("createSampleProcessor resetForRetry clears streamed text/reasoning", async () => {
  const store = new HarnessStore();
  const mid = store.startAssistant().id;
  const proc = createSampleProcessor(store, mid);

  proc.handlers.onText?.("STALE_PARTIAL_");
  proc.handlers.onReasoning?.("STALE_THINK_");
  // allow batch timers to flush
  await new Promise((r) => setTimeout(r, 40));

  const before = store.state.messages.find((m) => m.id === mid)!;
  const textBefore = before.parts.find((p) => p.type === "text");
  assert.ok(textBefore && textBefore.type === "text");
  assert.match(textBefore.content, /STALE/);

  proc.resetForRetry();

  const after = store.state.messages.find((m) => m.id === mid)!;
  const textAfter = after.parts.find((p) => p.type === "text");
  const reasonAfter = after.parts.find((p) => p.type === "reasoning");
  if (textAfter && textAfter.type === "text") {
    assert.equal(textAfter.content, "");
  }
  if (reasonAfter && reasonAfter.type === "reasoning") {
    assert.equal(reasonAfter.content, "");
  }

  // successful retry content replaces, does not prepend stale
  proc.handlers.onText?.("FRESH_ANSWER");
  await new Promise((r) => setTimeout(r, 40));
  proc.finish({
    content: "FRESH_ANSWER",
    reasoning: "fresh think",
    tool_calls: [],
  });

  const final = store.state.messages.find((m) => m.id === mid)!;
  const textFinal = final.parts.find((p) => p.type === "text");
  assert.ok(textFinal && textFinal.type === "text");
  assert.equal(textFinal.content, "FRESH_ANSWER");
  assert.ok(!textFinal.content.includes("STALE"));
});

test("withRetry onRetry fires so sample reset can run", async () => {
  let attempts = 0;
  const resets: number[] = [];
  const result = await withRetry(
    async () => {
      attempts++;
      if (attempts < 2) throw new Error("HTTP 503 upstream");
      return "ok";
    },
    {
      maxAttempts: 3,
      baseMs: 1,
      maxMs: 5,
      onRetry: (attempt) => {
        resets.push(attempt);
      },
    },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.deepEqual(resets, [1]);
});

// ─── runTurnCore integration (injected chat) ────────────────────────

test("runTurnCore: tools then final text; every call_id has one tool msg", async () => {
  let step = 0;
  const chat = async (req: ChatRequest): Promise<ChatResult> => {
    step++;
    if (step === 1) {
      return okResult({
        content: "I will list",
        reasoning: "need dir listing",
        finish_reason: "tool_calls",
        tool_calls: [
          tc("call_1", "list_dir", '{"target_directory":"."}'),
          tc("call_2", "list_dir", '{"target_directory":"src"}'),
        ],
      });
    }
    // verify pairing on follow-up messages
    const toolMsgs = req.messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 2);
    const ids = toolMsgs.map((m) => m.tool_call_id).sort();
    assert.deepEqual(ids, ["call_1", "call_2"]);
    // reasoning reattached on assistant tool round
    const asstTool = req.messages.find(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    );
    assert.ok(asstTool);
    assert.equal(asstTool!.reasoning, "need dir listing");
    return okResult({
      content: "Listed both dirs.",
      finish_reason: "stop",
    });
  };

  const result = await runTurnCore(makeCore(chat));
  assert.equal(result.error, undefined);
  assert.equal(result.finalText, "Listed both dirs.");
  assert.equal(result.toolsUsed.length, 2);
  assert.ok(result.rounds >= 2);

  const toolRoles = result.messages.filter((m) => m.role === "tool");
  assert.equal(toolRoles.length, 2);
  const callIds = new Set(toolRoles.map((m) => m.tool_call_id));
  assert.equal(callIds.size, 2);
});

test("runTurnCore: tool_calls continue even when finish_reason=stop", async () => {
  let step = 0;
  const chat = async (): Promise<ChatResult> => {
    step++;
    if (step === 1) {
      // Provider bug: finish_reason stop WITH tool_calls
      return okResult({
        content: "",
        finish_reason: "stop",
        tool_calls: [tc("c_stop", "list_dir", '{"target_directory":"."}')],
      });
    }
    return okResult({ content: "recovered after tools", finish_reason: "stop" });
  };
  const result = await runTurnCore(makeCore(chat));
  assert.equal(result.finalText, "recovered after tools");
  assert.ok(result.toolsUsed.includes("list_dir"));
  assert.ok(result.rounds >= 2);
});

test("runTurnCore: broken tool args recover without executing", async () => {
  let step = 0;
  let executed = 0;
  const chat = async (req: ChatRequest): Promise<ChatResult> => {
    step++;
    if (step === 1) {
      return okResult({
        content: "",
        finish_reason: "length",
        tool_calls: [
          tc("bad1", "list_dir", '{"target_directory":"/tmp'), // truncated
        ],
      });
    }
    // second sample should include recovery user nudge, not a successful tool result for bad1
    const tools = req.messages.filter((m) => m.role === "tool");
    assert.equal(
      tools.filter((t) => t.tool_call_id === "bad1").length,
      0,
      "broken call must not produce a tool result",
    );
    const users = req.messages.filter((m) => m.role === "user");
    assert.ok(
      users.some(
        (u) =>
          typeof u.content === "string" &&
          /truncated|incomplete JSON/i.test(u.content),
      ),
    );
    return okResult({
      content: "retrying properly",
      finish_reason: "tool_calls",
      tool_calls: [tc("good1", "list_dir", '{"target_directory":"."}')],
    });
  };

  const core = makeCore(chat, {
    hooks: {
      isCustomTool: () => true,
      customDispatch: async (call) => {
        executed++;
        return {
          ok: true,
          output: `ran:${call.name}`,
          durationMs: 1,
        };
      },
    },
  });
  // need a third sample after good tool
  let innerStep = 0;
  const chat2 = async (req: ChatRequest): Promise<ChatResult> => {
    innerStep++;
    if (innerStep === 1) {
      return okResult({
        content: "",
        finish_reason: "length",
        tool_calls: [tc("bad1", "list_dir", '{"target_directory":"/tmp')],
      });
    }
    if (innerStep === 2) {
      const tools = req.messages.filter((m) => m.role === "tool");
      assert.equal(tools.filter((t) => t.tool_call_id === "bad1").length, 0);
      return okResult({
        content: "ok now",
        finish_reason: "tool_calls",
        tool_calls: [tc("good1", "list_dir", '{"target_directory":"."}')],
      });
    }
    return okResult({ content: "done after recovery", finish_reason: "stop" });
  };
  const core2 = makeCore(chat2, {
    hooks: {
      isCustomTool: () => true,
      customDispatch: async (call) => {
        executed++;
        assert.notEqual(call.callId, "bad1");
        return { ok: true, output: `ran:${call.callId}`, durationMs: 1 };
      },
    },
  });
  const result = await runTurnCore(core2);
  assert.equal(result.finalText, "done after recovery");
  assert.equal(executed, 1); // only good1
  void chat; // silence if unused in branch
  void step;
  void core;
});

test("runTurnCore: length continue without tools", async () => {
  let step = 0;
  const chat = async (req: ChatRequest): Promise<ChatResult> => {
    step++;
    if (step === 1) {
      return okResult({
        content: "Part one of a long answer that got cut",
        finish_reason: "length",
      });
    }
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    assert.ok(
      typeof lastUser?.content === "string" &&
        /cut off|Continue/i.test(lastUser.content),
    );
    return okResult({
      content: " and here is the rest.",
      finish_reason: "stop",
    });
  };
  const result = await runTurnCore(makeCore(chat));
  assert.ok(result.rounds >= 2);
  assert.match(result.finalText, /rest/i);
});

test("runTurnCore: abort mid-turn", async () => {
  let aborted = false;
  const chat = async (): Promise<ChatResult> => {
    aborted = true;
    return okResult({ content: "should not finish normally", finish_reason: "stop" });
  };
  const result = await runTurnCore(
    makeCore(chat, {
      isAborted: () => true,
    }),
  );
  // aborted before first sample
  assert.equal(result.error, "cancelled");
  assert.ok(!aborted || result.finalText === "(cancelled)" || result.rounds === 0);
});

test("runTurnCore: max-steps injects MAX_STEPS_PROMPT and disables tools", async () => {
  let sawNudge = false;
  let toolsOnLast: boolean | undefined;
  const chat = async (req: ChatRequest): Promise<ChatResult> => {
    // always request tools so we keep looping until max
    const hasNudge = req.messages.some(
      (m) =>
        m.role === "assistant" &&
        typeof m.content === "string" &&
        m.content.includes(MAX_STEPS_PROMPT.slice(0, 40)),
    );
    if (hasNudge) {
      sawNudge = true;
      toolsOnLast = Boolean(req.tools?.length);
      return okResult({ content: "final under max steps", finish_reason: "stop" });
    }
    return okResult({
      content: "",
      finish_reason: "tool_calls",
      tool_calls: [tc(`c_${Date.now()}`, "list_dir", '{"target_directory":"."}')],
    });
  };
  const result = await runTurnCore(
    makeCore(chat, { maxSteps: 3 }),
  );
  assert.ok(sawNudge);
  assert.equal(toolsOnLast, false);
  assert.equal(result.finalText, "final under max steps");
});

test("runTurnCore: onSampleReset clears before retry (no stale prepend path)", async () => {
  let attempts = 0;
  let resets = 0;
  const chat = async (
    _req: ChatRequest,
    handlers?: StreamHandlers,
  ): Promise<ChatResult> => {
    attempts++;
    handlers?.onText?.(`attempt${attempts}_`);
    if (attempts === 1) {
      throw new Error("HTTP 502 bad gateway");
    }
    handlers?.onText?.("success");
    return okResult({ content: "attempt2_success", finish_reason: "stop" });
  };
  const result = await runTurnCore(
    makeCore(chat, {
      hooks: {
        onSampleReset: () => {
          resets++;
        },
        isCustomTool: () => true,
        customDispatch: async () => ({ ok: true, output: "x", durationMs: 0 }),
      },
    }),
  );
  assert.equal(result.finalText, "attempt2_success");
  assert.equal(resets, 1);
  assert.equal(attempts, 2);
});

// ─── Windows shell prep (live-run learning) ─────────────────────────

test("Windows default shell host is cmd.exe", () => {
  const { host, shellOption } = resolveShellHost("win32", {});
  assert.equal(host, "cmd");
  assert.equal(shellOption, "cmd.exe");
  const ps = resolveShellHost("win32", { LIBRA_SHELL: "powershell.exe" });
  assert.equal(ps.host, "powershell");
});

test("prepareShellCommand rewrites npm and && for PowerShell", () => {
  assert.equal(rewriteNodePackageBins("npm test"), "npm.cmd test");
  assert.equal(rewriteNodePackageBins("npx tsx a.ts"), "npx.cmd tsx a.ts");
  const prepared = prepareShellCommand("npm test && node -v", "powershell");
  assert.match(prepared, /npm\.cmd/);
  assert.ok(!prepared.includes("&&"));
  assert.match(prepared, /LASTEXITCODE/);
  // cmd host keeps && (after npm.cmd rewrite)
  const cmd = prepareShellCommand("npm test && node -v", "cmd");
  assert.match(cmd, /npm\.cmd test && node -v/);
  // strip unix tail/head pipes on cmd
  const tailed = prepareShellCommand("npm install 2>&1 | tail -n 20", "cmd");
  assert.ok(!/tail/i.test(tailed));
  assert.match(tailed, /npm\.cmd install/);
});

test("todo_write accepts stringified todos and missing ids", async () => {
  const { ToolExecutor } = await import("../src/toolcalling/executor.js");
  const ex = new ToolExecutor(process.cwd());
  const r = await ex.run("todo_write", {
    todos: JSON.stringify([
      { content: "Create package.json", status: "in_progress", activeForm: "x" },
      { content: "Write tests", status: "pending" },
    ]),
  });
  assert.equal(r.ok, true);
  assert.match(r.output, /Create package\.json/);
});

test("shellEnvHint mentions cmd on win32", () => {
  const h = shellEnvHint("win32", "cmd");
  assert.match(h, /cmd\.exe/i);
});

// ─── fusion ─────────────────────────────────────────────────────────

test("fusion formatFusionReasoningDisplay + prepareFusionForMain with chatImpl", async () => {
  const store = new HarnessStore({
    model: "main-model",
    provider: "openai",
  });

  const chatImpl = async (req: ChatRequest): Promise<ChatResult> => {
    // phase-1 must not expose tools
    assert.equal(req.tools, undefined);
    assert.equal(req.tool_choice, "none");
    const isMain = req.model === "main-model";
    return okResult({
      content: "",
      reasoning: isMain
        ? "MAIN_PLAN: touch src/a.ts then test"
        : "PEER_PLAN: prefer smaller diff on src/a.ts",
      finish_reason: "stop",
    });
  };

  const prep = await prepareFusionForMain(
    store,
    "implement feature X",
    "openai",
    "main-model",
    {
      chatImpl,
      secondaryKeys: ["xai/peer-model"],
    },
  );

  assert.ok(prep.systemAddon.length > 50);
  assert.match(prep.systemAddon, /MAIN_PLAN/);
  assert.match(prep.systemAddon, /PEER_PLAN/);
  assert.match(prep.systemAddon, /implement feature X/);
  assert.match(prep.displayReasoning, /MAIN_PLAN/);
  assert.match(prep.displayReasoning, /PEER_PLAN/);
  assert.ok(prep.mainReasoning.text.includes("MAIN_PLAN"));
  assert.equal(prep.secondaries.length, 1);
  assert.ok(prep.secondaries[0]!.text.includes("PEER_PLAN"));

  const display = formatFusionReasoningDisplay(
    prep.mainReasoning,
    prep.secondaries,
    "openai/main-model",
  );
  assert.match(display, /Ultra \+ Fusion/);
});

// ─── self-review backup / restore ───────────────────────────────────

test("self-review handoff write + resume path resolve", async () => {
  const {
    createHandoff,
    writeHandoff,
    writeHandoffStatus,
    readHandoffStatus,
  } = await import("../src/agent/self-review-handoff.js");
  const { resolveResumeTarget, saveSessionLibe, sessionLibePath } =
    await import("../src/memory/session-store.js");
  const { createEmptyState, newId } = await import("../src/core/types.js");
  const { mkdirSync, rmSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dir = join(tmpdir(), `libra-handoff-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.LIBRA_SESSIONS_DIR = dir;

  const state = createEmptyState({
    id: "resume_me",
    title: "handoff",
    model: "m",
    provider: "p",
    cwd: dir,
  });
  state.messages = [
    {
      id: newId("m"),
      role: "user",
      createdAt: Date.now(),
      parts: [{ id: newId("p"), type: "text", content: "hi" }],
    },
  ];
  const saved = saveSessionLibe(state);
  assert.ok(saved);
  const resolved = resolveResumeTarget("resume_me");
  assert.equal(resolved, saved!.path);
  assert.equal(resolveResumeTarget(saved!.path), saved!.path);

  const handoff = createHandoff({
    libraRoot: dir,
    backupId: "b1",
    backupDir: join(dir, "b1"),
    sessionPath: saved!.path,
    sessionId: "resume_me",
    userCwd: dir,
  });
  // point handoff files into tmp
  handoff.handoffPath = join(dir, "handoff.json");
  handoff.statusPath = join(dir, "status.json");
  handoff.logPath = join(dir, "log.txt");
  writeHandoff(handoff);
  assert.ok(existsSync(handoff.handoffPath));
  writeHandoffStatus(handoff.statusPath, {
    phase: "agent_done",
    at: new Date().toISOString(),
  });
  const st = readHandoffStatus(handoff.statusPath);
  assert.equal(st?.phase, "agent_done");
  assert.ok(sessionLibePath("resume_me").endsWith(".libe"));

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LIBRA_SESSIONS_DIR;
});

test("session .libe save + friction analysis", async () => {
  const {
    saveSessionLibe,
    loadSessionLibe,
    analyzeSessionFriction,
    sessionLibePath,
  } = await import("../src/memory/session-store.js");
  const { createEmptyState, newId } = await import("../src/core/types.js");
  const { existsSync, readFileSync, rmSync, mkdirSync } = await import(
    "node:fs"
  );
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dir = join(tmpdir(), `libra-libe-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.LIBRA_SESSIONS_DIR = dir;

  const state = createEmptyState({
    id: "sess_test1",
    title: "friction test",
    model: "mock",
    provider: "test",
    cwd: dir,
  });
  state.messages = [
    {
      id: newId("m"),
      role: "user",
      createdAt: Date.now(),
      parts: [{ id: newId("p"), type: "text", content: "do the thing" }],
    },
    {
      id: newId("m"),
      role: "assistant",
      createdAt: Date.now(),
      parts: [
        {
          id: newId("p"),
          type: "tool",
          toolName: "run_terminal_command",
          args: { command: "nope" },
          status: "error",
          error: "Command not found: nope",
          finishedAt: Date.now(),
        },
        {
          id: newId("p"),
          type: "status",
          level: "error",
          message: "turn failed hard",
        },
      ],
    },
    {
      id: newId("m"),
      role: "user",
      createdAt: Date.now() + 1,
      parts: [{ id: newId("p"), type: "text", content: "try again please" }],
    },
  ];

  const saved = saveSessionLibe(state, { libraVersion: "0.0.0-test" });
  assert.ok(saved);
  assert.ok(existsSync(saved!.path));
  assert.ok(saved!.path.endsWith(".libe"));
  assert.equal(saved!.summary.toolErrors, 1);
  assert.equal(saved!.summary.statusErrors, 1);

  const loaded = loadSessionLibe(saved!.path);
  assert.ok(loaded);
  assert.equal(loaded!.format, "libe");
  assert.equal(loaded!.session.id, "sess_test1");
  assert.equal(loaded!.messages.length, 3);

  // Same path helper
  assert.equal(sessionLibePath("sess_test1"), saved!.path);

  const report = analyzeSessionFriction({ limit: 5 });
  assert.ok(report.sessionsScanned >= 1);
  assert.ok((report.counts.tool_error ?? 0) >= 1);
  assert.ok((report.counts.status_error ?? 0) >= 1);
  assert.ok((report.counts.user_retry ?? 0) >= 1);
  assert.match(report.markdown, /tool_error|run_terminal_command/);
  assert.ok(readFileSync(join(dir, "latest.libe"), "utf8").includes("libe"));

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LIBRA_SESSIONS_DIR;
});

test("self-review backup + restore round-trip", async () => {
  const {
    createSelfReviewBackup,
    restoreSelfReviewBackup,
    listProjectFiles,
    isLibraPackageRoot,
  } = await import("../src/agent/self-review.js");
  const { readFileSync, existsSync } = await import("node:fs");

  const root = join(tmpdir(), `libra-self-review-${Date.now()}`);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "libra", version: "0.0.0-test" }) + "\n",
  );
  writeFileSync(join(root, "src", "marker.ts"), "export const X = 1;\n");
  writeFileSync(join(root, "README.md"), "# test\n");

  assert.equal(isLibraPackageRoot(root), true);
  const files = listProjectFiles(root);
  assert.ok(files.includes("src/marker.ts"));
  assert.ok(files.includes("package.json"));

  process.env.LIBRA_SELF_REVIEW_BACKUPS = join(root, ".backups");
  const snap = createSelfReviewBackup({
    libraRoot: root,
    provider: "test",
    model: "mock",
    note: "unit-test",
  });
  assert.ok(snap.id);
  assert.ok(snap.manifest.fileCount >= 2);
  assert.ok(existsSync(join(snap.dir, "MANIFEST.json")));
  assert.ok(existsSync(join(snap.dir, "src", "marker.ts")));

  // Mutate live tree, then restore
  writeFileSync(join(root, "src", "marker.ts"), "export const X = 999;\n");
  const restored = restoreSelfReviewBackup(snap.id, {
    libraRoot: root,
    skipSafetyBackup: true,
  });
  assert.equal(restored.restored > 0, true);
  assert.equal(
    readFileSync(join(root, "src", "marker.ts"), "utf8"),
    "export const X = 1;\n",
  );

  rmSync(root, { recursive: true, force: true });
  delete process.env.LIBRA_SELF_REVIEW_BACKUPS;
});

// ─── runner ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`harness tests: ${tests.length} cases`);
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      log(`  ok  — ${t.name}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      log(`  FAIL — ${t.name}`);
      log(msg);
    }
  }
  log("");
  log(`result: ${passed} passed, ${failed} failed, ${tests.length} total`);
  if (failed > 0) process.exitCode = 1;
}

await main();
