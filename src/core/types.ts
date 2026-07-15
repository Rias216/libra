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
}

export type AgentPhase =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool"
  | "waiting"
  | "error";

export interface HarnessState {
  session: SessionMeta;
  messages: Message[];
  phase: AgentPhase;
  /** Draft text currently in the prompt (owned by UI, mirrored for status) */
  draft: string;
  /** Live spinner label while the agent is busy */
  activityLabel?: string;
  /** Token totals for the session */
  tokens: { input: number; output: number };
  /** Whether tool details are expanded by default */
  showToolDetails: boolean;
  /** Whether reasoning/thinking blocks are visible */
  showThinking: boolean;
  compact: boolean;
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
    },
    messages: [],
    phase: "idle",
    draft: "",
    tokens: { input: 0, output: 0 },
    showToolDetails: true,
    showThinking: true,
    compact: false,
  };
}

export function newId(prefix = "p"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
