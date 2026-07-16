/**
 * Dynamic model catalog — fetched live from each connected provider.
 * No hardcoded per-provider model lists (stale by design).
 */

import type { ProviderId } from "./types.js";
import {
  canonicalizeProviderId,
  getProvider,
  PROVIDERS,
} from "./types.js";
import { resolveToken, resolveTokenFresh } from "./api-key.js";
import { getCredential } from "./store.js";
import {
  attachCapsToModels,
  pickHighestNativeReasoningModel,
} from "../agent/reasoning.js";

export interface RemoteModel {
  /** Provider-native model id */
  id: string;
  /** Display name */
  name: string;
  provider: ProviderId;
  description?: string;
  /** Hint: likely a reasoning / thinking model */
  reasoning?: boolean;
  /** Owned context if reported */
  context?: number;
  /** Raw provider payload (debug) */
  raw?: unknown;
}

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

/** In-memory cache: provider -> models */
const cache = new Map<
  string,
  { at: number; models: RemoteModel[]; error?: string }
>();

const CACHE_TTL_MS = 5 * 60 * 1000;

export function modelKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/**
 * Parse "provider/model/id" keys.
 * Provider is only the first segment when it matches a known ProviderId
 * (so openrouter/tencent/hy3 → provider=openrouter, model=tencent/hy3).
 */
export function parseModelKey(key: string): ModelRef | null {
  const raw = key.trim();
  if (!raw) return null;
  const i = raw.indexOf("/");
  if (i <= 0) return null;
  const provider = canonicalizeProviderId(raw.slice(0, i));
  const model = raw.slice(i + 1).trim();
  if (!provider || !getProvider(provider) || !model) return null;
  // Reject accidental cycle-encoding from pickers
  if (model.includes("::")) return null;
  return { provider, model };
}

/** True when this provider/model exists in the live catalog cache (if loaded). */
export function isKnownModel(provider: ProviderId, model: string): boolean {
  const list = cache.get(provider)?.models;
  if (!list || list.length === 0) return true; // unknown catalog — allow
  return list.some((m) => m.id === model);
}

export function clearModelCache(provider?: ProviderId): void {
  if (provider) cache.delete(provider);
  else cache.clear();
}

/**
 * Fetch models for one provider. Uses credential/env token.
 * Returns empty array + throws on hard auth errors when throwOnAuth is true.
 */
export async function fetchModelsForProvider(
  provider: ProviderId,
  opts?: { force?: boolean; timeoutMs?: number },
): Promise<{ models: RemoteModel[]; error?: string; fromCache: boolean }> {
  const def = getProvider(provider);
  if (!def) return { models: [], error: "unknown provider", fromCache: false };

  const token = await resolveTokenFresh(provider);
  if (!token) {
    return {
      models: [],
      error: `not logged in (${def.envKey ?? "API key / OAuth"})`,
      fromCache: false,
    };
  }

  const cached = cache.get(provider);
  if (
    !opts?.force &&
    cached &&
    Date.now() - cached.at < CACHE_TTL_MS &&
    cached.models.length > 0
  ) {
    return { models: cached.models, error: cached.error, fromCache: true };
  }

  const cred = getCredential(provider);
  const baseUrl = (cred?.meta?.baseUrl || def.baseUrl || "").replace(/\/$/, "");
  const timeoutMs = opts?.timeoutMs ?? 15_000;

  try {
    let models: RemoteModel[] = [];
    switch (def.modelsStyle) {
      case "openai":
        models = await fetchOpenAIStyle(provider, baseUrl, token, timeoutMs);
        break;
      case "gemini":
        models = await fetchGemini(provider, baseUrl, token, timeoutMs);
        break;
      case "anthropic":
        models = await fetchAnthropic(provider, baseUrl, token, timeoutMs);
        break;
      default:
        models = [];
    }

    // Discover native reasoning effort levels per model (API / heuristic)
    models = attachCapsToModels(provider, models);

    // Sort: reasoning-ish first, then alpha
    models.sort((a, b) => {
      if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

    cache.set(provider, { at: Date.now(), models });
    return { models, fromCache: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cache.set(provider, { at: Date.now(), models: [], error: message });
    return { models: [], error: message, fromCache: false };
  }
}

/**
 * Fetch models from every connected provider (has token).
 * Multi-login: returns a merged list tagged by provider.
 */
export async function fetchAllConnectedModels(opts?: {
  force?: boolean;
}): Promise<{
  models: RemoteModel[];
  byProvider: Record<string, RemoteModel[]>;
  errors: Record<string, string>;
}> {
  const connected = PROVIDERS.filter((p) => Boolean(resolveToken(p.id)));
  const byProvider: Record<string, RemoteModel[]> = {};
  const errors: Record<string, string> = {};
  const models: RemoteModel[] = [];

  await Promise.all(
    connected.map(async (p) => {
      const r = await fetchModelsForProvider(p.id, opts);
      byProvider[p.id] = r.models;
      if (r.error) errors[p.id] = r.error;
      models.push(...r.models);
    }),
  );

  models.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });

  return { models, byProvider, errors };
}

/** List providers that currently have a usable token. */
export function connectedProviders(): ProviderId[] {
  return PROVIDERS.filter((p) => Boolean(resolveToken(p.id))).map((p) => p.id);
}

/** Snapshot of models currently in the in-memory catalog cache (no network). */
export function listCachedModels(): RemoteModel[] {
  const out: RemoteModel[] = [];
  for (const entry of cache.values()) {
    for (const m of entry.models) out.push(m);
  }
  out.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });
  return out;
}

/**
 * Pick the highest native-reasoning model (provider catalog caps first).
 * Delegates to agent/reasoning so ultra / fusion use real API capabilities.
 */
export function pickHighestReasoningModel(
  models: RemoteModel[],
): RemoteModel | undefined {
  return pickHighestNativeReasoningModel(models);
}

function looksReasoning(id: string): boolean {
  const x = id.toLowerCase();
  if (/non[-_]?reason|no[-_]?think/.test(x)) return false;
  return /reason|thinking|o1|o3|o4|r1|opus|hy3|gpt-5|qwq/.test(x);
}

async function fetchOpenAIStyle(
  provider: ProviderId,
  baseUrl: string,
  token: string,
  timeoutMs: number,
): Promise<RemoteModel[]> {
  if (!baseUrl) throw new Error("missing base URL");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (
    provider === "openrouter" ||
    provider === "opencode" ||
    provider === "opencode-go"
  ) {
    headers["HTTP-Referer"] = "https://github.com/libra-tui";
    headers["X-Title"] = "Libra";
  }

  // xAI (and some gateways) may expose chat models under slightly different paths
  const urls =
    provider === "xai"
      ? [`${baseUrl}/models`, `${baseUrl}/language-models`]
      : [`${baseUrl}/models`];

  let lastErr = "";
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`HTTP ${res.status} unauthorized — check API key`);
      }
      if (res.status === 404) {
        lastErr = `HTTP 404 ${url}`;
        continue;
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status} listing models`;
        continue;
      }
      const json = (await res.json()) as {
        data?: Array<Record<string, unknown> & { id?: string; name?: string }>;
        models?: Array<Record<string, unknown> & { id?: string; name?: string }>;
      };
      // Support { data: [...] } and { models: [...] }
      const rawList = json.data ?? json.models ?? [];
      const mapped: RemoteModel[] = [];
      for (const m of rawList) {
        const id = m.id ?? m.name;
        if (!id || typeof id !== "string") continue;
        // Skip non-chat noise when obvious
        if (/embed|whisper|tts|moderation|dall-e|image|audio/i.test(id)) {
          continue;
        }
        const owned =
          typeof m.owned_by === "string" ? m.owned_by : undefined;
        const context = extractContextLength(m);
        mapped.push({
          id,
          name: (typeof m.name === "string" ? m.name : id),
          provider,
          description:
            owned != null
              ? `owned_by ${owned}`
              : provider === "xai"
                ? "xAI Grok"
                : undefined,
          reasoning: looksReasoning(id),
          context,
          raw: m,
        });
      }

      if (mapped.length > 0) return mapped;
      lastErr = "empty model list from API";
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      // Auth errors should surface immediately
      if (/unauthorized|401|403/i.test(lastErr)) throw err;
    }
  }

  // Fallback catalogs when live list fails (still allows selecting known IDs)
  if (provider === "xai") {
    return XAI_FALLBACK_MODELS.map((id) => ({
      id,
      name: id,
      provider: "xai" as const,
      description: "xAI (fallback catalog — API list unavailable)",
      reasoning: looksReasoning(id),
    }));
  }
  if (provider === "opencode") {
    return OPENCODE_ZEN_FALLBACK.map((id) => ({
      id,
      name: id,
      provider: "opencode" as const,
      description: "OpenCode Zen (fallback catalog)",
      reasoning: looksReasoning(id),
    }));
  }
  if (provider === "opencode-go") {
    return OPENCODE_GO_FALLBACK.map((id) => ({
      id,
      name: id,
      provider: "opencode-go" as const,
      description: "OpenCode Go (fallback catalog)",
      reasoning: looksReasoning(id),
    }));
  }

  throw new Error(lastErr || "failed to list models");
}

/** Known Grok chat model IDs when /models is empty or blocked */
const XAI_FALLBACK_MODELS = [
  "grok-4.5",
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4-0709",
  "grok-3",
  "grok-3-mini",
  "grok-2-1212",
  "grok-2-vision-1212",
];

/** Subset of curated Zen models when /models is unavailable */
const OPENCODE_ZEN_FALLBACK = [
  "gpt-5.5",
  "gpt-5.4",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
  "gemini-3-flash",
  "gemini-3.1-pro",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "glm-5.2",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "minimax-m2.7",
  "grok-4.5",
  "big-pickle",
];

/** OpenCode Go open-model catalog subset */
const OPENCODE_GO_FALLBACK = [
  "kimi-k2.7-code",
  "kimi-k2.6",
  "glm-5.2",
  "glm-5.1",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "minimax-m3",
  "minimax-m2.7",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
];

async function fetchGemini(
  provider: ProviderId,
  baseUrl: string,
  token: string,
  timeoutMs: number,
): Promise<RemoteModel[]> {
  const base = baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const url = `${base}/models?key=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 401 || res.status === 403 || res.status === 400) {
    throw new Error(`HTTP ${res.status} unauthorized — check Gemini key`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} listing Gemini models`);
  const json = (await res.json()) as {
    models?: Array<
      Record<string, unknown> & {
        name?: string;
        displayName?: string;
        description?: string;
        supportedGenerationMethods?: string[];
        inputTokenLimit?: number;
      }
    >;
  };
  return (json.models ?? [])
    .filter((m) =>
      (m.supportedGenerationMethods ?? []).includes("generateContent"),
    )
    .map((m) => {
      // name like "models/gemini-2.5-pro"
      const id = (m.name ?? "").replace(/^models\//, "");
      const context =
        extractContextLength(m) ??
        (typeof m.inputTokenLimit === "number" ? m.inputTokenLimit : undefined);
      return {
        id,
        name: m.displayName ?? id,
        provider,
        description: m.description?.slice(0, 80),
        reasoning: looksReasoning(id),
        context,
        raw: m,
      };
    })
    .filter((m) => m.id);
}

async function fetchAnthropic(
  provider: ProviderId,
  baseUrl: string,
  token: string,
  timeoutMs: number,
): Promise<RemoteModel[]> {
  const base = baseUrl || "https://api.anthropic.com";
  const res = await fetch(`${base}/v1/models`, {
    headers: {
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`HTTP ${res.status} unauthorized — check Anthropic key`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} listing Anthropic models`);
  const json = (await res.json()) as {
    data?: Array<
      Record<string, unknown> & { id?: string; display_name?: string }
    >;
  };
  return (json.data ?? [])
    .filter((m) => m.id)
    .map((m) => ({
      id: m.id!,
      name: m.display_name ?? m.id!,
      provider,
      reasoning: looksReasoning(m.id!),
      context: extractContextLength(m),
      raw: m,
    }));
}

// --- legacy shims used by older call sites (deprecated) ---

export type ModelDef = RemoteModel;

export function modelsForProvider(provider: ProviderId | string): RemoteModel[] {
  return cache.get(provider)?.models ?? [];
}

export function findModel(id: string): RemoteModel | undefined {
  for (const [, v] of cache) {
    const hit = v.models.find((m) => m.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Look up a model in the live catalog cache (provider + id).
 * Tolerant of case and common id shapes (exact, suffix, provider/model).
 */
export function findModelForProvider(
  provider: ProviderId | string,
  modelId: string,
): RemoteModel | undefined {
  const id = modelId.trim();
  if (!id) return undefined;
  const list = cache.get(provider)?.models;
  const pool = list && list.length > 0 ? list : undefined;

  const matchIn = (models: RemoteModel[]): RemoteModel | undefined => {
    const exact = models.find((m) => m.id === id);
    if (exact) return exact;
    const lower = id.toLowerCase();
    const ci = models.find((m) => m.id.toLowerCase() === lower);
    if (ci) return ci;
    // OpenRouter-style: catalog id is "org/model", session may store the same
    const ends = models.find(
      (m) =>
        m.id.endsWith(`/${id}`) ||
        m.id.toLowerCase().endsWith(`/${lower}`) ||
        id.endsWith(`/${m.id}`) ||
        lower.endsWith(`/${m.id.toLowerCase()}`),
    );
    return ends;
  };

  if (pool) {
    const hit = matchIn(pool);
    if (hit) return hit;
  }
  return findModel(id) ?? findModelLoose(id);
}

function findModelLoose(id: string): RemoteModel | undefined {
  const lower = id.toLowerCase();
  for (const [, v] of cache) {
    const hit =
      v.models.find((m) => m.id === id) ??
      v.models.find((m) => m.id.toLowerCase() === lower) ??
      v.models.find(
        (m) =>
          m.id.endsWith(`/${id}`) ||
          m.id.toLowerCase().endsWith(`/${lower}`),
      );
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Base context window (input tokens) for a model from the fetched catalog.
 * Returns null when the catalog has no figure for this model.
 */
export function getModelContextWindow(
  provider: ProviderId | string,
  modelId: string,
): number | null {
  const m = findModelForProvider(provider, modelId);
  if (m?.context != null && m.context > 0) return m.context;
  // Last resort: scan raw payload if context was never promoted
  if (m?.raw && typeof m.raw === "object") {
    const n = extractContextLength(m.raw as Record<string, unknown>);
    if (n != null) return n;
  }
  return null;
}

/**
 * Pull context window from common provider model-list shapes:
 * OpenRouter / OpenAI-compat / xAI / Gemini / Anthropic.
 */
export function extractContextLength(
  raw: Record<string, unknown> | null | undefined,
): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const tryNum = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return Math.floor(v);
    }
    if (typeof v === "string" && /^\d+$/.test(v.trim())) {
      const n = Number(v.trim());
      return n > 0 ? n : undefined;
    }
    return undefined;
  };

  const direct =
    tryNum(raw.context_length) ??
    tryNum(raw.contextLength) ??
    tryNum(raw.context) ??
    tryNum(raw.max_context_length) ??
    tryNum(raw.max_input_tokens) ??
    tryNum(raw.maxInputTokens) ??
    tryNum(raw.input_token_limit) ??
    tryNum(raw.inputTokenLimit) ?? // Gemini
    tryNum(raw.context_window) ??
    tryNum(raw.contextWindow);
  if (direct != null) return direct;

  const arch = raw.architecture;
  if (arch && typeof arch === "object") {
    const a = arch as Record<string, unknown>;
    const n =
      tryNum(a.context_length) ??
      tryNum(a.contextLength) ??
      tryNum(a.context_window);
    if (n != null) return n;
  }

  const top = raw.top_provider ?? raw.topProvider;
  if (top && typeof top === "object") {
    const t = top as Record<string, unknown>;
    const n =
      tryNum(t.context_length) ??
      tryNum(t.contextLength) ??
      tryNum(t.max_completion_tokens);
    // max_completion_tokens is not context — skip that
    if (tryNum(t.context_length) != null || tryNum(t.contextLength) != null) {
      return tryNum(t.context_length) ?? tryNum(t.contextLength);
    }
    void n;
  }

  // Nested limits objects (some gateways)
  const limits = raw.limits ?? raw.token_limits ?? raw.tokenLimits;
  if (limits && typeof limits === "object") {
    const l = limits as Record<string, unknown>;
    const n =
      tryNum(l.context) ??
      tryNum(l.max_prompt_tokens) ??
      tryNum(l.max_input_tokens) ??
      tryNum(l.input);
    if (n != null) return n;
  }

  return undefined;
}

export function defaultModelFor(provider: ProviderId | string): string {
  const list = modelsForProvider(provider);
  return pickHighestReasoningModel(list)?.id ?? list[0]?.id ?? "";
}

export const MODEL_CATALOG: RemoteModel[] = [];
