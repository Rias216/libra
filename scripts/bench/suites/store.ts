/**
 * Core store / events suite — message parts, tool status, tokens, phase.
 */

import { HarnessStore } from "../../../src/core/store.js";
import { newId } from "../../../src/core/types.js";
import { Suite, assert, assertEq, assertGte } from "../runner.js";

export function suiteStore(): Suite {
  const s = new Suite("store");

  s.test("appendUser + startAssistant", () => {
    const store = new HarnessStore({ model: "m", provider: "p" });
    const events: string[] = [];
    store.subscribe((e) => events.push(e.type));
    store.appendUser("hi");
    const a = store.startAssistant();
    assertEq(store.state.messages.length, 2);
    assertEq(store.state.messages[0]!.role, "user");
    assertEq(a.role, "assistant");
    assert(events.includes("message.append"), events.join(","));
  });

  s.test("text streaming deltas", () => {
    const store = new HarnessStore({});
    const a = store.startAssistant();
    const pid = newId("p");
    store.appendPart(a.id, {
      id: pid,
      type: "text",
      content: "",
      streaming: true,
    });
    store.textDelta(a.id, pid, "Hel");
    store.textDelta(a.id, pid, "lo");
    store.patchPart(a.id, pid, { streaming: false } as never);
    const part = store.state.messages[0]!.parts[0]!;
    assert(part.type === "text" && part.content === "Hello", JSON.stringify(part));
    assert(part.type === "text" && part.streaming === false);
  });

  s.test("reasoning deltas", () => {
    const store = new HarnessStore({});
    const a = store.startAssistant();
    const pid = newId("p");
    store.appendPart(a.id, {
      id: pid,
      type: "reasoning",
      content: "",
      streaming: true,
    });
    store.reasoningDelta(a.id, pid, "think");
    const part = store.state.messages[0]!.parts[0]!;
    assert(part.type === "reasoning" && part.content === "think");
  });

  s.test("text.delta does not mutate reasoning parts (no escape)", () => {
    const store = new HarnessStore({});
    const a = store.startAssistant();
    const pid = newId("p");
    store.appendPart(a.id, {
      id: pid,
      type: "reasoning",
      content: "plan",
      streaming: true,
    });
    // Mis-routed text delta must be ignored
    store.textDelta(a.id, pid, " LEAKED");
    const part = store.state.messages[0]!.parts[0]!;
    assert(part.type === "reasoning" && part.content === "plan", JSON.stringify(part));
  });

  s.test("tool status pipeline", () => {
    const store = new HarnessStore({});
    const a = store.startAssistant();
    const pid = newId("p");
    store.appendPart(a.id, {
      id: pid,
      type: "tool",
      toolName: "list_dir",
      args: { target_directory: "." },
      status: "pending",
    });
    store.toolStatus(a.id, pid, "running");
    store.toolStatus(a.id, pid, "completed", { result: "ok-files" });
    const part = store.state.messages[0]!.parts[0]!;
    assert(part.type === "tool");
    if (part.type === "tool") {
      assertEq(part.status, "completed");
      assertEq(part.result, "ok-files");
    }
  });

  s.test("tool error status", () => {
    const store = new HarnessStore({});
    const a = store.startAssistant();
    const pid = newId("p");
    store.appendPart(a.id, {
      id: pid,
      type: "tool",
      toolName: "grep",
      args: {},
      status: "running",
    });
    store.toolStatus(a.id, pid, "error", { error: "boom" });
    const part = store.state.messages[0]!.parts[0]!;
    assert(part.type === "tool" && part.status === "error" && part.error === "boom");
  });

  s.test("phase + tokens", () => {
    const store = new HarnessStore({});
    store.setPhase("streaming", "go");
    assertEq(store.state.phase, "streaming");
    store.addTokens(100, 50);
    store.addTokens(10, 5);
    assertEq(store.state.tokens.input, 110);
    assertEq(store.state.tokens.output, 55);
    store.setPhase("idle");
    assertEq(store.state.phase, "idle");
  });

  s.test("reset preserves session meta overrides", () => {
    const store = new HarnessStore({ model: "a", provider: "x", title: "t" });
    store.appendUser("x");
    store.reset({ model: "b" });
    assertEq(store.state.messages.length, 0);
    assertEq(store.state.session.model, "b");
  });

  s.test("event fan-out to multiple subscribers", () => {
    const store = new HarnessStore({});
    let a = 0;
    let b = 0;
    const off1 = store.subscribe(() => {
      a++;
    });
    store.subscribe(() => {
      b++;
    });
    store.appendUser("1");
    store.appendUser("2");
    assertGte(a, 2);
    assertGte(b, 2);
    off1();
    const aBefore = a;
    store.appendUser("3");
    assertEq(a, aBefore, "unsubscribed should not fire");
    assertGte(b, 3);
  });

  s.test("many parts throughput", () => {
    const store = new HarnessStore({});
    const a = store.startAssistant();
    const t0 = Date.now();
    const N = 500;
    for (let i = 0; i < N; i++) {
      store.appendPart(a.id, {
        id: newId("p"),
        type: "text",
        content: `chunk ${i}`,
      });
    }
    const ms = Date.now() - t0;
    assertEq(store.state.messages[0]!.parts.length, N);
    return { N, ms, partsPerSec: Math.round(N / (ms / 1000 || 1)) };
  });

  return s;
}
