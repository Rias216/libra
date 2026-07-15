/**
 * Credential store at ~/.libra/auth.json (mode-restricted when possible).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AuthFile, ProviderId, StoredCredential } from "./types.js";
import { canonicalizeProviderId } from "./types.js";

function authPath(): string {
  return process.env.LIBRA_AUTH ?? join(homedir(), ".libra", "auth.json");
}

export function loadAuth(): AuthFile {
  try {
    const p = authPath();
    if (!existsSync(p)) return { version: 1, credentials: [] };
    const raw = JSON.parse(readFileSync(p, "utf8")) as AuthFile;
    if (!raw.credentials) return { version: 1, credentials: [] };
    return raw;
  } catch {
    return { version: 1, credentials: [] };
  }
}

export function saveAuth(file: AuthFile): void {
  const p = authPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

export function getCredential(provider: ProviderId): StoredCredential | undefined {
  const id = canonicalizeProviderId(provider) ?? provider;
  return loadAuth().credentials.find((c) => c.provider === id);
}

export function upsertCredential(cred: StoredCredential): void {
  const file = loadAuth();
  const id = canonicalizeProviderId(cred.provider) ?? cred.provider;
  const normalized = { ...cred, provider: id };
  const idx = file.credentials.findIndex((c) => c.provider === id);
  if (idx >= 0) file.credentials[idx] = normalized;
  else file.credentials.push(normalized);
  saveAuth(file);
}

export function removeCredential(provider: ProviderId): void {
  const id = canonicalizeProviderId(provider) ?? provider;
  const file = loadAuth();
  file.credentials = file.credentials.filter((c) => c.provider !== id);
  saveAuth(file);
}

export function listCredentials(): StoredCredential[] {
  return loadAuth().credentials;
}

/** Mask a secret for display: sk-abc...xyz */
export function maskSecret(token: string | undefined): string {
  if (!token) return "(none)";
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
