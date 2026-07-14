/**
 * Header + status bar chrome — Grok footer vibes, OpenCode session meta.
 */

import type { HarnessState } from "../core/types.js";
import { stringWidth } from "./ansi.js";
import type { Theme } from "./theme.js";
import type { Row } from "./components/parts.js";
import { spinnerFrame } from "./components/parts.js";

export function renderHeader(
  state: HarnessState,
  theme: Theme,
  width: number,
  compact: boolean,
): Row[] {
  if (compact) {
    return [
      {
        segments: [
          { text: "* libra", style: { fg: theme.accent, bold: true } },
          {
            text: `  ${state.session.model}`,
            style: { fg: theme.fgMuted },
          },
          {
            text: padLeft(shortPath(state.session.cwd, 28), width - 20 - stringWidth(state.session.model)),
            style: { fg: theme.fgFaint },
          },
        ],
      },
    ];
  }

  const title = state.session.title;
  const left = `* libra`;
  const mid = `  ${title}`;
  const right = `${state.session.provider}/${state.session.model}`;
  const leftW = stringWidth(left + mid);
  const rightW = stringWidth(right);
  const gap = Math.max(1, width - leftW - rightW);

  return [
    {
      segments: [
        { text: left, style: { fg: theme.accent, bold: true } },
        { text: mid.slice(0, Math.max(0, width - rightW - stringWidth(left) - 1)), style: { fg: theme.fgMuted } },
        { text: " ".repeat(Math.max(0, gap - Math.max(0, stringWidth(mid) - Math.max(0, width - rightW - stringWidth(left) - 1)))), style: {} },
        { text: right.slice(0, width), style: { fg: theme.fgFaint } },
      ],
    },
    {
      segments: [
        {
          text: shortPath(state.session.cwd, width),
          style: { fg: theme.fgFaint },
        },
      ],
    },
  ];
}

export function renderStatus(
  state: HarnessState,
  theme: Theme,
  width: number,
  tick: number,
  focus: "prompt" | "scrollback",
  extra?: { scroll?: string; completeOpen?: boolean; pickerOpen?: boolean },
): Row {
  const phase = state.phase;
  let phaseText: string;
  let phaseStyle = { fg: theme.fgMuted };

  if (phase === "idle") {
    phaseText = "ready";
    phaseStyle = { fg: theme.success };
  } else if (phase === "error") {
    phaseText = state.activityLabel ?? "error";
    phaseStyle = { fg: theme.error };
  } else {
    phaseText = `${spinnerFrame(tick)} ${state.activityLabel ?? phase}`;
    phaseStyle = { fg: theme.spinner };
  }

  const tokens = `${state.tokens.input + state.tokens.output} tok`;
  const focusHint = focus === "prompt" ? "PROMPT" : "SCROLL";
  const scroll = extra?.scroll ? `  |  ${extra.scroll}` : "";
  const keys = extra?.pickerOpen
    ? "up/down move  space/left/right value  type=search  enter  esc"
    : extra?.completeOpen
      ? "up/down move  space toggle  tab fill  enter  esc"
      : focus === "prompt"
        ? "wheel/up-down scroll  ctrl+p hist  enter send"
        : "wheel/j/k scroll  tab prompt  g/G top/bot";

  const left = phaseText;
  const mid = `  ${tokens}  |  ${focusHint}${scroll}`;
  const right = keys;

  // Assemble with truncation
  const segs: Row["segments"] = [
    { text: left, style: phaseStyle },
    { text: mid, style: { fg: theme.fgFaint } },
  ];
  const used = stringWidth(left + mid);
  const room = width - used - 1;
  if (room > 8) {
    const pad = Math.max(1, room - stringWidth(right));
    segs.push({ text: " ".repeat(pad), style: {} });
    segs.push({
      text: right.slice(0, room),
      style: { fg: theme.fgFaint },
    });
  }

  return { segments: segs };
}

export function renderDivider(theme: Theme, width: number): Row {
  return {
    segments: [
      {
        text: "-".repeat(Math.max(0, width)),
        style: { fg: theme.border },
      },
    ],
  };
}

function shortPath(p: string, max: number): string {
  const normalized = p.replace(/\\/g, "/");
  if (stringWidth(normalized) <= max) return normalized;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return truncate(normalized, max);
  return truncate(".../" + parts.slice(-2).join("/"), max);
}

function truncate(s: string, max: number): string {
  if (stringWidth(s) <= max) return s;
  if (max <= 3) return s.slice(0, max);
  let w = 0;
  let i = 0;
  const budget = max - 3;
  while (i < s.length) {
    const code = s.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const cw = stringWidth(ch);
    if (w + cw > budget) break;
    w += cw;
    i += code > 0xffff ? 2 : 1;
  }
  return s.slice(0, i) + "...";
}

function padLeft(s: string, width: number): string {
  const w = stringWidth(s);
  if (w >= width) return s;
  return " ".repeat(width - w) + s;
}
