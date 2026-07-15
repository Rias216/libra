/**
 * Main TUI renderer — owns the alt-screen, frame loop, and layout.
 *
 * Layout (top -> bottom):
 *   header
 *   scrollback + scrollbar
 *   settings picker (optional, OpenCode-style)
 *   autocomplete popup (/ and @ only)
 *   prompt (+ ghost)
 *   status bar
 */

import type { HarnessState } from "../core/types.js";
import type { HarnessEvent } from "../core/events.js";
import { PathIndex } from "../memory/paths.js";
import { PromptHistory } from "../memory/history.js";
import {
  applySuggestion,
  complete,
  parseSlashInput,
  resolveSlashCommand,
  type CompleteResult,
} from "../complete/engine.js";
import { clampSelected, layoutPopup } from "../complete/popup.js";
import { FrameBuffer } from "./buffer.js";
import { ansi, CSI } from "./ansi.js";
import {
  detectColorLevel,
  resolveTheme,
  THEME_ORDER,
  type ColorLevel,
  type Theme,
} from "./theme.js";
import {
  buildScrollDocument,
  clearScrollCache,
  clampOffset,
  isFollowing,
} from "./scrollback.js";
import {
  createPrompt,
  layoutPrompt,
  promptBackspace,
  promptDelete,
  promptHistory,
  promptInsert,
  promptMove,
  promptSubmit,
  type PromptState,
} from "./prompt.js";
import {
  reasoningModeDisplay,
  renderDivider,
  renderHeader,
  renderStatus,
} from "./chrome.js";
import type { RowHit } from "./components/parts.js";
import { computeScrollbar, scrollPercent } from "./scrollbar.js";
import { decodeInput, type KeyEvent } from "./input.js";
import {
  createPicker,
  layoutPicker,
  pickerAccept,
  pickerActivate,
  pickerBackspace,
  pickerCycle,
  pickerMove,
  pickerPage,
  pickerGoto,
  pickerType,
  isSearchable,
  visibleCapacity,
  type PickerSpec,
  type PickerState,
} from "./picker.js";
import {
  fontChangeSequence,
  glyphsFor,
  resolveFont,
  type FontProfile,
  type GlyphSet,
} from "./font.js";
import {
  createModalInput,
  layoutModalInput,
  modalBackspace,
  modalInsert,
  modalMove,
  type ModalInputSpec,
  type ModalInputState,
} from "./modal-input.js";
import { copyText } from "./clipboard.js";
import type { Row } from "./components/parts.js";

export interface RendererOptions {
  theme?: string;
  font?: string;
  cwd?: string;
  onSubmit?: (text: string) => void;
  onCommand?: (cmd: string, args: string) => void;
  onQuit?: () => void;
  /**
   * Toggle collapse on a reasoning / tool / diff part (OpenCode-style).
   * Click on the part header when selection is empty (pure click).
   */
  onTogglePart?: (messageId: string, partId: string) => void;
}

export class TuiRenderer {
  private state: HarnessState | null = null;
  private theme: Theme;
  private colorLevel: ColorLevel;
  private buf: FrameBuffer;
  private prompt: PromptState = createPrompt();
  private focus: "prompt" | "scrollback" = "prompt";
  private scrollOffset = 0;
  private following = true;
  private tick = 0;
  private running = false;
  private needsFull = true;
  private timer: NodeJS.Timeout | null = null;
  /** Coalesce high-frequency store paints (stream deltas) to ~30fps */
  private paintRaf: NodeJS.Timeout | null = null;
  private paintQueued = false;
  private lastPaintMs = 0;
  private static readonly PAINT_MIN_MS = 32;
  private opts: RendererOptions;
  private stdin: NodeJS.ReadStream;
  private stdout: NodeJS.WriteStream;
  private onData: ((buf: Buffer) => void) | null = null;
  private onResize: (() => void) | null = null;
  private wasRaw = false;

  // Autocomplete
  private paths: PathIndex;
  private history: PromptHistory;
  private completeResult: CompleteResult = {
    items: [],
    tokenStart: 0,
    tokenEnd: 0,
    mode: "none",
    ghost: "",
  };
  private completeSelected = 0;
  private completeOpen = false;
  private picker: PickerState | null = null;
  /** Nested pickers — Escape pops back instead of exiting the whole tab */
  private pickerStack: PickerState[] = [];
  private modal: ModalInputState | null = null;
  private font: FontProfile;
  private glyphs: GlyphSet;
  /** Theme name to restore if picker cancelled after live preview */
  private themeBeforePreview: string | null = null;
  private lastDocLen = 0;
  private lastScrollH = 0;
  /** Plain-text lines of last painted scrollback document (for selection copy) */
  private lastDocPlain: string[] = [];
  /** Per-line click targets (reasoning/tool headers) for expand/collapse */
  private lastDocHits: (RowHit | null)[] = [];
  /** Geometry of last paint (for mouse hit-testing) */
  private layout = {
    padX: 2,
    scrollTop: 0,
    scrollH: 0,
    contentWidth: 80,
  };
  /** Track pure click vs drag so we can expand/collapse without selecting */
  private mouseDown: {
    docLine: number;
    col: number;
    moved: boolean;
  } | null = null;
  /** Text selection in document coords (line + column in plain text) */
  private selection: {
    active: boolean;
    anchorLine: number;
    anchorCol: number;
    focusLine: number;
    focusCol: number;
  } | null = null;
  private copyFlash: string | null = null;
  /**
   * Live generation throughput (tokens/sec) from stream deltas.
   * Sliding ~2s window; ~4 chars ≈ 1 token.
   */
  private tpsWindow: { t: number; tokens: number }[] = [];
  private tpsCurrent = 0;
  private tpsSampleStartedAt = 0;

  constructor(opts: RendererOptions = {}) {
    this.opts = opts;
    this.stdin = process.stdin;
    this.stdout = process.stdout;
    this.theme = resolveTheme(opts.theme ?? "libra-night");
    this.font = resolveFont(opts.font ?? "default");
    this.glyphs = glyphsFor(this.font);
    this.colorLevel = detectColorLevel();
    const { cols, rows } = this.size();
    this.buf = new FrameBuffer(cols, rows, this.colorLevel, this.theme.bg);
    this.paths = new PathIndex(opts.cwd ?? process.cwd());
    this.history = new PromptHistory();
    for (const h of this.history.recent(100).reverse()) {
      this.prompt.history.push(h);
    }
  }

  setState(state: HarnessState, event?: HarnessEvent): void {
    this.state = state;
    if (event) this.noteThroughput(event);
  }

  /**
   * Estimate live tokens/sec from stream deltas so the status bar can show
   * `120k / 60t` while the model is generating.
   */
  private noteThroughput(event: HarnessEvent): void {
    const now = Date.now();

    if (event.type === "phase") {
      if (event.phase === "streaming" || event.phase === "thinking") {
        this.tpsWindow = [];
        this.tpsSampleStartedAt = now;
        this.tpsCurrent = 0;
      } else if (event.phase === "idle" || event.phase === "error") {
        this.tpsSampleStartedAt = 0;
        this.tpsCurrent = 0;
        this.tpsWindow = [];
      }
      return;
    }

    if (event.type === "text.delta" || event.type === "reasoning.delta") {
      const chars = event.delta?.length ?? 0;
      if (chars <= 0) return;
      // ~4 chars per token (common English estimate for live rate)
      const tokens = chars / 4;
      if (!this.tpsSampleStartedAt) this.tpsSampleStartedAt = now;
      this.tpsWindow.push({ t: now, tokens });
      const cutoff = now - 2000;
      while (this.tpsWindow.length && this.tpsWindow[0]!.t < cutoff) {
        this.tpsWindow.shift();
      }
      const first = this.tpsWindow[0];
      const last = this.tpsWindow[this.tpsWindow.length - 1];
      const spanMs = Math.max(200, (last?.t ?? now) - (first?.t ?? now));
      const sum = this.tpsWindow.reduce((a, s) => a + s.tokens, 0);
      this.tpsCurrent = (sum / spanMs) * 1000;
      return;
    }

    if (event.type === "tokens" && event.output > 0 && this.tpsSampleStartedAt) {
      const elapsed = Math.max(0.25, (now - this.tpsSampleStartedAt) / 1000);
      this.tpsCurrent = Math.max(this.tpsCurrent, event.output / elapsed);
    }
  }

  /** Current tokens/sec for the status bar (0 when idle / cold). */
  private getTokensPerSec(): number {
    if (this.tpsCurrent <= 0) return 0;
    const state = this.state;
    if (state && state.phase !== "idle" && state.phase !== "error") {
      const last = this.tpsWindow[this.tpsWindow.length - 1];
      if (last && Date.now() - last.t > 3000) return 0;
      return this.tpsCurrent;
    }
    return 0;
  }

  /**
   * Schedule a paint soon (coalesced). Use for store/stream events.
   * Input handlers should call paint() for immediate feedback.
   */
  requestPaint(): void {
    if (!this.running) return;
    this.paintQueued = true;
    if (this.paintRaf != null) return;
    const elapsed = Date.now() - this.lastPaintMs;
    const wait = Math.max(0, TuiRenderer.PAINT_MIN_MS - elapsed);
    this.paintRaf = setTimeout(() => {
      this.paintRaf = null;
      if (!this.paintQueued) return;
      this.paintQueued = false;
      this.paint();
    }, wait);
  }

  getPromptText(): string {
    return this.prompt.text;
  }

  setTheme(name: string, opts?: { preview?: boolean }): void {
    this.theme = resolveTheme(name);
    this.needsFull = true;
    clearScrollCache();
    if (!opts?.preview) {
      this.themeBeforePreview = null;
    }
    // Update cursor color to match theme accent
    if (this.running) {
      this.stdout.write(ansi.cursorColor(this.theme.accentUser));
    }
    this.paint();
  }

  cycleTheme(): string {
    const idx = THEME_ORDER.indexOf(this.theme.name);
    const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length]!;
    this.setTheme(next);
    return next;
  }

  getThemeName(): string {
    return this.theme.name;
  }

  setFont(name: string, opts?: { preview?: boolean }): void {
    this.font = resolveFont(name);
    this.glyphs = glyphsFor(this.font);
    if (this.font.family && this.running) {
      this.stdout.write(fontChangeSequence(this.font.family));
    }
    this.needsFull = true;
    if (!opts?.preview) {
      /* persisted by caller */
    }
    this.paint();
  }

  getFontName(): string {
    return this.font.name;
  }

  getGlyphs(): GlyphSet {
    return this.glyphs;
  }

  /**
   * Open an OpenCode-style settings picker (modal).
   * If a picker is already open, the current one is stacked so Escape goes back.
   * Pass onPreview for live theme/font preview.
   */
  openPicker(spec: PickerSpec): void {
    this.modal = null;
    // Snapshot theme if this picker previews themes
    if (spec.onPreview && !this.themeBeforePreview) {
      this.themeBeforePreview = this.theme.name;
    }
    // Push current picker so Escape can return to it
    if (this.picker) {
      this.pickerStack.push(this.picker);
    }
    this.picker = createPicker(spec);
    this.completeOpen = false;
    this.prompt.text = "";
    this.prompt.cursor = 0;
    this.refreshComplete();
    this.paint();
  }

  /**
   * Replace the current picker without stacking (top-level entry points).
   * Use when Escape should leave the settings tab entirely, not go "back".
   */
  openPickerRoot(spec: PickerSpec): void {
    this.modal = null;
    this.pickerStack = [];
    if (spec.onPreview) {
      this.themeBeforePreview = this.theme.name;
    }
    this.picker = createPicker(spec);
    this.completeOpen = false;
    this.prompt.text = "";
    this.prompt.cursor = 0;
    this.refreshComplete();
    this.paint();
  }

  /** Pop nested picker, or fully close if at root. */
  pickerBack(): void {
    if (this.pickerStack.length > 0) {
      this.picker = this.pickerStack.pop()!;
      this.paint();
      return;
    }
    this.closePicker();
  }

  closePicker(): void {
    if (this.picker || this.pickerStack.length > 0) {
      // Revert live theme preview
      if (this.themeBeforePreview) {
        this.setTheme(this.themeBeforePreview);
        this.themeBeforePreview = null;
      }
      // Only cancel the top-level entry (deepest child's cancel is skip)
      const root = this.pickerStack[0] ?? this.picker;
      root?.spec.onCancel?.();
    }
    this.picker = null;
    this.pickerStack = [];
    this.paint();
  }

  /** Open a modal text field (API keys, device codes). */
  openModalInput(spec: ModalInputSpec): void {
    this.picker = null;
    this.modal = createModalInput(spec);
    this.completeOpen = false;
    this.paint();
  }

  closeModal(): void {
    if (this.modal) {
      this.modal.spec.onCancel?.();
    }
    this.modal = null;
    this.paint();
  }

  setModalError(msg: string): void {
    if (this.modal) {
      this.modal.error = msg;
      this.paint();
    }
  }

  /** Force-close modal without onCancel (after successful submit). */
  dismissModal(): void {
    this.modal = null;
    this.paint();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Index workspace for @-file complete (async-ish: rebuild then paint)
    try {
      this.paths.rebuild();
    } catch {
      /* empty index */
    }

    if (this.stdin.isTTY) {
      this.wasRaw = this.stdin.isRaw ?? false;
      this.stdin.setRawMode(true);
      this.stdin.resume();
      this.stdin.setEncoding("utf8");
    }

    this.stdout.write(
      ansi.altScreenOn +
        ansi.hideCursor +
        ansi.clear +
        `${CSI}?2004h` +
        ansi.mouseOn +
        ansi.cursorColor(this.theme.accentUser) +
        (this.font.family ? fontChangeSequence(this.font.family) : ""),
    );

    this.onData = (buf: Buffer) => {
      const text = buf.toString("utf8");
      for (const ev of decodeInput(text)) {
        this.handleKey(ev);
      }
    };
    this.stdin.on("data", this.onData);

    this.onResize = () => {
      const { cols, rows } = this.size();
      this.buf.resize(cols, rows, this.theme.bg);
      this.needsFull = true;
      this.paint();
    };
    process.stdout.on("resize", this.onResize);

    this.timer = setInterval(() => {
      this.tick++;
      if (!this.state) return;
      // Spinner / glow / streaming caret — coalesced so we never double-paint
      // with store events in the same frame budget
      if (
        this.state.phase !== "idle" ||
        this.hasStreaming() ||
        this.hasReasoningModeGlow() ||
        this.copyFlash
      ) {
        this.requestPaint();
      }
    }, 50);

    this.refreshComplete();
    this.paint();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.paintRaf) clearTimeout(this.paintRaf);
    this.paintRaf = null;

    if (this.onData) this.stdin.off("data", this.onData);
    if (this.onResize) process.stdout.off("resize", this.onResize);

    this.stdout.write(
      `${CSI}?2004l` +
        ansi.mouseOff +
        ansi.cursorColorReset +
        ansi.showCursor +
        ansi.altScreenOff,
    );

    if (this.stdin.isTTY) {
      this.stdin.setRawMode(this.wasRaw);
    }
  }

  private size(): { cols: number; rows: number } {
    const out = this.stdout ?? process.stdout;
    return {
      cols: out?.columns || 80,
      rows: out?.rows || 24,
    };
  }

  private hasStreaming(): boolean {
    if (!this.state) return false;
    for (const m of this.state.messages) {
      for (const p of m.parts) {
        if ((p.type === "text" || p.type === "reasoning") && p.streaming) {
          return true;
        }
        if (p.type === "tool" && p.status === "running") return true;
      }
    }
    return false;
  }

  /** True when bottom-right reasoning-mode label should animate. */
  private hasReasoningModeGlow(): boolean {
    if (!this.state) return false;
    return reasoningModeDisplay(this.state) != null;
  }

  private refreshComplete(): void {
    this.completeResult = complete({
      text: this.prompt.text,
      cursor: this.prompt.cursor,
      state: this.state,
      paths: this.paths,
      history: this.history,
    });
    this.completeSelected = clampSelected(
      this.completeSelected,
      this.completeResult.items.length,
    );
    // Only / commands, / params, and @ files
    const r = this.completeResult;
    this.completeOpen =
      !this.picker &&
      !this.modal &&
      this.focus === "prompt" &&
      r.items.length > 0 &&
      (r.mode === "command" || r.mode === "param" || r.mode === "file");
  }

  private acceptComplete(index?: number): boolean {
    if (!this.completeOpen || this.completeResult.items.length === 0) {
      return false;
    }
    const i = index ?? this.completeSelected;
    const item = this.completeResult.items[i];
    if (!item) return false;
    const next = applySuggestion(
      this.prompt.text,
      this.prompt.cursor,
      this.completeResult,
      item,
    );
    this.prompt.text = next.text;
    this.prompt.cursor = next.cursor;
    this.refreshComplete();
    // After accepting a slash command with trailing space, keep open if args
    return true;
  }

  private acceptGhost(): boolean {
    const g = this.completeResult.ghost;
    if (!g) return false;
    promptInsert(this.prompt, g);
    this.refreshComplete();
    return true;
  }

  private handleKey(ev: KeyEvent): void {
    if (ev.name === "ctrl+c") {
      this.opts.onQuit?.();
      this.stop();
      process.exit(0);
    }

    // Scroll wheel: ONLY scrolls the transcript line-by-line — never pickers,
    // autocomplete, or prompt-history cycling.
    if (ev.name === "wheelup" || ev.name === "wheeldown") {
      const lines = Math.abs(ev.wheelDelta ?? 3) || 3;
      this.scrollTranscript(ev.name === "wheelup" ? -lines : lines);
      return;
    }

    // Mouse: selection in scrollback (auto-copy plain content, not TUI chrome)
    if (ev.name === "mouse") {
      this.handleMouse(ev);
      return;
    }

    // Modal input (device code / API key) captures all input
    if (this.modal) {
      this.handleModalKey(ev);
      return;
    }

    // Settings picker captures all input while open
    if (this.picker) {
      this.handlePickerKey(ev);
      return;
    }

    if (ev.name === "ctrl+l") {
      this.needsFull = true;
      this.paint();
      return;
    }

    if (ev.name === "ctrl+t") {
      this.opts.onCommand?.("thinking", "");
      return;
    }

    // Tab: complete first, else toggle focus
    if (ev.name === "tab") {
      if (this.focus === "prompt" && this.completeOpen) {
        this.acceptComplete();
        this.paint();
        return;
      }
      if (this.focus === "prompt" && this.completeResult.ghost) {
        this.acceptGhost();
        this.paint();
        return;
      }
      this.focus = this.focus === "prompt" ? "scrollback" : "prompt";
      this.refreshComplete();
      this.paint();
      return;
    }

    if (this.focus === "scrollback") {
      this.handleScrollKey(ev);
      return;
    }

    this.handlePromptKey(ev);
  }

  /**
   * Scroll the conversation transcript by `delta` lines (not by message).
   * Positive = down (newer), negative = up (older history / prior replies).
   * Wheel + Up/Down always use this — never prompt history.
   */
  /**
   * Left-drag in the scrollback pane selects plain message text and
   * auto-copies on release (no header/prompt/status chrome).
   * Pure click (no drag) on a reasoning/tool header toggles collapse.
   */
  private handleMouse(ev: KeyEvent): void {
    // Don't fight pickers/modals
    if (this.picker || this.modal) return;
    if (ev.button !== 0 && !ev.drag) return; // left button only
    const x = (ev.x ?? 1) - 1; // 0-based
    const y = (ev.y ?? 1) - 1;
    const { padX, scrollTop, scrollH, contentWidth } = this.layout;
    const inScroll =
      y >= scrollTop &&
      y < scrollTop + scrollH &&
      x >= padX &&
      x < padX + contentWidth;
    if (!inScroll) {
      if (ev.release && this.selection?.active) {
        this.finishSelectionCopy();
      }
      this.mouseDown = null;
      return;
    }

    const docLine = this.scrollOffset + (y - scrollTop);
    const col = Math.max(0, x - padX);
    const line = Math.max(0, docLine);

    if (!ev.release && !ev.drag) {
      // Press — remember for click vs drag; start soft selection
      this.mouseDown = { docLine: line, col, moved: false };
      this.selection = {
        active: true,
        anchorLine: line,
        anchorCol: col,
        focusLine: line,
        focusCol: col,
      };
      this.following = false;
      this.paint();
      return;
    }

    if (ev.drag && this.selection) {
      if (
        this.mouseDown &&
        (Math.abs(line - this.mouseDown.docLine) > 0 ||
          Math.abs(col - this.mouseDown.col) > 1)
      ) {
        this.mouseDown.moved = true;
      }
      this.selection.focusLine = line;
      this.selection.focusCol = col;
      this.selection.active = true;
      this.paint();
      return;
    }

    if (ev.release) {
      const wasClick =
        this.mouseDown &&
        !this.mouseDown.moved &&
        Math.abs(line - this.mouseDown.docLine) === 0 &&
        Math.abs(col - this.mouseDown.col) <= 1;
      this.mouseDown = null;

      // Pure click on a collapsible header → expand/collapse (OpenCode)
      if (wasClick) {
        const hit = this.lastDocHits[line];
        if (hit?.action === "toggle-collapse") {
          this.selection = null;
          this.opts.onTogglePart?.(hit.messageId, hit.partId);
          this.paint();
          return;
        }
      }

      if (this.selection) {
        this.selection.focusLine = line;
        this.selection.focusCol = col;
        this.finishSelectionCopy();
      }
    }
  }

  private finishSelectionCopy(): void {
    const sel = this.selection;
    if (!sel) return;
    const text = this.selectionPlainText(sel);
    this.selection = {
      ...sel,
      active: false,
    };
    if (text.trim()) {
      copyText(text, this.stdout);
      this.copyFlash = "copied";
      setTimeout(() => {
        if (this.copyFlash === "copied") {
          this.copyFlash = null;
          this.paint();
        }
      }, 1500);
    }
    this.paint();
  }

  private selectionPlainText(sel: {
    anchorLine: number;
    anchorCol: number;
    focusLine: number;
    focusCol: number;
  }): string {
    const lines = this.lastDocPlain;
    if (lines.length === 0) return "";
    let aL = sel.anchorLine;
    let aC = sel.anchorCol;
    let bL = sel.focusLine;
    let bC = sel.focusCol;
    if (aL > bL || (aL === bL && aC > bC)) {
      [aL, bL] = [bL, aL];
      [aC, bC] = [bC, aC];
    }
    aL = Math.max(0, Math.min(aL, lines.length - 1));
    bL = Math.max(0, Math.min(bL, lines.length - 1));
    if (aL === bL) {
      const line = lines[aL] ?? "";
      return line.slice(aC, bC);
    }
    const out: string[] = [];
    out.push((lines[aL] ?? "").slice(aC));
    for (let i = aL + 1; i < bL; i++) out.push(lines[i] ?? "");
    out.push((lines[bL] ?? "").slice(0, bC));
    return out.join("\n");
  }

  private scrollTranscript(delta: number): void {
    if (delta === 0) return;
    const max = Math.max(0, this.lastDocLen - this.lastScrollH);
    // If we have no measured doc yet, force a paint first so lastDocLen is set
    if (this.lastDocLen <= 0 || this.lastScrollH <= 0) {
      this.following = false;
      this.scrollOffset = Math.max(0, this.scrollOffset + delta);
      this.paint();
      return;
    }
    this.following = false;
    this.scrollOffset = Math.max(0, Math.min(max, this.scrollOffset + delta));
    // Re-stick to tail only when the user reaches the true bottom
    if (this.scrollOffset >= max) {
      this.following = true;
    }
    this.paint();
  }

  /** Visible option rows for the current terminal height */
  private pickerViewSize(): number {
    const { rows } = this.size();
    // Use most of the screen for long lists (themes); leave room for
    // header + scrollback strip + prompt + status (~10 rows chrome)
    const budget = Math.max(12, rows - 10);
    return visibleCapacity(budget);
  }

  private handlePickerKey(ev: KeyEvent): void {
    if (!this.picker) return;
    const view = this.pickerViewSize();
    const searching = isSearchable(this.picker);

    switch (ev.name) {
      case "up":
      case "ctrl+p":
        pickerMove(this.picker, -1, view);
        this.paint();
        break;
      case "down":
      case "ctrl+n":
        pickerMove(this.picker, 1, view);
        this.paint();
        break;
      case "left":
        // Switch hovered item value only — never move hover
        pickerCycle(this.picker, -1);
        this.paint();
        break;
      case "right":
        pickerCycle(this.picker, 1);
        this.paint();
        break;
      case "pageup":
        pickerPage(this.picker, -1, view);
        this.paint();
        break;
      case "pagedown":
        pickerPage(this.picker, 1, view);
        this.paint();
        break;
      case "home":
        if (!this.picker.query) {
          pickerGoto(this.picker, 0, view);
          this.paint();
        }
        break;
      case "end":
        if (!this.picker.query) {
          const n = this.picker.spec.options.length;
          pickerGoto(this.picker, n - 1, view);
          this.paint();
        }
        break;
      case "backspace":
        if (this.picker.query) {
          pickerBackspace(this.picker, view);
          this.paint();
        }
        break;
      case "char":
        if (ev.char === " ") {
          // Space: cycle/toggle hovered value (+1) — never type into search, never move hover
          pickerActivate(this.picker);
          this.paint();
        } else if (ev.char === "j" && !searching && !this.picker.query) {
          pickerMove(this.picker, 1, view);
          this.paint();
        } else if (ev.char === "k" && !searching && !this.picker.query) {
          pickerMove(this.picker, -1, view);
          this.paint();
        } else if (ev.char && ev.char >= " ") {
          // Type-to-search (large lists) — space is reserved for toggle above
          if (
            searching ||
            this.picker.query.length > 0 ||
            this.picker.spec.options.length > 12
          ) {
            pickerType(this.picker, ev.char, view);
            this.paint();
          }
        }
        break;
      case "enter": {
        this.themeBeforePreview = null;
        const before = this.picker;
        const shouldClose = pickerAccept(this.picker);
        if (shouldClose) {
          if (this.picker !== before) {
            // onSelect opened a child/root picker — keep it (Esc back uses stack)
          } else {
            // Leaf selection — leave the settings tab entirely
            this.picker = null;
            this.pickerStack = [];
          }
        }
        this.paint();
        break;
      }
      case "escape":
        if (this.picker.query) {
          // First esc clears search; next esc goes back
          this.picker.query = "";
          this.picker.selected = 0;
          this.picker.scroll = 0;
          this.paint();
        } else {
          // Nested tab: back to parent picker; root: dismiss settings
          this.pickerBack();
        }
        break;
      default:
        break;
    }
  }

  private handleModalKey(ev: KeyEvent): void {
    if (!this.modal) return;
    switch (ev.name) {
      case "enter": {
        // Leave modal open so onSubmit can setModalError; success paths call closeModal.
        const val = this.modal.value;
        this.modal.spec.onSubmit(val);
        this.paint();
        break;
      }
      case "escape":
        this.closeModal();
        break;
      case "backspace":
        modalBackspace(this.modal);
        this.paint();
        break;
      case "left":
        modalMove(this.modal, -1);
        this.paint();
        break;
      case "right":
        modalMove(this.modal, 1);
        this.paint();
        break;
      case "home":
      case "ctrl+a":
        this.modal.cursor = 0;
        this.paint();
        break;
      case "end":
      case "ctrl+e":
        this.modal.cursor = this.modal.value.length;
        this.paint();
        break;
      case "paste":
        if (ev.paste) {
          modalInsert(this.modal, ev.paste.replace(/\r?\n/g, ""));
          this.paint();
        }
        break;
      case "char":
        if (ev.char && ev.char >= " ") {
          modalInsert(this.modal, ev.char);
          this.paint();
        }
        break;
      default:
        break;
    }
  }

  private handleScrollKey(ev: KeyEvent): void {
    const page = Math.max(5, this.lastScrollH || Math.floor((this.stdout.rows || 24) / 2));
    switch (ev.name) {
      case "up":
        this.scrollTranscript(-1);
        break;
      case "down":
        this.scrollTranscript(1);
        break;
      case "char":
        if (ev.char === "k") {
          this.scrollTranscript(-1);
        } else if (ev.char === "j") {
          this.scrollTranscript(1);
        } else if (ev.char === "g") {
          this.following = false;
          this.scrollOffset = 0;
          this.paint();
        } else if (ev.char === "G") {
          this.following = true;
          this.paint();
        } else if (ev.char && ev.char.length === 1 && !ev.ctrl) {
          // Letter keys jump back to prompt (type to chat)
          this.focus = "prompt";
          if (ev.char !== " ") promptInsert(this.prompt, ev.char);
          this.refreshComplete();
          this.paint();
        }
        break;
      case "pageup":
        this.scrollTranscript(-page);
        break;
      case "pagedown":
        this.scrollTranscript(page);
        break;
      case "home":
        this.following = false;
        this.scrollOffset = 0;
        this.paint();
        break;
      case "end":
        this.following = true;
        this.paint();
        break;
      case "enter":
      case "escape":
        this.focus = "prompt";
        this.refreshComplete();
        this.paint();
        break;
    }
  }

  private handlePromptKey(ev: KeyEvent): void {
    // Autocomplete tab: up/down move hover; left/right/space switch value (accept item)
    if (this.completeOpen && this.completeResult.items.length > 0) {
      if (ev.name === "up" || ev.name === "ctrl+p") {
        this.completeSelected = clampSelected(
          this.completeSelected - 1,
          this.completeResult.items.length,
        );
        this.paint();
        return;
      }
      if (ev.name === "down" || ev.name === "ctrl+n") {
        this.completeSelected = clampSelected(
          this.completeSelected + 1,
          this.completeResult.items.length,
        );
        this.paint();
        return;
      }
      // Left / right: cycle which item is active (switch value under hover list)
      // — does not leave the tab; updates the filled arg when accepting
      if (ev.name === "left") {
        this.completeSelected = clampSelected(
          this.completeSelected - 1,
          this.completeResult.items.length,
        );
        this.acceptComplete();
        // keep complete open for further cycling
        this.completeOpen = true;
        this.refreshComplete();
        this.paint();
        return;
      }
      if (ev.name === "right") {
        this.completeSelected = clampSelected(
          this.completeSelected + 1,
          this.completeResult.items.length,
        );
        this.acceptComplete();
        this.completeOpen = true;
        this.refreshComplete();
        this.paint();
        return;
      }
      // Space: apply hovered value into the prompt (toggle/set value)
      if (ev.name === "char" && ev.char === " ") {
        this.acceptComplete();
        this.completeOpen = true;
        this.refreshComplete();
        this.paint();
        return;
      }
      if (ev.name === "escape") {
        this.completeOpen = false;
        this.completeResult = {
          ...this.completeResult,
          items: [],
          ghost: "",
          mode: "none",
        };
        this.paint();
        return;
      }
    }

    // Right arrow accepts ghost only when complete tab is closed
    if (
      !this.completeOpen &&
      ev.name === "right" &&
      this.prompt.cursor === this.prompt.text.length
    ) {
      if (this.completeResult.ghost) {
        this.acceptGhost();
        this.paint();
        return;
      }
    }

    switch (ev.name) {
      case "enter": {
        // Expand partial command / param from the popup, then run.
        if (this.completeOpen && this.completeResult.items.length > 0) {
          if (this.completeResult.mode === "command") {
            const partial = this.prompt.text.trim().replace(/^\/+/, "");
            const selected = this.completeResult.items[this.completeSelected];
            const name = selected?.label.replace(/^\//, "") ?? "";
            if (
              selected &&
              name &&
              partial !== name &&
              !partial.startsWith(name + " ")
            ) {
              this.acceptComplete();
            }
          } else if (this.completeResult.mode === "param") {
            // Fill selected param value before submit (/thinking o -> /thinking on)
            const selected = this.completeResult.items[this.completeSelected];
            if (selected) {
              const token = this.prompt.text.slice(
                this.completeResult.tokenStart,
                this.completeResult.tokenEnd,
              );
              if (token !== selected.insert) {
                this.acceptComplete();
              }
            }
          }
        }

        const text = promptSubmit(this.prompt);
        if (text == null) return;
        this.history.push(text);
        this.completeOpen = false;

        const slash = parseSlashInput(text);
        if (slash) {
          const cmd = resolveSlashCommand(slash.cmd);
          if (!cmd) {
            this.refreshComplete();
            this.paint();
            break;
          }
          this.opts.onCommand?.(cmd, slash.args);
        } else {
          this.opts.onSubmit?.(text);
        }
        this.following = true;
        this.refreshComplete();
        this.paint();
        break;
      }
      case "backspace":
        promptBackspace(this.prompt);
        this.completeSelected = 0;
        this.refreshComplete();
        this.paint();
        break;
      case "delete":
        promptDelete(this.prompt);
        this.refreshComplete();
        this.paint();
        break;
      case "left":
        promptMove(this.prompt, -1);
        this.refreshComplete();
        this.paint();
        break;
      case "right":
        promptMove(this.prompt, 1);
        this.refreshComplete();
        this.paint();
        break;
      case "home":
      case "ctrl+a":
        this.prompt.cursor = 0;
        this.refreshComplete();
        this.paint();
        break;
      case "end":
      case "ctrl+e":
        this.prompt.cursor = this.prompt.text.length;
        this.refreshComplete();
        this.paint();
        break;
      // Up/Down (/ wheel-as-arrows): scroll the transcript line-by-line so you
      // can read prior model replies. Prompt history is Ctrl+P / Ctrl+N only.
      case "up":
        this.scrollTranscript(-1);
        break;
      case "down":
        this.scrollTranscript(1);
        break;
      case "ctrl+p":
        promptHistory(this.prompt, -1);
        this.refreshComplete();
        this.paint();
        break;
      case "ctrl+n":
        promptHistory(this.prompt, 1);
        this.refreshComplete();
        this.paint();
        break;
      case "ctrl+u":
        this.prompt.text = this.prompt.text.slice(this.prompt.cursor);
        this.prompt.cursor = 0;
        this.refreshComplete();
        this.paint();
        break;
      case "ctrl+k":
        this.prompt.text = this.prompt.text.slice(0, this.prompt.cursor);
        this.refreshComplete();
        this.paint();
        break;
      case "paste":
        if (ev.paste) {
          promptInsert(
            this.prompt,
            ev.paste.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
          );
          this.refreshComplete();
          this.paint();
        }
        break;
      case "char":
        if (ev.char) {
          promptInsert(this.prompt, ev.char);
          this.completeSelected = 0;
          this.refreshComplete();
          this.paint();
        }
        break;
      case "pageup": {
        const page = Math.max(5, this.lastScrollH || 10);
        this.scrollTranscript(-page);
        break;
      }
      case "pagedown": {
        const page = Math.max(5, this.lastScrollH || 10);
        this.scrollTranscript(page);
        break;
      }
      case "escape":
        if (this.prompt.text) {
          this.prompt.text = "";
          this.prompt.cursor = 0;
          this.refreshComplete();
          this.paint();
        }
        break;
    }
  }

  paint(): void {
    if (!this.running) return;
    const state = this.state;
    if (!state) return;
    this.lastPaintMs = Date.now();
    this.paintQueued = false;

    const { cols, rows } = this.size();
    if (cols !== this.buf.width || rows !== this.buf.height) {
      this.buf.resize(cols, rows, this.theme.bg);
      this.needsFull = true;
    }

    this.buf.setLevel(this.colorLevel);
    if (this.needsFull) {
      this.buf.clear(this.theme.bg);
    } else {
      this.buf.beginFrame(this.theme.bg);
    }

    const compact = state.compact;
    const padX = compact ? 1 : 2;
    const gutter = 1;
    const contentWidth = Math.max(20, cols - padX * 2 - gutter);

    const headerRows = renderHeader(state, this.theme, contentWidth, compact);
    const headerH = headerRows.length + (compact ? 0 : 1);
    const statusH = 1;
    const dividerH = 1;

    const ghost =
      this.focus === "prompt" ? this.completeResult.ghost : "";

    const promptLayout = layoutPrompt(
      this.prompt,
      this.theme,
      contentWidth,
      this.focus === "prompt",
      { ghost },
    );
    const promptH = promptLayout.height;

    const completeMax = Math.min(
      this.completeResult.items.length,
      Math.max(10, Math.floor(rows / 2)),
    );
    const popup =
      this.completeOpen && !this.picker && !this.modal
        ? layoutPopup(
            this.completeResult,
            this.completeSelected,
            this.theme,
            contentWidth,
            completeMax,
          )
        : { rows: [] as Row[], height: 0 };

    const pickerMaxRows = this.picker ? Math.max(14, rows - 8) : 0;
    const pickerLayout = this.picker
      ? layoutPicker(
          this.picker,
          this.theme,
          contentWidth,
          pickerMaxRows,
          this.pickerStack.length > 0,
        )
      : { rows: [] as Row[], height: 0, viewSize: 0 };

    const modalLayout = this.modal
      ? layoutModalInput(this.modal, this.theme, contentWidth)
      : { rows: [] as Row[], height: 0, cursorCol: 0, cursorRow: 0 };

    const chromeH =
      headerH +
      dividerH +
      promptH +
      statusH +
      popup.height +
      pickerLayout.height +
      modalLayout.height +
      (compact ? 0 : 1);
    const scrollH = Math.max(3, rows - chromeH);

    // Plain text only when selecting (copy) — skip join cost during stream
    const needPlain = Boolean(this.selection) || this.focus === "scrollback";
    const { rows: doc, plain, hits } = buildScrollDocument(
      state,
      this.theme,
      contentWidth,
      this.tick,
      { needPlain },
    );
    this.lastDocLen = doc.length;
    this.lastScrollH = scrollH;
    this.lastDocHits = hits;
    if (needPlain) this.lastDocPlain = plain;

    if (this.following) {
      this.scrollOffset = Math.max(0, doc.length - scrollH);
    } else {
      this.scrollOffset = clampOffset(this.scrollOffset, doc.length, scrollH);
    }
    this.following = isFollowing(this.scrollOffset, doc.length, scrollH);

    let y = 0;

    for (const row of headerRows) {
      this.paintRow(padX, y++, row, contentWidth);
    }
    if (!compact) {
      this.paintRow(
        padX,
        y++,
        renderDivider(this.theme, contentWidth),
        contentWidth,
      );
    }

    const scrollTop = y;
    this.layout = { padX, scrollTop, scrollH, contentWidth };
    const viewEnd = Math.min(doc.length, this.scrollOffset + scrollH);
    for (let i = 0; i < scrollH; i++) {
      const docLine = this.scrollOffset + i;
      const row = docLine < viewEnd ? doc[docLine] : undefined;
      if (row) {
        this.paintRow(padX, y, row, contentWidth, docLine);
      } else {
        this.buf.clearRowRest(0, y);
      }
      y++;
    }

    const sbCol = cols - 1;
    const sb = computeScrollbar(
      {
        top: scrollTop,
        height: scrollH,
        total: doc.length,
        offset: this.scrollOffset,
        col: sbCol,
      },
      this.theme,
      this.focus === "scrollback",
      { thumb: this.glyphs.thumb, track: this.glyphs.track },
    );
    for (const cell of sb) {
      this.buf.put(sbCol, cell.y, cell.ch, cell.style);
    }

    let modalTop = y;
    if (modalLayout.height > 0) {
      modalTop = y;
      for (const row of modalLayout.rows) {
        this.paintRow(padX, y++, row, contentWidth);
      }
    }

    if (pickerLayout.height > 0) {
      for (const row of pickerLayout.rows) {
        this.paintRow(padX, y++, row, contentWidth);
      }
    }

    if (popup.height > 0) {
      for (const row of popup.rows) {
        this.paintRow(padX, y++, row, contentWidth);
      }
    }

    this.paintRow(
      padX,
      y++,
      renderDivider(this.theme, contentWidth),
      contentWidth,
    );

    const promptTop = y;
    for (const row of promptLayout.rows) {
      this.paintRow(padX, y++, row, contentWidth);
    }

    const sp = scrollPercent(this.scrollOffset, doc.length, scrollH);
    const statusState =
      this.copyFlash && state.phase === "idle"
        ? { ...state, activityLabel: this.copyFlash }
        : state;
    this.paintRow(
      padX,
      rows - 1,
      renderStatus(statusState, this.theme, contentWidth, this.tick, this.focus, {
        scroll: sp,
        completeOpen: this.completeOpen && !this.picker && !this.modal,
        pickerOpen: Boolean(this.picker || this.modal),
        tokensPerSec: this.getTokensPerSec(),
      }),
      contentWidth,
    );

    let cursorY = promptTop + promptLayout.cursorRow;
    let cursorX = padX + promptLayout.cursorCol;
    if (this.modal) {
      cursorY = modalTop + modalLayout.cursorRow;
      cursorX = padX + Math.min(modalLayout.cursorCol, contentWidth - 1);
    }

    const showCursor =
      (this.focus === "prompt" && !this.picker) || Boolean(this.modal);
    const payload =
      (this.needsFull ? this.buf.flushFull() : this.buf.flushDiff()) +
      (showCursor
        ? ansi.showCursor + ansi.move(cursorY + 1, cursorX + 1)
        : ansi.hideCursor);

    this.needsFull = false;
    this.stdout.write(payload);
  }

  private paintRow(
    x: number,
    y: number,
    row: Row,
    maxWidth: number,
    docLine?: number,
  ): void {
    let col = x;
    const end = x + maxWidth;
    let textCol = 0;
    const bg = this.theme.bg;
    const selecting =
      docLine !== undefined &&
      this.selection &&
      this.lineInSelection(docLine);

    for (const seg of row.segments) {
      if (col >= end) break;
      // Reuse segment style object when bg already set
      const style =
        seg.style.bg !== undefined
          ? seg.style
          : ({ ...seg.style, bg } as typeof seg.style);

      if (selecting) {
        for (const ch of [...seg.text]) {
          if (col >= end) break;
          const selected = this.cellSelected(docLine!, textCol);
          const w = this.buf.write(col, y, ch, {
            ...style,
            bg: selected ? this.theme.selection : style.bg,
            inverse: selected ? true : style.inverse,
          });
          col += w;
          textCol += w > 0 ? 1 : 0;
        }
      } else {
        const written = this.buf.write(col, y, seg.text, style);
        col += written;
        // Approximate textCol without spreading full string (only for selection)
        textCol += written > 0 ? seg.text.length : 0;
        if (written === 0 && seg.text) break;
      }
    }
    // Erase stale glyphs past end of content on this row
    if (col < end) {
      this.buf.clearRowRest(col, y);
    } else {
      this.buf.markRow(y);
    }
  }

  private lineInSelection(docLine: number): boolean {
    const sel = this.selection;
    if (!sel) return false;
    const lo = Math.min(sel.anchorLine, sel.focusLine);
    const hi = Math.max(sel.anchorLine, sel.focusLine);
    return docLine >= lo && docLine <= hi;
  }

  private cellSelected(docLine: number, col: number): boolean {
    const sel = this.selection;
    if (!sel) return false;
    let aL = sel.anchorLine;
    let aC = sel.anchorCol;
    let bL = sel.focusLine;
    let bC = sel.focusCol;
    if (aL > bL || (aL === bL && aC > bC)) {
      [aL, bL] = [bL, aL];
      [aC, bC] = [bC, aC];
    }
    if (docLine < aL || docLine > bL) return false;
    if (aL === bL) return col >= aC && col < bC;
    if (docLine === aL) return col >= aC;
    if (docLine === bL) return col < bC;
    return true;
  }
}
