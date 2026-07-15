/**
 * Ultra + Fusion — both models REASON first; main COMPARES then EXECUTES.
 *
 * Pipeline:
 *  1. Main + secondary model(s) produce reasoning-only plans in parallel
 *     (no tools / no edits) — streaming, with full debug traces
 *  2. Main session model compares both (all) reasoning traces
 *  3. Main keeps what it deems valuable and executes with tools
 */

import type { HarnessStore } from "../core/store.js";
import type { ProviderId } from "../auth/types.js";
import {
  fetchAllConnectedModels,
  parseModelKey,
  modelKey,
} from "../auth/models.js";
import { loadAgentSettings, type FusionConfig } from "./config.js";
import { rankModelsByNativeReasoning } from "./reasoning.js";
import {
  chatComplete,
  mergeReasoningText,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type StreamHandlers,
} from "../llm/client.js";
import { dbg, span } from "./debug.js";

/** Injected chat for fusion phase-1 tests (mirrors turn/loop chatImpl). */
export type FusionChatImpl = (
  req: ChatRequest,
  handlers?: StreamHandlers,
) => Promise<ChatResult>;

export interface FusionCandidate {
  modelKey: string;
  provider: ProviderId;
  model: string;
  text: string;
  /** Raw content vs reasoning breakdown for debug */
  content?: string;
  reasoning?: string;
  error?: string;
  ms: number;
  ttftMs?: number;
  usage?: ChatResult["usage"];
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
  /**
   * Single reasoning block for the UI — same shape as normal model thinking.
   * Shown on the same assistant turn as execution (no split layout).
   */
  displayReasoning: string;
  /** Total phase-1 wall time (parallel) */
  phase1Ms: number;
}

/** One quick retry on 429 / upstream rate limit */
const FUSION_RETRY_MS = 2500;

/**
 * Phase-1 system prompt. Critical: do NOT say "plan for a multi-model harness" —
 * models interpret that as "build an AI harness", ignoring the user request.
 */
const REASONING_PASS_SYSTEM = `You are a planning specialist producing a reasoning-only plan for the USER'S request below.

RULES:
- Answer the USER request only. Do not invent a different project (especially not an "AI harness", agent framework, or multi-model orchestrator unless they explicitly asked for that).
- REASONING ONLY — no tool calls, no fake file edits, no "I will now run…"
- Cover: goal (as the user stated it), approach, risks, and concrete next steps
- If the task involves code: note likely files/layout. If it is design/chat/advice: plan that deliverable instead — do not force a TypeScript package scaffold.
- Do not artificially shorten your reasoning; the API effort level controls depth`;
/**
 * Resolve the single peer reasoner (NOT the main executor).
 * Hard cap: 1 additional agent. Uses fusion.modelKeys[0] or auto-picks.
 *
 * Same-model dual sampling is allowed when the user explicitly configures
 * the peer to equal main (e.g. two independent hy3:free reasoning passes).
 * Auto-pick still prefers a different model.
 */
export async function resolveSecondaryReasoners(
  fusion: FusionConfig,
  mainKey: string,
): Promise<string[]> {
  const configured = fusion.modelKeys.filter((k) => Boolean(k?.trim()));

  if (configured.length > 0) {
    // Prefer a different model when available; otherwise dual-sample main
    const different = configured.find((k) => k !== mainKey);
    return [different ?? configured[0]!];
  }

  const { models } = await fetchAllConnectedModels({ force: false });
  if (models.length === 0) return [];

  const scored = rankModelsByNativeReasoning(models);
  for (const m of scored) {
    const key = modelKey({ provider: m.provider, model: m.id });
    if (key === mainKey) continue;
    return [key];
  }

  return [];
}

export interface PrepareFusionOptions {
  signal?: AbortSignal;
  /**
   * Injected chat for tests — both main and peer reasoners use this when set.
   * Production leaves undefined → chatComplete.
   */
  chatImpl?: FusionChatImpl;
  /**
   * Skip resolveSecondaryReasoners / catalog fetch. When set, used as the
   * peer model key list (e.g. ["xai/grok-4"] or ["openrouter/test-peer"]).
   */
  secondaryKeys?: string[];
}

/**
 * Phase 1: main + peer reason in parallel (no tools, no store UI dump).
 * Returns systemAddon for execute + a single reasoning block body that
 * the agent loop displays like any other "thinking" part (same turn).
 */
export async function prepareFusionForMain(
  store: HarnessStore,
  userPrompt: string,
  mainProvider: ProviderId,
  mainModel: string,
  signalOrOpts?: AbortSignal | PrepareFusionOptions,
): Promise<FusionPrepResult> {
  const opts: PrepareFusionOptions =
    signalOrOpts instanceof AbortSignal || signalOrOpts == null
      ? { signal: signalOrOpts ?? undefined }
      : signalOrOpts;
  const signal = opts.signal;

  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const settings = loadAgentSettings();
  const fusion = settings.reasoning.fusion;
  const mainKey = modelKey({ provider: mainProvider, model: mainModel });
  let secondaryKeys =
    opts.secondaryKeys ??
    (await resolveSecondaryReasoners(fusion, mainKey));

  if (secondaryKeys.length === 0) {
    // Last resort: dual-sample main (2 independent reasoning passes)
    secondaryKeys = [mainKey];
    dbg("fusion", "phase1.dual_sample_fallback", { main: mainKey });
  }

  store.setPhase("thinking", "Ultra + Fusion · both models reasoning…");
  dbg("fusion", "phase1.start", {
    main: mainKey,
    peers: secondaryKeys,
    promptLen: userPrompt.length,
  });
  const phase = span("fusion", "phase1.parallel", {
    main: mainKey,
    peers: secondaryKeys,
  });

  // Parallel: main + peer reason (no tools)
  const [mainReasoning, ...secondaries] = await Promise.all([
    runOneReasoning(mainKey, userPrompt, fusion, "fusion.main", signal, opts.chatImpl),
    ...secondaryKeys.map((key) =>
      runOneReasoning(key, userPrompt, fusion, "fusion.peer", signal, opts.chatImpl),
    ),
  ]);

  const phase1Ms = phase.end({
    mainMs: mainReasoning.ms,
    mainTtft: mainReasoning.ttftMs,
    mainChars: mainReasoning.text.length,
    mainErr: mainReasoning.error,
    peerMs: secondaries[0]?.ms,
    peerTtft: secondaries[0]?.ttftMs,
    peerChars: secondaries[0]?.text.length,
    peerErr: secondaries[0]?.error,
  });

  // If both failed, surface a clear error
  if (mainReasoning.error && secondaries.every((s) => s.error)) {
    throw new Error(
      `Fusion phase-1 failed: main=${mainReasoning.error}; peer=${secondaries[0]?.error}`,
    );
  }

  const displayReasoning = formatFusionReasoningDisplay(
    mainReasoning,
    secondaries,
    mainKey,
  );
  // Compact system addon: full dual traces ship once via seedReasoning
  // (assistant wire reasoning). Avoids ~2× context on heavy hy3 plans.
  const systemAddon = buildMainCompareAddon(
    userPrompt,
    mainReasoning,
    secondaries,
    fusion,
    { compact: true, displayAlreadySeeded: true },
  );
  const summary = `Ultra + Fusion · ${mainKey} + peer → compare & execute (${phase1Ms}ms phase1)`;

  store.setPhase("streaming", "Ultra + Fusion · main executing…");
  dbg("fusion", "phase1.done", {
    summary,
    addonLen: systemAddon.length,
    displayLen: displayReasoning.length,
  });

  return {
    mainReasoning,
    secondaries,
    systemAddon,
    summary,
    displayReasoning,
    phase1Ms,
  };
}

/** Single thinking-block body (same style as normal model reasoning). */
export function formatFusionReasoningDisplay(
  mainReasoning: FusionCandidate,
  secondaries: FusionCandidate[],
  mainKey: string,
): string {
  const mainBody = mainReasoning.error
    ? `(error: ${mainReasoning.error})`
    : mainReasoning.text?.trim() || "(empty)";
  const peer = secondaries[0];
  const peerBody = peer
    ? peer.error
      ? `(error: ${peer.error})`
      : peer.text?.trim() || "(empty)"
    : "(no peer)";
  const peerKey = peer?.modelKey ?? "peer";

  return [
    `Ultra + Fusion`,
    ``,
    `Main · ${mainKey} (${mainReasoning.ms}ms${mainReasoning.ttftMs != null ? ` ttft=${mainReasoning.ttftMs}ms` : ""})`,
    mainBody,
    ``,
    `Peer · ${peerKey} (${peer?.ms ?? "?"}ms${peer?.ttftMs != null ? ` ttft=${peer.ttftMs}ms` : ""})`,
    peerBody,
  ].join("\n");
}

export interface BuildCompareAddonOptions {
  /**
   * When true (default for seedReasoning path), do not re-embed full phase-1
   * bodies in the system prompt — they already appear in the assistant
   * reasoning block. Cuts dual-hy3 context roughly in half on heavy tasks.
   */
  compact?: boolean;
  /** Hint text that dual traces were seeded into the thinking block. */
  displayAlreadySeeded?: boolean;
}

export function buildMainCompareAddon(
  userPrompt: string,
  mainReasoning: FusionCandidate,
  secondaries: FusionCandidate[],
  fusion: FusionConfig,
  opts?: BuildCompareAddonOptions,
): string {
  const compact = opts?.compact === true;
  const reviewHint =
    fusion.fuseInstructions?.trim() ||
    "Compare first-pass vs peer traces. Prefer stronger arguments, drop contradictions, keep only what serves the USER request. Then act.";

  const mainStatus = mainReasoning.error
    ? `FAILED: ${mainReasoning.error}`
    : `${mainReasoning.text?.trim().length ?? 0} chars, ${mainReasoning.ms}ms`;
  const peerStatus = secondaries
    .map((c, i) => {
      const st = c.error
        ? `FAILED: ${c.error}`
        : `${c.text?.trim().length ?? 0} chars, ${c.ms}ms`;
      return `#${i + 1} ${c.modelKey}: ${st}`;
    })
    .join("; ");

  const header = `
## Fusion phase 2 — execute the USER request

### User request (source of truth — follow this)
${userPrompt}

Phase 1 already produced dual reasoning plans (no tools).
${
  opts?.displayAlreadySeeded
    ? "Full dual traces are in your prior thinking block (sections **Main** and **Peer**)."
    : "Full traces are included below."
}

### Job
1. Compare first-pass + peer traces against the user request above
2. ${reviewHint}
3. Discard any plan that invents a different product (e.g. building an "AI harness", agent framework, or unrelated scaffold) unless the user explicitly asked for that
4. Execute the user's request with tools when needed — do not only restate plans
5. Spawn subagents only for independent parallel work that serves the user request

### Coding hygiene (only if the user request involves writing code)
- Prefer medium-sized writes over one giant truncated file
- Skip version probes; run tests/build only when relevant to the request
- Stop when the user's goal is met

### Phase-1 roster
- Main ${mainReasoning.modelKey}: ${mainStatus}
- Peers: ${peerStatus || "(none)"}
`.trim();

  if (compact) {
    return header;
  }

  // Full traces — no internal truncation; API effort is the only depth control
  const mainBody = mainReasoning.error
    ? `(failed: ${mainReasoning.error})`
    : mainReasoning.text?.trim() || "(empty)";

  const peerTraces = secondaries
    .map((c, i) => {
      const body = c.error
        ? `(failed: ${c.error})`
        : c.text?.trim() || "(empty trace)";
      return `### Secondary reasoning #${i + 1} — ${c.modelKey} (${c.ms}ms)\n${body}`;
    })
    .join("\n\n");

  return `${header}

### Your first-pass reasoning — ${mainReasoning.modelKey}
${mainBody}

### Secondary reasoning traces
${peerTraces}`;
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

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate.?limit|temporarily rate-limited/i.test(msg);
}

/** Rate-limit retry wait that bails immediately if the turn is cancelled. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runOneReasoning(
  key: string,
  userPrompt: string,
  fusion: FusionConfig,
  label: string,
  signal?: AbortSignal,
  chatImpl?: FusionChatImpl,
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

  const extra = fusion.analysisInstructions?.trim();
  const system =
    REASONING_PASS_SYSTEM +
    (extra ? `\n\nExtra instructions:\n${extra}` : "");

  dbg("fusion", `${label}.start`, { key, model: ref.model });

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) {
      lastError = "aborted";
      break;
    }
    try {
      if (attempt > 0) {
        dbg("fusion", `${label}.retry`, { attempt, waitMs: FUSION_RETRY_MS });
        await sleepUnlessAborted(FUSION_RETRY_MS, signal);
      }
      const text = await completeReasoningOnly({
        provider: ref.provider,
        model: ref.model,
        system,
        user: userPrompt,
        label: attempt ? `${label}.retry` : label,
        signal,
        chatImpl,
      });
      const ms = Date.now() - started;
      dbg("fusion", `${label}.ok`, {
        key,
        ms,
        ttftMs: text.ttftMs,
        textLen: text.text.length,
        contentLen: text.content?.length ?? 0,
        reasoningLen: text.reasoning?.length ?? 0,
        usage: text.usage,
        attempt,
      });
      return {
        modelKey: key,
        provider: ref.provider,
        model: ref.model,
        text: text.text,
        content: text.content,
        reasoning: text.reasoning,
        ms,
        ttftMs: text.ttftMs,
        usage: text.usage,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      dbg("fusion", `${label}.error`, {
        key,
        ms: Date.now() - started,
        error: lastError,
        attempt,
        retryable: isRateLimitError(err),
      });
      if (!isRateLimitError(err) || attempt === 1) break;
    }
  }

  return {
    modelKey: key,
    provider: ref.provider,
    model: ref.model,
    text: "",
    error: lastError,
    ms: Date.now() - started,
  };
}

interface ReasoningOnlyResult {
  text: string;
  content?: string;
  reasoning?: string;
  ttftMs?: number;
  usage?: ChatResult["usage"];
}

/**
 * Minimal chat completion — text only, no tools.
 * Uses shared client so reasoning/content merge + streaming + debug apply.
 */
async function completeReasoningOnly(opts: {
  provider: ProviderId;
  model: string;
  system: string;
  user: string;
  label: string;
  signal?: AbortSignal;
  chatImpl?: FusionChatImpl;
}): Promise<ReasoningOnlyResult> {
  // No internal reasoning caps — depth comes only from the model's API
  // effort setting (buildReasoningApiFields / per-model effort).
  const chat = opts.chatImpl ?? chatComplete;
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const result = await chat(
    {
      provider: opts.provider,
      model: opts.model,
      messages,
      tools: undefined,
      tool_choice: "none",
      temperature: 0.2,
      // No max_tokens — unlimited; reasoning depth via API effort only
      stream: true,
      applyNativeReasoning: true,
      signal: opts.signal,
      label: opts.label,
    },
    {
      onFirstToken: (kind, ms) => {
        dbg("fusion", `${opts.label}.first_token`, {
          kind,
          ms,
          model: opts.model,
        });
      },
    },
  );

  const content = result.content ?? "";
  const reasoning = result.reasoning ?? "";
  const text = mergeReasoningText(content, reasoning);

  if (!text.trim()) {
    dbg("fusion", `${opts.label}.empty_plan`, {
      model: opts.model,
      finish: result.finish_reason,
      usage: result.usage,
    });
  }

  return {
    text,
    content,
    reasoning,
    ttftMs: result.ttftMs,
    usage: result.usage,
  };
}
