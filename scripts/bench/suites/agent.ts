/**
 * Agent loop helpers (offline) — system prompt, multi-part history shaping,
 * length_continue / length_broken_tools wiring via injected chatImpl.
 */

import {
  buildSystemPrompt,
  AgentLoop,
  toolFingerprint,
  normalizeToolArgs,
  _testHistoryToMessages,
} from "../../../src/agent/loop.js";
import { HarnessStore } from "../../../src/core/store.js";
import { newId } from "../../../src/core/types.js";
import type {
  ChatRequest,
  ChatResult,
  StreamHandlers,
} from "../../../src/llm/client.js";
import { Suite, assert, assertIncludes, assertEq } from "../runner.js";

export function suiteAgent(): Suite {
  const s = new Suite("agent-loop");

  s.test("buildSystemPrompt base", () => {
    const p = buildSystemPrompt();
    assertIncludes(p, "Libra");
    assertIncludes(p, "tools");
    // OpenCode-style sections
    assertIncludes(p, "Tool usage policy");
    assertIncludes(p, "PARALLEL");
    assertIncludes(p, "target_files");
    assertIncludes(p, "read_file DIRECTLY");
    assertIncludes(p, "specialized tools");
  });

  s.test("dedupe fingerprints for list_dir variants", () => {
    assertEq(
      toolFingerprint("list_dir", {}),
      toolFingerprint("list_dir", { target_directory: "." }),
    );
    assertEq(
      normalizeToolArgs("list_dir", {}).target_directory,
      ".",
    );
  });

  s.test("buildSystemPrompt merges extra", () => {
    const p = buildSystemPrompt("ALWAYS use list_dir first.");
    assertIncludes(p, "ALWAYS use list_dir first.");
  });

  s.test("AgentLoop busy flag + cancel", () => {
    const store = new HarnessStore({ model: "m", provider: "openrouter" });
    const agent = new AgentLoop(store);
    assertEq(agent.isBusy, false);
    agent.cancel();
    // cancel while idle is fine
    assertEq(agent.isBusy, false);
  });

  s.test("store history with tools for multi-turn continuity", () => {
    const store = new HarnessStore({ model: "m", provider: "openrouter" });
    store.appendUser("list files");
    const a = store.startAssistant();
    store.appendPart(a.id, {
      id: newId("p"),
      type: "tool",
      toolName: "list_dir",
      args: { target_directory: "." },
      status: "completed",
      result: "a\nb",
    });
    store.appendPart(a.id, {
      id: newId("p"),
      type: "text",
      content: "Found two files",
    });
    store.appendUser("read a");
    assertEq(store.state.messages.filter((m) => m.role === "user").length, 2);
    assertEq(store.state.messages.filter((m) => m.role === "assistant").length, 1);
    const tools = store.state.messages[1]!.parts.filter((p) => p.type === "tool");
    assertEq(tools.length, 1);
  });

  s.test("historyToMessages attaches reasoning from store parts", () => {
    const store = new HarnessStore({ model: "m", provider: "openrouter" });
    store.appendUser("plan then list");
    const a = store.startAssistant();
    store.appendPart(a.id, {
      id: newId("p"),
      type: "reasoning",
      content: "I should list the directory first",
    });
    store.appendPart(a.id, {
      id: newId("p"),
      type: "tool",
      toolName: "list_dir",
      args: { target_directory: "." },
      status: "completed",
      result: "src\npackage.json",
    });
    store.appendPart(a.id, {
      id: newId("p"),
      type: "text",
      content: "Here are the files.",
    });
    // open next turn so history includes completed assistant
    store.appendUser("next");
    const wire = _testHistoryToMessages(store);
    const asst = wire.find((m) => m.role === "assistant");
    assert(asst != null, "assistant wire message");
    assertEq(asst!.reasoning, "I should list the directory first");
    assertEq(asst!.reasoning_content, "I should list the directory first");
    // Proper OpenAI tool protocol (not flattened notes)
    assert(asst!.tool_calls != null && asst!.tool_calls.length >= 1, "tool_calls");
    assertEq(asst!.tool_calls![0]!.function.name, "list_dir");
    assertIncludes(String(asst!.content ?? ""), "Here are the files");
    const toolMsg = wire.find((m) => m.role === "tool");
    assert(toolMsg != null, "tool role message");
    assertIncludes(String(toolMsg!.content ?? ""), "package.json");
  });

  s.test("historyToMessages keeps large tool results (not 400-char clip)", () => {
    const store = new HarnessStore({ model: "m", provider: "openrouter" });
    store.appendUser("read");
    const a = store.startAssistant();
    const big = "X".repeat(1500);
    store.appendPart(a.id, {
      id: newId("p"),
      type: "tool",
      toolName: "read_file",
      args: { target_file: "a.ts" },
      status: "completed",
      result: big,
      callId: "call_big",
    });
    store.appendUser("next");
    const wire = _testHistoryToMessages(store);
    const asst = wire.find((m) => m.role === "assistant");
    assert(asst != null, "assistant");
    assertEq(asst!.tool_calls?.[0]?.id, "call_big");
    const toolMsg = wire.find((m) => m.role === "tool");
    assert(toolMsg != null, "tool role");
    // Must retain far more than the old 400-char clip
    assert(
      String(toolMsg!.content ?? "").length > 1000,
      `history tool snippet too short: ${String(toolMsg!.content ?? "").length}`,
    );
  });

  s.test("historyToMessages synthesizes callId when missing", () => {
    const store = new HarnessStore({ model: "m", provider: "openrouter" });
    store.appendUser("g");
    const a = store.startAssistant();
    store.appendPart(a.id, {
      id: newId("p"),
      type: "tool",
      toolName: "grep",
      args: { pattern: "x" },
      status: "completed",
      result: "hit",
    });
    store.appendUser("n");
    const wire = _testHistoryToMessages(store);
    const asst = wire.find((m) => m.role === "assistant");
    const tool = wire.find((m) => m.role === "tool");
    assert(asst?.tool_calls?.[0]?.id, "synth id on tool_calls");
    assertEq(tool?.tool_call_id, asst!.tool_calls![0]!.id);
  });

  s.test("length_broken_tools keeps tools enabled on retry", async () => {
    const store = new HarnessStore({ model: "m", provider: "openrouter" });
    const agent = new AgentLoop(store);
    const toolFlags: boolean[] = [];
    let call = 0;
    const chatImpl = async (
      req: ChatRequest,
      handlers?: StreamHandlers,
    ): Promise<ChatResult> => {
      call++;
      const toolsOn = Boolean(req.tools?.length) && req.tool_choice !== "none";
      toolFlags.push(toolsOn);
      if (call === 1) {
        // Truncated tool args mid-stream
        const r: ChatResult = {
          content: "",
          reasoning: "I will call list_dir",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "list_dir",
                arguments: '{"target_directory":',
              },
            },
          ],
          finish_reason: "length",
        };
        if (r.reasoning) handlers?.onReasoning?.(r.reasoning);
        return r;
      }
      if (call === 2) {
        // Retry must still have tools — return a clean tool call
        assert(toolsOn, "round 2 after length_broken_tools must keep tools");
        return {
          content: "",
          reasoning: "retry list",
          tool_calls: [
            {
              id: "c2",
              type: "function",
              function: {
                name: "list_dir",
                arguments: '{"target_directory":"."}',
              },
            },
          ],
          finish_reason: "tool_calls",
        };
      }
      // After tools executed, final answer
      handlers?.onText?.("Listed top-level entries.");
      return {
        content: "Listed top-level entries.",
        reasoning: "",
        tool_calls: [],
        finish_reason: "stop",
      };
    };

    await agent.handle("list files", {
      provider: "openrouter",
      model: "test-model",
      cwd: process.cwd(),
      tools: true,
      lightReasoning: true,
      subagents: false,
      chatImpl,
      label: "t.broken",
    });

    assert(call >= 2, `expected >=2 chat rounds, got ${call}`);
    assertEq(toolFlags[0], true);
    assertEq(toolFlags[1], true); // THE skeptic bug: was false
    // Final text should not be pure plan-speak stub
    const asst = store.state.messages.find((m) => m.role === "assistant");
    const texts =
      asst?.parts
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.content : ""))
        .join("\n") ?? "";
    assert(
      !/no final answer/i.test(texts),
      `stub text: ${texts}`,
    );
  });

  s.test("length_continue forces tools off; single text part accumulates", async () => {
    const store = new HarnessStore({ model: "m", provider: "openrouter" });
    const agent = new AgentLoop(store);
    const toolFlags: boolean[] = [];
    let call = 0;
    const chatImpl = async (
      req: ChatRequest,
      handlers?: StreamHandlers,
    ): Promise<ChatResult> => {
      call++;
      const toolsOn = Boolean(req.tools?.length) && req.tool_choice !== "none";
      toolFlags.push(toolsOn);
      if (call === 1) {
        const partial = "Hello wor";
        handlers?.onText?.(partial);
        return {
          content: partial,
          reasoning: "",
          tool_calls: [],
          finish_reason: "length",
        };
      }
      assert(!toolsOn, "length_continue must disable tools (forceFinal)");
      const rest = "ld!";
      handlers?.onText?.(rest);
      return {
        content: rest,
        reasoning: "",
        tool_calls: [],
        finish_reason: "stop",
      };
    };

    await agent.handle("say hello world", {
      provider: "openrouter",
      model: "test-model",
      tools: true,
      lightReasoning: true,
      subagents: false,
      chatImpl,
      label: "t.len",
    });

    assertEq(call, 2);
    assertEq(toolFlags[0], true);
    assertEq(toolFlags[1], false);
    const asst = store.state.messages.find((m) => m.role === "assistant");
    const textParts =
      asst?.parts.filter((p) => p.type === "text") ?? [];
    // One turn text part (not stacked per-round)
    assertEq(textParts.length, 1);
    const content =
      textParts[0] && textParts[0].type === "text"
        ? textParts[0].content
        : "";
    assertIncludes(content, "Hello");
    assertIncludes(content, "ld!");
  });

  s.test("tool-round short content must not prefix final answer", async () => {
    // Live bug: r1 content "AgentLoop" + r2 "Saw 9 matches" → "AgentLoopSaw…"
    const store = new HarnessStore({ model: "m", provider: "openrouter" });
    const agent = new AgentLoop(store);
    let call = 0;
    const chatImpl = async (
      _req: ChatRequest,
      handlers?: StreamHandlers,
    ): Promise<ChatResult> => {
      call++;
      if (call === 1) {
        handlers?.onText?.("AgentLoop");
        return {
          content: "AgentLoop",
          reasoning: "search then answer",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "list_dir",
                arguments: '{"target_directory":"."}',
              },
            },
          ],
          finish_reason: "tool_calls",
        };
      }
      handlers?.onText?.("Saw **9 matches** under src/.");
      return {
        content: "Saw **9 matches** under src/.",
        reasoning: "",
        tool_calls: [],
        finish_reason: "stop",
      };
    };

    await agent.handle("grep AgentLoop", {
      provider: "openrouter",
      model: "test-model",
      cwd: process.cwd(),
      tools: true,
      lightReasoning: true,
      subagents: false,
      chatImpl,
      label: "t.prefix",
    });

    const asst = store.state.messages.find((m) => m.role === "assistant");
    const textParts = asst?.parts.filter((p) => p.type === "text") ?? [];
    assertEq(textParts.length, 1);
    const content =
      textParts[0] && textParts[0].type === "text"
        ? textParts[0].content
        : "";
    assertIncludes(content, "9 matches");
    assert(
      !content.startsWith("AgentLoop"),
      `tool-round prefix leaked: ${JSON.stringify(content)}`,
    );
    assert(
      !content.includes("AgentLoopSaw"),
      `concatenated mid-tool + final: ${JSON.stringify(content)}`,
    );
    assertEq(content, "Saw **9 matches** under src/.");
  });

  s.test("tool round plan-speak does not remain as final answer text", async () => {
    const store = new HarnessStore({ model: "m", provider: "openrouter" });
    const agent = new AgentLoop(store);
    let call = 0;
    const chatImpl = async (
      _req: ChatRequest,
      handlers?: StreamHandlers,
    ): Promise<ChatResult> => {
      call++;
      if (call === 1) {
        const plan =
          "The user wants me to use list_dir on the current directory.";
        // Simulate stream that would have polluted the text channel
        handlers?.onText?.(plan);
        handlers?.onReasoning?.(plan);
        return {
          // After real partition this is empty; mock returns plan-speak as content
          // to prove loop clears non-meaningful text before tools / final
          content: plan,
          reasoning: plan,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "list_dir",
                arguments: '{"target_directory":"."}',
              },
            },
          ],
          finish_reason: "tool_calls",
        };
      }
      handlers?.onText?.("Top-level: package.json, src");
      return {
        content: "Top-level: package.json, src",
        reasoning: "",
        tool_calls: [],
        finish_reason: "stop",
      };
    };

    await agent.handle("list top-level files", {
      provider: "openrouter",
      model: "test-model",
      cwd: process.cwd(),
      tools: true,
      lightReasoning: true,
      subagents: false,
      chatImpl,
      label: "t.plan",
    });

    const asst = store.state.messages.find((m) => m.role === "assistant");
    const textParts =
      asst?.parts.filter((p) => p.type === "text") ?? [];
    assertEq(textParts.length, 1);
    const content =
      textParts[0] && textParts[0].type === "text"
        ? textParts[0].content
        : "";
    assert(!/^the user wants/i.test(content.trim()), content);
    assertIncludes(content, "package.json");
    // Joined multi-part garbage would include plan-speak length > answer
    assert(
      !content.includes("The user wants"),
      `plan-speak leaked into final text: ${content}`,
    );
  });

  return s;
}
