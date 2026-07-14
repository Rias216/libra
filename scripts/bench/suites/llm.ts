/**
 * LLM client helpers (offline) — tool id normalize, reasoning merge, extract.
 */

import {
  extractReasoningFromMessage,
  mergeReasoningText,
  normalizeToolCalls,
} from "../../../src/llm/client.js";
import { Suite, assert, assertEq, assertIncludes } from "../runner.js";

export function suiteLlm(): Suite {
  const s = new Suite("llm-helpers");

  s.test("normalizeToolCalls fills missing ids", () => {
    const out = normalizeToolCalls([
      {
        id: "",
        type: "function",
        function: { name: "list_dir", arguments: "{}" },
      },
      {
        function: { name: "read_file", arguments: '{"target_file":"a"}' },
      },
    ]);
    assertEq(out.length, 2);
    assert(out[0]!.id.length > 0, "id0");
    assert(out[1]!.id.length > 0, "id1");
    assertEq(out[0]!.function.name, "list_dir");
    assertEq(out[1]!.function.name, "read_file");
  });

  s.test("normalizeToolCalls drops empty names", () => {
    const out = normalizeToolCalls([
      { function: { name: "", arguments: "{}" } },
      { id: "x", function: { name: "grep", arguments: "{}" } },
    ]);
    assertEq(out.length, 1);
    assertEq(out[0]!.function.name, "grep");
  });

  s.test("mergeReasoningText prefers reasoning when content empty", () => {
    const t = mergeReasoningText("", "plan: use list_dir");
    assertEq(t, "plan: use list_dir");
  });

  s.test("mergeReasoningText prefers content when reasoning empty", () => {
    assertEq(mergeReasoningText("hello", ""), "hello");
  });

  s.test("mergeReasoningText joins distinct", () => {
    const t = mergeReasoningText("answer", "thoughts");
    assertIncludes(t, "thoughts");
    assertIncludes(t, "answer");
  });

  s.test("mergeReasoningText dedupes contained", () => {
    const t = mergeReasoningText("full plan here", "full");
    assert(t === "full plan here" || t.includes("full plan"), t);
  });

  s.test("extractReasoningFromMessage.reasoning", () => {
    assertEq(
      extractReasoningFromMessage({ reasoning: "r1" }),
      "r1",
    );
  });

  s.test("extractReasoningFromMessage.reasoning_content", () => {
    assertEq(
      extractReasoningFromMessage({ reasoning_content: "rc" }),
      "rc",
    );
  });

  s.test("extractReasoningFromMessage.reasoning_details", () => {
    const t = extractReasoningFromMessage({
      reasoning_details: [
        { type: "reasoning.text", text: "a" },
        { type: "reasoning.text", text: "b" },
      ],
    });
    assertEq(t, "ab");
  });

  s.test("extractReasoningFromMessage empty", () => {
    assertEq(extractReasoningFromMessage(null), "");
    assertEq(extractReasoningFromMessage({}), "");
  });

  return s;
}
