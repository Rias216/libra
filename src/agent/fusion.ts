/**
 * Ultra + Fusion — multi-model side-by-side REASONING ONLY.
 *
 * Pipeline:
 *  1. Fan-out the user prompt to N chosen models (reasoning effort max)
 *  2. Each model produces analysis only (no tools, no file edits)
 *  3. A judge model fuses candidates into the best synthesis
 *
 * Unrelated to per-model provider "effort" flags as a product surface —
 * this is a Libra harness profile above `ultra`.
 */

import type { HarnessStore } from "../core/store.js";
import { newId } from "../core/types.js";
import type { ProviderId } from "../auth/types.js";
import { getProvider } from "../auth/types.js";
import { resolveToken } from "../auth/api-key.js";
import { getCredential } from "../auth/store.js";
import {
  fetchAllConnectedModels,
  parseModelKey,
  pickHighestReasoningModel,
  modelKey,
} from "../auth/models.js";
import {
  loadAgentSettings,
  type FusionConfig,
} from "./config.js";

export interface FusionCandidate {
  modelKey: string;
  provider: ProviderId;
  model: string;
  text: string;
  error?: string;
  ms: number;
}

export interface FusionResult {
  candidates: FusionCandidate[];
  fused: string;
  judgeModelKey: string;
  analysis: string;
}

const REASONING_SYSTEM = `You are a pure reasoning engine.
REASONING ONLY — do not claim to edit files, run tools, or take actions.
Produce a thorough analysis, plan, and trade-offs for the user request.
Be concrete and structured. No filler.`;

const FUSE_SYSTEM = `You are a fusion judge for multi-model reasoning.
You receive several independent analyses of the same problem.
Your job:
1. Compare strengths/weaknesses of each analysis
2. Resolve contradictions
3. Synthesize the single best reasoning result
REASONING ONLY — do not execute tools or edit files.
Output a clear final analysis and recommended plan.`;

/**
 * Resolve which models participate in fusion.
 * Uses config.modelKeys when set; otherwise picks top reasoning models
 * across connected providers (up to maxParallel).
 */
export async function resolveFusionModels(
  fusion: FusionConfig,
): Promise<string[]> {
  if (fusion.modelKeys.length >= (fusion.minModels || 2)) {
    return fusion.modelKeys.slice(0, fusion.maxParallel);
  }
  const { models } = await fetchAllConnectedModels({ force: false });
  if (models.length === 0) return fusion.modelKeys;

  // Prefer distinct providers, reasoning models first
  const scored = [...models].sort((a, b) => {
    const sa = (a.reasoning ? 50 : 0) + reasonBoost(a.id);
    const sb = (b.reasoning ? 50 : 0) + reasonBoost(b.id);
    return sb - sa;
  });

  const picked: string[] = [];
  const seenProv = new Set<string>();
  for (const m of scored) {
    if (picked.length >= fusion.maxParallel) break;
    const key = modelKey({ provider: m.provider, model: m.id });
    if (fusion.modelKeys.includes(key) || !seenProv.has(m.provider)) {
      picked.push(key);
      seenProv.add(m.provider);
    }
  }
  // Fill remaining slots even from same provider
  for (const m of scored) {
    if (picked.length >= fusion.maxParallel) break;
    const key = modelKey({ provider: m.provider, model: m.id });
    if (!picked.includes(key)) picked.push(key);
  }
  return picked.length >= 2 ? picked : fusion.modelKeys;
}

function reasonBoost(id: string): number {
  const x = id.toLowerCase();
  let s = 0;
  if (/reason|thinking|o3|o4|opus|4\.5|pro/.test(x)) s += 30;
  if (/mini|flash|haiku|lite|fast/.test(x)) s -= 15;
  return s;
}

/** Run full fusion pipeline and stream reasoning parts into the store. */
export async function runFusionReasoning(
  store: HarnessStore,
  userPrompt: string,
): Promise<FusionResult> {
  const settings = loadAgentSettings();
  const fusion = settings.reasoning.fusion;
  const modelKeys = await resolveFusionModels(fusion);

  if (modelKeys.length < 2) {
    throw new Error(
      "Fusion needs at least 2 models. Connect more providers (/login) or pick models in /reasoning → Ultra + Fusion.",
    );
  }

  store.setPhase("thinking", "fusion: parallel reasoning");
  const assistant = store.startAssistant();
  const mid = assistant.id;

  // Intro reasoning block
  const introId = newId("p");
  store.appendPart(mid, {
    id: introId,
    type: "reasoning",
    content: "",
    streaming: true,
  });
  const intro =
    `Ultra + Fusion (reasoning only)\n` +
    `Models: ${modelKeys.join(", ")}\n` +
    `Running side-by-side analyses…\n`;
  store.reasoningDelta(mid, introId, intro);
  store.patchPart(mid, introId, { streaming: false } as never);

  // Parallel candidates
  store.setPhase("thinking", `fusion: ${modelKeys.length} models`);
  const candidates = await Promise.all(
    modelKeys.map((key) => runOneReasoning(key, userPrompt, fusion)),
  );

  for (const c of candidates) {
    const pid = newId("p");
    store.appendPart(mid, {
      id: pid,
      type: "reasoning",
      content: "",
      streaming: true,
    });
    const header = c.error
      ? `[${c.modelKey}] ERROR: ${c.error}\n`
      : `[${c.modelKey}] (${c.ms}ms)\n`;
    store.reasoningDelta(mid, pid, header + (c.text || "(empty)"));
    store.patchPart(mid, pid, { streaming: false } as never);
  }

  // Judge / fuse
  let judgeKey = fusion.judgeModelKey;
  if (!judgeKey) {
    const { models } = await fetchAllConnectedModels({ force: false });
    const best = pickHighestReasoningModel(models);
    judgeKey = best
      ? modelKey({ provider: best.provider, model: best.id })
      : modelKeys[0]!;
  }

  store.setPhase("thinking", `fusion: judge ${judgeKey}`);
  const analysisBody = candidates
    .map(
      (c, i) =>
        `### Candidate ${i + 1}: ${c.modelKey}\n${c.error ? `ERROR: ${c.error}` : c.text}`,
    )
    .join("\n\n");

  const fuseUser =
    `${fusion.fuseInstructions || "Fuse into the best single analysis."}\n\n` +
    `## Original request\n${userPrompt}\n\n` +
    `## Candidate analyses\n${analysisBody}`;

  const fused = await runOneReasoning(judgeKey, fuseUser, fusion, FUSE_SYSTEM);

  const fuseId = newId("p");
  store.appendPart(mid, {
    id: fuseId,
    type: "reasoning",
    content: "",
    streaming: true,
  });
  store.reasoningDelta(
    mid,
    fuseId,
    `[FUSED by ${judgeKey}]\n` + (fused.text || fused.error || "(empty)"),
  );
  store.patchPart(mid, fuseId, { streaming: false } as never);

  // User-visible summary text (still reasoning-only product — short note)
  const textId = newId("p");
  store.appendPart(mid, {
    id: textId,
    type: "text",
    content: "",
    streaming: true,
  });
  const summary =
    `**Ultra + Fusion** complete (reasoning only).\n\n` +
    `Ran **${candidates.length}** models side-by-side, then fused via \`${judgeKey}\`.\n\n` +
    (fused.text
      ? fused.text
      : `Fusion judge failed: ${fused.error ?? "unknown"}`);
  // stream-ish in chunks
  for (const chunk of summary.match(/.{1,80}/g) ?? [summary]) {
    store.textDelta(mid, textId, chunk);
  }
  store.patchPart(mid, textId, { streaming: false } as never);

  store.addTokens(0, Math.ceil(summary.length / 4));
  store.setPhase("idle");

  return {
    candidates,
    fused: fused.text,
    judgeModelKey: judgeKey,
    analysis: analysisBody,
  };
}

async function runOneReasoning(
  key: string,
  userPrompt: string,
  fusion: FusionConfig,
  system: string = REASONING_SYSTEM +
    (fusion.analysisInstructions
      ? `\n\nExtra instructions:\n${fusion.analysisInstructions}`
      : ""),
): Promise<FusionCandidate> {
  const ref = parseModelKey(key);
  const started = Date.now();
  if (!ref) {
    return {
      modelKey: key,
      provider: "custom",
      model: key,
      text: "",
      error: "invalid model key (use provider/model)",
      ms: 0,
    };
  }
  try {
    const text = await completeReasoningOnly({
      provider: ref.provider,
      model: ref.model,
      system,
      user: userPrompt,
    });
    return {
      modelKey: key,
      provider: ref.provider,
      model: ref.model,
      text,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      modelKey: key,
      provider: ref.provider,
      model: ref.model,
      text: "",
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
    };
  }
}

/** Minimal chat completion — text only, no tools. */
async function completeReasoningOnly(opts: {
  provider: ProviderId;
  model: string;
  system: string;
  user: string;
}): Promise<string> {
  const def = getProvider(opts.provider);
  if (!def) throw new Error(`unknown provider ${opts.provider}`);
  const token = resolveToken(opts.provider);
  if (!token) throw new Error(`${opts.provider} not logged in`);
  const cred = getCredential(opts.provider);
  const base = (cred?.meta?.baseUrl || def.baseUrl || "").replace(/\/$/, "");

  if (def.modelsStyle === "gemini") {
    return completeGemini(base, token, opts.model, opts.system, opts.user);
  }
  if (def.modelsStyle === "anthropic") {
    return completeAnthropic(base, token, opts.model, opts.system, opts.user);
  }
  // OpenAI-compatible (xAI, OpenAI, OpenRouter, custom, codex)
  return completeOpenAI(base, token, opts.provider, opts.model, opts.system, opts.user);
}

async function completeOpenAI(
  baseUrl: string,
  token: string,
  provider: ProviderId,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  if (!baseUrl) throw new Error("missing base URL");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/libra-tui";
    headers["X-Title"] = "Libra Fusion";
  }
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.3,
  };
  // Best-effort reasoning effort for APIs that accept it
  if (provider === "xai" || provider === "openai" || provider === "codex") {
    body.reasoning_effort = "high";
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => c.text ?? "").join("");
  }
  return "";
}

async function completeGemini(
  baseUrl: string,
  token: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const base = baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const id = model.replace(/^models\//, "");
  const url = `${base}/models/${id}:generateContent?key=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (
    json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
    ""
  );
}

async function completeAnthropic(
  baseUrl: string,
  token: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const base = baseUrl || "https://api.anthropic.com";
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return (json.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}
