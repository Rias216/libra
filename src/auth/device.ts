/**
 * xAI auth helpers.
 *
 * The xAI *developer* Inference API authenticates with a Bearer API key
 * from https://console.x.ai — there is no public device-code OAuth for
 * api.x.ai. Libra stores that key via /login xai.
 *
 * Optional: open the console in a browser and prompt the user to paste
 * the key (still API-key auth, not a fake local "retype code" dance).
 */

import { spawn } from "node:child_process";
import { saveApiKey } from "./api-key.js";

export const XAI_CONSOLE_URL = "https://console.x.ai/team/default/api-keys";
export const XAI_DOCS_URL = "https://docs.x.ai/docs/tutorial";

/** Best-effort open URL in the default browser. */
export function openBrowser(url: string): void {
  try {
    const plat = process.platform;
    if (plat === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (plat === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // ignore
  }
}

/**
 * Validate and store an xAI API key.
 * Accepts keys from console.x.ai (typically start with xai-).
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
        "That looks like an old demo token. Paste a real key from console.x.ai",
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

/**
 * @deprecated Device-code OAuth is not used by the xAI Inference API.
 * Kept as thin wrappers so old call sites fail clearly.
 */
export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresInSec: number;
}

export interface DeviceFlowCallbacks {
  onCode: (info: DeviceCodeStart) => void;
  onStatus?: (msg: string) => void;
  signal?: AbortSignal;
}

export async function startXaiDeviceFlow(
  _cbs: DeviceFlowCallbacks,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  return {
    ok: false,
    error:
      "xAI Inference API uses API keys (console.x.ai), not device-code OAuth. Use /login xai and paste your key.",
  };
}

export async function confirmXaiDeviceCode(_opts: {
  issued: DeviceCodeStart;
  enteredCode: string;
  tokenUrl?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return {
    ok: false,
    error:
      "Device-code confirm is disabled. Connect with an API key from console.x.ai",
  };
}
