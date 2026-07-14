/**
 * Event bus connecting the agent harness to the TUI renderer.
 * Mirrors OpenCode's SSE-style push model: the harness mutates state
 * and emits fine-grained events; the renderer reacts without owning
 * agent logic.
 */

import type {
  AgentPhase,
  DiffPart,
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
    }
  | { type: "phase"; phase: AgentPhase; label?: string }
  | { type: "tokens"; input: number; output: number }
  | { type: "draft"; text: string }
  | { type: "ui.toggle"; key: "showToolDetails" | "showThinking" | "compact" }
  | { type: "diff.append"; messageId: string; part: DiffPart }
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
    case "reasoning.delta":
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== event.messageId) return m;
          return {
            ...m,
            parts: m.parts.map((p) => {
              if (p.id !== event.partId) return p;
              if (p.type !== "text" && p.type !== "reasoning") return p;
              return { ...p, content: p.content + event.delta, streaming: true };
            }),
          };
        }),
      };

    case "tool.status":
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== event.messageId) return m;
          return {
            ...m,
            parts: m.parts.map((p) => {
              if (p.id !== event.partId || p.type !== "tool") return p;
              const next: ToolPart = {
                ...p,
                status: event.status,
                result: event.result ?? p.result,
                error: event.error ?? p.error,
              };
              if (event.status === "running" && !next.startedAt) {
                next.startedAt = Date.now();
              }
              if (
                event.status === "completed" ||
                event.status === "error" ||
                event.status === "cancelled"
              ) {
                next.finishedAt = Date.now();
              }
              return next;
            }),
          };
        }),
      };

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

    case "error":
      return { ...state, phase: "error", activityLabel: event.message };

    default:
      return state;
  }
}
