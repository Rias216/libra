/**
 * list_windows — enumerate visible OS windows.
 * Returns {pid, title, processName, bounds}[].
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  pid: number;
  title: string;
  processName: string;
  bounds: WindowBounds;
}

const WIN_PS = `
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> List() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      string title = sb.ToString();
      if (string.IsNullOrWhiteSpace(title)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      int w = r.Right - r.Left; int hgt = r.Bottom - r.Top;
      if (w <= 0 || hgt <= 0) return true;
      string proc = "";
      try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
      list.Add(pid + "\\t" + proc + "\\t" + r.Left + "\\t" + r.Top + "\\t" + w + "\\t" + hgt + "\\t" + title.Replace("\\t"," "));
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
[WinEnum]::List() | ForEach-Object { $_ }
`;

const MAC_OSA = `
tell application "System Events"
  set out to {}
  repeat with p in (every process whose background only is false)
    try
      set pname to name of p
      set ppid to unix id of p
      repeat with w in (windows of p)
        try
          set t to name of w
          set pos to position of w
          set sz to size of w
          set end of out to (ppid as text) & tab & pname & tab & (item 1 of pos as text) & tab & (item 2 of pos as text) & tab & (item 1 of sz as text) & tab & (item 2 of sz as text) & tab & t
        end try
      end repeat
    end try
  end repeat
  set AppleScript's text item delimiters to linefeed
  return out as text
end tell
`;

function parseTsvLines(text: string): WindowInfo[] {
  const out: WindowInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split("\t");
    if (parts.length < 7) continue;
    const pid = Number(parts[0]);
    const processName = parts[1] || "";
    const x = Number(parts[2]);
    const y = Number(parts[3]);
    const width = Number(parts[4]);
    const height = Number(parts[5]);
    const title = parts.slice(6).join("\t");
    if (!Number.isFinite(pid) || !title) continue;
    out.push({
      pid,
      title,
      processName,
      bounds: {
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
      },
    });
  }
  return out;
}

async function listWindowsWin(): Promise<WindowInfo[]> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WIN_PS],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
  );
  return parseTsvLines(String(stdout));
}

async function listWindowsMac(): Promise<WindowInfo[]> {
  const { stdout } = await execFileAsync(
    "osascript",
    ["-e", MAC_OSA],
    { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
  );
  return parseTsvLines(String(stdout));
}

async function listWindowsLinux(): Promise<WindowInfo[]> {
  // Prefer wmctrl -lpG (pid + geometry), fall back to xdotool
  try {
    const { stdout } = await execFileAsync(
      "wmctrl",
      ["-lpG"],
      { maxBuffer: 2 * 1024 * 1024, timeout: 10_000 },
    );
    const out: WindowInfo[] = [];
    for (const line of String(stdout).split(/\r?\n/)) {
      // id desktop pid x y w h host title...
      const m = line.match(
        /^\S+\s+\S+\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.*)$/,
      );
      if (!m) continue;
      const pid = Number(m[1]);
      const title = (m[6] || "").trim();
      if (!title) continue;
      out.push({
        pid,
        title,
        processName: "",
        bounds: {
          x: Number(m[2]),
          y: Number(m[3]),
          width: Number(m[4]),
          height: Number(m[5]),
        },
      });
    }
    if (out.length) return out;
  } catch {
    /* try xdotool */
  }
  try {
    const { stdout: idsOut } = await execFileAsync(
      "xdotool",
      ["search", "--name", "."],
      { maxBuffer: 2 * 1024 * 1024, timeout: 10_000 },
    );
    const out: WindowInfo[] = [];
    for (const id of String(idsOut).split(/\r?\n/).filter(Boolean)) {
      try {
        const [{ stdout: name }, { stdout: pidS }, { stdout: geo }] =
          await Promise.all([
            execFileAsync("xdotool", ["getwindowname", id], { timeout: 3000 }),
            execFileAsync("xdotool", ["getwindowpid", id], { timeout: 3000 }),
            execFileAsync("xdotool", ["getwindowgeometry", "--shell", id], {
              timeout: 3000,
            }),
          ]);
        const title = String(name).trim();
        if (!title) continue;
        const pid = Number(String(pidS).trim());
        const kv: Record<string, number> = {};
        for (const ln of String(geo).split(/\r?\n/)) {
          const [k, v] = ln.split("=");
          if (k && v) kv[k] = Number(v);
        }
        out.push({
          pid: Number.isFinite(pid) ? pid : 0,
          title,
          processName: "",
          bounds: {
            x: kv.X ?? 0,
            y: kv.Y ?? 0,
            width: kv.WIDTH ?? 0,
            height: kv.HEIGHT ?? 0,
          },
        });
      } catch {
        /* skip window */
      }
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `list_windows: neither wmctrl nor xdotool available (${msg})`,
    );
  }
}

/** Enumerate visible windows for the current platform. */
export async function listWindows(
  platform: NodeJS.Platform = process.platform,
): Promise<WindowInfo[]> {
  if (platform === "win32") return listWindowsWin();
  if (platform === "darwin") return listWindowsMac();
  if (platform === "linux") return listWindowsLinux();
  throw new Error(`list_windows: unsupported platform ${platform}`);
}

/** Pure: format windows as JSON-friendly records (for tests). */
export function windowsToRecords(windows: WindowInfo[]): WindowInfo[] {
  return windows.map((w) => ({
    pid: w.pid,
    title: w.title,
    processName: w.processName,
    bounds: { ...w.bounds },
  }));
}
