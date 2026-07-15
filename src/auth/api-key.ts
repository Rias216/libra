/**
 * API-key based provider connection + token resolution.
 * xAI OAuth tokens are refreshed via resolveTokenFresh.
 */

import type { ProviderId } from "./types.js";
import {
  canonicalizeProviderId,
  getProvider,
  isOpenCodeFamily,
} from "./types.js";
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
  const canonical =
    canonicalizeProviderId(provider) ?? (provider as ProviderId);
  const def = getProvider(canonical);
  const meta: Record<string, string> = {};
  if (extra?.baseUrl) meta.baseUrl = extra.baseUrl.replace(/\/$/, "");
  upsertCredential({
    provider: canonical,
    method: "api_key",
    token: trimmed,
    label: extra?.label ?? def?.name ?? canonical,
    meta: Object.keys(meta).length ? meta : undefined,
    updatedAt: Date.now(),
  });
  return { ok: true };
}

/**
 * Sync token lookup (no network). Prefer resolveTokenFresh for API calls
 * so xAI OAuth tokens are refreshed when expired.
 *
 * OpenCode Zen and Go share the same console API key — if one side is
 * stored, the other can use it (docs: same key works for both).
 */
export function resolveToken(provider: ProviderId): string | undefined {
  const canonical =
    canonicalizeProviderId(provider) ?? (provider as ProviderId);
  const stored = getCredential(canonical)?.token;
  if (stored) return stored;

  const def = getProvider(canonical);
  if (def?.envKey && process.env[def.envKey]) {
    return process.env[def.envKey];
  }
  for (const alias of def?.envKeyAliases ?? []) {
    const v = process.env[alias];
    if (v) return v;
  }

  // Zen ↔ Go shared console credential
  if (isOpenCodeFamily(canonical)) {
    const peer: ProviderId =
      canonical === "opencode" ? "opencode-go" : "opencode";
    const peerTok = getCredential(peer)?.token;
    if (peerTok) return peerTok;
    if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
    if (process.env.OPENCODE_ZEN_API_KEY) return process.env.OPENCODE_ZEN_API_KEY;
    if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
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
