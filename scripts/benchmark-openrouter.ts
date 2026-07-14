/**
 * Benchmark free OpenRouter models for latency + tool-calling.
 *
 *   npx tsx scripts/benchmark-openrouter.ts
 *
 * Uses OPENROUTER_API_KEY or key saved via /login openrouter.
 */

import { saveApiKey, resolveToken } from "../src/auth/api-key.js";
import { OPENAI_TOOLS } from "../src/toolcalling/schema.js";
import { ToolExecutor } from "../src/toolcalling/executor.js";

const KEY =
  process.env.OPENROUTER_API_KEY ||
  resolveToken("openrouter") ||
  "";

const BASE = "https://openrouter.ai/api/v1";

interface BenchRow {
  model: string;
  ok: boolean;
  latencyMs: number;
  ttftMs?: number;
  toolCall: boolean;
  toolOk?: boolean;
  tokensOut?: number;
  error?: string;
  preview?: string;
}

async function main(): Promise<void> {
  if (!KEY) {
    console.error("No OpenRouter key. Set OPENROUTER_API_KEY or /login openrouter");
    process.exit(1);
  }
  // Persist for the TUI session
  saveApiKey("openrouter", KEY, { label: "benchmark" });

  console.log("Fetching model list…");
  const models = await listFreeModels();
  console.log(`Found ${models.length} free-ish models (sample up to 8)\n`);

  // Prefer models that look instruction-tuned / small for free tier
  const pick = pickModels(models, 8);
  if (pick.length === 0) {
    console.log("No free models found; trying known free IDs…");
    pick.push(
      "openrouter/free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemma-3-4b-it:free",
      "qwen/qwen3-4b:free",
      "mistralai/mistral-small-3.1-24b-instruct:free",
    );
  }

  const rows: BenchRow[] = [];
  for (const model of pick) {
    process.stdout.write(`bench ${model} … `);
    const row = await benchModel(model);
    rows.push(row);
    console.log(
      row.ok
        ? `OK ${row.latencyMs}ms ttft=${row.ttftMs ?? "-"} tools=${row.toolCall ? (row.toolOk ? "yes" : "fail") : "no"}`
        : `FAIL ${row.error?.slice(0, 80)}`,
    );
  }

  console.log("\n=== Benchmark summary ===\n");
  console.log(
    "model".padEnd(52) +
      "lat".padStart(8) +
      "ttft".padStart(8) +
      "tools".padStart(8) +
      "  status",
  );
  console.log("-".repeat(90));
  for (const r of rows.sort((a, b) => (a.ok === b.ok ? a.latencyMs - b.latencyMs : a.ok ? -1 : 1))) {
    console.log(
      r.model.slice(0, 50).padEnd(52) +
        String(r.latencyMs).padStart(8) +
        String(r.ttftMs ?? "-").padStart(8) +
        (r.toolCall ? (r.toolOk ? "ok" : "fail") : "—").padStart(8) +
        `  ${r.ok ? "ok" : "err"}`,
    );
  }

  const best = rows.filter((r) => r.ok).sort((a, b) => a.latencyMs - b.latencyMs)[0];
  if (best) {
    console.log(`\nFastest OK: ${best.model} (${best.latencyMs}ms)`);
    console.log(`\nTo use in Libra:\n  /login openrouter (already saved)\n  /model ${best.model}`);
  }
}

async function listFreeModels(): Promise<string[]> {
  const res = await fetch(`${BASE}/models`, {
    headers: {
      Authorization: `Bearer ${KEY}`,
      "HTTP-Referer": "https://github.com/libra-tui",
      "X-Title": "Libra Bench",
    },
  });
  if (!res.ok) throw new Error(`models HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }>;
  };
  const ids: string[] = [];
  for (const m of json.data ?? []) {
    if (!m.id) continue;
    const free =
      m.id.includes(":free") ||
      m.id.includes("free") ||
      (m.pricing?.prompt === "0" && m.pricing?.completion === "0");
    if (free) ids.push(m.id);
  }
  return ids.sort();
}

function pickModels(all: string[], n: number): string[] {
  // Prefer small/fast sounding free models
  const scored = all.map((id) => {
    let s = 0;
    if (/:free$/i.test(id)) s += 10;
    if (/3b|4b|7b|8b|small|mini|gemma|qwen3-4|mistral-small|llama-3\.2|llama-3\.1-8/i.test(id))
      s += 20;
    if (/70b|405b|large|r1|deepseek/i.test(id)) s -= 5;
    if (/nightride|hy3|hydra/i.test(id)) s += 30; // user mentioned hy3
    return { id, s };
  });
  scored.sort((a, b) => b.s - a.s || a.id.localeCompare(b.id));
  return scored.slice(0, n).map((x) => x.id);
}

async function benchModel(model: string): Promise<BenchRow> {
  const t0 = Date.now();
  let ttft: number | undefined;
  try {
    // 1) Simple latency / TTFT
    const simple = await streamChat(model, [
      { role: "user", content: "Reply with exactly: pong" },
    ]);
    ttft = simple.ttftMs;
    const latencyMs = Date.now() - t0;

    // 2) Tool-calling round
    let toolCall = false;
    let toolOk = false;
    const toolRes = await streamChat(
      model,
      [
        {
          role: "system",
          content: "You are a tool-using agent. Use list_dir when asked about files.",
        },
        {
          role: "user",
          content: "List the workspace root directory using the list_dir tool.",
        },
      ],
      true,
    );
    if (toolRes.tool_calls.length > 0) {
      toolCall = true;
      const tc = toolRes.tool_calls[0]!;
      const exec = new ToolExecutor(process.cwd());
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* */
      }
      const out = await exec.run(tc.function.name, args);
      toolOk = out.ok && out.output.length > 0;
    }

    return {
      model,
      ok: true,
      latencyMs,
      ttftMs: ttft,
      toolCall,
      toolOk,
      tokensOut: simple.content.length,
      preview: simple.content.slice(0, 40),
    };
  } catch (err) {
    return {
      model,
      ok: false,
      latencyMs: Date.now() - t0,
      toolCall: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function streamChat(
  model: string,
  messages: Array<{ role: string; content: string }>,
  withTools = false,
): Promise<{
  content: string;
  tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>;
  ttftMs?: number;
}> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature: 0,
  };
  if (withTools) {
    body.tools = OPENAI_TOOLS.slice(0, 3); // small set for free models
    body.tool_choice = "auto";
  }

  const t0 = Date.now();
  let ttft: number | undefined;
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/libra-tui",
      "X-Title": "Libra Bench",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  const toolCalls: Array<{
    id: string;
    function: { name: string; arguments: string };
  }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (data === "[DONE]") continue;
      let json: {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        if (ttft == null) ttft = Date.now() - t0;
        content += delta.content;
      }
      if (delta.tool_calls) {
        if (ttft == null) ttft = Date.now() - t0;
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          while (toolCalls.length <= idx) {
            toolCalls.push({ id: "", function: { name: "", arguments: "" } });
          }
          const cur = toolCalls[idx]!;
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) {
            cur.function.arguments += tc.function.arguments;
          }
        }
      }
    }
  }

  return {
    content,
    tool_calls: toolCalls.filter((t) => t.function.name),
    ttftMs: ttft,
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
