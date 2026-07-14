/**
 * xAI SuperGrok OAuth (Authorization Code + PKCE).
 *
 * Mirrors the official Grok CLI / pi-xai-oauth flow:
 *  1. Local HTTP callback on 127.0.0.1
 *  2. Authorize URL with PKCE S256 challenge
 *  3. Browser opens auth.x.ai login
 *  4. Redirect to local callback with code
 *  5. Exchange code → access + refresh tokens
 *  6. Persist to ~/.libra/auth.json; refresh automatically
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getCredential, upsertCredential } from "./store.js";
import type { StoredCredential } from "./types.js";
import { openBrowser } from "./open-browser.js";

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
/** Public Grok CLI / pi client id (PKCE public client — no secret). */
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
export const XAI_OAUTH_REDIRECT_PORT = 56121;
export const XAI_OAUTH_REDIRECT_PATH = "/callback";
/** Refresh this many ms before expires_at. */
export const XAI_OAUTH_REFRESH_SKEW_MS = 2 * 60 * 1000;

const GROK_CLI_SCOPE_KEY = `${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`;
const GROK_CLI_LEGACY_KEY = "https://accounts.x.ai/sign-in";

type XaiDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
};

type XaiTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
};

type CallbackResult = {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  trustedManualCode?: boolean;
};

export interface XaiOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  tokenEndpoint: string;
  tokenType?: string;
  idToken?: string;
}

export interface XaiOAuthLoginCallbacks {
  onProgress?: (msg: string) => void;
  /** Called with the authorize URL (browser open is automatic). */
  onAuthUrl?: (url: string) => void;
  signal?: AbortSignal;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function validateXaiEndpoint(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    (host !== "x.ai" && !host.endsWith(".x.ai"))
  ) {
    throw new Error(`xAI OAuth discovery returned unexpected endpoint: ${url}`);
  }
  return url;
}

async function xaiDiscovery(): Promise<XaiDiscovery> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `xAI OAuth discovery failed: ${response.status} ${await response.text()}`,
    );
  }
  const data = (await response.json()) as Partial<XaiDiscovery>;
  if (!data.authorization_endpoint || !data.token_endpoint) {
    throw new Error("xAI OAuth discovery missing authorization/token endpoints");
  }
  return {
    authorization_endpoint: validateXaiEndpoint(data.authorization_endpoint),
    token_endpoint: validateXaiEndpoint(data.token_endpoint),
  };
}

function callbackCorsOrigin(origin: string | undefined): string | undefined {
  return origin === "https://accounts.x.ai" || origin === "https://auth.x.ai"
    ? origin
    : undefined;
}

function writeCors(res: ServerResponse, origin: string | undefined): void {
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Vary", "Origin");
}

async function startCallbackServer(expectedState: string): Promise<{
  redirectUri: string;
  waitForCallback: (signal?: AbortSignal) => Promise<CallbackResult>;
  resolveCallback: (result: CallbackResult) => void;
  close: () => void;
}> {
  let resolveCallback!: (result: CallbackResult) => void;
  const callbackPromise = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const origin = callbackCorsOrigin(req.headers.origin);

    if (req.method === "OPTIONS") {
      writeCors(res, origin);
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${XAI_OAUTH_REDIRECT_HOST}`);
    if (url.pathname !== XAI_OAUTH_REDIRECT_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const result: CallbackResult = {
      code: url.searchParams.get("code") || undefined,
      state: url.searchParams.get("state") || undefined,
      error: url.searchParams.get("error") || undefined,
      error_description:
        url.searchParams.get("error_description") || undefined,
    };

    if (result.state !== expectedState) {
      writeCors(res, origin);
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><body><h1>xAI authorization state mismatch.</h1>Return to Libra and try again.</body></html>",
      );
      return;
    }

    resolveCallback(result);
    writeCors(res, origin);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      result.error
        ? "<html><body><h1>xAI authorization failed.</h1>You can close this tab.</body></html>"
        : "<html><body><h1>xAI authorization received.</h1>You can close this tab and return to Libra.</body></html>",
    );
  };

  const listen = (port: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = createServer(handle);
      server.once("error", reject);
      server.listen(port, XAI_OAUTH_REDIRECT_HOST, () => {
        server.removeListener("error", reject);
        resolve(server);
      });
    });

  let server: Server;
  try {
    server = await listen(XAI_OAUTH_REDIRECT_PORT);
  } catch {
    // Port busy — fall back to ephemeral
    server = await listen(0);
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine xAI OAuth callback port");
  }

  const redirectUri = `http://${XAI_OAUTH_REDIRECT_HOST}:${address.port}${XAI_OAUTH_REDIRECT_PATH}`;

  const close = () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  };

  return {
    redirectUri,
    close,
    resolveCallback,
    waitForCallback: async (signal?: AbortSignal) => {
      let timer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;
      const timeout = new Promise<CallbackResult>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for xAI OAuth callback (3 min)")),
          180_000,
        );
        abortHandler = () => {
          if (timer) clearTimeout(timer);
          reject(new Error("xAI OAuth login was cancelled"));
        };
        signal?.addEventListener("abort", abortHandler, { once: true });
      });

      try {
        return await Promise.race([callbackPromise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
        close();
      }
    },
  };
}

function buildAuthorizeUrl(
  discovery: XaiDiscovery,
  redirectUri: string,
  challenge: string,
  state: string,
  nonce: string,
): string {
  // Match official Grok CLI — extra params can route users to API console SSO.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

async function exchangeXaiToken(
  tokenEndpoint: string,
  body: Record<string, string>,
): Promise<XaiTokenPayload> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `xAI token request failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as XaiTokenPayload;
}

function credentialsFromTokenPayload(
  data: XaiTokenPayload,
  tokenEndpoint: string,
  fallbackRefresh = "",
): XaiOAuthCredentials {
  if (!data.access_token) {
    throw new Error("xAI token response missing access_token");
  }
  const refresh = data.refresh_token || fallbackRefresh;
  if (!refresh) {
    throw new Error("xAI token response missing refresh_token");
  }
  return {
    refresh,
    access: data.access_token,
    expires:
      Date.now() + (data.expires_in || 3600) * 1000 - XAI_OAUTH_REFRESH_SKEW_MS,
    tokenEndpoint,
    idToken: data.id_token || "",
    tokenType: data.token_type || "Bearer",
  };
}

/** Persist OAuth tokens into ~/.libra/auth.json */
export function saveXaiOAuthCredentials(creds: XaiOAuthCredentials): void {
  upsertCredential({
    provider: "xai",
    method: "oauth_browser",
    token: creds.access,
    refreshToken: creds.refresh,
    expiresAt: creds.expires,
    label: "xAI SuperGrok OAuth",
    meta: {
      tokenEndpoint: creds.tokenEndpoint,
      tokenType: creds.tokenType ?? "Bearer",
      ...(creds.idToken ? { idToken: creds.idToken.slice(0, 32) + "…" } : {}),
    },
    updatedAt: Date.now(),
  });
}

export function storedToXaiOAuth(
  c: StoredCredential,
): XaiOAuthCredentials | null {
  if (!c.token) return null;
  if (c.method !== "oauth_browser" && !c.refreshToken) return null;
  return {
    access: c.token,
    refresh: c.refreshToken ?? "",
    expires: c.expiresAt ?? Date.now() + 3600_000,
    tokenEndpoint:
      c.meta?.tokenEndpoint ?? `${XAI_OAUTH_ISSUER}/oauth2/token`,
    tokenType: c.meta?.tokenType ?? "Bearer",
  };
}

/** Refresh using refresh_token grant. */
export async function refreshXaiCredentials(
  credentials: XaiOAuthCredentials,
): Promise<XaiOAuthCredentials> {
  if (!credentials.refresh) {
    throw new Error(
      "xAI credentials expired and have no refresh token — run /login xai",
    );
  }
  const tokenEndpoint =
    credentials.tokenEndpoint && credentials.tokenEndpoint.startsWith("https://")
      ? validateXaiEndpoint(credentials.tokenEndpoint)
      : (await xaiDiscovery()).token_endpoint;

  const data = await exchangeXaiToken(tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: XAI_OAUTH_CLIENT_ID,
  });
  return credentialsFromTokenPayload(
    data,
    tokenEndpoint,
    credentials.refresh,
  );
}

/** Return as-is when fresh, otherwise refresh + re-persist. */
export async function ensureFreshXaiCredentials(
  credentials: XaiOAuthCredentials,
  opts?: { persist?: boolean },
): Promise<XaiOAuthCredentials> {
  if (credentials.expires > Date.now()) return credentials;
  const next = await refreshXaiCredentials(credentials);
  if (opts?.persist !== false) saveXaiOAuthCredentials(next);
  return next;
}

/** Parse expires_at from number, unix string, or ISO (Grok CLI uses ISO). */
function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // seconds vs ms heuristic
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  // Trim sub-ms fractions so Date.parse accepts Grok CLI timestamps
  const iso = value.replace(/(\.\d{3})\d+(Z)?$/, "$1$2");
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Load OAuth credentials from official Grok CLI ~/.grok/auth.json if present.
 * Also accepts any key matching auth.x.ai::<client_id>.
 */
export function loadGrokCliCredentials(): XaiOAuthCredentials | null {
  const authPath = join(homedir(), ".grok", "auth.json");
  if (!existsSync(authPath)) return null;
  try {
    const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
      string,
      unknown
    >;

    const candidates: unknown[] = [];
    if (data[GROK_CLI_SCOPE_KEY]) candidates.push(data[GROK_CLI_SCOPE_KEY]);
    // Any auth.x.ai::<uuid> entry
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith("https://auth.x.ai::") && v !== data[GROK_CLI_SCOPE_KEY]) {
        candidates.push(v);
      }
    }
    if (data[GROK_CLI_LEGACY_KEY]) candidates.push(data[GROK_CLI_LEGACY_KEY]);

    for (const entry of candidates) {
      if (!entry || typeof entry !== "object") continue;
      const o = entry as Record<string, unknown>;
      const access = String(o.key || o.access_token || o.token || "");
      if (!access) continue;
      const expires =
        parseExpiry(o.expires_at) ??
        parseExpiry(o.expires) ??
        Date.now() + 6 * 60 * 60 * 1000;
      return {
        access,
        refresh: String(o.refresh_token || o.refresh || ""),
        expires: expires - XAI_OAUTH_REFRESH_SKEW_MS,
        tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
        tokenType: "Bearer",
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Full browser PKCE login. Opens the authorize URL automatically.
 */
export async function loginXaiOAuth(
  cbs: XaiOAuthLoginCallbacks = {},
): Promise<
  | { ok: true; credentials: XaiOAuthCredentials }
  | { ok: false; error: string }
> {
  try {
    cbs.onProgress?.("Discovering xAI OAuth endpoints…");
    const discovery = await xaiDiscovery();
    const { verifier, challenge } = pkcePair();
    const state = randomUUID().replace(/-/g, "");
    const nonce = randomUUID().replace(/-/g, "");
    const callbackServer = await startCallbackServer(state);
    const authorizeUrl = buildAuthorizeUrl(
      discovery,
      callbackServer.redirectUri,
      challenge,
      state,
      nonce,
    );

    cbs.onProgress?.(
      `Callback listening on ${callbackServer.redirectUri}`,
    );
    cbs.onAuthUrl?.(authorizeUrl);
    openBrowser(authorizeUrl);
    cbs.onProgress?.(
      "Browser opened — approve xAI login. Waiting for callback…",
    );

    const callback = await callbackServer.waitForCallback(cbs.signal);
    if (callback.error) {
      return {
        ok: false,
        error: `authorization failed: ${callback.error_description || callback.error}`,
      };
    }
    if (!callback.trustedManualCode && callback.state !== state) {
      return { ok: false, error: "authorization state mismatch" };
    }
    if (!callback.code) {
      return { ok: false, error: "no authorization code returned" };
    }

    cbs.onProgress?.("Exchanging authorization code for tokens…");
    const data = await exchangeXaiToken(discovery.token_endpoint, {
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: callbackServer.redirectUri,
      client_id: XAI_OAUTH_CLIENT_ID,
      code_verifier: verifier,
    });

    const credentials = credentialsFromTokenPayload(
      data,
      discovery.token_endpoint,
    );
    saveXaiOAuthCredentials(credentials);
    cbs.onProgress?.("xAI OAuth tokens saved");
    return { ok: true, credentials };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Import ~/.grok/auth.json into Libra store (with refresh if needed).
 */
export async function importGrokCliAuth(): Promise<
  | { ok: true; credentials: XaiOAuthCredentials }
  | { ok: false; error: string }
> {
  const existing = loadGrokCliCredentials();
  if (!existing) {
    return {
      ok: false,
      error: "no ~/.grok/auth.json OAuth credentials found",
    };
  }
  try {
    const fresh = await ensureFreshXaiCredentials(existing, { persist: true });
    saveXaiOAuthCredentials(fresh);
    return { ok: true, credentials: fresh };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve a usable xAI bearer token: OAuth (refreshed) → API key → env.
 */
export async function resolveXaiAccessToken(): Promise<string | undefined> {
  const cred = getCredential("xai");
  if (cred?.method === "oauth_browser" && cred.token) {
    const oauth = storedToXaiOAuth(cred);
    if (oauth) {
      try {
        const fresh = await ensureFreshXaiCredentials(oauth, { persist: true });
        return fresh.access;
      } catch {
        // fall through
      }
    }
  }
  if (cred?.token) return cred.token;

  // Try Grok CLI store
  const grok = loadGrokCliCredentials();
  if (grok) {
    try {
      const fresh = await ensureFreshXaiCredentials(grok, { persist: true });
      return fresh.access;
    } catch {
      if (grok.access) return grok.access;
    }
  }

  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  return undefined;
}
