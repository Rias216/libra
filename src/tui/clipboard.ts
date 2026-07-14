/**
 * Copy plain text to the system clipboard.
 * Prefer OSC 52 (works over many terminals); on Windows also use clip.exe.
 */

import { spawn } from "node:child_process";

/** OSC 52 clipboard write (base64). Safe for modern terminals. */
export function writeOsc52(text: string, stdout: NodeJS.WriteStream = process.stdout): void {
  try {
    const b64 = Buffer.from(text, "utf8").toString("base64");
    // BEL terminator is widely supported; ST also used
    stdout.write(`\x1b]52;c;${b64}\x07`);
  } catch {
    /* ignore */
  }
}

/** Best-effort system clipboard (Windows/macOS/Linux). */
export function copyToSystemClipboard(text: string): void {
  if (!text) return;
  try {
    const plat = process.platform;
    if (plat === "win32") {
      // clip.exe expects UTF-16LE on modern Windows when piped carefully;
      // PowerShell Set-Clipboard handles Unicode reliably.
      const ps = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Set-Clipboard -Value $input",
        ],
        { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
      );
      ps.stdin?.write(text, "utf8");
      ps.stdin?.end();
      return;
    }
    if (plat === "darwin") {
      const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      p.stdin?.write(text, "utf8");
      p.stdin?.end();
      return;
    }
    // Linux: try wl-copy then xclip
    const wl = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
    wl.on("error", () => {
      const xc = spawn("xclip", ["-selection", "clipboard"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      xc.stdin?.write(text, "utf8");
      xc.stdin?.end();
    });
    wl.stdin?.write(text, "utf8");
    wl.stdin?.end();
  } catch {
    /* ignore */
  }
}

/** OSC 52 + OS clipboard. */
export function copyText(
  text: string,
  stdout?: NodeJS.WriteStream,
): void {
  if (!text) return;
  writeOsc52(text, stdout);
  copyToSystemClipboard(text);
}
