/**
 * Per-model native reasoning capability — NOT prompt engineering.
 *
 * Discovers which effort levels a model accepts (from provider /models
 * catalogs when available), clamps user settings to those levels, and
 * builds the real API payload fields:
 *   - OpenRouter: reasoning: { effort }  (from model.reasoning.supported_efforts)
 *   - OpenAI / xAI: reasoning_effort + reasoning: { effort }
 *   - Anthropic: thinking: { type, budget_tokens }
 *   - Gemini: generationConfig.thinkingConfig
 */

import type { ProviderId } from "../auth/types.js";
import type { RemoteModel } from "../auth/models.js";
import { modelKey } from "../auth/models.js";
import {
  CUSTOM_REASONING_OPTIONS,
  loadAgentSettings,
  saveAgentSettings,
} from "./config.js";

/** Canonical effort tokens we understand (order from least → most). */
export const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type EffortLevel = (typeof EFFORT_ORDER)[number];

/** Full gateway effort set (OpenRouter when supported_efforts is null). */
export const ALL_GATEWAY_EFFORTS: EffortLevel[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type ReasoningApiStyle =
  | "none"
  | "openai_effort" // reasoning_effort top-level
  | "openrouter_reasoning" // reasoning: { effort }
  | "anthropic_thinking" // thinking: { type, budget_tokens }
  | "gemini_thinking"; // thinkingConfig

export interface ModelReasoningCaps {
  /** Model supports any native reasoning control */
  supported: boolean;
  /** Effort levels this model accepts (empty if unsupported) */
  efforts: EffortLevel[];
  style: ReasoningApiStyle;
  /** For Anthropic/Gemini style token budgets */
  maxThinkingTokens?: number;
  /** Prefer max_tokens budget over effort enum (OpenRouter/Anthropic) */
  supportsMaxTokens?: boolean;
  /** Model rejects effort: "none" */
  mandatory?: boolean;
  /** Provider default effort when user has not set one */
  defaultEffort?: EffortLevel;
  /** Raw hints from provider catalog */
  source: "api" | "heuristic" | "none";
}

const DEFAULT_CAPS: ModelReasoningCaps = {
  supported: false,
  efforts: [],
  style: "none",
  source: "none",
};

/** Cache: provider/model → caps */
const capsCache = new Map<string, ModelReasoningCaps>();

export function clearReasoningCapsCache(): void {
  capsCache.clear();
}

export function getCachedReasoningCaps(
  provider: ProviderId,
  model: string,
): ModelReasoningCaps | undefined {
  return capsCache.get(modelKey({ provider, model }));
}

export function setReasoningCaps(
  provider: ProviderId,
  model: string,
  caps: ModelReasoningCaps,
): void {
  capsCache.set(modelKey({ provider, model }), caps);
}

/**
 * Infer / extract reasoning capabilities from a remote model listing.
 * Call this while mapping provider /models responses.
 */
export function capsFromRemoteModel(
  provider: ProviderId,
  model: RemoteModel,
  raw?: unknown,
): ModelReasoningCaps {
  const key = modelKey({ provider, model: model.id });
  const fromApi = parseCapsFromRaw(provider, model.id, raw ?? model.raw);
  if (fromApi) {
    capsCache.set(key, fromApi);
    return fromApi;
  }
  const heuristic = heuristicCaps(provider, model.id, model.reasoning === true);
  capsCache.set(key, heuristic);
  return heuristic;
}

/**
 * OpenRouter documents per-model:
 *   reasoning: {
 *     supported_efforts: string[] | null,
 *     default_effort?: string,
 *     default_enabled?: boolean,
 *     mandatory?: boolean,
 *     supports_max_tokens?: boolean
 *   }
 * When supported_efforts is null → all gateway values accepted.
 * When reasoning field omitted → no effort selection.
 */
function parseCapsFromRaw(
  provider: ProviderId,
  modelId: string,
  raw: unknown,
): ModelReasoningCaps | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const supportedParams = Array.isArray(r.supported_parameters)
    ? (r.supported_parameters as string[]).map((s) => s.toLowerCase())
    : [];

  // --- Official OpenRouter reasoning object ---
  const reasoningObj =
    r.reasoning && typeof r.reasoning === "object" && !Array.isArray(r.reasoning)
      ? (r.reasoning as Record<string, unknown>)
      : null;

  const hasReasoningParam =
    supportedParams.includes("reasoning") ||
    supportedParams.includes("reasoning_effort") ||
    supportedParams.includes("include_reasoning");

  // --- Official OpenRouter `reasoning` object (trust catalog; do not invent) ---
  // Docs: supported_efforts null = all gateway values; omitted = no effort selection.
  if (reasoningObj) {
    const hasEffortsKey = Object.prototype.hasOwnProperty.call(
      reasoningObj,
      "supported_efforts",
    );
    const se = reasoningObj.supported_efforts;
    let efforts: EffortLevel[] = [];
    let effortSource: "api" | "api-open" = "api";

    if (hasEffortsKey) {
      if (se === null) {
        // Explicit null = all gateway effort values accepted
        efforts = [...ALL_GATEWAY_EFFORTS];
        effortSource = "api-open";
      } else if (Array.isArray(se)) {
        efforts = normalizeEfforts(se as string[]);
      }
      // else: key present but garbage → empty (no inventing)
    }
    // If supported_efforts is omitted entirely → efforts stay [] (no inventing)

    const mandatory = reasoningObj.mandatory === true;
    if (mandatory) {
      efforts = efforts.filter((e) => e !== "none");
    }

    const defEff = normalizeOneEffort(
      typeof reasoningObj.default_effort === "string"
        ? reasoningObj.default_effort
        : undefined,
    );

    // Budget-only reasoning (Anthropic-style via OpenRouter)
    if (
      efforts.length === 0 &&
      reasoningObj.supports_max_tokens === true
    ) {
      efforts = ["low", "medium", "high", "max"];
    }

    return {
      // Effort control only when we have a real enum (or open-all / budget map)
      supported:
        efforts.length > 0 ||
        hasReasoningParam ||
        reasoningObj.supports_max_tokens === true ||
        reasoningObj.default_enabled === true,
      efforts,
      style:
        provider === "openrouter"
          ? "openrouter_reasoning"
          : provider === "anthropic"
            ? "anthropic_thinking"
            : "openai_effort",
      supportsMaxTokens: reasoningObj.supports_max_tokens === true,
      mandatory,
      defaultEffort: defEff,
      maxThinkingTokens:
        provider === "anthropic" || reasoningObj.supports_max_tokens
          ? 32000
          : undefined,
      source: effortSource === "api-open" ? "api" : "api",
    };
  }

  // --- Explicit effort enums on the model object (other gateways) ---
  const effortField =
    r.reasoning_effort_options ??
    r.supported_reasoning_efforts ??
    r.reasoning_efforts;

  let efforts = normalizeEfforts(
    Array.isArray(effortField) ? (effortField as string[]) : [],
  );

  // OpenRouter without a reasoning object: trust catalog — no invented enums
  if (provider === "openrouter") {
    if (efforts.length > 0 || hasReasoningParam) {
      return {
        supported: efforts.length > 0 || hasReasoningParam,
        efforts, // may be empty = reasoning exists but no effort control
        style: "openrouter_reasoning",
        source: "api",
      };
    }
    // Explicitly no reasoning in catalog
    return { ...DEFAULT_CAPS, source: "api" };
  }

  if (
    (provider === "openai" || provider === "xai" || provider === "codex") &&
    efforts.length > 0
  ) {
    return {
      supported: true,
      efforts,
      style: "openai_effort",
      source: "api",
    };
  }

  // Direct provider catalogs rarely list effort enums — only then use id heuristics
  if (
    (provider === "openai" || provider === "xai" || provider === "codex") &&
    hasReasoningParam
  ) {
    return {
      supported: true,
      efforts: defaultEffortsFor(provider, modelId),
      style: "openai_effort",
      source: "heuristic",
    };
  }

  if (provider === "anthropic") {
    if (
      supportedParams.includes("thinking") ||
      /claude|opus|sonnet|haiku/i.test(modelId)
    ) {
      return {
        supported: true,
        efforts: ["low", "medium", "high", "max"],
        style: "anthropic_thinking",
        maxThinkingTokens: 32000,
        supportsMaxTokens: true,
        source: supportedParams.includes("thinking") ? "api" : "heuristic",
      };
    }
  }

  if (provider === "gemini") {
    if (
      /gemini|thinking/i.test(modelId) ||
      supportedParams.includes("thinking_config")
    ) {
      return {
        supported: true,
        efforts: ["low", "medium", "high"],
        style: "gemini_thinking",
        maxThinkingTokens: 24576,
        source: "heuristic",
      };
    }
  }

  return null;
}

function defaultEffortsFor(provider: ProviderId, modelId: string): EffortLevel[] {
  const id = modelId.toLowerCase();
  // OpenAI o-series classic: low/medium/high only
  if (
    /^o[134](-|$)|o3-mini|o4-mini|o1/.test(id) &&
    !/gpt-5|codex-max|xhigh/.test(id)
  ) {
    return ["low", "medium", "high"];
  }
  // GPT-5.x often exposes broader sets including max/xhigh
  if (/gpt-5|xhigh/.test(id)) {
    return ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
  if (provider === "xai" || /grok/.test(id)) {
    // xAI Grok: commonly low–high; some accept max
    if (/grok-4|grok-3-mini|reasoning/.test(id)) {
      return ["low", "medium", "high"];
    }
    return ["low", "medium", "high"];
  }
  if (provider === "openrouter") {
    // Hy3 family: none / low / high only (no medium/max/xhigh)
    if (/hy3|tencent/.test(id)) return ["none", "low", "high"];
    return ["none", "low", "medium", "high", "xhigh", "max"];
  }
  return ["low", "medium", "high"];
}

function heuristicCaps(
  provider: ProviderId,
  modelId: string,
  flaggedReasoning: boolean,
): ModelReasoningCaps {
  const id = modelId.toLowerCase();
  // Explicit non-reasoning variants
  if (/non[-_]?reason|no[-_]?think|instant|base(?!-reason)/i.test(id)) {
    return { ...DEFAULT_CAPS, source: "heuristic" };
  }
  const looks =
    flaggedReasoning ||
    /reason|thinking|o1|o3|o4|r1|opus|gpt-5|hy3|qwq|deepseek-r/i.test(id) ||
    // Grok: only flag when name suggests reasoning / flagship (not all grok ids)
    (/grok/i.test(id) && /reason|4|3-mini|think/i.test(id));

  if (!looks) {
    return { ...DEFAULT_CAPS, source: "heuristic" };
  }

  if (provider === "anthropic") {
    return {
      supported: true,
      efforts: ["low", "medium", "high", "max"],
      style: "anthropic_thinking",
      maxThinkingTokens: 32000,
      supportsMaxTokens: true,
      source: "heuristic",
    };
  }
  if (provider === "gemini") {
    return {
      supported: true,
      efforts: ["low", "medium", "high"],
      style: "gemini_thinking",
      maxThinkingTokens: 24576,
      source: "heuristic",
    };
  }
  if (provider === "openrouter") {
    return {
      supported: true,
      efforts: defaultEffortsFor(provider, modelId),
      style: "openrouter_reasoning",
      source: "heuristic",
    };
  }
  return {
    supported: true,
    efforts: defaultEffortsFor(provider, modelId),
    style: "openai_effort",
    source: "heuristic",
  };
}

function normalizeOneEffort(raw?: string): EffortLevel | undefined {
  if (!raw) return undefined;
  const e = raw.toLowerCase().replace(/^x-/, "x");
  const mapped = e === "x-high" ? "xhigh" : e;
  if ((EFFORT_ORDER as readonly string[]).includes(mapped)) {
    return mapped as EffortLevel;
  }
  return undefined;
}

function normalizeEfforts(raw: string[]): EffortLevel[] {
  const out: EffortLevel[] = [];
  for (const r of raw) {
    const mapped = normalizeOneEffort(r);
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  out.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return out;
}

/**
 * Resolve the effort to send for a model: per-model override → global → default.
 * Clamped to what the model supports. Returns null when we should omit the field.
 */
export function resolveEffortForModel(
  provider: ProviderId,
  model: string,
): { effort: EffortLevel | null; caps: ModelReasoningCaps; clamped: boolean } {
  const caps =
    getCachedReasoningCaps(provider, model) ??
    heuristicCaps(provider, model, false);

  if (!caps.supported || caps.efforts.length === 0) {
    return { effort: null, caps, clamped: false };
  }

  const cfg = loadAgentSettings();
  const key = modelKey({ provider, model });
  const perModel = cfg.reasoning.perModelEffort?.[key];
  const global = cfg.reasoning.effort;

  let desired: string | undefined =
    perModel ??
    (global === "default" || global === "off" ? undefined : global);

  // Map legacy "off" → none when supported
  if (global === "off" && !perModel) {
    desired = caps.efforts.includes("none")
      ? "none"
      : caps.efforts.includes("minimal")
        ? "minimal"
        : undefined;
  }

  if (!desired || desired === "default") {
    return { effort: null, caps, clamped: false };
  }

  let effort = desired as EffortLevel;
  let clamped = false;
  if (!caps.efforts.includes(effort)) {
    effort = clampEffort(effort, caps.efforts);
    clamped = true;
  }

  // Mandatory models reject none
  if (caps.mandatory && (effort === "none" || effort === "minimal")) {
    effort = clampEffort("low", caps.efforts);
    clamped = true;
  }

  return { effort, caps, clamped };
}

function clampEffort(
  wanted: EffortLevel,
  supported: EffortLevel[],
): EffortLevel {
  if (supported.includes(wanted)) return wanted;
  const wi = EFFORT_ORDER.indexOf(wanted);
  // Prefer highest supported that is ≤ wanted
  let best: EffortLevel | null = null;
  for (const s of supported) {
    const si = EFFORT_ORDER.indexOf(s);
    if (si <= wi) best = s;
  }
  return best ?? supported[supported.length - 1]!;
}

/** Highest effort level this model accepts via native API (null if none). */
export function highestSupportedEffort(
  caps: ModelReasoningCaps,
): EffortLevel | null {
  if (!caps.supported || caps.efforts.length === 0) return null;
  // efforts are sorted least → most
  const usable = caps.efforts.filter((e) => e !== "none");
  if (usable.length === 0) return caps.efforts[caps.efforts.length - 1]!;
  return usable[usable.length - 1]!;
}

export function resolveCapsForModel(
  provider: ProviderId,
  model: string,
  flaggedReasoning = false,
): ModelReasoningCaps {
  return (
    getCachedReasoningCaps(provider, model) ??
    heuristicCaps(provider, model, flaggedReasoning)
  );
}

/**
 * Score a model for "highest reasoning" using native API caps first,
 * then name heuristics as tie-breakers. Prefer api-sourced caps.
 */
export function nativeReasoningScore(m: RemoteModel): number {
  const caps = resolveCapsForModel(m.provider, m.id, m.reasoning === true);
  const id = m.id.toLowerCase();
  let s = 0;

  if (caps.supported && caps.efforts.length > 0) {
    s += 100;
    if (caps.source === "api") s += 40;
    const top = highestSupportedEffort(caps);
    if (top) s += EFFORT_ORDER.indexOf(top) * 12;
    // Prefer models that expose more than low/high only
    s += Math.min(caps.efforts.length, 6) * 3;
  } else if (m.reasoning) {
    s += 30; // flagged but no effort enum
  }

  // Name / tier heuristics (tie-break only relative to native caps)
  if (/non[-_]?reason|no[-_]?think/.test(id)) s -= 200;
  if (/reason|thinking|o3|o4|opus|gpt-5|hy3|qwq|deepseek-r/.test(id)) s += 25;
  if (/grok-4\.5|grok-4-1|claude-opus|gemini-2\.5-pro|gpt-5\.2|gpt-5\.1/.test(id))
    s += 35;
  if (/grok-4|o3(?!-mini)|o4/.test(id)) s += 20;
  if (/mini|fast|flash|haiku|lite|nano|free/.test(id)) s -= 25;
  if (/pro(?!-)|ultra|max/.test(id)) s += 10;

  return s;
}

/**
 * Pick the strongest native-reasoning model from a catalog list.
 * Prefers models with supported_efforts / thinking from the provider API.
 */
export function pickHighestNativeReasoningModel(
  models: RemoteModel[],
): RemoteModel | undefined {
  if (models.length === 0) return undefined;
  const scored = models.map((m) => ({ m, s: nativeReasoningScore(m) }));
  scored.sort((a, b) => b.s - a.s || a.m.id.localeCompare(b.m.id));
  return scored[0]?.m;
}

/**
 * Rank models for fusion auto-pick (highest native reasoning first).
 */
export function rankModelsByNativeReasoning(
  models: RemoteModel[],
): RemoteModel[] {
  return [...models].sort(
    (a, b) =>
      nativeReasoningScore(b) - nativeReasoningScore(a) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Persist this model's highest native effort (for ultra / ultra-fusion).
 * Returns the effort that was set, or null if unsupported.
 */
export function setMaxEffortForModel(
  provider: ProviderId,
  model: string,
): EffortLevel | null {
  const caps = resolveCapsForModel(provider, model, true);
  const top = highestSupportedEffort(caps);
  if (!top) return null;
  setEffortForModel(provider, model, top);
  return top;
}

/**
 * Build API body fragments for native reasoning — never prompt text.
 * These fields are merged into the provider chat request body.
 *
 * @param opts.forceMax — use highest supported effort (ultra / fusion),
 *   ignoring user default when they haven't set a lower override is optional;
 *   forceMax always sends the top native level.
 */
export function buildReasoningApiFields(
  provider: ProviderId,
  model: string,
  opts?: { forceMax?: boolean },
): Record<string, unknown> {
  const caps = resolveCapsForModel(provider, model, false);
  if (!caps.supported) return {};

  let effort: EffortLevel | null;
  if (opts?.forceMax) {
    effort = highestSupportedEffort(caps);
  } else {
    effort = resolveEffortForModel(provider, model).effort;
  }
  if (!effort) return {};

  return fieldsForEffort(provider, caps, effort);
}

function fieldsForEffort(
  provider: ProviderId,
  caps: ModelReasoningCaps,
  effort: EffortLevel,
): Record<string, unknown> {
  switch (caps.style) {
    case "openrouter_reasoning": {
      // OpenRouter unified: reasoning: { effort } or reasoning: { max_tokens }
      if (caps.supportsMaxTokens && !caps.efforts.includes(effort)) {
        const budget = effortToAnthropicBudget(
          effort,
          caps.maxThinkingTokens ?? 32000,
        );
        if (budget <= 0) {
          return caps.mandatory
            ? {}
            : { reasoning: { effort: "none", exclude: true } };
        }
        return { reasoning: { max_tokens: budget } };
      }
      if (effort === "none") {
        if (caps.mandatory) return {};
        return { reasoning: { effort: "none", exclude: true } };
      }
      return { reasoning: { effort } };
    }

    case "openai_effort": {
      const e = effort;
      if (provider === "xai") {
        return {
          reasoning_effort: e,
          reasoning: { effort: e },
        };
      }
      return { reasoning_effort: e };
    }

    case "anthropic_thinking": {
      const budget = effortToAnthropicBudget(
        effort,
        caps.maxThinkingTokens ?? 32000,
      );
      if (budget <= 0) return {};
      return {
        thinking: { type: "enabled", budget_tokens: budget },
      };
    }

    case "gemini_thinking": {
      const budget = effortToGeminiBudget(
        effort,
        caps.maxThinkingTokens ?? 24576,
      );
      if (budget <= 0) {
        return {
          generationConfig: {
            thinkingConfig: { thinkingBudget: 0 },
          },
        };
      }
      return {
        generationConfig: {
          thinkingConfig: { thinkingBudget: budget },
        },
      };
    }

    default:
      return {};
  }
}

function effortToAnthropicBudget(effort: EffortLevel, max: number): number {
  switch (effort) {
    case "none":
    case "minimal":
      return 0;
    case "low":
      return Math.min(2000, max);
    case "medium":
      return Math.min(8000, max);
    case "high":
      return Math.min(16000, max);
    case "xhigh":
    case "max":
      return max;
    default:
      return Math.min(8000, max);
  }
}

function effortToGeminiBudget(effort: EffortLevel, max: number): number {
  switch (effort) {
    case "none":
    case "minimal":
      return 0;
    case "low":
      return Math.min(1024, max);
    case "medium":
      return Math.min(8192, max);
    case "high":
    case "xhigh":
    case "max":
      return max;
    default:
      return Math.min(8192, max);
  }
}

/** Persist effort for the active model only (source of truth for API calls). */
export function setEffortForModel(
  provider: ProviderId,
  model: string,
  effort: EffortLevel | "default",
): void {
  const settings = loadAgentSettings();
  const key = modelKey({ provider, model });
  const per = { ...(settings.reasoning.perModelEffort ?? {}) };
  if (effort === "default") delete per[key];
  else per[key] = effort;
  saveAgentSettings({
    reasoning: {
      ...settings.reasoning,
      perModelEffort: per,
    },
  });
}

/** Also set global fallback effort (used when a model has no per-model entry). */
export function setGlobalEffort(effort: string): void {
  const settings = loadAgentSettings();
  saveAgentSettings({
    reasoning: {
      ...settings.reasoning,
      effort: effort as never,
    },
  });
}

export function getEffortForModel(
  provider: ProviderId,
  model: string,
): string {
  const key = modelKey({ provider, model });
  const settings = loadAgentSettings();
  return (
    settings.reasoning.perModelEffort?.[key] ??
    settings.reasoning.effort ??
    "default"
  );
}

/** Labels for UI */
export function effortLabel(e: EffortLevel | "default" | "off"): string {
  switch (e) {
    case "none":
      return "None / off";
    case "off":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "XHigh";
    case "max":
      return "Max";
    case "default":
      return "Model default";
    default:
      return e;
  }
}

export function effortDescription(
  e: EffortLevel | "default",
  caps: ModelReasoningCaps,
): string {
  if (e === "default") return "Omit reasoning param — provider default";
  if (!caps.supported) {
    return "This model does not expose native reasoning controls";
  }
  if (caps.style === "anthropic_thinking" || caps.style === "gemini_thinking") {
    const budget =
      caps.style === "anthropic_thinking"
        ? effortToAnthropicBudget(
            e as EffortLevel,
            caps.maxThinkingTokens ?? 32000,
          )
        : effortToGeminiBudget(
            e as EffortLevel,
            caps.maxThinkingTokens ?? 24576,
          );
    return `Native thinking budget ≈ ${budget} tokens (${caps.style})`;
  }
  return `Native API: reasoning.effort = "${e}" (${caps.source})`;
}

/**
 * Build picker options for the active model only.
 * Always includes "default"; only lists efforts the model actually supports
 * from the provider catalog (never the full static effort list).
 */
export function effortPickerOptions(
  provider: ProviderId,
  model: string,
  opts?: { allowHeuristic?: boolean },
): {
  value: string;
  label: string;
  description: string;
  caps: ModelReasoningCaps;
}[] {
  const cached = getCachedReasoningCaps(provider, model);
  const caps =
    cached ??
    (opts?.allowHeuristic === false
      ? { ...DEFAULT_CAPS, source: "none" as const }
      : heuristicCaps(provider, model, false));

  const out: {
    value: string;
    label: string;
    description: string;
    caps: ModelReasoningCaps;
  }[] = [
    {
      value: "default",
      label: effortLabel("default"),
      description:
        caps.source === "api"
          ? caps.efforts.length
            ? `Omit reasoning.effort (catalog default${caps.defaultEffort ? `: ${caps.defaultEffort}` : ""})`
            : "No effort enum in catalog — omit field"
          : effortDescription("default", caps),
      caps,
    },
  ];

  if (caps.efforts.length === 0) {
    out[0]!.description =
      caps.source === "api"
        ? "Catalog: no supported_efforts for this model"
        : "No native effort levels known for this model";
    return out;
  }

  for (const e of caps.efforts) {
    out.push({
      value: e,
      label: effortLabel(e),
      description: effortDescription(e, caps),
      caps,
    });
  }
  return out;
}

/**
 * Slash-complete values for /reasoning — same set & labels as the /reasoning
 * tab picker (effort levels for the active model + ultra / ultra-fusion).
 * Values stay the CLI form (`low`, `ultra-fusion`); labels match the picker.
 */
export function reasoningCompleteValues(
  provider: ProviderId | string | undefined,
  model: string | undefined,
): { value: string; label: string; description: string }[] {
  const values: { value: string; label: string; description: string }[] = [];

  const hasModel =
    Boolean(provider) &&
    provider !== "none" &&
    Boolean(model) &&
    model !== "unset";

  if (hasModel) {
    const opts = effortPickerOptions(provider as ProviderId, model!, {
      allowHeuristic: false,
    });
    for (const o of opts) {
      values.push({
        value: o.value,
        label: o.label,
        description: o.description,
      });
    }
    const caps = getCachedReasoningCaps(provider as ProviderId, model!);
    if (!caps && values.length === 0) {
      values.push({
        value: "default",
        label: effortLabel("default"),
        description: "Open /reasoning or /model to refresh the catalog",
      });
    }
  } else {
    // Mirror root picker when no model: custom harness modes only
    for (const o of CUSTOM_REASONING_OPTIONS) {
      values.push({
        value: o.value,
        label: o.label,
        description: o.description,
      });
    }
    return values;
  }

  // Same as openEffortModesPicker: skip "none", add ultra / ultra-fusion
  for (const o of CUSTOM_REASONING_OPTIONS) {
    if (o.value === "none") continue;
    values.push({
      value: o.value,
      label: o.label,
      description: o.description,
    });
  }

  const seen = new Set<string>();
  return values.filter((v) => {
    if (seen.has(v.value)) return false;
    seen.add(v.value);
    return true;
  });
}

/** Attach caps when models are fetched (populates capsCache). */
export function attachCapsToModels(
  provider: ProviderId,
  models: RemoteModel[],
): RemoteModel[] {
  return models.map((m) => {
    const caps = capsFromRemoteModel(provider, m, m.raw);
    return {
      ...m,
      reasoning: m.reasoning || caps.supported,
    };
  });
}
