/**
 * browser_devtools — custom tool, raw CDP action multiplex (no Playwright).
 * action: goto | click | fill | screenshot | console_log | eval
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CdpSession,
  listCdpTargets,
  cdpCaptureScreenshot,
  type CdpTarget,
} from "./cdp.js";
import {
  imagePart,
  textPart,
  type ChatContentPart,
} from "./multimodal.js";

export type BrowserAction =
  | "goto"
  | "click"
  | "fill"
  | "screenshot"
  | "console_log"
  | "eval";

export interface BrowserDevtoolsArgs {
  action: BrowserAction;
  targetId?: string;
  url?: string;
  selector?: string;
  text?: string;
  expression?: string;
  cdp_host?: string;
  cdp_port?: number;
  /** How long to collect CDP console events (console_log), ms. Default 800. */
  wait_ms?: number;
}

export interface BrowserDevtoolsResult {
  ok: boolean;
  output: string | ChatContentPart[];
  savedPath?: string;
  error?: string;
}

async function resolveTarget(
  args: BrowserDevtoolsArgs,
): Promise<{ target: CdpTarget; error?: string }> {
  const host = args.cdp_host ?? "127.0.0.1";
  const port = args.cdp_port ?? 9222;
  let targets: CdpTarget[];
  try {
    targets = await listCdpTargets({ host, port });
  } catch (err) {
    return {
      target: { id: "", title: "", type: "", url: "" },
      error: `CDP unavailable at ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (args.targetId) {
    const t = targets.find((x) => x.id === args.targetId);
    if (!t?.webSocketDebuggerUrl) {
      return {
        target: { id: "", title: "", type: "", url: "" },
        error: `unknown targetId: ${args.targetId}`,
      };
    }
    return { target: t };
  }
  const page = targets.find(
    (t) =>
      (t.type === "page" || t.type === "webview") && t.webSocketDebuggerUrl,
  );
  if (!page) {
    return {
      target: { id: "", title: "", type: "", url: "" },
      error: "no page target; pass targetId from CDP /json",
    };
  }
  return { target: page };
}

async function withSession<T>(
  target: CdpTarget,
  fn: (s: CdpSession) => Promise<T>,
): Promise<T> {
  const session = await CdpSession.connect(target.webSocketDebuggerUrl!);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

export async function runBrowserDevtools(
  cwd: string,
  args: BrowserDevtoolsArgs,
): Promise<BrowserDevtoolsResult> {
  const action = args.action;
  if (
    !action ||
    !["goto", "click", "fill", "screenshot", "console_log", "eval"].includes(
      action,
    )
  ) {
    return {
      ok: false,
      output:
        'browser_devtools requires action: goto|click|fill|screenshot|console_log|eval',
      error: "invalid_action",
    };
  }

  const { target, error } = await resolveTarget(args);
  if (error) return { ok: false, output: error, error };

  try {
    switch (action) {
      case "goto": {
        if (!args.url) {
          return { ok: false, output: "goto requires url", error: "invalid_args" };
        }
        await withSession(target, async (s) => {
          await s.send("Page.enable").catch(() => undefined);
          await s.send("Page.navigate", { url: args.url });
        });
        return {
          ok: true,
          output: `navigated target ${target.id} → ${args.url}`,
        };
      }
      case "click": {
        if (!args.selector) {
          return {
            ok: false,
            output: "click requires selector",
            error: "invalid_args",
          };
        }
        const expr = `
          (() => {
            const el = document.querySelector(${JSON.stringify(args.selector)});
            if (!el) throw new Error('selector not found');
            el.click();
            return true;
          })()
        `;
        await withSession(target, async (s) => {
          await s.send("Runtime.enable").catch(() => undefined);
          const r = await s.send<{
            exceptionDetails?: { text?: string };
          }>("Runtime.evaluate", {
            expression: expr,
            awaitPromise: true,
            returnByValue: true,
          });
          if (r?.exceptionDetails) {
            throw new Error(r.exceptionDetails.text ?? "click failed");
          }
        });
        return {
          ok: true,
          output: `clicked ${args.selector} on target ${target.id}`,
        };
      }
      case "fill": {
        if (!args.selector) {
          return {
            ok: false,
            output: "fill requires selector",
            error: "invalid_args",
          };
        }
        const value = args.text ?? "";
        const expr = `
          (() => {
            const el = document.querySelector(${JSON.stringify(args.selector)});
            if (!el) throw new Error('selector not found');
            el.focus();
            el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()
        `;
        await withSession(target, async (s) => {
          await s.send("Runtime.enable").catch(() => undefined);
          const r = await s.send<{
            exceptionDetails?: { text?: string };
          }>("Runtime.evaluate", {
            expression: expr,
            awaitPromise: true,
            returnByValue: true,
          });
          if (r?.exceptionDetails) {
            throw new Error(r.exceptionDetails.text ?? "fill failed");
          }
        });
        return {
          ok: true,
          output: `filled ${args.selector} on target ${target.id}`,
        };
      }
      case "screenshot": {
        const b64 = await withSession(target, (s) => cdpCaptureScreenshot(s));
        const dir = join(cwd, ".libra", "screenshots");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${Date.now()}-devtools.png`);
        writeFileSync(path, Buffer.from(b64, "base64"));
        const summary = `browser_devtools screenshot saved to \`${path}\` (target ${target.id})`;
        return {
          ok: true,
          savedPath: path,
          output: [textPart(summary), imagePart("image/png", b64)],
        };
      }
      case "console_log": {
        // Real CDP console capture: enable Runtime + Log, listen for
        // Runtime.consoleAPICalled / Log.entryAdded, install a page-side buffer,
        // briefly collect, and return structured messages.
        const waitMs = Math.min(
          Math.max(Number(args.wait_ms ?? 800) || 800, 100),
          10_000,
        );
        const messages = await withSession(target, async (s) => {
          const collected: Array<Record<string, unknown>> = [];
          const unsub = s.onEvent((method, params) => {
            if (method === "Runtime.consoleAPICalled") {
              const type = String(params.type ?? "log");
              const argsList = Array.isArray(params.args) ? params.args : [];
              const text = argsList
                .map((a) => {
                  const o = a as {
                    value?: unknown;
                    description?: string;
                    type?: string;
                  };
                  if (o.value != null) return String(o.value);
                  if (o.description) return o.description;
                  return o.type ?? "";
                })
                .filter(Boolean)
                .join(" ");
              collected.push({
                source: "consoleAPI",
                level: type,
                text,
                timestamp: params.timestamp ?? Date.now(),
              });
            } else if (method === "Log.entryAdded") {
              const entry = (params.entry ?? {}) as Record<string, unknown>;
              collected.push({
                source: "log",
                level: String(entry.level ?? "info"),
                text: String(entry.text ?? ""),
                timestamp: entry.timestamp ?? Date.now(),
              });
            }
          });
          try {
            await s.send("Runtime.enable").catch(() => undefined);
            await s.send("Log.enable").catch(() => undefined);
            // Install durable page buffer + return prior buffered messages
            const install = await s.send<{
              result?: { value?: unknown };
            }>("Runtime.evaluate", {
              expression: `(() => {
                if (!window.__libraConsole) {
                  window.__libraConsole = [];
                  for (const level of ['log','info','warn','error','debug']) {
                    const orig = console[level].bind(console);
                    console[level] = (...a) => {
                      try {
                        window.__libraConsole.push({
                          level,
                          text: a.map(x => {
                            try { return typeof x === 'string' ? x : JSON.stringify(x); }
                            catch { return String(x); }
                          }).join(' '),
                          t: Date.now()
                        });
                      } catch {}
                      return orig(...a);
                    };
                  }
                }
                return window.__libraConsole.slice(-200);
              })()`,
              returnByValue: true,
              awaitPromise: false,
            });
            const buffered = Array.isArray(install?.result?.value)
              ? (install!.result!.value as Array<Record<string, unknown>>)
              : [];
            for (const b of buffered) {
              collected.push({
                source: "pageBuffer",
                level: String(b.level ?? "log"),
                text: String(b.text ?? ""),
                timestamp: b.t ?? Date.now(),
              });
            }
            // Nudge a marker so consoleAPICalled is exercised when listeners work
            await s
              .send("Runtime.evaluate", {
                expression: `console.debug('[libra browser_devtools console_log probe]')`,
                returnByValue: true,
              })
              .catch(() => undefined);
            await new Promise((r) => setTimeout(r, waitMs));
            // Re-read page buffer after wait (captures probe + any app logs)
            const again = await s.send<{
              result?: { value?: unknown };
            }>("Runtime.evaluate", {
              expression: `window.__libraConsole ? window.__libraConsole.slice(-200) : []`,
              returnByValue: true,
            });
            if (Array.isArray(again?.result?.value)) {
              for (const b of again!.result!.value as Array<
                Record<string, unknown>
              >) {
                const text = String(b.text ?? "");
                const level = String(b.level ?? "log");
                if (
                  !collected.some(
                    (c) => c.text === text && c.level === level && c.source === "pageBuffer",
                  )
                ) {
                  collected.push({
                    source: "pageBuffer",
                    level,
                    text,
                    timestamp: b.t ?? Date.now(),
                  });
                }
              }
            }
          } finally {
            unsub();
          }
          return collected;
        });
        return {
          ok: true,
          output: JSON.stringify(
            {
              targetId: target.id,
              url: target.url,
              count: messages.length,
              messages,
            },
            null,
            0,
          ),
        };
      }
      case "eval": {
        if (!args.expression) {
          return {
            ok: false,
            output: "eval requires expression",
            error: "invalid_args",
          };
        }
        const value = await withSession(target, async (s) => {
          await s.send("Runtime.enable").catch(() => undefined);
          const r = await s.send<{
            result?: { value?: unknown; type?: string; description?: string };
            exceptionDetails?: { text?: string };
          }>("Runtime.evaluate", {
            expression: args.expression,
            awaitPromise: true,
            returnByValue: true,
          });
          if (r?.exceptionDetails) {
            throw new Error(r.exceptionDetails.text ?? "eval failed");
          }
          return r?.result?.value ?? r?.result?.description ?? null;
        });
        return {
          ok: true,
          output:
            typeof value === "string"
              ? value
              : JSON.stringify(value, null, 2) ?? String(value),
        };
      }
      default:
        return {
          ok: false,
          output: `unknown action: ${action}`,
          error: "invalid_action",
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg, error: msg };
  }
}
