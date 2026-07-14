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
  buildScrollRows,
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
import { renderDivider, renderHeader, renderStatus } from "./chrome.js";
import { computeScrollbar, scrollPercent } from "./scrollbar.js";
import { decodeInput, type KeyEvent } from "./input.js";
import type { Row } from "./components/parts.js";
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

export interface RendererOptions {
  theme?: string;
  font?: string;
  cwd?: string;
  onSubmit?: (text: string) => void;
  onCommand?: (cmd: string, args: string) => void;
  onQuit?: () => void;
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
  private modal: ModalInputState | null = null;
  private font: FontProfile;
  private glyphs: GlyphSet;
  /** Theme name to restore if picker cancelled after live preview */
  private themeBeforePreview: string | null = null;
  private lastDocLen = 0;
  private lastScrollH = 0;

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

  setState(state: HarnessState, _event?: HarnessEvent): void {
    this.state = state;
  }

  getPromptText(): string {
    return this.prompt.text;
  }

  setTheme(name: string, opts?: { preview?: boolean }): void {
    this.theme = resolveTheme(name);
    this.needsFull = true;
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
   * Pass onPreview for live theme/font preview.
   */
  openPicker(spec: PickerSpec): void {
    this.modal = null;
    // Snapshot theme if this picker previews themes
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

  closePicker(): void {
    if (this.picker) {
      // Revert live theme preview
      if (this.themeBeforePreview) {
        this.setTheme(this.themeBeforePreview);
        this.themeBeforePreview = null;
      }
      this.picker.spec.onCancel?.();
    }
    this.picker = null;
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
      if (this.state && (this.state.phase !== "idle" || this.hasStreaming())) {
        this.paint();
      }
    }, 33);

    this.refreshComplete();
    this.paint();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

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

    // Ignore other mouse events (clicks/drags) — keyboard drives the UI
    if (ev.name === "mouse") {
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
        // Change value / toggle — does NOT move selection
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
          // Space: toggle / activate value — stay in the tab
          pickerActivate(this.picker);
          this.paint();
        } else if (ev.char === "j" && !searching && !this.picker.query) {
          pickerMove(this.picker, 1, view);
          this.paint();
        } else if (ev.char === "k" && !searching && !this.picker.query) {
          pickerMove(this.picker, -1, view);
          this.paint();
        } else if (ev.char && ev.char >= " ") {
          // Type-to-search (large lists like OpenRouter models)
          if (searching || this.picker.query.length > 0 || this.picker.spec.options.length > 12) {
            pickerType(this.picker, ev.char, view);
            this.paint();
          }
        }
        break;
      case "enter": {
        this.themeBeforePreview = null;
        const shouldClose = pickerAccept(this.picker);
        if (shouldClose) {
          this.picker = null;
        }
        this.paint();
        break;
      }
      case "escape":
        if (this.picker.query) {
          // First esc clears search; second closes
          this.picker.query = "";
          this.picker.selected = 0;
          this.picker.scroll = 0;
          this.paint();
        } else {
          this.closePicker();
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
    // Complete tab navigation — same hover keys as full pickers
    if (this.completeOpen && this.completeResult.items.length > 0) {
      if (
        ev.name === "up" ||
        ev.name === "left" ||
        ev.name === "ctrl+p"
      ) {
        this.completeSelected = clampSelected(
          this.completeSelected - 1,
          this.completeResult.items.length,
        );
        this.paint();
        return;
      }
      if (
        ev.name === "down" ||
        ev.name === "right" ||
        ev.name === "ctrl+n"
      ) {
        this.completeSelected = clampSelected(
          this.completeSelected + 1,
          this.completeResult.items.length,
        );
        this.paint();
        return;
      }
      // Space: move hover only (do not insert space / leave the tab)
      if (ev.name === "char" && ev.char === " ") {
        this.completeSelected = clampSelected(
          this.completeSelected + 1,
          this.completeResult.items.length,
        );
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

    const { cols, rows } = this.size();
    if (cols !== this.buf.width || rows !== this.buf.height) {
      this.buf.resize(cols, rows, this.theme.bg);
      this.needsFull = true;
    }

    this.buf.setLevel(this.colorLevel);
    this.buf.clear(this.theme.bg);

    const compact = state.compact;
    const padX = compact ? 1 : 2;
    // Reserve 1 col for scrollbar gutter on the right
    const gutter = 1;
    const contentWidth = Math.max(20, cols - padX * 2 - gutter);

    const headerRows = renderHeader(state, this.theme, contentWidth, compact);
    const headerH = headerRows.length + (compact ? 0 : 1);
    const statusH = 1;
    const dividerH = 1;

    const ghost =
      this.focus === "prompt" && !this.completeOpen
        ? this.completeResult.ghost
        : this.focus === "prompt"
          ? this.completeResult.ghost
          : "";

    const promptLayout = layoutPrompt(
      this.prompt,
      this.theme,
      contentWidth,
      this.focus === "prompt",
      { ghost },
    );
    const promptH = promptLayout.height;

    // Same max density as pickers so `/` looks like a real tab, not a thin strip
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

    // Give pickers (especially themes) most of the viewport so the list
    // can show many items; remaining height is a thin scrollback strip.
    const pickerMaxRows = this.picker
      ? Math.max(14, rows - 8)
      : 0;
    const pickerLayout = this.picker
      ? layoutPicker(this.picker, this.theme, contentWidth, pickerMaxRows)
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

    const doc = buildScrollRows(state, this.theme, contentWidth, this.tick);
    this.lastDocLen = doc.length;
    this.lastScrollH = scrollH;

    // Follow tail only when pinned; otherwise keep absolute line offset so
    // scrolling walks the full transcript (user + assistant + tools), not
    // message-to-message jumps.
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
    const view = doc.slice(this.scrollOffset, this.scrollOffset + scrollH);
    for (let i = 0; i < scrollH; i++) {
      const row = view[i];
      if (row) this.paintRow(padX, y, row, contentWidth);
      y++;
    }

    // Scrollbar gutter
    const sbCol = cols - (compact ? 1 : 1);
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

    // Auth / device-code modal
    let modalTop = y;
    if (modalLayout.height > 0) {
      modalTop = y;
      for (const row of modalLayout.rows) {
        this.paintRow(padX, y++, row, contentWidth);
      }
    }

    // Settings picker sits above autocomplete / prompt
    if (pickerLayout.height > 0) {
      for (const row of pickerLayout.rows) {
        this.paintRow(padX, y++, row, contentWidth);
      }
    }

    // Autocomplete popup sits just above the prompt divider
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
    this.paintRow(
      padX,
      rows - 1,
      renderStatus(state, this.theme, contentWidth, this.tick, this.focus, {
        scroll: sp,
        completeOpen: this.completeOpen && !this.picker && !this.modal,
        pickerOpen: Boolean(this.picker || this.modal),
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

  private paintRow(x: number, y: number, row: Row, maxWidth: number): void {
    let col = x;
    const end = x + maxWidth;
    for (const seg of row.segments) {
      if (col >= end) break;
      const written = this.buf.write(col, y, seg.text, {
        ...seg.style,
        bg: seg.style.bg ?? this.theme.bg,
      });
      col += written;
      if (written < (seg.text ? 1 : 0) && seg.text) break;
    }
  }
}
