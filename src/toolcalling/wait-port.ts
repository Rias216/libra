/**
 * wait_for_port — poll 127.0.0.1:<port> until open or timeout.
 */

import * as net from "node:net";

export interface WaitForPortOptions {
  host?: string;
  port: number;
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface WaitForPortResult {
  ok: boolean;
  open: boolean;
  host: string;
  port: number;
  waitedMs: number;
  error?: string;
}

function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/** Pure helper: validate port number. */
export function isValidPort(port: unknown): port is number {
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
  );
}

/** Poll until TCP port accepts connections or timeout. */
export async function waitForPort(
  opts: WaitForPortOptions,
): Promise<WaitForPortResult> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port;
  if (!isValidPort(port)) {
    return {
      ok: false,
      open: false,
      host,
      port: Number(port) || 0,
      waitedMs: 0,
      error: `invalid port: ${port}`,
    };
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 200;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (opts.signal?.aborted) {
      return {
        ok: false,
        open: false,
        host,
        port,
        waitedMs: Date.now() - t0,
        error: "aborted",
      };
    }
    const open = await tryConnect(host, port, Math.min(intervalMs, 500));
    if (open) {
      return {
        ok: true,
        open: true,
        host,
        port,
        waitedMs: Date.now() - t0,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return {
    ok: false,
    open: false,
    host,
    port,
    waitedMs: Date.now() - t0,
    error: `port ${host}:${port} not open after ${timeoutMs}ms`,
  };
}
