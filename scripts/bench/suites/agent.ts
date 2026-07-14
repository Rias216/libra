/**
 * Agent loop helpers (offline) — system prompt, multi-part history shaping.
 */

import {
  buildSystemPrompt,
  AgentLoop,
  toolFingerprint,
  normalizeToolArgs,
} from "../../../src/agent/loop.js";
import { HarnessStore } from "../../../src/core/store.js";
import { newId } from "../../../src/core/types.js";
import { Suite, assert, assertIncludes, assertEq } from "../runner.js";

export function suiteAgent(): Suite {
  const s = new Suite("agent-loop");

  s.test("buildSystemPrompt base", () => {
    const p = buildSystemPrompt();
    assertIncludes(p, "Libra");
    assertIncludes(p, "tools");
    assertIncludes(p, "re-run");
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

  return s;
}
