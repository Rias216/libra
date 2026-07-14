/**
 * Header + status bar chrome.
 * Top-right: plain main / peer models (no rainbow badges).
 * Bottom-right: purple glow ULTRACODE + FUSION when active.
 */

import type { HarnessState } from "../core/types.js";
import { stringWidth } from "./ansi.js";
import type { Rgb, Theme } from "./theme.js";
import type { Row } from "./components/parts.js";
import { spinnerFrame } from "./components/parts.js";
import { loadAgentSettings } from "../agent/config.js";
import { parseModelKey } from "../auth/models.js";

/** Signature purple glow (bright peak + dim base) */
const ULTRA_PURPLE: Rgb = { r: 216, g: 180, b: 254 };
const ULTRA_DIM: Rgb = { r: 88, g: 56, b: 140 };

export function renderHeader(
  state: HarnessState,
  theme: Theme,
  width: number,
  compact: boolean,
): Row[] {
  const modelsRight = formatMainPeerModels(state);

  if (compact) {
    const left = `* libra`;
    const gap = Math.max(1, width - stringWidth(left) - stringWidth(modelsRight));
    return [
      {
        segments: [
          { text: left, style: { fg: theme.accent, bold: true } },
          { text: " ".repeat(gap), style: {} },
          {
            text: modelsRight.slice(0, Math.max(0, width - stringWidth(left) - 1)),
            style: { fg: theme.fgFaint },
          },
        ],
      },
    ];
  }

  const title = state.session.title;
  const left = `* libra`;
  const mid = `  ${title}`;
  const leftW = stringWidth(left);
  const rightW = stringWidth(modelsRight);
  const midBudget = Math.max(0, width - leftW - rightW - 1);
  const midShown = mid.slice(0, midBudget);
  const gap = Math.max(
    1,
    width - leftW - stringWidth(midShown) - rightW,
  );

  return [
    {
      segments: [
        { text: left, style: { fg: theme.accent, bold: true } },
        { text: midShown, style: { fg: theme.fgMuted } },
        { text: " ".repeat(gap), style: {} },
        {
          text: modelsRight.slice(0, width),
          style: { fg: theme.fgFaint },
        },
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

/**
 * Top-right plain models: `xai/grok-4.5 / tencent/hy3:free`
 * No effort/mode rainbow text.
 */
function formatMainPeerModels(state: HarnessState): string {
  const main = formatModelLabel(
    state.session.provider,
    state.session.model,
  );
  try {
    const cfg = loadAgentSettings();
    if (cfg.reasoning.custom === "ultra-fusion") {
      const peerKey = cfg.reasoning.fusion.modelKeys[0];
      if (peerKey) {
        const ref = parseModelKey(peerKey);
        const peer = ref
          ? formatModelLabel(ref.provider, ref.model)
          : peerKey;
        return `${main} / ${peer}`;
      }
      return `${main} / peer:auto`;
    }
  } catch {
    /* ignore */
  }
  return main;
}

/** xai + grok-4.5 → xai/grok-4.5 ; openrouter + tencent/hy3 → tencent/hy3 */
function formatModelLabel(provider: string, model: string): string {
  if (!model || model === "unset" || model === "none") return "—";
  // Model id already namespaced (OpenRouter style)
  if (model.includes("/")) return truncate(model, 36);
  return truncate(`${provider}/${model}`, 36);
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
    phaseText = state.activityLabel?.trim() || "ready";
    phaseStyle = {
      fg: state.activityLabel?.trim() ? theme.accent : theme.success,
    };
  } else if (phase === "error") {
    phaseText = state.activityLabel ?? "error";
    phaseStyle = { fg: theme.error };
  } else {
    phaseText = `${spinnerFrame(tick)} ${state.activityLabel ?? phase}`;
    phaseStyle = { fg: theme.spinner };
  }

  const modeLabel = ultraModeLabel();
  const tokens = `${state.tokens.input + state.tokens.output} tok`;
  const focusHint = focus === "prompt" ? "PROMPT" : "SCROLL";
  const scroll = extra?.scroll ? `  |  ${extra.scroll}` : "";
  const keys = extra?.pickerOpen
    ? "up/down  enter  esc"
    : extra?.completeOpen
      ? "up/down  tab  enter  esc"
      : focus === "prompt"
        ? "wheel scroll  enter send  drag=copy"
        : "wheel scroll  tab prompt";

  const left = phaseText;
  const mid = `  ${tokens}  |  ${focusHint}${scroll}`;
  const segs: Row["segments"] = [
    { text: left, style: phaseStyle },
    { text: mid, style: { fg: theme.fgFaint } },
  ];

  const used = stringWidth(left + mid);
  const room = width - used - 1;
  if (room > 8) {
    const glowSegs = modeLabel
      ? animatedGlowSegments(modeLabel, tick)
      : [];
    const glowW = modeLabel ? stringWidth(modeLabel) + 2 : 0;
    const keysRoom = Math.max(0, room - glowW);
    const keysShown = keys.slice(0, keysRoom);
    const pad = Math.max(
      1,
      room - glowW - stringWidth(keysShown),
    );
    segs.push({ text: " ".repeat(Math.min(pad, room)), style: {} });
    segs.push(...glowSegs);
    if (modeLabel) {
      segs.push({ text: "  ", style: {} });
    }
    if (keysShown) {
      segs.push({
        text: keysShown,
        style: { fg: theme.fgFaint },
      });
    }
  }

  return { segments: segs };
}

/**
 * Bottom-right label — plain "Ultra + Fusion" / "Ultra" (no model suffix).
 */
function ultraModeLabel(): string {
  try {
    const custom = loadAgentSettings().reasoning.custom;
    if (custom === "ultra-fusion") return "Ultra + Fusion";
    if (custom === "ultra") return "Ultra";
  } catch {
    /* ignore */
  }
  return "";
}

/** Purple sweep glow left → right across the label. */
function animatedGlowSegments(
  label: string,
  tick: number,
): Row["segments"] {
  const chars = [...label];
  const n = chars.length;
  if (n === 0) return [];

  // Highlight window slides L→R; period ~1.2s at 30fps
  const period = Math.max(n + 6, 18);
  const head = tick % period;
  const segs: Row["segments"] = [];

  for (let i = 0; i < n; i++) {
    const dist = head - i;
    // Peak at head, soft trail behind (left of head as it moves right)
    let t = 0;
    if (dist >= 0 && dist <= 4) {
      t = 1 - dist / 5;
    } else if (dist < 0 && dist >= -1) {
      t = 0.35; // slight lead glow
    }
    const fg = lerpRgb(ULTRA_DIM, ULTRA_PURPLE, t * t);
    const bold = t > 0.45;
    segs.push({
      text: chars[i]!,
      style: { fg, bold },
    });
  }
  return segs;
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const u = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
  };
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
