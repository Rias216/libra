/**
 * Custom-tool dispatch for expansion tools that return images or own state:
 * screenshot, browser_devtools.
 */

import type { DispatchCall } from "./router.js";
import type { CustomDispatchResult } from "./runtime.js";
import { runScreenshot, type ScreenshotArgs } from "./screenshot.js";
import {
  runBrowserDevtools,
  type BrowserDevtoolsArgs,
  type BrowserAction,
} from "./browser-devtools.js";
import { resolveToolName } from "./tool.js";

const CUSTOM = new Set(["screenshot", "browser_devtools"]);

export function isExpansionCustomTool(name: string): boolean {
  const c = resolveToolName(name);
  return CUSTOM.has(c) || CUSTOM.has(name);
}

export async function dispatchExpansionCustomTool(
  call: DispatchCall,
  opts: {
    cwd: string;
    model?: string;
    signal?: AbortSignal;
  },
): Promise<CustomDispatchResult> {
  const name = resolveToolName(call.name);
  const args = call.args ?? {};
  const t0 = Date.now();

  if (opts.signal?.aborted) {
    return { ok: false, output: "aborted", durationMs: 0 };
  }

  if (name === "screenshot") {
    const sa: ScreenshotArgs = {
      session_id:
        args.session_id != null ? String(args.session_id) : undefined,
      pid: args.pid != null ? Number(args.pid) : undefined,
      url: args.url != null ? String(args.url) : undefined,
      selector: args.selector != null ? String(args.selector) : undefined,
      full_page: Boolean(args.full_page),
      engine:
        args.engine === "playwright" || args.engine === "cdp"
          ? args.engine
          : undefined,
      full_screen: Boolean(args.full_screen),
      cdp_port: args.cdp_port != null ? Number(args.cdp_port) : undefined,
      cdp_host: args.cdp_host != null ? String(args.cdp_host) : undefined,
    };
    const r = await runScreenshot(opts.cwd, sa);
    return {
      ok: r.ok,
      output: r.output,
      savedPath: r.savedPath,
      durationMs: Date.now() - t0,
    };
  }

  if (name === "browser_devtools") {
    const ba: BrowserDevtoolsArgs = {
      action: String(args.action ?? "") as BrowserAction,
      targetId: args.targetId != null ? String(args.targetId) : args.target_id != null ? String(args.target_id) : undefined,
      url: args.url != null ? String(args.url) : undefined,
      selector: args.selector != null ? String(args.selector) : undefined,
      text: args.text != null ? String(args.text) : undefined,
      expression:
        args.expression != null ? String(args.expression) : undefined,
      cdp_host: args.cdp_host != null ? String(args.cdp_host) : undefined,
      cdp_port: args.cdp_port != null ? Number(args.cdp_port) : undefined,
      wait_ms: args.wait_ms != null ? Number(args.wait_ms) : undefined,
    };
    const r = await runBrowserDevtools(opts.cwd, ba);
    return {
      ok: r.ok,
      output: r.output,
      savedPath: r.savedPath,
      durationMs: Date.now() - t0,
    };
  }

  return {
    ok: false,
    output: `unknown expansion custom tool: ${name}`,
    durationMs: Date.now() - t0,
  };
}
