/**
 * screenshot — custom tool: native window / CDP / optional Playwright capture.
 * Returns image content parts + short text summary; saves under .libra/screenshots/.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSession } from "./process.js";
import {
  cdpCaptureScreenshot,
  CdpSession,
  listCdpTargets,
  pickCdpTarget,
} from "./cdp.js";
import {
  imagePart,
  textPart,
  type ChatContentPart,
} from "./multimodal.js";

const execFileAsync = promisify(execFile);

export interface ScreenshotArgs {
  session_id?: string;
  pid?: number;
  url?: string;
  selector?: string;
  full_page?: boolean;
  engine?: "cdp" | "playwright";
  full_screen?: boolean;
  /** CDP host/port overrides */
  cdp_port?: number;
  cdp_host?: string;
}

export interface ScreenshotResult {
  ok: boolean;
  output: string | ChatContentPart[];
  savedPath?: string;
  error?: string;
}

function screenshotsDir(cwd: string): string {
  const dir = join(cwd, ".libra", "screenshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function savePng(cwd: string, buf: Buffer): string {
  const dir = screenshotsDir(cwd);
  const name = `${Date.now()}.png`;
  const path = join(dir, name);
  writeFileSync(path, buf);
  return path;
}

/**
 * Windows per-window capture by pid.
 *
 * Split intentionally:
 *  1) user32 P/Invoke only (no System.Drawing in Add-Type — that fails on
 *     missing System.Drawing.Imaging without -ReferencedAssemblies)
 *  2) System.Drawing via Add-Type -AssemblyName (same path as full_screen)
 *     for CopyFromScreen of the window rect, then PrintWindow via GDI hdc.
 *
 * Capture is always scoped to the window bounds (never full desktop unless
 * full_screen=true uses the separate path).
 */
async function captureWindowWin(pid: number, outPath: string): Promise<void> {
  const safePath = outPath.replace(/'/g, "''");
  // Write script to temp file to avoid -Command quoting/length issues
  const { writeFileSync: wfs, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const scriptPath = j(tmpdir(), `libra-wincap-${pid}-${Date.now()}.ps1`);
  // Avoid $pid — PowerShell automatic variable for current process id.
  const ps = `
$ErrorActionPreference = 'Stop'
$targetPid = ${Number(pid)}
$outPath = '${safePath}'

# --- user32 only (no System.Drawing references) ---
if (-not ('LibraUser32' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LibraUser32 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr FindHwnd(int processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if ((int)p != processId) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      if (r.Right - r.Left <= 1 || r.Bottom - r.Top <= 1) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
}

$hwnd = [LibraUser32]::FindHwnd($targetPid)
if ($hwnd -eq [IntPtr]::Zero) { throw "No visible window for processId=$targetPid" }

if (-not ('LibraBounds' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LibraBounds {
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  public static int[] Of(IntPtr hwnd) {
    RECT r; if (!GetWindowRect(hwnd, out r)) return null;
    return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
  }
}
'@
}
$b = [LibraBounds]::Of($hwnd)
if (-not $b) { throw "GetWindowRect failed for processId=$targetPid" }
$x = [int]$b[0]; $y = [int]$b[1]; $w = [int]$b[2]; $h = [int]$b[3]
if ($w -le 0 -or $h -le 0) { throw "Invalid bounds for processId=$targetPid : $x,$y,$w,$h" }

# --- System.Drawing the proven way (full_screen path) ---
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$printed = $false
try {
  $hdc = $g.GetHdc()
  try {
    # PW_RENDERFULLCONTENT = 2
    $printed = [LibraUser32]::PrintWindow($hwnd, $hdc, 2)
    if (-not $printed) { $printed = [LibraUser32]::PrintWindow($hwnd, $hdc, 0) }
  } finally {
    $g.ReleaseHdc($hdc)
  }
  if (-not $printed) {
    # Fallback: CopyFromScreen of window rect only (scoped, not full_screen)
    $g.Clear([System.Drawing.Color]::Black)
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
  }
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $g.Dispose()
  $bmp.Dispose()
}
if (-not (Test-Path -LiteralPath $outPath)) { throw "screenshot file not written for processId=$targetPid" }
`;
  try {
    wfs(scriptPath, ps, "utf8");
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    );
  } finally {
    try {
      unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
  }
}

async function captureWindowMac(pid: number, outPath: string): Promise<void> {
  // Get bounds via osascript then screencapture -R
  const { stdout } = await execFileAsync(
    "osascript",
    [
      "-e",
      `tell application "System Events" to tell (first process whose unix id is ${pid}) to get {position, size} of window 1`,
    ],
    { timeout: 10_000 },
  );
  const nums = String(stdout).match(/-?\d+/g)?.map(Number) ?? [];
  if (nums.length < 4) throw new Error(`macOS window bounds failed for pid ${pid}`);
  const [x, y, w, h] = nums;
  await execFileAsync(
    "screencapture",
    ["-R", `${x},${y},${w},${h}`, outPath],
    { timeout: 15_000 },
  );
}

async function captureWindowLinux(pid: number, outPath: string): Promise<void> {
  // xdotool search --pid + import -window / maim -i
  const { stdout } = await execFileAsync(
    "xdotool",
    ["search", "--pid", String(pid)],
    { timeout: 10_000 },
  );
  const wid = String(stdout).trim().split(/\r?\n/).filter(Boolean)[0];
  if (!wid) throw new Error(`no window for pid ${pid}`);
  try {
    await execFileAsync("import", ["-window", wid, outPath], { timeout: 15_000 });
    return;
  } catch {
    /* try maim */
  }
  await execFileAsync("maim", ["-i", wid, outPath], { timeout: 15_000 });
}

async function captureFullScreen(
  platform: NodeJS.Platform,
  outPath: string,
): Promise<void> {
  if (platform === "win32") {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${outPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 20_000 },
    );
    return;
  }
  if (platform === "darwin") {
    await execFileAsync("screencapture", ["-x", outPath], { timeout: 15_000 });
    return;
  }
  // Linux: try grim (Wayland) then import (X11)
  try {
    await execFileAsync("grim", [outPath], { timeout: 15_000 });
    return;
  } catch {
    /* X11 */
  }
  await execFileAsync("import", ["-window", "root", outPath], {
    timeout: 15_000,
  });
}

async function captureCdp(
  cwd: string,
  args: ScreenshotArgs,
): Promise<ScreenshotResult> {
  const host = args.cdp_host ?? "127.0.0.1";
  const port = args.cdp_port ?? 9222;
  let targets;
  try {
    targets = await listCdpTargets({ host, port });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      output: `CDP unavailable at ${host}:${port}: ${msg}`,
      error: msg,
    };
  }
  const target = pickCdpTarget(targets, args.url);
  if (!target?.webSocketDebuggerUrl) {
    return {
      ok: false,
      output: `No CDP page target at ${host}:${port}`,
      error: "no_target",
    };
  }
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    if (args.url && !target.url.includes(args.url)) {
      await session.send("Page.enable").catch(() => undefined);
      await session.send("Page.navigate", { url: args.url });
      await new Promise((r) => setTimeout(r, 800));
    }
    const b64 = await cdpCaptureScreenshot(session, {
      fullPage: Boolean(args.full_page),
    });
    const buf = Buffer.from(b64, "base64");
    const path = savePng(cwd, buf);
    const summary = `screenshot saved to \`${path}\` (cdp target ${target.id}, ${target.title || target.url})`;
    return {
      ok: true,
      savedPath: path,
      output: [textPart(summary), imagePart("image/png", b64)],
    };
  } finally {
    session.close();
  }
}

async function capturePlaywright(
  cwd: string,
  args: ScreenshotArgs,
): Promise<ScreenshotResult> {
  // Optional dynamic import — never a hard dependency (feature-detect).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playwright: any;
  try {
    playwright = await import(
      /* webpackIgnore: true */ "playwright" as string
    );
  } catch {
    return {
      ok: false,
      output:
        'Playwright is not installed. Run `bun add -D playwright` and install browsers, or use engine:"cdp" with a browser already on --remote-debugging-port.',
      error: "playwright_missing",
    };
  }
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    if (args.url) {
      await page.goto(args.url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    let buf: Buffer;
    if (args.selector) {
      const el = await page.$(args.selector);
      if (!el) {
        return {
          ok: false,
          output: `selector not found: ${args.selector}`,
          error: "selector_not_found",
        };
      }
      buf = (await el.screenshot({ type: "png" })) as Buffer;
    } else {
      buf = (await page.screenshot({
        type: "png",
        fullPage: Boolean(args.full_page),
      })) as Buffer;
    }
    const path = savePng(cwd, buf);
    const b64 = buf.toString("base64");
    const summary = `screenshot saved to \`${path}\` (playwright${args.selector ? ` selector=${args.selector}` : ""})`;
    return {
      ok: true,
      savedPath: path,
      output: [textPart(summary), imagePart("image/png", b64)],
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function runScreenshot(
  cwd: string,
  args: ScreenshotArgs,
  platform: NodeJS.Platform = process.platform,
): Promise<ScreenshotResult> {
  try {
    // Resolve pid from session_id
    let pid = args.pid;
    if (args.session_id) {
      const s = getSession(args.session_id);
      if (!s?.pid) {
        return {
          ok: false,
          output: `unknown session_id: ${args.session_id}`,
          error: "unknown_session",
        };
      }
      pid = s.pid;
    }

    // Browser path
    if (args.url || args.engine === "cdp" || args.engine === "playwright") {
      if (args.engine === "playwright" || (args.selector && args.engine !== "cdp")) {
        return capturePlaywright(cwd, args);
      }
      // Default browser engine: CDP
      const cdp = await captureCdp(cwd, args);
      if (!cdp.ok && (args.full_page || args.selector || args.url)) {
        // Optional fallback to playwright when CDP fails and URL requested
        if (args.engine !== "cdp") {
          return capturePlaywright(cwd, args);
        }
      }
      return cdp;
    }

    const dir = screenshotsDir(cwd);
    const outPath = join(dir, `${Date.now()}.png`);

    if (args.full_screen) {
      await captureFullScreen(platform, outPath);
    } else if (pid != null) {
      if (platform === "win32") await captureWindowWin(pid, outPath);
      else if (platform === "darwin") await captureWindowMac(pid, outPath);
      else await captureWindowLinux(pid, outPath);
    } else {
      return {
        ok: false,
        output:
          "screenshot requires one of: session_id, pid, url, or full_screen=true",
        error: "invalid_args",
      };
    }

    if (!existsSync(outPath)) {
      return {
        ok: false,
        output: "screenshot file was not created",
        error: "no_file",
      };
    }
    const buf = readFileSync(outPath);
    const b64 = buf.toString("base64");
    const scope = args.full_screen
      ? "full_screen"
      : `pid=${pid}`;
    const summary = `screenshot saved to \`${outPath}\` (${scope})`;
    return {
      ok: true,
      savedPath: outPath,
      output: [textPart(summary), imagePart("image/png", b64)],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg, error: msg };
  }
}

/** Permission helper: full_screen requires ask. */
export function screenshotNeedsAsk(args: ScreenshotArgs): boolean {
  return Boolean(args.full_screen);
}
