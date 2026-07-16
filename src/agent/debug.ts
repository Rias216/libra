/**
 * Structured harness debug logger — every model / tool / fusion move.
 *
 * Enable with:
 *   LIBRA_DEBUG=1          → stderr + ~/.libra/debug/latest.log (+ .jsonl)
 *   LIBRA_DEBUG=trace      → ultra-verbose (raw SSE chunks, full payloads)
 *   LIBRA_DEBUG=info       → structured loop events without raw SSE
 *   LIBRA_DEBUG_FULL=1     → no payload truncation (even at info)
 *   LIBRA_DEBUG_FILE=path  → override text log file (jsonl = path + ".jsonl")
 *   LIBRA_DEBUG_JSONL=0    → disable jsonl sidecar (default: on when debug on)
 *   LIBRA_DEBUG=0          → off (default)
 *
 * Consumers (benches) can subscribe via onDebugEvent() for in-process capture.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type DebugLevel = "off" | "info" | "trace";

/** One structured debug event (text log + jsonl + subscribers). */
export interface DebugEvent {
  /** Monotonic sequence within process */
  seq: number;
  /** ms since process debug clock started */
  ms: number;
  /** Wall-clock ISO */
  at: string;
  category: string;
  event: string;
  data?: Record<string, unknown>;
  level: "info" | "trace";
}

export type DebugEventListener = (ev: DebugEvent) => void;

let level: DebugLevel = "off";
/** When true, `initDebug(force)` pinned the level — do not re-open from env. */
let levelPinned = false;
let logPath: string | null = null;
let jsonlPath: string | null = null;
let sessionLogPath: string | null = null;
let sessionJsonlPath: string | null = null;
let seq = 0;
const t0 = Date.now();
/** In-process ring buffer for postmortem without re-reading the file. */
const RING_MAX = 20_000;
const ring: DebugEvent[] = [];
const listeners = new Set<DebugEventListener>();
/** When true, never truncate string/object payloads (info+trace). */
let fullPayloads = false;
/** Write machine-readable jsonl next to the text log. */
let writeJsonl = true;

function detectLevel(): DebugLevel {
  const v = (process.env.LIBRA_DEBUG ?? "").trim().toLowerCase();
  if (!v || v === "0" || v === "false" || v === "off") return "off";
  if (v === "trace" || v === "2" || v === "verbose") return "trace";
  return "info";
}

function detectFullPayloads(): boolean {
  const v = (process.env.LIBRA_DEBUG_FULL ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  // Trace implies full payloads unless explicitly disabled
  if (detectLevel() === "trace") {
    const off = (process.env.LIBRA_DEBUG_FULL ?? "").trim().toLowerCase();
    if (off === "0" || off === "false" || off === "off") return false;
    return true;
  }
  return false;
}

function detectJsonl(): boolean {
  const v = (process.env.LIBRA_DEBUG_JSONL ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

function jsonlFor(textPath: string): string {
  if (textPath.endsWith(".log")) return textPath.slice(0, -4) + ".jsonl";
  return textPath + ".jsonl";
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
  fullPayloads = detectFullPayloads() || level === "trace";
  writeJsonl = detectJsonl();
  seq = 0;
  ring.length = 0;

  if (level === "off") {
    logPath = null;
    jsonlPath = null;
    sessionLogPath = null;
    sessionJsonlPath = null;
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
  jsonlPath = writeJsonl ? jsonlFor(logPath) : null;

  const header = `# libra debug ${new Date().toISOString()} level=${level} full=${fullPayloads ? 1 : 0} jsonl=${writeJsonl ? 1 : 0}\n`;
  try {
    writeFileSync(logPath, header, "utf8");
  } catch {
    logPath = null;
  }
  if (jsonlPath) {
    try {
      writeFileSync(jsonlPath, "", "utf8");
    } catch {
      jsonlPath = null;
    }
  }

  // Always also write a session-stamped copy for history (when not overriding)
  if (!override) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    sessionLogPath = join(dir, `session-${stamp}.log`);
    sessionJsonlPath = writeJsonl ? join(dir, `session-${stamp}.jsonl`) : null;
    try {
      writeFileSync(sessionLogPath, header, "utf8");
    } catch {
      sessionLogPath = null;
    }
    if (sessionJsonlPath) {
      try {
        writeFileSync(sessionJsonlPath, "", "utf8");
      } catch {
        sessionJsonlPath = null;
      }
    }
  } else {
    sessionLogPath = null;
    sessionJsonlPath = null;
  }

  dbg("harness", "debug logger ready", {
    level,
    logPath,
    jsonlPath,
    sessionLogPath,
    fullPayloads,
  });
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

export function isFullPayloads(): boolean {
  return fullPayloads;
}

export function getDebugLogPath(): string | null {
  return logPath;
}

export function getDebugJsonlPath(): string | null {
  return jsonlPath;
}

export function getDebugLevel(): DebugLevel {
  return level;
}

/** In-process ring of events since last initDebug (or process start). */
export function getDebugRing(): readonly DebugEvent[] {
  return ring;
}

export function clearDebugRing(): void {
  ring.length = 0;
}

/**
 * Subscribe to live debug events (same process). Returns unsubscribe.
 * Useful for debug-live-run / benches to mirror into outDir/loop-events.jsonl.
 */
export function onDebugEvent(fn: DebugEventListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function ms(): number {
  return Date.now() - t0;
}

function appendAll(textLine: string, jsonLine: string | null, opts?: { stderr?: boolean }): void {
  // Default: stderr + file. High-volume trace events (SSE chunks) should
  // pass stderr:false — writing every token to the console is a major lag
  // source when reasoning streams are large/fast.
  if (opts?.stderr !== false) {
    process.stderr.write(textLine + "\n");
  }
  for (const p of [logPath, sessionLogPath]) {
    if (!p) continue;
    try {
      appendFileSync(p, textLine + "\n", "utf8");
    } catch {
      /* */
    }
  }
  if (jsonLine) {
    for (const p of [jsonlPath, sessionJsonlPath]) {
      if (!p) continue;
      try {
        appendFileSync(p, jsonLine + "\n", "utf8");
      } catch {
        /* */
      }
    }
  }
}

/**
 * Serialize values for logs.
 * - full mode: only hard-cap extremely large blobs (256k) so disk stays usable
 * - normal: truncate long strings + overall JSON size
 */
export function safeJson(
  v: unknown,
  max = 2000,
  opts?: { full?: boolean; stringMax?: number },
): string {
  const full = opts?.full ?? fullPayloads;
  const stringMax = opts?.stringMax ?? (full ? 200_000 : 400);
  const hardMax = full ? 256_000 : max;
  try {
    const s = JSON.stringify(v, (_k, val) => {
      if (typeof val === "string" && val.length > stringMax) {
        return val.slice(0, stringMax) + `…[+${val.length - stringMax}]`;
      }
      // Avoid serializing huge nested arrays of numbers (e.g. image bytes)
      if (Array.isArray(val) && val.length > 200 && !full) {
        return `[Array(${val.length})]`;
      }
      return val;
    });
    if (s.length > hardMax) return s.slice(0, hardMax) + `…[+${s.length - hardMax}]`;
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

function emit(
  category: string,
  event: string,
  data: Record<string, unknown> | undefined,
  lvl: "info" | "trace",
  opts?: { stderr?: boolean },
): void {
  if (!isDebug()) return;
  // dbgTrace only when level=trace
  if (lvl === "trace" && !isTrace()) return;

  const id = ++seq;
  const ev: DebugEvent = {
    seq: id,
    ms: ms(),
    at: new Date().toISOString(),
    category,
    event,
    data,
    level: lvl,
  };

  // Ring buffer
  ring.push(ev);
  if (ring.length > RING_MAX) {
    ring.splice(0, ring.length - RING_MAX);
  }

  // Subscribers (benches) — never throw into agent path
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      /* */
    }
  }

  const base = `[${String(ev.ms).padStart(6)}ms #${id}] [${category}] ${event}`;
  const line =
    data && Object.keys(data).length
      ? `${base} ${safeJson(data)}`
      : base;

  // JSONL: full-ish structured record (respects safeJson for nested strings)
  let jsonLine: string | null = null;
  if (writeJsonl && (jsonlPath || sessionJsonlPath || listeners.size > 0)) {
    try {
      jsonLine = JSON.stringify({
        seq: ev.seq,
        ms: ev.ms,
        at: ev.at,
        category: ev.category,
        event: ev.event,
        level: ev.level,
        data: data
          ? JSON.parse(safeJson(data, fullPayloads ? 256_000 : 8_000))
          : undefined,
      });
    } catch {
      jsonLine = JSON.stringify({
        seq: ev.seq,
        ms: ev.ms,
        at: ev.at,
        category: ev.category,
        event: ev.event,
        level: ev.level,
        data: { _error: "serialize_failed" },
      });
    }
  }

  const fileOnly = FILE_ONLY_EVENTS.has(event);
  appendAll(line, jsonLine, {
    stderr: opts?.stderr === false || fileOnly ? false : opts?.stderr,
  });
}

/** Core log: category, event, optional data */
export function dbg(
  category: string,
  event: string,
  data?: Record<string, unknown>,
  opts?: { stderr?: boolean },
): void {
  emit(category, event, data, "info", opts);
}

/** Trace-only (raw chunks, full messages) */
export function dbgTrace(
  category: string,
  event: string,
  data?: Record<string, unknown>,
): void {
  // High-volume stream events → file only (still available for postmortem).
  const fileOnly = FILE_ONLY_EVENTS.has(event);
  emit(category, event, data, "trace", fileOnly ? { stderr: false } : undefined);
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

/**
 * Compact summary of wire messages for loop debugging (roles + sizes + tool names).
 * Safe for info-level logs — never dumps full content unless full mode.
 */
export function summarizeMessagesForDebug(
  messages: Array<{
    role: string;
    content?: unknown;
    tool_calls?: Array<{ function?: { name?: string; arguments?: string }; id?: string }>;
    tool_call_id?: string;
    name?: string;
  }>,
): Array<Record<string, unknown>> {
  return messages.map((m, i) => {
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? JSON.stringify(m.content)
          : m.content == null
            ? ""
            : String(m.content);
    const row: Record<string, unknown> = {
      i,
      role: m.role,
      contentChars: content.length,
    };
    if (m.tool_call_id) row.tool_call_id = m.tool_call_id;
    if (m.name) row.name = m.name;
    if (m.tool_calls?.length) {
      row.tool_calls = m.tool_calls.map((t) => ({
        id: t.id,
        name: t.function?.name,
        argsChars: t.function?.arguments?.length ?? 0,
      }));
    }
    if (fullPayloads && content.length > 0 && content.length <= 4_000) {
      row.contentPreview = content.slice(0, 4_000);
    } else if (content.length > 0) {
      row.contentPreview = content.slice(0, 160);
    }
    return row;
  });
}

// Auto-init when env is set at process start
if (process.env.LIBRA_DEBUG) {
  initDebug();
}
