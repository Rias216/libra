/**
 * Ultra + Fusion — both models REASON first; main COMPARES then EXECUTES.
 *
 * Pipeline:
 *  1. Main + secondary model(s) produce reasoning-only plans in parallel
 *     (max native effort, no tools / no edits)
 *  2. Main session model compares both (all) reasoning traces
 *  3. Main keeps what it deems valuable and executes with tools
 */

import type { HarnessStore } from "../core/store.js";
import { newId } from "../core/types.js";
import type { ProviderId } from "../auth/types.js";
import { getProvider } from "../auth/types.js";
import { resolveTokenFresh } from "../auth/api-key.js";
import { getCredential } from "../auth/store.js";
import {
  fetchAllConnectedModels,
  parseModelKey,
  modelKey,
} from "../auth/models.js";
import {
  loadAgentSettings,
  type FusionConfig,
} from "./config.js";
import {
  buildReasoningApiFields,
  rankModelsByNativeReasoning,
  setMaxEffortForModel,
} from "./reasoning.js";

export interface FusionCandidate {
  modelKey: string;
  provider: ProviderId;
  model: string;
  text: string;
  error?: string;
  ms: number;
}

export interface FusionPrepResult {
  /** Main model's first-pass reasoning (no tools) */
  mainReasoning: FusionCandidate;
  /** Secondary models that only reasoned */
  secondaries: FusionCandidate[];
  /** Injected into main system prompt for compare + execute */
  systemAddon: string;
  /** Human-readable summary of the roster */
  summary: string;
}

const REASONING_PASS_SYSTEM = `You are producing a reasoning-only plan for a multi-model harness.
REASONING ONLY — do not claim to edit files, run tools, or take actions.
Produce a thorough plan, analysis, risks, and trade-offs for the user request.
Be concrete and structured. Output an executable plan.
No filler. No tool calls.`;

/**
 * Resolve secondary reasoner model keys (NOT the main executor).
 * Uses config.modelKeys when set; otherwise auto-picks strong reasoners
 * other than the main session model.
 */
export async function resolveSecondaryReasoners(
  fusion: FusionConfig,
  mainKey: string,
): Promise<string[]> {
  const max = Math.max(1, fusion.maxParallel || 2);
  const configured = fusion.modelKeys.filter((k) => k && k !== mainKey);

  if (configured.length > 0) {
    for (const key of configured.slice(0, max)) {
      const ref = parseModelKey(key);
      if (ref) setMaxEffortForModel(ref.provider, ref.model);
    }
    return configured.slice(0, max);
  }

  const { models } = await fetchAllConnectedModels({ force: false });
  if (models.length === 0) return [];

  const scored = rankModelsByNativeReasoning(models);
  const picked: string[] = [];
  const seenProv = new Set<string>();

  for (const m of scored) {
    if (picked.length >= max) break;
    const key = modelKey({ provider: m.provider, model: m.id });
    if (key === mainKey) continue;
    // Prefer distinct providers for diversity
    if (!seenProv.has(m.provider) || picked.length === 0) {
      picked.push(key);
      seenProv.add(m.provider);
      setMaxEffortForModel(m.provider, m.id);
    }
  }
  // Fill remaining even from same provider
  for (const m of scored) {
    if (picked.length >= max) break;
    const key = modelKey({ provider: m.provider, model: m.id });
    if (key === mainKey || picked.includes(key)) continue;
    picked.push(key);
    setMaxEffortForModel(m.provider, m.id);
  }

  return picked;
}

/**
 * Phase 1: main + secondaries all reason (no tools).
 * Phase 2 addon: main compares both traces, then executes with tools.
 */
export async function prepareFusionForMain(
  store: HarnessStore,
  userPrompt: string,
  mainProvider: ProviderId,
  mainModel: string,
): Promise<FusionPrepResult> {
  const settings = loadAgentSettings();
  const fusion = settings.reasoning.fusion;
  const mainKey = modelKey({ provider: mainProvider, model: mainModel });
  const secondaryKeys = await resolveSecondaryReasoners(fusion, mainKey);

  if (secondaryKeys.length === 0) {
    throw new Error(
      "Fusion needs at least one secondary reasoner model (different from the main model). Connect another provider or pick models in /reasoning → Ultra + Fusion.",
    );
  }

  // Pin max native effort on main for its reasoning pass too
  setMaxEffortForModel(mainProvider, mainModel);

  store.setPhase(
    "thinking",
    `fusion: main + ${secondaryKeys.length} secondary reason in parallel`,
  );

  const introMsg = store.startAssistant();
  const introId = newId("p");
  store.appendPart(introMsg.id, {
    id: introId,
    type: "reasoning",
    content: "",
    streaming: true,
  });
  store.reasoningDelta(
    introMsg.id,
    introId,
    `Ultra + Fusion — phase 1: both reason\n` +
      `Main reasoner: ${mainKey}\n` +
      `Secondary reasoner(s): ${secondaryKeys.join(", ")}\n` +
      `Phase 2: main compares both traces and executes.\n`,
  );
  store.patchPart(introMsg.id, introId, { streaming: false } as never);

  // Parallel: main reasons + each secondary reasons (no tools)
  const [mainReasoning, ...secondaries] = await Promise.all([
    runOneReasoning(mainKey, userPrompt, fusion),
    ...secondaryKeys.map((key) => runOneReasoning(key, userPrompt, fusion)),
  ]);

  const allTraces = [mainReasoning, ...secondaries];
  for (const c of allTraces) {
    const pid = newId("p");
    store.appendPart(introMsg.id, {
      id: pid,
      type: "reasoning",
      content: "",
      streaming: true,
    });
    const role = c.modelKey === mainKey ? "main" : "secondary";
    const header = c.error
      ? `[${role} ${c.modelKey}] ERROR: ${c.error}\n`
      : `[${role} ${c.modelKey}] reason-only (${c.ms}ms)\n`;
    store.reasoningDelta(
      introMsg.id,
      pid,
      header + (c.text || "(empty)"),
    );
    store.patchPart(introMsg.id, pid, { streaming: false } as never);
  }

  const systemAddon = buildMainCompareAddon(
    userPrompt,
    mainReasoning,
    secondaries,
    fusion,
  );
  const summary =
    `Fusion: main + ${secondaries.length} secondary reasoned → main ${mainKey} compares & executes`;

  store.setPhase("streaming", "main compares both reasonings & executes");
  return { mainReasoning, secondaries, systemAddon, summary };
}

function buildMainCompareAddon(
  userPrompt: string,
  mainReasoning: FusionCandidate,
  secondaries: FusionCandidate[],
  fusion: FusionConfig,
): string {
  const mainBody = mainReasoning.error
    ? `(failed: ${mainReasoning.error})`
    : mainReasoning.text?.trim() || "(empty)";

  const peerTraces = secondaries
    .map((c, i) => {
      const body = c.error
        ? `(failed: ${c.error})`
        : c.text?.trim() || "(empty trace)";
      return `### Secondary reasoning #${i + 1} — ${c.modelKey}\n${body}`;
    })
    .join("\n\n");

  const reviewHint =
    fusion.fuseInstructions?.trim() ||
    "Compare your own first-pass reasoning with every secondary trace. Prefer stronger arguments, catch errors, and keep only what is correct, valuable, and actionable. Merge into one plan, then execute.";

  return `
## Multi-model fusion — phase 2 (you are the MAIN executor)

Phase 1 already ran: you and the secondary model(s) each produced a REASONING-ONLY plan (no tools).
Now compare both reasonings, merge the best ideas, and EXECUTE.

### Your job
1. Read YOUR first-pass reasoning and every secondary reasoning below
2. Compare them carefully — strengths, weaknesses, contradictions
3. ${reviewHint}
4. EXECUTE with tools: edit files, run commands, implement the merged plan
   Do not only restate plans — act.

### User request
${userPrompt}

### Your first-pass reasoning — ${mainReasoning.modelKey}
${mainBody}

### Secondary reasoning traces
${peerTraces}
`.trim();
}

/**
 * @deprecated Use prepareFusionForMain + AgentLoop. Kept for any external imports.
 */
export async function runFusionReasoning(
  store: HarnessStore,
  userPrompt: string,
  main?: { provider: ProviderId; model: string },
): Promise<FusionPrepResult> {
  const provider =
    main?.provider ?? (store.state.session.provider as ProviderId);
  const model = main?.model ?? store.state.session.model;
  if (!provider || !model || model === "unset") {
    throw new Error("ultra-fusion needs an active main model (/model)");
  }
  return prepareFusionForMain(store, userPrompt, provider, model);
}

async function runOneReasoning(
  key: string,
  userPrompt: string,
  fusion: FusionConfig,
  system: string = REASONING_PASS_SYSTEM +
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

/** Minimal chat completion — text only, no tools (secondary reasoners). */
async function completeReasoningOnly(opts: {
  provider: ProviderId;
  model: string;
  system: string;
  user: string;
}): Promise<string> {
  const def = getProvider(opts.provider);
  if (!def) throw new Error(`unknown provider ${opts.provider}`);
  const token = await resolveTokenFresh(opts.provider);
  if (!token) throw new Error(`${opts.provider} not logged in`);
  const cred = getCredential(opts.provider);
  const base = (cred?.meta?.baseUrl || def.baseUrl || "").replace(/\/$/, "");

  if (def.modelsStyle === "gemini") {
    return completeGemini(base, token, opts.model, opts.system, opts.user);
  }
  if (def.modelsStyle === "anthropic") {
    return completeAnthropic(base, token, opts.model, opts.system, opts.user);
  }
  return completeOpenAI(
    base,
    token,
    opts.provider,
    opts.model,
    opts.system,
    opts.user,
  );
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
  Object.assign(
    body,
    buildReasoningApiFields(provider, model, { forceMax: true }),
  );

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
    choices?: Array<{
      message?: { content?: string | Array<{ text?: string }> };
    }>;
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
  const native = buildReasoningApiFields("gemini", model, { forceMax: true });
  const genCfg = native.generationConfig as Record<string, unknown> | undefined;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      ...(genCfg ? { generationConfig: genCfg } : {}),
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
  const native = buildReasoningApiFields("anthropic", model, { forceMax: true });
  const thinking = native.thinking as
    | { type: string; budget_tokens: number }
    | undefined;
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
      ...(thinking ? { thinking } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
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
