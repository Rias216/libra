/**
 * Harness store — single source of truth for session state.
 * Emits events so the TUI (and future web/IDE clients) stay in sync.
 */

import { EventBus, reduce, type HarnessEvent } from "./events.js";
import {
  createEmptyState,
  newId,
  type HarnessState,
  type Message,
  type Part,
  type SessionMeta,
  type ToolStatus,
} from "./types.js";

export class HarnessStore {
  state: HarnessState;
  readonly bus = new EventBus();

  constructor(session?: Partial<SessionMeta>) {
    this.state = createEmptyState(session);
  }

  subscribe(
    listener: (event: HarnessEvent, state: HarnessState) => void,
  ): () => void {
    return this.bus.on(listener);
  }

  private dispatch(event: HarnessEvent): void {
    this.state = reduce(this.state, event);
    this.bus.emit(event, this.state);
  }

  reset(session?: Partial<SessionMeta>): void {
    this.dispatch({
      type: "session.reset",
      state: createEmptyState({ ...this.state.session, ...session }),
    });
  }

  /**
   * Start a brand-new session (new id) seeded with pre-built messages.
   * Used after auto-compaction: wipe the old transcript UI and continue
   * from the compacted context.
   *
   * Preserves provider / model / cwd / UI toggles; clears token totals.
   */
  resetWithSeed(
    session: Partial<SessionMeta> | undefined,
    messages: Message[],
  ): void {
    const prev = this.state;
    const next = createEmptyState({
      ...prev.session,
      ...session,
      // Force a new session id unless the caller set one
      id: session?.id ?? crypto.randomUUID().slice(0, 8),
      createdAt: session?.createdAt ?? Date.now(),
    });
    next.messages = messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => ({ ...p })),
    }));
    next.showToolDetails = prev.showToolDetails;
    next.showThinking = prev.showThinking;
    next.compact = prev.compact;
    next.tokens = { input: 0, output: 0 };
    this.dispatch({ type: "session.reset", state: next });
  }

  appendMessage(message: Message): void {
    this.dispatch({ type: "message.append", message });
  }

  appendUser(text: string): Message {
    const message: Message = {
      id: newId("m"),
      role: "user",
      createdAt: Date.now(),
      parts: [{ id: newId("p"), type: "text", content: text }],
    };
    this.appendMessage(message);
    return message;
  }

  startAssistant(): Message {
    const message: Message = {
      id: newId("m"),
      role: "assistant",
      createdAt: Date.now(),
      parts: [],
    };
    this.appendMessage(message);
    return message;
  }

  appendPart(messageId: string, part: Part): void {
    this.dispatch({ type: "part.append", messageId, part });
  }

  updatePart(messageId: string, part: Part): void {
    this.dispatch({ type: "part.update", messageId, partId: part.id, part });
  }

  patchPart(messageId: string, partId: string, patch: Partial<Part>): void {
    this.dispatch({ type: "part.patch", messageId, partId, patch });
  }

  textDelta(messageId: string, partId: string, delta: string): void {
    this.dispatch({ type: "text.delta", messageId, partId, delta });
  }

  reasoningDelta(messageId: string, partId: string, delta: string): void {
    this.dispatch({ type: "reasoning.delta", messageId, partId, delta });
  }

  toolStatus(
    messageId: string,
    partId: string,
    status: ToolStatus,
    extra?: {
      result?: string;
      error?: string;
      contentParts?: import("./types.js").ToolPart["contentParts"];
    },
  ): void {
    this.dispatch({
      type: "tool.status",
      messageId,
      partId,
      status,
      result: extra?.result,
      error: extra?.error,
      contentParts: extra?.contentParts,
    });
  }

  setPhase(
    phase: HarnessState["phase"],
    label?: string,
  ): void {
    this.dispatch({ type: "phase", phase, label });
  }

  /** Push live goal badge for TUI chrome (null clears). */
  setGoal(
    goal: import("./types.js").GoalUiSnapshot | null,
  ): void {
    this.dispatch({ type: "goal", goal });
  }

  addTokens(input: number, output: number): void {
    this.dispatch({ type: "tokens", input, output });
  }

  toggle(key: "showToolDetails" | "showThinking" | "compact"): void {
    this.dispatch({ type: "ui.toggle", key });
  }

  /** Update model / provider / title without resetting messages. */
  patchSession(patch: Partial<import("./types.js").SessionMeta>): void {
    this.dispatch({ type: "session.patch", patch });
  }
}
