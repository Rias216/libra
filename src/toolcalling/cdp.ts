/**
 * Minimal Chrome DevTools Protocol client (zero deps — uses global WebSocket).
 * Used by screenshot (Page.captureScreenshot) and browser_devtools.
 */

export interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpClientOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

function httpGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? import("node:https") : import("node:http");
    lib.then((mod) => {
      const req = mod.get(url, { timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`CDP HTTP timeout: ${url}`));
      });
    }).catch(reject);
  });
}

/** List page targets from a Chrome/Edge remote-debugging port. */
export async function listCdpTargets(
  opts: CdpClientOptions = {},
): Promise<CdpTarget[]> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 9222;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const body = await httpGet(`http://${host}:${port}/json`, timeoutMs);
  const raw = JSON.parse(body) as CdpTarget[];
  return Array.isArray(raw) ? raw : [];
}

/** Pick first page target, optionally matching url substring. */
export function pickCdpTarget(
  targets: CdpTarget[],
  preferUrl?: string,
): CdpTarget | undefined {
  const pages = targets.filter(
    (t) =>
      (t.type === "page" || t.type === "webview") && t.webSocketDebuggerUrl,
  );
  if (!pages.length) return undefined;
  if (preferUrl) {
    const hit = pages.find((t) => t.url.includes(preferUrl));
    if (hit) return hit;
  }
  return pages[0];
}

export type CdpEventHandler = (
  method: string,
  params: Record<string, unknown>,
) => void;

export class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private closed = false;
  private eventHandlers = new Set<CdpEventHandler>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
          method?: string;
          params?: Record<string, unknown>;
        };
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message ?? "CDP error"));
          } else {
            p.resolve(msg.result);
          }
          return;
        }
        if (msg.method) {
          for (const h of this.eventHandlers) {
            try {
              h(msg.method, msg.params ?? {});
            } catch {
              /* ignore handler errors */
            }
          }
        }
      } catch {
        /* ignore */
      }
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        p.reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();
      this.eventHandlers.clear();
    });
  }

  /** Subscribe to CDP events (Runtime.consoleAPICalled, Log.entryAdded, …). */
  onEvent(handler: CdpEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  static async connect(
    webSocketDebuggerUrl: string,
    timeoutMs = 10_000,
  ): Promise<CdpSession> {
    const WS = globalThis.WebSocket;
    if (!WS) {
      throw new Error("WebSocket not available in this runtime");
    }
    const ws = new WS(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("CDP WebSocket connect timeout")),
        timeoutMs,
      );
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("CDP WebSocket error"));
      });
    });
    return new CdpSession(ws);
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed) throw new Error("CDP session closed");
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(payload);
    });
  }

  close(): void {
    if (!this.closed) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.closed = true;
    }
  }
}

/** Capture PNG base64 via Page.captureScreenshot. */
export async function cdpCaptureScreenshot(
  session: CdpSession,
  opts?: { fullPage?: boolean },
): Promise<string> {
  await session.send("Page.enable").catch(() => undefined);
  const result = await session.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: Boolean(opts?.fullPage),
  });
  if (!result?.data) throw new Error("Page.captureScreenshot returned no data");
  return result.data;
}
