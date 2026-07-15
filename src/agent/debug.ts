/**
 * Structured harness debug logger — every model / tool / fusion move.
 *
 * Enable with:
 *   LIBRA_DEBUG=1          → stderr + ~/.libra/debug/latest.log
 *   LIBRA_DEBUG=trace      → ultra-verbose (raw SSE chunks, full payloads)
 *   LIBRA_DEBUG_FILE=path  → override log file
 *   LIBRA_DEBUG=0          → off (default)
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type DebugLevel = "off" | "info" | "trace";

let level: DebugLevel = "off";
/** When true, `initDebug(force)` pinned the level — do not re-open from env. */
let levelPinned = false;
let logPath: string | null = null;
let seq = 0;
const t0 = Date.now();

function detectLevel(): DebugLevel {
  const v = (process.env.LIBRA_DEBUG ?? "").trim().toLowerCase();
  if (!v || v === "0" || v === "false" || v === "off") return "off";
  if (v === "trace" || v === "2" || v === "verbose") return "trace";
  return "info";
}

export function initDebug(force?: DebugLevel): void {
  // Explicit force (including "off") pins the level so isDebug() will not
  // re-enable from LIBRA_DEBUG env mid-process (needed by tests + callers
  // that temporarily silence logging).
  if (force !== undefined) {
    level = force;
    levelPinned = true;
  } else {
    level = detectLevel();
    levelPinned = false;
  }
  if (level === "off") {
    logPath = null;
    return;
  }
  const override = process.env.LIBRA_DEBUG_FILE?.trim();
  const dir = join(homedir(), ".libra", "debug");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* */
  }
  logPath = override || join(dir, "latest.log");
  try {
    writeFileSync(
      logPath,
      `# libra debug ${new Date().toISOString()} level=${level}\n`,
      "utf8",
    );
  } catch {
    logPath = null;
  }
  // Always also write a session-stamped copy for history
  if (!override) {
    const stamped = join(
      dir,
      `session-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
    );
    try {
      if (logPath && existsSync(logPath)) {
        writeFileSync(stamped, `# session start ${new Date().toISOString()}\n`, "utf8");
      }
    } catch {
      /* */
    }
  }
  dbg("harness", "debug logger ready", { level, logPath });
}

export function isDebug(): boolean {
  if (level === "off" && !levelPinned && process.env.LIBRA_DEBUG) {
    // lazy init if env set after import (but never override a pinned off)
    initDebug();
  }
  return level !== "off";
}

export function isTrace(): boolean {
  return level === "trace";
}

export function getDebugLogPath(): string | null {
  return logPath;
}

function ms(): number {
  return Date.now() - t0;
}

function writeLine(line: string, opts?: { stderr?: boolean }): void {
  // Default: stderr + file. High-volume trace events (SSE chunks) should
  // pass stderr:false — writing every token to the console is a major lag
  // source when reasoning streams are large/fast.
  if (opts?.stderr !== false) {
    process.stderr.write(line + "\n");
  }
  if (logPath) {
    try {
      appendFileSync(logPath, line + "\n", "utf8");
    } catch {
      /* */
    }
  }
}

function safeJson(v: unknown, max = 2000): string {
  try {
    const s = JSON.stringify(v, (_k, val) => {
      if (typeof val === "string" && val.length > 400) {
        return val.slice(0, 400) + `…[+${val.length - 400}]`;
      }
      return val;
    });
    if (s.length > max) return s.slice(0, max) + `…[+${s.length - max}]`;
    return s;
  } catch {
    return String(v);
  }
}

/** Events so frequent that stderr would dominate the event loop under load. */
const FILE_ONLY_EVENTS = new Set([
  "sse.chunk",
  "sse.raw",
  "delta",
  "reasoning.delta",
  "text.delta",
]);

/** Core log: category, event, optional data */
export function dbg(
  category: string,
  event: string,
  data?: Record<string, unknown>,
  opts?: { stderr?: boolean },
): void {
  if (!isDebug()) return;
  const id = ++seq;
  const base = `[${String(ms()).padStart(6)}ms #${id}] [${category}] ${event}`;
  const line =
    data && Object.keys(data).length
      ? `${base} ${safeJson(data)}`
      : base;
  writeLine(line, opts);
}

/** Trace-only (raw chunks, full messages) */
export function dbgTrace(
  category: string,
  event: string,
  data?: Record<string, unknown>,
): void {
  if (!isTrace()) return;
  // High-volume stream events → file only (still available for postmortem).
  const fileOnly = FILE_ONLY_EVENTS.has(event);
  dbg(category, event, data, fileOnly ? { stderr: false } : undefined);
}

/** Time a named span */
export function span(category: string, name: string, extra?: Record<string, unknown>) {
  const start = Date.now();
  dbg(category, `${name}:start`, extra);
  return {
    end(more?: Record<string, unknown>) {
      const durationMs = Date.now() - start;
      dbg(category, `${name}:end`, { durationMs, ...extra, ...more });
      return durationMs;
    },
    mark(label: string, more?: Record<string, unknown>) {
      dbg(category, `${name}:${label}`, {
        elapsedMs: Date.now() - start,
        ...extra,
        ...more,
      });
    },
  };
}

/** Pretty one-liner for model identity */
export function modelTag(provider: string, model: string): string {
  return `${provider}/${model}`;
}

// Auto-init when env is set at process start
if (process.env.LIBRA_DEBUG) {
  initDebug();
}
