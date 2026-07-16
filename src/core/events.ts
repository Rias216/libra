/**
 * Event bus connecting the agent harness to the TUI renderer.
 * Mirrors OpenCode's SSE-style push model: the harness mutates state
 * and emits fine-grained events; the renderer reacts without owning
 * agent logic.
 */

import type {
  AgentPhase,
  DiffPart,
  GoalUiSnapshot,
  HarnessState,
  Message,
  Part,
  SessionMeta,
  ToolPart,
  ToolStatus,
} from "./types.js";

export type HarnessEvent =
  | { type: "session.reset"; state: HarnessState }
  | { type: "session.patch"; patch: Partial<SessionMeta> }
  | { type: "message.append"; message: Message }
  | { type: "message.update"; messageId: string; message: Message }
  | { type: "part.append"; messageId: string; part: Part }
  | { type: "part.update"; messageId: string; partId: string; part: Part }
  | { type: "part.patch"; messageId: string; partId: string; patch: Partial<Part> }
  | { type: "text.delta"; messageId: string; partId: string; delta: string }
  | { type: "reasoning.delta"; messageId: string; partId: string; delta: string }
  | {
      type: "tool.status";
      messageId: string;
      partId: string;
      status: ToolStatus;
      result?: string;
      error?: string;
      contentParts?: ToolPart["contentParts"];
    }
  | { type: "phase"; phase: AgentPhase; label?: string }
  | { type: "tokens"; input: number; output: number }
  | { type: "draft"; text: string }
  | { type: "ui.toggle"; key: "showToolDetails" | "showThinking" | "compact" }
  | { type: "diff.append"; messageId: string; part: DiffPart }
  | { type: "goal"; goal: GoalUiSnapshot | null }
  | { type: "error"; message: string };

export type HarnessListener = (event: HarnessEvent, state: HarnessState) => void;

export class EventBus {
  private listeners = new Set<HarnessListener>();

  on(listener: HarnessListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: HarnessEvent, state: HarnessState): void {
    for (const listener of this.listeners) {
      try {
        listener(event, state);
      } catch (err) {
        // Renderer bugs must never crash the harness loop
        console.error("[libra] event listener error:", err);
      }
    }
  }
}

/** Immutable-ish reducer: apply an event and return the next state. */
export function reduce(state: HarnessState, event: HarnessEvent): HarnessState {
  switch (event.type) {
    case "session.reset":
      return event.state;

    case "session.patch":
      return {
        ...state,
        session: { ...state.session, ...event.patch },
      };

    case "message.append":
      return { ...state, messages: [...state.messages, event.message] };

    case "message.update":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === event.messageId ? event.message : m,
        ),
      };

    case "part.append":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === event.messageId
            ? { ...m, parts: [...m.parts, event.part] }
            : m,
        ),
      };

    case "part.update":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === event.messageId
            ? {
                ...m,
                parts: m.parts.map((p) =>
                  p.id === event.partId ? event.part : p,
                ),
              }
            : m,
        ),
      };

    case "part.patch":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === event.messageId
            ? {
                ...m,
                parts: m.parts.map((p) =>
                  p.id === event.partId
                    ? ({ ...p, ...event.patch } as Part)
                    : p,
                ),
              }
            : m,
        ),
      };

    case "text.delta":
    case "reasoning.delta": {
      // Hot path: mutate the target part in place (no full message array clone).
      // Stream deltas are the dominant event volume during agent runs.
      // Strict type match: never append reasoning into a text part (or vice versa).
      const expectType = event.type === "text.delta" ? "text" : "reasoning";
      const msgs = state.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (m.id !== event.messageId) continue;
        const parts = m.parts;
        for (let j = 0; j < parts.length; j++) {
          const p = parts[j]!;
          if (p.id !== event.partId) continue;
          if (p.type !== expectType) return state;
          p.content += event.delta;
          p.streaming = true;
          return state;
        }
        return state;
      }
      return state;
    }

    case "tool.status": {
      const msgs = state.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (m.id !== event.messageId) continue;
        for (let j = 0; j < m.parts.length; j++) {
          const p = m.parts[j]!;
          if (p.id !== event.partId || p.type !== "tool") continue;
          const tool = p as ToolPart;
          tool.status = event.status;
          if (event.result !== undefined) tool.result = event.result;
          if (event.error !== undefined) tool.error = event.error;
          if (event.contentParts !== undefined) {
            tool.contentParts = event.contentParts;
          }
          if (event.status === "running" && !tool.startedAt) {
            tool.startedAt = Date.now();
          }
          if (
            event.status === "completed" ||
            event.status === "error" ||
            event.status === "cancelled"
          ) {
            tool.finishedAt = Date.now();
          }
          return state;
        }
        return state;
      }
      return state;
    }

    case "phase":
      return {
        ...state,
        phase: event.phase,
        activityLabel: event.label,
      };

    case "tokens":
      return {
        ...state,
        tokens: {
          input: state.tokens.input + event.input,
          output: state.tokens.output + event.output,
          // Latest request size ≈ current context window fill
          lastPrompt:
            event.input > 0 ? event.input : state.tokens.lastPrompt,
        },
      };

    case "draft":
      return { ...state, draft: event.text };

    case "ui.toggle":
      return { ...state, [event.key]: !state[event.key] };

    case "diff.append":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === event.messageId
            ? { ...m, parts: [...m.parts, event.part] }
            : m,
        ),
      };

    case "goal":
      return { ...state, goal: event.goal };

    case "error":
      return { ...state, phase: "error", activityLabel: event.message };

    default:
      return state;
  }
}
