/**
 * Dynamic model catalog — fetched live from each connected provider.
 * No hardcoded per-provider model lists (stale by design).
 */

import type { ProviderId } from "./types.js";
import { getProvider, PROVIDERS } from "./types.js";
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

export function parseModelKey(key: string): ModelRef | null {
  const i = key.indexOf("/");
  if (i <= 0) return null;
  const provider = key.slice(0, i) as ProviderId;
  const model = key.slice(i + 1);
  if (!getProvider(provider) || !model) return null;
  return { provider, model };
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
  if (provider === "openrouter") {
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
        data?: Array<{
          id?: string;
          object?: string;
          owned_by?: string;
          name?: string;
        }>;
        models?: Array<{ id?: string; name?: string }>;
      };
      // Support { data: [...] } and { models: [...] }
      const rawList = json.data ?? json.models ?? [];
      const mapped: RemoteModel[] = [];
      for (const m of rawList) {
        const id = m.id ?? m.name;
        if (!id) continue;
        // Skip non-chat noise when obvious
        if (/embed|whisper|tts|moderation|dall-e|image|audio/i.test(id)) {
          continue;
        }
        const owned =
          "owned_by" in m && typeof (m as { owned_by?: string }).owned_by === "string"
            ? (m as { owned_by: string }).owned_by
            : undefined;
        mapped.push({
          id,
          name: m.name ?? id,
          provider,
          description:
            owned != null
              ? `owned_by ${owned}`
              : provider === "xai"
                ? "xAI Grok"
                : undefined,
          reasoning: looksReasoning(id),
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

  // xAI fallback catalog if live list fails (still allows selecting known IDs)
  if (provider === "xai") {
    return XAI_FALLBACK_MODELS.map((id) => ({
      id,
      name: id,
      provider: "xai" as const,
      description: "xAI (fallback catalog — API list unavailable)",
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
    models?: Array<{
      name?: string;
      displayName?: string;
      description?: string;
      supportedGenerationMethods?: string[];
    }>;
  };
  return (json.models ?? [])
    .filter((m) =>
      (m.supportedGenerationMethods ?? []).includes("generateContent"),
    )
    .map((m) => {
      // name like "models/gemini-2.5-pro"
      const id = (m.name ?? "").replace(/^models\//, "");
      return {
        id,
        name: m.displayName ?? id,
        provider,
        description: m.description?.slice(0, 80),
        reasoning: looksReasoning(id),
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
    data?: Array<{ id?: string; display_name?: string }>;
  };
  return (json.data ?? [])
    .filter((m) => m.id)
    .map((m) => ({
      id: m.id!,
      name: m.display_name ?? m.id!,
      provider,
      reasoning: looksReasoning(m.id!),
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

export function defaultModelFor(provider: ProviderId | string): string {
  const list = modelsForProvider(provider);
  return pickHighestReasoningModel(list)?.id ?? list[0]?.id ?? "";
}

export const MODEL_CATALOG: RemoteModel[] = [];
