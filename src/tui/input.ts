/**
 * Raw terminal input decoder — keys, paste, mouse wheel, resize.
 *
 * Scroll wheel is decoded as wheelup/wheeldown only (never as arrow keys),
 * so it can be routed exclusively to transcript scrolling.
 */

export type KeyName =
  | "enter"
  | "escape"
  | "tab"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "ctrl+c"
  | "ctrl+d"
  | "ctrl+l"
  | "ctrl+t"
  | "ctrl+u"
  | "ctrl+k"
  | "ctrl+a"
  | "ctrl+e"
  | "ctrl+n"
  | "ctrl+p"
  | "shift+tab"
  | "char"
  | "paste"
  | "wheelup"
  | "wheeldown"
  | "mouse"
  | "unknown";

export interface KeyEvent {
  name: KeyName;
  char?: string;
  paste?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  /** Wheel lines (positive = down) */
  wheelDelta?: number;
  /** Mouse: button (0=left, 1=middle, 2=right), 1-based cell coords */
  button?: number;
  x?: number;
  y?: number;
  /** true on button release (SGR trailing `m`) */
  release?: boolean;
  /** motion/drag with button held */
  drag?: boolean;
  raw: string;
}

export function decodeInput(data: string): KeyEvent[] {
  const events: KeyEvent[] = [];
  let i = 0;

  while (i < data.length) {
    const ch = data[i]!;

    // CSI / SS3 sequences
    if (ch === "\x1b") {
      // bracketed paste
      if (data.startsWith("\x1b[200~", i)) {
        const end = data.indexOf("\x1b[201~", i + 6);
        if (end !== -1) {
          const paste = data.slice(i + 6, end);
          events.push({ name: "paste", paste, raw: data.slice(i, end + 6) });
          i = end + 6;
          continue;
        }
      }

      // ESC alone / alt
      if (i === data.length - 1) {
        events.push({ name: "escape", raw: "\x1b" });
        i++;
        continue;
      }

      const rest = data.slice(i);
      const seq = matchEscape(rest);
      if (seq) {
        events.push(seq.event);
        i += seq.len;
        continue;
      }

      // alt+key
      events.push({
        name: "char",
        char: data[i + 1],
        meta: true,
        raw: data.slice(i, i + 2),
      });
      i += 2;
      continue;
    }

    // Ctrl keys
    if (ch < " " || ch === "\x7f") {
      const ctrl = decodeCtrl(ch);
      if (ctrl) {
        events.push(ctrl);
        i++;
        continue;
      }
    }

    // UTF-8 / printable
    const code = data.codePointAt(i)!;
    const glyph = String.fromCodePoint(code);
    const step = code > 0xffff ? 2 : 1;
    events.push({ name: "char", char: glyph, raw: glyph });
    i += step;
  }

  return events;
}

function decodeCtrl(ch: string): KeyEvent | null {
  const code = ch.charCodeAt(0);
  if (ch === "\r" || ch === "\n") return { name: "enter", raw: ch };
  if (ch === "\t") return { name: "tab", raw: ch };
  if (ch === "\x7f" || ch === "\b") return { name: "backspace", raw: ch };
  if (code === 3) return { name: "ctrl+c", ctrl: true, raw: ch };
  if (code === 4) return { name: "ctrl+d", ctrl: true, raw: ch };
  if (code === 12) return { name: "ctrl+l", ctrl: true, raw: ch };
  if (code === 20) return { name: "ctrl+t", ctrl: true, raw: ch };
  if (code === 21) return { name: "ctrl+u", ctrl: true, raw: ch };
  if (code === 11) return { name: "ctrl+k", ctrl: true, raw: ch };
  if (code === 1) return { name: "ctrl+a", ctrl: true, raw: ch };
  if (code === 5) return { name: "ctrl+e", ctrl: true, raw: ch };
  if (code === 14) return { name: "ctrl+n", ctrl: true, raw: ch };
  if (code === 16) return { name: "ctrl+p", ctrl: true, raw: ch };
  return null;
}

function matchEscape(
  rest: string,
): { event: KeyEvent; len: number } | null {
  // --- Mouse: SGR extended  ESC [ < Cb ; Cx ; Cy M/m ---
  // Must be checked before generic CSI (the '<' breaks numeric param parse).
  const sgr = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (sgr) {
    const btn = Number(sgr[1]);
    const x = Number(sgr[2]);
    const y = Number(sgr[3]);
    const release = sgr[4] === "m";
    const raw = sgr[0]!;
    const len = raw.length;
    // Modifiers: +4 shift, +8 meta, +16 ctrl — strip for core button
    const mods = btn & 0x1c;
    const core = btn & ~0x1c;
    // Wheel: 64 = up, 65 = down (sometimes 66/67)
    if (core === 64 || core === 65 || core === 66 || core === 67) {
      const down = core === 65 || core === 67;
      return {
        event: {
          name: down ? "wheeldown" : "wheelup",
          wheelDelta: down ? 3 : -3,
          x,
          y,
          raw,
        },
        len,
      };
    }
    // 32 = motion with button held (drag), 35 = motion no button
    const drag = core >= 32;
    const button = drag ? core - 32 : core;
    return {
      event: {
        name: "mouse",
        button,
        x,
        y,
        release,
        drag,
        shift: Boolean(mods & 4),
        raw,
      },
      len,
    };
  }

  // --- Mouse: X10  ESC [ M Cb Cx Cy  (3 bytes after M) ---
  if (rest.startsWith("\x1b[M") && rest.length >= 6) {
    const cb = rest.charCodeAt(3) - 32;
    const raw = rest.slice(0, 6);
    // wheel: button 64/65 encoded as cb with bit 6 set
    if (cb === 64 || cb === 96 || cb === 80) {
      // 64 = wheel up; some terms use 96
      return {
        event: { name: "wheelup", wheelDelta: -3, raw },
        len: 6,
      };
    }
    if (cb === 65 || cb === 97 || cb === 81) {
      return {
        event: { name: "wheeldown", wheelDelta: 3, raw },
        len: 6,
      };
    }
    return { event: { name: "mouse", raw }, len: 6 };
  }

  // SS3: ESC O A/B/C/D
  if (rest.startsWith("\x1bOA"))
    return { event: { name: "up", raw: rest.slice(0, 3) }, len: 3 };
  if (rest.startsWith("\x1bOB"))
    return { event: { name: "down", raw: rest.slice(0, 3) }, len: 3 };
  if (rest.startsWith("\x1bOC"))
    return { event: { name: "right", raw: rest.slice(0, 3) }, len: 3 };
  if (rest.startsWith("\x1bOD"))
    return { event: { name: "left", raw: rest.slice(0, 3) }, len: 3 };
  if (rest.startsWith("\x1bOH"))
    return { event: { name: "home", raw: rest.slice(0, 3) }, len: 3 };
  if (rest.startsWith("\x1bOF"))
    return { event: { name: "end", raw: rest.slice(0, 3) }, len: 3 };

  // CSI sequences ESC [ ...
  // Exclude SGR mouse which starts with [
  const m = rest.match(/^\x1b\[([0-9;]*)([A-Za-z~])/);
  if (!m) {
    if (rest.startsWith("\x1b[")) {
      return null;
    }
    return null;
  }

  const params = m[1]!;
  const final = m[2]!;
  const raw = m[0]!;
  const len = raw.length;
  const parts = params.split(";").filter(Boolean).map(Number);
  const mod =
    parts.length >= 2 ? parts[1]! : parts.length === 1 && final !== "~" ? 0 : 0;

  const shift = mod === 2 || mod === 4 || mod === 6 || mod === 8;

  switch (final) {
    case "A":
      return { event: { name: "up", shift, raw }, len };
    case "B":
      return { event: { name: "down", shift, raw }, len };
    case "C":
      return { event: { name: "right", shift, raw }, len };
    case "D":
      return { event: { name: "left", shift, raw }, len };
    case "H":
      return { event: { name: "home", raw }, len };
    case "F":
      return { event: { name: "end", raw }, len };
    case "Z":
      return { event: { name: "shift+tab", shift: true, raw }, len };
    case "~": {
      const n = parts[0] ?? 0;
      if (n === 1 || n === 7) return { event: { name: "home", raw }, len };
      if (n === 4 || n === 8) return { event: { name: "end", raw }, len };
      if (n === 3) return { event: { name: "delete", raw }, len };
      if (n === 5) return { event: { name: "pageup", raw }, len };
      if (n === 6) return { event: { name: "pagedown", raw }, len };
      return { event: { name: "unknown", raw }, len };
    }
    default:
      return { event: { name: "unknown", raw }, len };
  }
}
