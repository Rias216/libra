/**
 * API-key based provider connection + token resolution.
 * xAI OAuth tokens are refreshed via resolveTokenFresh.
 */

import type { ProviderId } from "./types.js";
import { getProvider } from "./types.js";
import { getCredential, upsertCredential } from "./store.js";

export function saveApiKey(
  provider: ProviderId,
  key: string,
  extra?: { baseUrl?: string; label?: string },
): { ok: true } | { ok: false; error: string } {
  const trimmed = key.trim();
  if (!trimmed) {
    return { ok: false, error: "API key is empty" };
  }
  // Lightweight format check (full verify is in verify.ts)
  if (trimmed.length < 8) {
    return { ok: false, error: "API key looks too short" };
  }
  const def = getProvider(provider);
  const meta: Record<string, string> = {};
  if (extra?.baseUrl) meta.baseUrl = extra.baseUrl.replace(/\/$/, "");
  upsertCredential({
    provider,
    method: "api_key",
    token: trimmed,
    label: extra?.label ?? def?.name ?? provider,
    meta: Object.keys(meta).length ? meta : undefined,
    updatedAt: Date.now(),
  });
  return { ok: true };
}

/**
 * Sync token lookup (no network). Prefer resolveTokenFresh for API calls
 * so xAI OAuth tokens are refreshed when expired.
 */
export function resolveToken(provider: ProviderId): string | undefined {
  const stored = getCredential(provider)?.token;
  if (stored) return stored;
  const def = getProvider(provider);
  if (def?.envKey && process.env[def.envKey]) {
    return process.env[def.envKey];
  }
  return undefined;
}

/**
 * Resolve a usable bearer token, refreshing xAI OAuth when needed.
 */
export async function resolveTokenFresh(
  provider: ProviderId,
): Promise<string | undefined> {
  if (provider === "xai") {
    const { resolveXaiAccessToken } = await import("./xai-oauth.js");
    return resolveXaiAccessToken();
  }
  return resolveToken(provider);
}
