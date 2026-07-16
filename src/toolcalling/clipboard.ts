/**
 * clipboard_read — read system clipboard (companion to TUI OSC-52 write).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ClipboardReadResult {
  ok: boolean;
  text?: string;
  error?: string;
  platform: string;
}

export async function clipboardRead(
  platform: NodeJS.Platform = process.platform,
): Promise<ClipboardReadResult> {
  try {
    if (platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-Clipboard -Raw",
        ],
        { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
      );
      return { ok: true, text: String(stdout).replace(/\r\n/g, "\n"), platform };
    }
    if (platform === "darwin") {
      const { stdout } = await execFileAsync("pbpaste", [], {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
      });
      return { ok: true, text: String(stdout), platform };
    }
    // Linux: try wl-paste then xclip
    try {
      const { stdout } = await execFileAsync("wl-paste", ["-n"], {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5_000,
      });
      return { ok: true, text: String(stdout), platform };
    } catch {
      /* try xclip */
    }
    try {
      const { stdout } = await execFileAsync(
        "xclip",
        ["-selection", "clipboard", "-o"],
        { maxBuffer: 4 * 1024 * 1024, timeout: 5_000 },
      );
      return { ok: true, text: String(stdout), platform };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `clipboard_read: wl-paste/xclip unavailable (${msg})`,
        platform,
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      platform,
    };
  }
}
