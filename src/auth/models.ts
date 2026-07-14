/**
 * Dynamic model catalog — fetched live from each connected provider.
 * No hardcoded per-provider model lists (stale by design).
 */

import type { ProviderId } from "./types.js";
import { getProvider, PROVIDERS } from "./types.js";
import { resolveToken } from "./api-key.js";
import { getCredential } from "./store.js";

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

  const token = resolveToken(provider);
  if (!token) {
    return {
      models: [],
      error: `not logged in (${def.envKey ?? "API key"})`,
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

/** Heuristic: pick "highest" reasoning model from a list. */
export function pickHighestReasoningModel(
  models: RemoteModel[],
): RemoteModel | undefined {
  if (models.length === 0) return undefined;
  const scored = models.map((m) => ({ m, s: reasonScore(m) }));
  scored.sort((a, b) => b.s - a.s || a.m.id.localeCompare(b.m.id));
  return scored[0]?.m;
}

function reasonScore(m: RemoteModel): number {
  const id = m.id.toLowerCase();
  let s = 0;
  if (m.reasoning) s += 50;
  if (/reason|thinking|o3|o4|opus|pro|ultra|4\.5|4-1/.test(id)) s += 30;
  if (/mini|fast|flash|haiku|lite|nano/.test(id)) s -= 20;
  if (/grok-4|claude-opus|gpt-4\.1(?!-mini)|gemini-2\.5-pro/.test(id)) s += 25;
  if (/grok-4\.5|grok-4-1/.test(id)) s += 40;
  return s;
}

function looksReasoning(id: string): boolean {
  const x = id.toLowerCase();
  return /reason|thinking|o1|o3|o4|r1|opus/.test(x);
}

async function fetchOpenAIStyle(
  provider: ProviderId,
  baseUrl: string,
  token: string,
  timeoutMs: number,
): Promise<RemoteModel[]> {
  if (!baseUrl) throw new Error("missing base URL");
  const url = `${baseUrl}/models`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/libra-tui";
    headers["X-Title"] = "Libra";
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`HTTP ${res.status} unauthorized — check API key`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} listing models`);
  }
  const json = (await res.json()) as {
    data?: Array<{ id?: string; object?: string; owned_by?: string }>;
  };
  const data = json.data ?? [];
  return data
    .filter((m) => m.id)
    .map((m) => ({
      id: m.id!,
      name: m.id!,
      provider,
      description: m.owned_by ? `owned_by ${m.owned_by}` : undefined,
      reasoning: looksReasoning(m.id!),
      raw: m,
    }));
}

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
