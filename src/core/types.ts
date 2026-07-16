/**
 * Polymorphic Part system — inspired by OpenCode's message Parts.
 * Each part has its own schema and rendering logic so new content
 * types (audio, images, custom widgets) can be added without
 * rewriting the scrollback renderer.
 */

export type Role = "user" | "assistant" | "system" | "tool";

export type ToolStatus = "pending" | "running" | "completed" | "error" | "cancelled";

export interface TextPart {
  id: string;
  type: "text";
  content: string;
  /** True while tokens are still streaming in */
  streaming?: boolean;
}

export interface ReasoningPart {
  id: string;
  type: "reasoning";
  content: string;
  collapsed?: boolean;
  streaming?: boolean;
  /**
   * Optional UI label override (e.g. "Main · opencode/…", "Peer · …")
   * so Ultra+Fusion dual traces are distinguishable.
   */
  title?: string;
}

export interface ToolPart {
  id: string;
  type: "tool";
  toolName: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  result?: string;
  error?: string;
  /** Provider tool_call id — required for proper multi-turn wire history */
  callId?: string;
  startedAt?: number;
  finishedAt?: number;
  collapsed?: boolean;
}

export interface DiffPart {
  id: string;
  type: "diff";
  path: string;
  language?: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  collapsed?: boolean;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface FilePart {
  id: string;
  type: "file";
  path: string;
  excerpt?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface StatusPart {
  id: string;
  type: "status";
  level: "info" | "warn" | "error" | "success";
  message: string;
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | DiffPart
  | FilePart
  | StatusPart;

export interface Message {
  id: string;
  role: Role;
  parts: Part[];
  createdAt: number;
  /** Token usage for this turn, if known */
  usage?: {
    input: number;
    output: number;
  };
}

export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  provider: string;
  cwd: string;
  createdAt: number;
  /**
   * Context window (input tokens) for the active model, when known from the
   * catalog. Kept on the session so the footer updates immediately on /model
   * even before the next token usage event.
   */
  contextWindow?: number;
}

export type AgentPhase =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool"
  | "waiting"
  | "error";

export type AgentThreadStatusLite =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "closed";

/**
 * Bounded, best-effort snapshot of one subagent thread for TUI display —
 * modeled on codex-cli's `AgentStatusThreadPreview` / `/agent` v2 status
 * feed (codex-rs/tui/src/app/agent_status_feed.rs) and the footer
 * `active_agent_label` (codex-rs/tui/src/bottom_pane/footer.rs).
 *
 * Unlike the main-thread TPS in TuiRenderer (which samples a ~2s sliding
 * window of char deltas), `tokensPerSec` here is a running average over
 * the thread's lifetime: subagent hooks only fire once per model round
 * (`onUsage` in agent/turn.ts), not per streamed token, so a sliding
 * window would be mostly empty between rounds. This mirrors codex-cli's
 * own choice not to show a live per-token rate anywhere in its TUI —
 * only elapsed time and token *counts* — because round-granularity is
 * the real resolution available for background agent threads.
 */
export interface AgentThreadSummary {
  id: string;
  nickname: string;
  /** Role id (agent_type): explorer, worker, review, … */
  role: string;
  status: AgentThreadStatusLite;
  tokens: { input: number; output: number };
  /** Running-average tokens/sec since the thread started (0 when idle/cold). */
  tokensPerSec: number;
  /** Short label for the thread's most recent activity, e.g. "streaming · step 2". */
  lastActivity?: string;
  startedAt: number;
  endedAt?: number;
}

/**
 * Live goal badge for TUI chrome (grok-build goal status chip spirit).
 * Owned by the goal orchestrator; mirrored into HarnessState for render.
 */
export interface GoalUiSnapshot {
  objective: string;
  status: string;
  /** e.g. "Active — Verifying (2/8)" or "Paused" */
  statusLine: string;
  /** Footer chip e.g. "[Goal: Executing · 3m]" */
  chip: string;
  /** active | paused | done | error */
  tone: "active" | "paused" | "done" | "error";
  nextStep?: string;
  planning?: boolean;
  verifying?: boolean;
}

export interface HarnessState {
  session: SessionMeta;
  messages: Message[];
  phase: AgentPhase;
  /** Draft text currently in the prompt (owned by UI, mirrored for status) */
  draft: string;
  /** Live spinner label while the agent is busy */
  activityLabel?: string;
  /**
   * Token totals for the session.
   * `lastPrompt` is the most recent request's prompt_tokens (context fill).
   */
  tokens: { input: number; output: number; lastPrompt?: number };
  /** Whether tool details are expanded by default */
  showToolDetails: boolean;
  /** Whether reasoning/thinking blocks are visible */
  showThinking: boolean;
  compact: boolean;
  /**
   * Bounded live view of subagent threads (most recent N, open threads
   * first — see SubagentRuntime.emitSnapshot). Empty when multi-agent is
   * off or no subagent has spawned yet this session.
   */
  agents: AgentThreadSummary[];
  /** Active / recent goal badge for chrome (null when no goal). */
  goal?: GoalUiSnapshot | null;
}

export function createEmptyState(partial?: Partial<SessionMeta>): HarnessState {
  const now = Date.now();
  return {
    session: {
      id: partial?.id ?? crypto.randomUUID().slice(0, 8),
      title: partial?.title ?? "untitled session",
      model: partial?.model ?? "libra-demo",
      provider: partial?.provider ?? "local",
      cwd: partial?.cwd ?? process.cwd(),
      createdAt: partial?.createdAt ?? now,
      contextWindow: partial?.contextWindow,
    },
    messages: [],
    phase: "idle",
    draft: "",
    tokens: { input: 0, output: 0 },
    // Collapsed by default — click headers / Ctrl+E to manage
    showToolDetails: false,
    showThinking: true,
    compact: false,
    agents: [],
    goal: null,
  };
}

export function newId(prefix = "p"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}