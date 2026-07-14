/**
 * xAI auth helpers — browser open + API-key path.
 * Full OAuth PKCE lives in ./xai-oauth.ts
 */

import { saveApiKey } from "./api-key.js";
export { openBrowser } from "./open-browser.js";

export const XAI_CONSOLE_URL = "https://console.x.ai/team/default/api-keys";
export const XAI_DOCS_URL = "https://docs.x.ai/docs/tutorial";
export const XAI_AUTH_URL = "https://auth.x.ai";

/**
 * Validate and store an xAI API key (console.x.ai).
 * Prefer OAuth via /login xai → Browser OAuth for SuperGrok subscription.
 */
export function connectXaiApiKey(
  key: string,
): { ok: true } | { ok: false; error: string } {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "empty key" };
  if (trimmed.startsWith("xai_device_")) {
    return {
      ok: false,
      error:
        "That looks like an old demo token. Use Browser OAuth or paste a key from console.x.ai",
    };
  }
  if (trimmed.length < 8) return { ok: false, error: "key too short" };
  if (!(trimmed.startsWith("xai-") || trimmed.length >= 20)) {
    return {
      ok: false,
      error: "expected API key from console.x.ai (xai-...)",
    };
  }

  return saveApiKey("xai", trimmed, { label: "xAI console API key" });
}

// Re-export OAuth for convenience
export {
  loginXaiOAuth,
  importGrokCliAuth,
  resolveXaiAccessToken,
  ensureFreshXaiCredentials,
  loadGrokCliCredentials,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REDIRECT_PORT,
} from "./xai-oauth.js";
