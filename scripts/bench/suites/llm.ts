/**
 * LLM client helpers (offline) — tool id normalize, reasoning merge, extract.
 */

import {
  attachInTurnReasoning,
  buildAssistantToolRoundMessage,
  ContentReasoningSplitter,
  extractReasoningFromMessage,
  mergeReasoningText,
  normalizeToolCalls,
  ensureAnswerChannel,
  extractLikelyAnswer,
  hasBrokenToolCallArgs,
  isFreeModelId,
  isIncompleteToolArguments,
  isLengthFinish,
  lengthContinuationNudge,
  OUTPUT_TOKEN_FREE,
  OUTPUT_TOKEN_MAX,
  OUTPUT_TOKEN_TOOLS,
  partitionModelOutput,
  isAllPlanSpeak,
  isMeaningfulAnswer,
  peelLeadingPlanSpeak,
  peelThinkTags,
  resolveMaxOutputTokens,
} from "../../../src/llm/client.js";
import { Suite, assert, assertEq, assertIncludes, assertGte } from "../runner.js";

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

  s.test("peelThinkTags strips <think> from content", () => {
    const r = peelThinkTags(
      "Before\n<think>secret plan</think>\nAfter answer",
    );
    assertIncludes(r.reasoning, "secret plan");
    assertIncludes(r.content, "Before");
    assertIncludes(r.content, "After answer");
    assert(!r.content.includes("secret plan"), r.content);
  });

  s.test("partitionModelOutput drops exact content=reasoning echo", () => {
    const r = partitionModelOutput(
      "I will list files then delete them",
      "I will list files then delete them",
    );
    assertEq(r.content, "");
    assertIncludes(r.reasoning, "list files");
  });

  s.test("partitionModelOutput keeps distinct answer + reasoning", () => {
    const r = partitionModelOutput(
      "Deleted 3 files.",
      "User asked to delete; I used rm.",
    );
    assertIncludes(r.content, "Deleted");
    assertIncludes(r.reasoning, "User asked");
  });

  s.test("ContentReasoningSplitter handles chunked think tags", () => {
    const s = new ContentReasoningSplitter();
    const a = s.push("Hello <th");
    const b = s.push("ink>hidden");
    const c = s.push(" thoughts</think> visible");
    const d = s.flush();
    const text = a.text + b.text + c.text + d.text;
    const reason = a.reasoning + b.reasoning + c.reasoning + d.reasoning;
    assertIncludes(text, "Hello");
    assertIncludes(text, "visible");
    assert(!text.includes("hidden"), text);
    assertIncludes(reason, "hidden");
    assertIncludes(reason, "thoughts");
  });

  s.test("ensureAnswerChannel promotes reasoning when content empty", () => {
    // hy3:free often only fills reasoning with max_tokens budget
    const r = ensureAnswerChannel("", "The answer is pong", {
      rawContentEmpty: true,
    });
    assertEq(r.content, "The answer is pong");
    assertEq(r.reasoning, "The answer is pong");
    // After partition emptied a CoT echo, do NOT re-promote (would restore CoT)
    const parted = partitionModelOutput("same", "same");
    assertEq(parted.content, "");
    const noPromote = ensureAnswerChannel(parted.content, parted.reasoning, {
      rawContentEmpty: false,
    });
    assertEq(noPromote.content, "");
    assertIncludes(noPromote.reasoning, "same");
    // Non-empty content is preserved
    const keep = ensureAnswerChannel("pong", "long internal plan");
    assertEq(keep.content, "pong");
    assertEq(keep.reasoning, "long internal plan");
  });

  s.test("extractLikelyAnswer prefers quoted short answer over CoT", () => {
    const cot =
      'The user wants me to say hi in 2 words max.\nI should just output "Hi there".\n';
    assertEq(extractLikelyAnswer(cot), "Hi there");
    assertEq(extractLikelyAnswer("pong"), "pong");
  });

  // codex/opencode: mid-turn tool loop keeps reasoning on assistant messages
  s.test("attachInTurnReasoning sets reasoning + reasoning_content", () => {
    const base = {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function" as const,
          function: { name: "list_dir", arguments: "{}" },
        },
      ],
    };
    const withR = attachInTurnReasoning(base, "  plan: list then read  ");
    assertEq(withR.reasoning, "plan: list then read");
    assertEq(withR.reasoning_content, "plan: list then read");
    assertEq(withR.tool_calls?.length, 1);
    // empty / whitespace → omit fields
    const bare = attachInTurnReasoning(base, "   ");
    assertEq(bare.reasoning, undefined);
    assertEq(bare.reasoning_content, undefined);
  });

  s.test("buildAssistantToolRoundMessage wires content + tools + reasoning", () => {
    const msg = buildAssistantToolRoundMessage({
      content: "",
      tool_calls: [
        {
          id: "t1",
          type: "function",
          function: { name: "read_file", arguments: '{"target_file":"a"}' },
        },
      ],
      reasoning: "Need file contents before edit",
    });
    assertEq(msg.role, "assistant");
    assertEq(msg.content, null);
    assertEq(msg.tool_calls?.[0]?.function.name, "read_file");
    assertEq(msg.reasoning, "Need file contents before edit");
    assertEq(msg.reasoning_content, "Need file contents before edit");
  });

  // codex/opencode: generous output budgets so CoT cannot starve the answer
  s.test("resolveMaxOutputTokens is generous (not 1.5k/4k)", () => {
    assertEq(isFreeModelId("tencent/hy3:free"), true);
    assertEq(isFreeModelId("gpt-5"), false);
    const free = resolveMaxOutputTokens({ model: "tencent/hy3:free", tools: true });
    assertGte(free, OUTPUT_TOKEN_FREE);
    assert(free >= 8192, `free budget ${free} too small`);
    const tools = resolveMaxOutputTokens({ model: "gpt-5", tools: true });
    assertGte(tools, OUTPUT_TOKEN_TOOLS);
    assert(tools >= 16384, `tools budget ${tools} too small`);
    const cont = resolveMaxOutputTokens({
      model: "gpt-5",
      tools: true,
      lengthContinuation: true,
    });
    assertGte(cont, tools);
    assert(cont <= OUTPUT_TOKEN_MAX, String(cont));
    // explicit override respected but capped
    assertEq(
      resolveMaxOutputTokens({ model: "x", tools: true, explicit: 1000 }),
      1000,
    );
  });

  s.test("isLengthFinish + lengthContinuationNudge", () => {
    assert(isLengthFinish("length"));
    assert(isLengthFinish("max_tokens"));
    assert(!isLengthFinish("stop"));
    const n = lengthContinuationNudge("Hello world this is partial");
    assertIncludes(n, "cut off");
    assertIncludes(n, "Continue");
    assertIncludes(n, "Hello world");
  });

  s.test("partition keeps short answer even if also in reasoning", () => {
    // Old code wiped any content fully contained in longer reasoning
    const r = partitionModelOutput(
      "Done. Updated loop.ts.",
      "I should edit the file.\nPlan: change max_tokens.\nDone. Updated loop.ts.\nThen verify.",
    );
    assertIncludes(r.content, "Done");
    assertIncludes(r.reasoning, "Plan");
  });

  s.test("ensureAnswerChannel promotes on length cut", () => {
    const cot =
      "The completion hit max_tokens while I was still thinking.\n" +
      'I should finish by saying "pong" to the user.\n';
    const r = ensureAnswerChannel("", cot, { lengthCut: true });
    assertEq(r.content, "pong");
    assertIncludes(r.reasoning, "max_tokens");
  });

  s.test("partition preservePartialAnswer keeps exact echo on length cut", () => {
    const same = "partial answer cut mid-sente";
    const r = partitionModelOutput(same, same, { preservePartialAnswer: true });
    assertIncludes(r.content, "partial answer");
  });

  s.test("isIncompleteToolArguments / hasBrokenToolCallArgs", () => {
    assert(isIncompleteToolArguments('{"target_directory":'));
    assert(isIncompleteToolArguments(""));
    assert(isIncompleteToolArguments(null));
    assert(!isIncompleteToolArguments("{}"));
    assert(
      !isIncompleteToolArguments('{"target_directory":"."}'),
    );
    assert(
      hasBrokenToolCallArgs([
        { function: { arguments: '{"a":' } },
        { function: { arguments: "{}" } },
      ]),
    );
    assert(
      !hasBrokenToolCallArgs([{ function: { arguments: "{}" } }]),
    );
  });

  s.test("peelLeadingPlanSpeak drops The-user-wants prefix", () => {
    const raw =
      "The user wants me to list files then answer briefly.\n" +
      "Top-level: src, package.json";
    const p = peelLeadingPlanSpeak(raw);
    assertIncludes(p, "Top-level");
    assert(!/^the user wants/i.test(p.trim()), p);
    // via partition
    const part = partitionModelOutput(raw, "planning…");
    assertIncludes(part.content, "Top-level");
    assert(!/^the user wants/i.test(part.content.trim()), part.content);
  });

  s.test("pure plan-speak is stripped from answer channel", () => {
    const plan = "The user wants me to use list_dir on the current directory.";
    assert(isAllPlanSpeak(plan), "isAllPlanSpeak");
    assert(!isMeaningfulAnswer(plan), "not meaningful");
    // exact content=reasoning plan-speak echo
    const r = partitionModelOutput(plan, plan);
    assertEq(r.content, "");
    assertIncludes(r.reasoning, "list_dir");
    // content-only plan-speak (no separate reasoning)
    const r2 = partitionModelOutput(plan, "");
    assertEq(r2.content, "");
    assertIncludes(r2.reasoning, "The user wants");
    // peel pure plan-speak → empty
    assertEq(peelLeadingPlanSpeak(plan, { dropPurePlanSpeak: true }), "");
  });

  return s;
}
