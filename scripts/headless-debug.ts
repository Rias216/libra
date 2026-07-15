/**
 * Deep headless agent/LLM debug runner.
 * Exercises cutoffs, toolcalling, reasoning, multi-step continuity.
 *
 *   npx tsx scripts/headless-debug.ts
 *   LIBRA_DEBUG=trace LIBRA_DEBUG_FILE=... npx tsx scripts/headless-debug.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveToken } from "../src/auth/api-key.js";
import { saveApiKey } from "../src/auth/api-key.js";
import { saveConfig } from "../src/config/store.js";
import { HarnessStore } from "../src/core/store.js";
import { AgentLoop } from "../src/agent/loop.js";
import { initDebug, getDebugLogPath, dbg } from "../src/agent/debug.js";
import {
  isLengthFinish,
  lengthContinuationNudge,
  resolveMaxOutputTokens,
  attachInTurnReasoning,
  buildAssistantToolRoundMessage,
  partitionModelOutput,
  ensureAnswerChannel,
  isFreeModelId,
} from "../src/llm/client.js";
import { _testHistoryToMessages } from "../src/agent/loop.js";
import { newId } from "../src/core/types.js";

const SCRATCH =
  process.env.HEADLESS_OUT ||
  join(
    process.env.TEMP || process.env.TMP || ".",
    "grok-goal-ab9b3f6e4c68",
    "implementer",
    "headless",
  );

const MODEL = process.env.LIBRA_SMOKE_MODEL || "tencent/hy3:free";
const PROVIDER = "openrouter" as const;

interface ScenarioResult {
  name: string;
  ok: boolean;
  ms: number;
  errors: string[];
  observations: Record<string, unknown>;
}

function summarizeStore(store: HarnessStore) {
  const msgs = store.state.messages;
  const lastAsst = [...msgs].reverse().find((m) => m.role === "assistant");
  const tools =
    lastAsst?.parts
      .filter((p) => p.type === "tool")
      .map((p) =>
        p.type === "tool"
          ? {
              name: p.toolName,
              status: p.status,
              err: p.error?.slice(0, 120),
              resultLen: p.result?.length ?? 0,
            }
          : null,
      )
      .filter(Boolean) ?? [];
  const texts =
    lastAsst?.parts
      .filter((p) => p.type === "text")
      .map((p) => (p.type === "text" ? p.content : ""))
      .join("\n") ?? "";
  const reasoning =
    lastAsst?.parts
      .filter((p) => p.type === "reasoning")
      .map((p) => (p.type === "reasoning" ? p.content : ""))
      .join("\n") ?? "";
  return {
    phase: store.state.phase,
    phaseDetail: store.state.phaseDetail,
    tools,
    textLen: texts.length,
    textPreview: texts.slice(0, 400),
    reasoningLen: reasoning.length,
    reasoningPreview: reasoning.slice(0, 200),
    tokens: store.state.tokens,
    msgCount: msgs.length,
  };
}

async function runScenario(
  name: string,
  prompt: string,
  opts: {
    tools?: boolean;
    lightReasoning?: boolean;
    expectTool?: string | RegExp;
    expectText?: RegExp;
    minTextLen?: number;
    multiTurn?: { second: string; expectText2?: RegExp }[];
  },
): Promise<ScenarioResult> {
  const errors: string[] = [];
  const t0 = Date.now();
  const store = new HarnessStore({
    provider: PROVIDER,
    model: MODEL,
    title: `headless:${name}`,
  });
  store.subscribe(() => {});
  const agent = new AgentLoop(store);
  dbg("headless", `scenario.${name}.start`, { prompt: prompt.slice(0, 120) });

  try {
    await agent.handle(prompt, {
      provider: PROVIDER,
      model: MODEL,
      cwd: process.cwd(),
      tools: opts.tools !== false,
      lightReasoning: opts.lightReasoning ?? false,
      label: `hd.${name}`,
    });
  } catch (e) {
    errors.push(`throw: ${e instanceof Error ? e.message : String(e)}`);
  }

  const sum = summarizeStore(store);
  if (store.state.phase === "error") {
    errors.push(`phase=error detail=${store.state.phaseDetail}`);
  }
  if (opts.expectTool) {
    const re =
      typeof opts.expectTool === "string"
        ? new RegExp(opts.expectTool)
        : opts.expectTool;
    const hit = sum.tools.some(
      (t) => t && re.test(t.name) && t.status === "completed",
    );
    if (!hit) {
      errors.push(
        `expected completed tool matching ${opts.expectTool}; got ${JSON.stringify(sum.tools)}`,
      );
    }
  }
  if (opts.expectText && !opts.expectText.test(sum.textPreview)) {
    errors.push(
      `expected text matching ${opts.expectText}; got: ${sum.textPreview.slice(0, 200)}`,
    );
  }
  if (opts.minTextLen != null && sum.textLen < opts.minTextLen) {
    errors.push(`text too short: ${sum.textLen} < ${opts.minTextLen}`);
  }
  // Stub / failure markers in final text
  if (/no final answer|model produced reasoning only/i.test(sum.textPreview)) {
    errors.push("stub final text after reasoning-only stop");
  }
  if (/\bundefined\b|\bnull\b|\[object Object\]/.test(sum.textPreview)) {
    errors.push("garbage tokens in final text");
  }

  // Multi-turn continuity
  if (opts.multiTurn?.length) {
    for (let i = 0; i < opts.multiTurn.length; i++) {
      const step = opts.multiTurn[i]!;
      try {
        await agent.handle(step.second, {
          provider: PROVIDER,
          model: MODEL,
          cwd: process.cwd(),
          tools: opts.tools !== false,
          lightReasoning: opts.lightReasoning ?? false,
          label: `hd.${name}.t${i + 2}`,
        });
      } catch (e) {
        errors.push(
          `turn${i + 2} throw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const s2 = summarizeStore(store);
      if (step.expectText2 && !step.expectText2.test(s2.textPreview)) {
        errors.push(
          `turn${i + 2} text mismatch ${step.expectText2}: ${s2.textPreview.slice(0, 160)}`,
        );
      }
      // Wire history must include proper tool protocol after first turn
      const wire = _testHistoryToMessages(store);
      const hasToolRole = wire.some((m) => m.role === "tool");
      const hasAsstTools = wire.some(
        (m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0,
      );
      dbg("headless", `scenario.${name}.history_wire`, {
        msgs: wire.length,
        hasToolRole,
        hasAsstTools,
        roles: wire.map((m) => m.role),
      });
      if (sum.tools.length > 0 && !hasToolRole && !hasAsstTools) {
        // soft warn → hard fail for multi-turn fidelity
        errors.push(
          "historyToMessages lacks tool_calls/tool roles after tool use (multi-turn fidelity)",
        );
      }
    }
  }

  const ms = Date.now() - t0;
  dbg("headless", `scenario.${name}.end`, {
    ok: errors.length === 0,
    ms,
    errors,
    ...sum,
  });
  return {
    name,
    ok: errors.length === 0,
    ms,
    errors,
    observations: sum,
  };
}

function offlineSelfChecks(): ScenarioResult {
  const errors: string[] = [];
  const t0 = Date.now();

  // budgets
  const free = resolveMaxOutputTokens({ model: "x:free", tools: true });
  if (free < 8192) errors.push(`free max_tokens too low: ${free}`);
  const paid = resolveMaxOutputTokens({ model: "gpt-5", tools: true });
  if (paid < 16384) errors.push(`paid max_tokens too low: ${paid}`);

  // length helpers
  if (!isLengthFinish("length")) errors.push("isLengthFinish broken");
  const nudge = lengthContinuationNudge("partial answer here");
  if (!/cut off/i.test(nudge)) errors.push("nudge missing cut off");

  // partition / answer channel
  const p = partitionModelOutput(
    "Done. Fixed loop.ts.",
    "I will edit loop.ts.\nDone. Fixed loop.ts.\nVerify next.",
  );
  if (!p.content.includes("Done")) {
    errors.push("partition wiped short answer");
  }
  const e = ensureAnswerChannel(
    "",
    'Thinking about the reply.\nI should say "ok-done" clearly.\n',
    { lengthCut: true },
  );
  if (e.content !== "ok-done") {
    errors.push(`ensureAnswer lengthCut got ${JSON.stringify(e.content)}`);
  }

  // mid-turn reasoning attach
  const msg = buildAssistantToolRoundMessage({
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "list_dir", arguments: "{}" },
      },
    ],
    reasoning: "need listing first",
  });
  if (msg.reasoning !== "need listing first" || !msg.reasoning_content) {
    errors.push("buildAssistantToolRoundMessage missing reasoning");
  }

  // free model detect
  if (!isFreeModelId("tencent/hy3:free")) errors.push("isFreeModelId");

  // history assembly structural
  const store = new HarnessStore({ provider: "openrouter", model: "m" });
  store.appendUser("list");
  const a = store.startAssistant();
  store.appendPart(a.id, {
    id: newId("p"),
    type: "reasoning",
    content: "list first",
  });
  store.appendPart(a.id, {
    id: newId("p"),
    type: "tool",
    toolName: "list_dir",
    args: { target_directory: "." },
    status: "completed",
    result: "a\nb\nc",
    // callId may be missing on older stores — assembly should still work
  } as never);
  store.appendPart(a.id, {
    id: newId("p"),
    type: "text",
    content: "found 3",
  });
  store.appendUser("next");
  const wire = _testHistoryToMessages(store);
  const asst = wire.find((m) => m.role === "assistant");
  if (!asst?.reasoning) errors.push("history missing reasoning");

  return {
    name: "offline_self_checks",
    ok: errors.length === 0,
    ms: Date.now() - t0,
    errors,
    observations: {
      freeBudget: free,
      paidBudget: paid,
      wireRoles: wire.map((m) => m.role),
      asstHasReasoning: Boolean(asst?.reasoning),
      asstHasToolCalls: Boolean(asst?.tool_calls?.length),
      hasToolRole: wire.some((m) => m.role === "tool"),
    },
  };
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  initDebug(process.env.LIBRA_DEBUG ? undefined : "info");
  const key = process.env.OPENROUTER_API_KEY || resolveToken("openrouter") || "";

  const results: ScenarioResult[] = [];
  results.push(offlineSelfChecks());

  if (!key) {
    const skip = {
      name: "live_skip",
      ok: false,
      ms: 0,
      errors: ["No OpenRouter key — live scenarios skipped"],
      observations: {},
    };
    results.push(skip);
    writeFileSync(
      join(SCRATCH, "live-skip.log"),
      "No OpenRouter key. Set OPENROUTER_API_KEY or /login openrouter\n",
      "utf8",
    );
  } else {
    saveApiKey("openrouter", key, { label: "headless" });
    saveConfig({
      provider: PROVIDER,
      model: MODEL,
      modelKey: `${PROVIDER}/${MODEL}`,
    });

    // 1) Tool loop basics
    results.push(
      await runScenario(
        "tool_list_dir",
        "Use list_dir on the current directory (.) and report the top-level names only. Be brief.",
        {
          tools: true,
          lightReasoning: false,
          expectTool: "list_dir",
          minTextLen: 5,
        },
      ),
    );

    // 2) Multi-tool: list then read
    results.push(
      await runScenario(
        "multi_tool_list_read",
        "1) list_dir on .\n2) read_file package.json (or the path you found) and report the package name field only. Use tools. Be brief.",
        {
          tools: true,
          lightReasoning: false,
          expectTool: /list_dir|read_file/,
          minTextLen: 3,
        },
      ),
    );

    // 3) Pure reasoning / chat (no tools) — check content not empty
    results.push(
      await runScenario(
        "chat_no_tools",
        "Reply with exactly one word: pong",
        {
          tools: false,
          lightReasoning: false,
          expectText: /pong/i,
          minTextLen: 3,
        },
      ),
    );

    // 4) Multi-turn continuity after tools
    results.push(
      await runScenario(
        "multi_turn_after_tools",
        "Use list_dir on . briefly. Just list names.",
        {
          tools: true,
          lightReasoning: false,
          expectTool: "list_dir",
          multiTurn: [
            {
              second:
                "From the previous tool results only: is package.json present? Answer yes or no.",
              expectText2: /yes|no/i,
            },
          ],
        },
      ),
    );

    // 5) Grep tool path
    results.push(
      await runScenario(
        "tool_grep",
        'Use the grep tool to search for "AgentLoop" under src/ with head_limit 5. Report how many matches you saw. Be brief.',
        {
          tools: true,
          lightReasoning: false,
          expectTool: "grep",
          minTextLen: 1,
        },
      ),
    );

    // 6) Force thinking then answer (reasoning stress)
    results.push(
      await runScenario(
        "reasoning_then_answer",
        "Think carefully about what 17*19 equals, then answer with ONLY the number.",
        {
          tools: false,
          lightReasoning: false,
          expectText: /323/,
          minTextLen: 2,
        },
      ),
    );
  }

  const report = {
    at: new Date().toISOString(),
    model: MODEL,
    provider: PROVIDER,
    debugLog: getDebugLogPath(),
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };

  const outJson = join(SCRATCH, "headless-results.json");
  writeFileSync(outJson, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("═══ HEADLESS DEBUG SUMMARY ═══");
  for (const r of results) {
    console.log(
      `${r.ok ? "✓" : "✗"} ${r.name} (${r.ms}ms)`,
      r.errors.length ? "→ " + r.errors.join("; ") : "",
    );
    if (r.observations && Object.keys(r.observations).length) {
      console.log(
        "   ",
        JSON.stringify(r.observations).slice(0, 240),
      );
    }
  }
  console.log(
    `passed=${report.passed} failed=${report.failed} debug=${report.debugLog}`,
  );
  console.log(`report → ${outJson}`);

  if (report.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
