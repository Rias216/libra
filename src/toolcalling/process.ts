/**
 * Background process manager (Hermes-style process tool).
 * Shell can return immediately with background=true; process() polls/kills.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface BgSession {
  id: string;
  command: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  running: boolean;
  child?: ChildProcess;
}

const MAX_LOG = 200_000;
const sessions = new Map<string, BgSession>();
let seq = 0;

function nextId(): string {
  seq += 1;
  return `proc_${Date.now().toString(36)}_${seq}`;
}

function truncateLog(s: string): string {
  if (s.length <= MAX_LOG) return s;
  return s.slice(s.length - MAX_LOG);
}

export function listSessions(): Array<Record<string, unknown>> {
  return [...sessions.values()].map((s) => summarize(s));
}

export function getSession(id: string): BgSession | undefined {
  return sessions.get(id);
}

function summarize(s: BgSession): Record<string, unknown> {
  return {
    session_id: s.id,
    command: s.command,
    pid: s.pid,
    running: s.running,
    started_at: s.startedAt,
    ended_at: s.endedAt,
    exit_code: s.exitCode,
    stdout_len: s.stdout.length,
    stderr_len: s.stderr.length,
  };
}

export function startBackground(
  command: string,
  cwd: string,
  shellOpt: string | boolean,
): BgSession {
  const id = nextId();
  const session: BgSession = {
    id,
    command,
    startedAt: Date.now(),
    stdout: "",
    stderr: "",
    running: true,
  };

  const child = spawn(command, {
    cwd,
    shell: shellOpt,
    windowsHide: true,
    env: { ...process.env, NO_PROXY: "*" },
  });
  session.child = child;
  session.pid = child.pid;

  child.stdout?.on("data", (d: Buffer) => {
    session.stdout = truncateLog(session.stdout + d.toString("utf8"));
  });
  child.stderr?.on("data", (d: Buffer) => {
    session.stderr = truncateLog(session.stderr + d.toString("utf8"));
  });
  child.on("error", (e) => {
    session.stderr = truncateLog(session.stderr + "\n" + e.message);
    session.running = false;
    session.endedAt = Date.now();
    session.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    session.running = false;
    session.endedAt = Date.now();
    session.exitCode = code;
    session.signal = signal;
    session.child = undefined;
  });

  sessions.set(id, session);
  return session;
}

export async function processAction(
  action: string,
  opts: {
    session_id?: string;
    data?: string;
    timeout_ms?: number;
    offset?: number;
    limit?: number;
  } = {},
): Promise<Record<string, unknown>> {
  switch (action) {
    case "list":
      return { ok: true, sessions: listSessions() };

    case "poll": {
      const s = requireSession(opts.session_id);
      return {
        ok: true,
        ...summarize(s),
        stdout_tail: s.stdout.slice(-4000),
        stderr_tail: s.stderr.slice(-2000),
      };
    }

    case "log": {
      const s = requireSession(opts.session_id);
      const offset = Math.max(0, opts.offset ?? 0);
      const limit = opts.limit ?? 50_000;
      const combined = s.stdout + (s.stderr ? `\n--- stderr ---\n${s.stderr}` : "");
      const slice = combined.slice(offset, offset + limit);
      return {
        ok: true,
        session_id: s.id,
        offset,
        length: slice.length,
        total: combined.length,
        content: slice,
        running: s.running,
      };
    }

    case "wait": {
      const s = requireSession(opts.session_id);
      const timeout = opts.timeout_ms ?? 60_000;
      const t0 = Date.now();
      while (s.running && Date.now() - t0 < timeout) {
        await sleep(100);
      }
      return {
        ok: !s.running,
        ...summarize(s),
        timed_out: s.running,
        stdout_tail: s.stdout.slice(-4000),
        stderr_tail: s.stderr.slice(-2000),
      };
    }

    case "kill": {
      const s = requireSession(opts.session_id);
      if (s.child && s.running) {
        try {
          s.child.kill();
        } catch {
          /* */
        }
      }
      s.running = false;
      s.endedAt = Date.now();
      if (s.exitCode == null) s.exitCode = 1;
      return { ok: true, ...summarize(s), killed: true };
    }

    case "write": {
      const s = requireSession(opts.session_id);
      const data = opts.data ?? "";
      if (!s.child || !s.running || !s.child.stdin) {
        return {
          ok: false,
          error: "process not running or stdin closed",
          code: "not_running",
        };
      }
      s.child.stdin.write(data);
      return { ok: true, session_id: s.id, written: data.length };
    }

    default:
      return {
        ok: false,
        error: `unknown process action: ${action}`,
        code: "error",
        hint: "Use list|poll|log|wait|kill|write",
      };
  }
}

function requireSession(id: string | undefined): BgSession {
  if (!id) throw new Error("session_id required");
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session_id: ${id}`);
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Test helper — clear all sessions (kills running). */
export function _resetProcessSessions(): void {
  for (const s of sessions.values()) {
    try {
      s.child?.kill();
    } catch {
      /* */
    }
  }
  sessions.clear();
  seq = 0;
}
