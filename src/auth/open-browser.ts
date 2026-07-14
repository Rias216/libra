/**
 * Open a URL in the default browser.
 *
 * Windows: `cmd /c start` truncates at `&` (query params), which makes
 * OAuth URLs look like "Missing or invalid client_id". Use PowerShell
 * Start-Process so the full query string is preserved.
 */

import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
  try {
    const plat = process.platform;
    if (plat === "win32") {
      // PowerShell Start-Process with a single-quoted URL keeps & intact.
      // Escape single quotes for PowerShell: ' -> ''
      const safe = url.replace(/'/g, "''");
      spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          `Start-Process '${safe}'`,
        ],
        { detached: true, stdio: "ignore", windowsHide: true },
      ).unref();
      return;
    }
    if (plat === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // ignore — caller may print the URL for manual open
  }
}
