/**
 * Verify provider credentials end-to-end.
 */

import {
  getProvider,
  type ProviderId,
  PROVIDERS,
} from "./types.js";
import { resolveToken } from "./api-key.js";
import { getCredential } from "./store.js";
import { connectXaiApiKey } from "./device.js";
import { fetchModelsForProvider } from "./models.js";

export interface VerifyResult {
  provider: ProviderId;
  ok: boolean;
  status:
    | "ok"
    | "missing"
    | "invalid_format"
    | "unreachable"
    | "unauthorized"
    | "skipped"
    | "error";
  message: string;
  httpStatus?: number;
  method?: string;
  modelCount?: number;
}

export interface VerifyOptions {
  providers?: ProviderId[];
  offline?: boolean;
  timeoutMs?: number;
}

export function validateKeyFormat(
  provider: ProviderId,
  key: string,
): { ok: true } | { ok: false; error: string } {
  const k = key.trim();
  if (!k) return { ok: false, error: "empty key" };
  if (k.length < 8) return { ok: false, error: "key too short" };

  // Reject obsolete demo tokens
  if (k.startsWith("xai_device_")) {
    return {
      ok: false,
      error: "obsolete demo token — use a real API key from console.x.ai",
    };
  }

  switch (provider) {
    case "xai":
      // console.x.ai keys are often xai-... but accept any long secret
      if (k.startsWith("xai-") || k.length >= 20) return { ok: true };
      return { ok: false, error: "expected API key from console.x.ai (xai-...)" };
    case "gemini":
      if (k.startsWith("AIza") || k.length >= 20) return { ok: true };
      return { ok: false, error: "expected Google AI Studio key (AIza...)" };
    case "openai":
    case "codex":
      if (k.startsWith("sk-") || k.startsWith("sess-") || k.length >= 20) {
        return { ok: true };
      }
      return { ok: false, error: "expected sk-... OpenAI key" };
    case "openrouter":
      if (k.startsWith("sk-or-") || k.startsWith("sk-") || k.length >= 20) {
        return { ok: true };
      }
      return { ok: false, error: "expected sk-or-... OpenRouter key" };
    case "anthropic":
      if (k.startsWith("sk-ant-") || k.length >= 20) return { ok: true };
      return { ok: false, error: "expected sk-ant-... Anthropic key" };
    case "custom":
      return { ok: true };
    default:
      return { ok: true };
  }
}

export async function verifyProvider(
  provider: ProviderId,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const def = getProvider(provider);
  if (!def) {
    return {
      provider,
      ok: false,
      status: "error",
      message: "unknown provider",
    };
  }

  const cred = getCredential(provider);
  const token = resolveToken(provider);

  if (!token) {
    return {
      provider,
      ok: false,
      status: "missing",
      message: `no credential (set ${def.envKey ?? "API key"} or /login ${provider})`,
      method: cred?.method,
    };
  }

  const fmt = validateKeyFormat(provider, token);
  if (!fmt.ok) {
    return {
      provider,
      ok: false,
      status: "invalid_format",
      message: fmt.error,
      method: cred?.method ?? "api_key",
    };
  }

  if (opts.offline) {
    return {
      provider,
      ok: true,
      status: "ok",
      message: `format ok (${cred?.method ?? "env"}) — offline`,
      method: cred?.method ?? "api_key",
    };
  }

  // Live: list models (proves the key works and refreshes cache)
  const listed = await fetchModelsForProvider(provider, {
    force: true,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  if (listed.error) {
    const unauthorized = /401|403|unauthorized/i.test(listed.error);
    return {
      provider,
      ok: false,
      status: unauthorized ? "unauthorized" : "unreachable",
      message: listed.error,
      method: cred?.method ?? "api_key",
    };
  }

  return {
    provider,
    ok: true,
    status: "ok",
    message: `live OK — ${listed.models.length} models`,
    method: cred?.method ?? "api_key",
    modelCount: listed.models.length,
  };
}

export async function verifyAll(
  opts: VerifyOptions = {},
): Promise<VerifyResult[]> {
  const withToken = PROVIDERS.map((p) => p.id).filter((id) =>
    Boolean(resolveToken(id)),
  );
  const ids = opts.providers?.length
    ? opts.providers
    : withToken.length > 0
      ? withToken
      : (PROVIDERS.map((p) => p.id) as ProviderId[]);

  const out: VerifyResult[] = [];
  for (const id of ids) {
    out.push(await verifyProvider(id, opts));
  }
  return out;
}

/** Offline suite: key formats + xAI connect helper. */
export async function verifyAuthModelsOffline(): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];

  // xAI connect rejects fake device tokens
  const rejectDemo = connectXaiApiKey("xai_device_fake");
  results.push({
    provider: "xai",
    ok: !rejectDemo.ok,
    status: !rejectDemo.ok ? "ok" : "error",
    message: !rejectDemo.ok
      ? "rejects obsolete device demo tokens"
      : "should reject xai_device_ tokens",
    method: "api_key",
  });

  const samples: Record<ProviderId, { good: string; bad: string }> = {
    xai: { good: "xai-abcdefghijklmnopqrstuv", bad: "short" },
    gemini: { good: "AIzaSyDummyKeyForFormatCheck01", bad: "nope" },
    openai: { good: "sk-proj-abcdefghijklmnopqrstuv", bad: "abc" },
    codex: { good: "sk-abcdefghijklmnopqrstuvwxyz", bad: "x" },
    openrouter: { good: "sk-or-v1-abcdefghijklmnopqrstuv", bad: "or" },
    anthropic: { good: "sk-ant-api03-abcdefghijklmnopqrstuv", bad: "ant" },
    custom: { good: "any-long-enough-key-value", bad: "" },
  };

  for (const p of PROVIDERS) {
    const s = samples[p.id];
    const g = validateKeyFormat(p.id, s.good);
    const b = validateKeyFormat(p.id, s.bad);
    if (!g.ok) {
      results.push({
        provider: p.id,
        ok: false,
        status: "error",
        message: `good key rejected: ${g.error}`,
        method: "api_key",
      });
      continue;
    }
    if (b.ok) {
      results.push({
        provider: p.id,
        ok: false,
        status: "error",
        message: "bad key was accepted",
        method: "api_key",
      });
      continue;
    }
    results.push({
      provider: p.id,
      ok: true,
      status: "ok",
      message: "API key format rules OK",
      method: "api_key",
    });
  }

  return results;
}

/** @deprecated */
export async function verifyXaiDeviceCodeFlow(): Promise<VerifyResult> {
  return {
    provider: "xai",
    ok: true,
    status: "ok",
    message: "device-code OAuth removed — xAI uses API keys from console.x.ai",
    method: "api_key",
  };
}
