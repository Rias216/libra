/**
 * Durable session transcripts — `.libe` files under ~/.libra/sessions/
 *
 * Used for:
 *  - crash recovery / later inspection
 *  - self-review: mine recent sessions for friction & errors
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AgentPhase,
  HarnessState,
  Message,
  Part,
  SessionMeta,
} from "../core/types.js";

/** On-disk session format (extension `.libe`). */
export const LIBE_FORMAT = "libe" as const;
export const LIBE_VERSION = 1;

export interface LibeFile {
  format: typeof LIBE_FORMAT;
  version: number;
  savedAt: string;
  savedAtMs: number;
  /** Libra package version when known */
  libraVersion?: string;
  session: SessionMeta;
  messages: Message[];
  tokens: { input: number; output: number };
  phase: AgentPhase;
  activityLabel?: string;
  /** Precomputed at save time for quick listing */
  summary?: SessionSummary;
}

export interface SessionSummary {
  messageCount: number;
  userTurns: number;
  toolCalls: number;
  toolErrors: number;
  statusErrors: number;
  statusWarns: number;
  /** Short labels for failures (truncated) */
  errorSamples: string[];
}

export interface FrictionEvent {
  kind:
    | "tool_error"
    | "status_error"
    | "status_warn"
    | "phase_error"
    | "user_retry"
    | "empty_assistant"
    | "cancelled_tool";
  sessionId: string;
  sessionFile?: string;
  at?: number;
  detail: string;
  toolName?: string;
  path?: string;
}

export interface FrictionReport {
  sessionsScanned: number;
  sessionIds: string[];
  events: FrictionEvent[];
  /** Aggregated counts by kind */
  counts: Record<string, number>;
  /** toolName → error count */
  toolErrorCounts: Record<string, number>;
  /** Human markdown for self-review prompts */
  markdown: string;
}

const MAX_SESSIONS_KEPT = 80;
const MAX_MESSAGE_CHARS = 400_000; // soft cap per file body

function sessionsDir(): string {
  return (
    process.env.LIBRA_SESSIONS_DIR ?? join(homedir(), ".libra", "sessions")
  );
}

export function getSessionsDir(): string {
  return sessionsDir();
}

function ensureSessionsDir(): string {
  const d = sessionsDir();
  mkdirSync(d, { recursive: true });
  return d;
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
}

/** Stable path for a live session (updated in place as the session grows). */
export function sessionLibePath(sessionId: string): string {
  return join(ensureSessionsDir(), `${safeId(sessionId)}.libe`);
}

export function summarizeMessages(messages: Message[]): SessionSummary {
  let userTurns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let statusErrors = 0;
  let statusWarns = 0;
  const errorSamples: string[] = [];

  const pushSample = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!t) return;
    if (errorSamples.length >= 12) return;
    if (errorSamples.includes(t)) return;
    errorSamples.push(t);
  };

  for (const msg of messages) {
    if (msg.role === "user") userTurns++;
    for (const part of msg.parts) {
      if (part.type === "tool") {
        toolCalls++;
        if (part.status === "error" || part.status === "cancelled") {
          if (part.status === "error") toolErrors++;
          pushSample(
            `${part.toolName}: ${part.error || part.status}${
              part.result ? " · " + part.result.slice(0, 80) : ""
            }`,
          );
        }
      } else if (part.type === "status") {
        if (part.level === "error") {
          statusErrors++;
          pushSample(part.message);
        } else if (part.level === "warn") {
          statusWarns++;
          pushSample(part.message);
        }
      }
    }
  }

  return {
    messageCount: messages.length,
    userTurns,
    toolCalls,
    toolErrors,
    statusErrors,
    statusWarns,
    errorSamples,
  };
}

/**
 * Serialize current harness state to a `.libe` file.
 * Overwrites the same path for the session id (rolling live save).
 */
export function saveSessionLibe(
  state: HarnessState,
  opts?: { libraVersion?: string; path?: string },
): { path: string; summary: SessionSummary } | null {
  if (!state.session?.id) return null;
  // Skip empty sessions (boot only)
  if (state.messages.length === 0) return null;

  const summary = summarizeMessages(state.messages);
  const now = Date.now();
  const payload: LibeFile = {
    format: LIBE_FORMAT,
    version: LIBE_VERSION,
    savedAt: new Date(now).toISOString(),
    savedAtMs: now,
    libraVersion: opts?.libraVersion,
    session: { ...state.session },
    messages: truncateMessagesForDisk(state.messages),
    tokens: { ...state.tokens },
    phase: state.phase,
    activityLabel: state.activityLabel,
    summary,
  };

  try {
    const dir = ensureSessionsDir();
    const path = opts?.path ?? sessionLibePath(state.session.id);
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    try {
      renameSync(tmp, path);
    } catch {
      writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
    }
    // Mirror latest for quick tools
    try {
      writeFileSync(
        join(dir, "latest.libe"),
        JSON.stringify(payload, null, 2) + "\n",
        "utf8",
      );
    } catch {
      /* */
    }
    pruneOldSessions(MAX_SESSIONS_KEPT);
    return { path, summary };
  } catch {
    return null;
  }
}

/** Cap total serialized message bulk so sessions stay manageable. */
function truncateMessagesForDisk(messages: Message[]): Message[] {
  let total = 0;
  const out: Message[] = [];
  // Keep newest messages preferentially
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const clone: Message = {
      ...m,
      parts: m.parts.map((p) => shrinkPart(p)),
    };
    const size = JSON.stringify(clone).length;
    if (total + size > MAX_MESSAGE_CHARS && out.length > 0) break;
    total += size;
    out.push(clone);
  }
  out.reverse();
  return out;
}

function shrinkPart(part: Part): Part {
  if (part.type === "text" || part.type === "reasoning") {
    const c = part.content;
    if (c.length > 24_000) {
      return {
        ...part,
        content:
          c.slice(0, 12_000) +
          `\n\n…[truncated ${c.length - 20_000} chars]…\n\n` +
          c.slice(-8_000),
      };
    }
  }
  if (part.type === "tool") {
    const result = part.result;
    const error = part.error;
    return {
      ...part,
      result:
        result && result.length > 12_000
          ? result.slice(0, 8_000) +
            `\n…[truncated ${result.length - 10_000} chars]…\n` +
            result.slice(-2_000)
          : result,
      error:
        error && error.length > 4_000 ? error.slice(0, 4_000) + "…" : error,
    };
  }
  if (part.type === "status" && part.message.length > 4_000) {
    return { ...part, message: part.message.slice(0, 4_000) + "…" };
  }
  return part;
}

export function loadSessionLibe(path: string): LibeFile | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as LibeFile;
    if (raw.format !== LIBE_FORMAT) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Resolve a --resume argument: absolute .libe path, bare session id,
 * or `latest`.
 */
export function resolveResumeTarget(arg: string): string | null {
  const a = arg.trim();
  if (!a) return null;
  if (a === "latest") {
    const p = join(sessionsDir(), "latest.libe");
    return existsSync(p) ? p : null;
  }
  if (a.endsWith(".libe") || a.includes("/") || a.includes("\\")) {
    return existsSync(a) ? a : null;
  }
  // session id
  const byId = sessionLibePath(a);
  if (existsSync(byId)) return byId;
  // fuzzy: file starting with id
  try {
    const dir = sessionsDir();
    if (!existsSync(dir)) return null;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(a) && name.endsWith(".libe")) {
        return join(dir, name);
      }
    }
  } catch {
    /* */
  }
  return null;
}

export interface ListedSession {
  path: string;
  id: string;
  savedAtMs: number;
  savedAt: string;
  title: string;
  model: string;
  provider: string;
  summary?: SessionSummary;
}

/** Newest first. */
export function listSessionLibes(limit = 30): ListedSession[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const out: ListedSession[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".libe")) continue;
    if (name === "latest.libe") continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      const libe = loadSessionLibe(path);
      if (!libe) continue;
      out.push({
        path,
        id: libe.session.id,
        savedAtMs: libe.savedAtMs || st.mtimeMs,
        savedAt: libe.savedAt || new Date(st.mtimeMs).toISOString(),
        title: libe.session.title,
        model: libe.session.model,
        provider: libe.session.provider,
        summary: libe.summary ?? summarizeMessages(libe.messages),
      });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => b.savedAtMs - a.savedAtMs);
  return out.slice(0, limit);
}

function pruneOldSessions(keep: number): void {
  const all = listSessionLibes(500);
  if (all.length <= keep) return;
  for (const s of all.slice(keep)) {
    try {
      unlinkSync(s.path);
    } catch {
      /* */
    }
  }
}

/**
 * Mine recent `.libe` sessions for friction: tool errors, warnings,
 * empty answers, cancelled tools, and user retries after failures.
 */
export function analyzeSessionFriction(
  opts?: { limit?: number; paths?: string[] },
): FrictionReport {
  const limit = opts?.limit ?? 20;
  const files: { path: string; libe: LibeFile }[] = [];

  if (opts?.paths?.length) {
    for (const p of opts.paths) {
      const libe = loadSessionLibe(p);
      if (libe) files.push({ path: p, libe });
    }
  } else {
    for (const s of listSessionLibes(limit)) {
      const libe = loadSessionLibe(s.path);
      if (libe) files.push({ path: s.path, libe });
    }
  }

  const events: FrictionEvent[] = [];
  const counts: Record<string, number> = {};
  const toolErrorCounts: Record<string, number> = {};
  const sessionIds: string[] = [];

  const bump = (k: string) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };

  for (const { path, libe } of files) {
    sessionIds.push(libe.session.id);
    const msgs = libe.messages;
    let prevHadError = false;

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]!;

      if (msg.role === "user" && prevHadError) {
        const text = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { content: string }).content)
          .join(" ")
          .trim();
        events.push({
          kind: "user_retry",
          sessionId: libe.session.id,
          sessionFile: path,
          at: msg.createdAt,
          detail: text.slice(0, 200) || "(user continued after errors)",
        });
        bump("user_retry");
        prevHadError = false;
      }

      let msgError = false;
      let hasAssistantText = false;
      let hasTool = false;

      for (const part of msg.parts) {
        if (part.type === "tool") {
          hasTool = true;
          if (part.status === "error") {
            msgError = true;
            events.push({
              kind: "tool_error",
              sessionId: libe.session.id,
              sessionFile: path,
              at: part.finishedAt ?? msg.createdAt,
              detail: (part.error || part.result || "tool error").slice(0, 300),
              toolName: part.toolName,
            });
            bump("tool_error");
            toolErrorCounts[part.toolName] =
              (toolErrorCounts[part.toolName] ?? 0) + 1;
          } else if (part.status === "cancelled") {
            events.push({
              kind: "cancelled_tool",
              sessionId: libe.session.id,
              sessionFile: path,
              at: part.finishedAt ?? msg.createdAt,
              detail: "tool cancelled",
              toolName: part.toolName,
            });
            bump("cancelled_tool");
          }
        } else if (part.type === "status") {
          if (part.level === "error") {
            msgError = true;
            events.push({
              kind: "status_error",
              sessionId: libe.session.id,
              sessionFile: path,
              at: msg.createdAt,
              detail: part.message.slice(0, 300),
            });
            bump("status_error");
          } else if (part.level === "warn") {
            events.push({
              kind: "status_warn",
              sessionId: libe.session.id,
              sessionFile: path,
              at: msg.createdAt,
              detail: part.message.slice(0, 300),
            });
            bump("status_warn");
          }
        } else if (part.type === "text" && msg.role === "assistant") {
          if (part.content.trim()) hasAssistantText = true;
        }
      }

      if (
        msg.role === "assistant" &&
        !hasAssistantText &&
        !hasTool &&
        msg.parts.length > 0
      ) {
        // reasoning-only or empty answer — mild friction
        const onlyReasoning = msg.parts.every(
          (p) => p.type === "reasoning" || p.type === "status",
        );
        if (onlyReasoning) {
          events.push({
            kind: "empty_assistant",
            sessionId: libe.session.id,
            sessionFile: path,
            at: msg.createdAt,
            detail: "assistant turn with no user-facing text/tools",
          });
          bump("empty_assistant");
        }
      }

      if (msgError) prevHadError = true;
    }

    if (libe.phase === "error" && libe.activityLabel) {
      events.push({
        kind: "phase_error",
        sessionId: libe.session.id,
        sessionFile: path,
        at: libe.savedAtMs,
        detail: libe.activityLabel.slice(0, 300),
      });
      bump("phase_error");
    }
  }

  // Cap events for prompt size; keep newest-ish by scanning order
  const capped = events.slice(0, 80);
  const markdown = formatFrictionMarkdown({
    sessionsScanned: files.length,
    sessionIds,
    events: capped,
    counts,
    toolErrorCounts,
  });

  return {
    sessionsScanned: files.length,
    sessionIds,
    events: capped,
    counts,
    toolErrorCounts,
    markdown,
  };
}

function formatFrictionMarkdown(r: {
  sessionsScanned: number;
  sessionIds: string[];
  events: FrictionEvent[];
  counts: Record<string, number>;
  toolErrorCounts: Record<string, number>;
}): string {
  const lines: string[] = [];
  lines.push(`## Recent session friction (from .libe transcripts)`);
  lines.push("");
  lines.push(
    `Scanned **${r.sessionsScanned}** session file(s). ` +
      `Events below are real user-visible failures and retries — prioritize fixing these.`,
  );
  lines.push("");

  const countEntries = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
  if (countEntries.length === 0) {
    lines.push("_No tool/status errors found in recent sessions._");
    lines.push("");
    lines.push(
      "Still review UX friction: slow paths, confusing reasoning modes, Windows shell, self-review, Bun/TS7 port leftovers.",
    );
    return lines.join("\n");
  }

  lines.push("### Counts");
  for (const [k, n] of countEntries) {
    lines.push(`- **${k}**: ${n}`);
  }
  lines.push("");

  const tools = Object.entries(r.toolErrorCounts).sort((a, b) => b[1] - a[1]);
  if (tools.length) {
    lines.push("### Tools with errors");
    for (const [name, n] of tools.slice(0, 15)) {
      lines.push(`- \`${name}\` × ${n}`);
    }
    lines.push("");
  }

  lines.push("### Event samples (newest sessions first)");
  for (const e of r.events.slice(0, 40)) {
    const tool = e.toolName ? ` \`${e.toolName}\`` : "";
    lines.push(
      `- **${e.kind}** session=\`${e.sessionId}\`${tool}: ${e.detail.replace(/\n/g, " ")}`,
    );
  }
  lines.push("");
  lines.push("### How to review");
  lines.push(
    "1. Reproduce or read the cited tool/status errors in `src/toolcalling/` and `src/agent/`.",
  );
  lines.push(
    "2. Fix root causes (Windows shell, path handling, permissions, stream/partition bugs).",
  );
  lines.push("3. Add/adjust a harness test when the failure is deterministic.");
  lines.push(
    "4. Sessions live under `~/.libra/sessions/*.libe` — re-read with tools if you need full context.",
  );

  return lines.join("\n");
}

/**
 * Debounced live saver — attach to HarnessStore.subscribe.
 * Saves on phase transitions to idle/error and periodically while busy.
 */
export function createSessionAutosave(
  getState: () => HarnessState,
  opts?: { libraVersion?: string; debounceMs?: number },
): {
  onEvent: () => void;
  flush: () => void;
  dispose: () => void;
} {
  const debounceMs = opts?.debounceMs ?? 800;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPhase: AgentPhase | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    saveSessionLibe(getState(), { libraVersion: opts?.libraVersion });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveSessionLibe(getState(), { libraVersion: opts?.libraVersion });
    }, debounceMs);
  };

  return {
    onEvent: () => {
      const st = getState();
      // Always schedule; flush immediately when a turn ends or errors
      if (
        (st.phase === "idle" || st.phase === "error") &&
        lastPhase !== null &&
        lastPhase !== st.phase
      ) {
        flush();
      } else {
        schedule();
      }
      lastPhase = st.phase;
    },
    flush,
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      flush();
    },
  };
}
