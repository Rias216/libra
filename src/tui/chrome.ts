/**
 * Header + status bar chrome.
 * Top-right: plain main / peer models (no rainbow badges).
 * Bottom-right: theme-accent glow for Ultra / Ultra + Fusion when active.
 */

import type { HarnessState } from "../core/types.js";
import { stringWidth } from "./ansi.js";
import type { Rgb, Theme } from "./theme.js";
import type { Row } from "./components/parts.js";
import { spinnerFrame } from "./components/parts.js";
import { loadAgentSettings } from "../agent/config.js";
import { parseModelKey } from "../auth/models.js";



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
      ? animatedGlowSegments(modeLabel, tick, theme)
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

/**
 * Seamless soft sheen across Ultra / Ultra + Fusion.
 *
 * Traveling cosine lobe over theme accent colors — continuous gradients
 * between neighboring characters, mild bright tip (not pure white).
 * ~0.9s per loop at 30fps for a 14-char label.
 */
const GLOW_SPEED = 0.39; // chars / tick (~25% slower than 0.52)
const GLOW_HALF = 2.6; // half-width of the soft lobe (chars)

function animatedGlowSegments(
  label: string,
  tick: number,
  theme: Theme,
): Row["segments"] {
  const chars = [...label];
  const n = chars.length;
  if (n === 0) return [];

  const { dim, peak } = ultraGlowPalette(theme);
  const head = ((tick * GLOW_SPEED) % n + n) % n;
  const segs: Row["segments"] = [];

  for (let i = 0; i < n; i++) {
    // Wrapped distance → seamless loop
    let d = Math.abs(i - head);
    d = Math.min(d, n - d);

    // Cosine lobe: C1-smooth 1→0 with continuous slope at the edges
    let intensity = 0;
    if (d < GLOW_HALF) {
      intensity = 0.5 * (1 + Math.cos((d / GLOW_HALF) * Math.PI));
    }

    // Single continuous ramp dim → bright peak (no hard white layer)
    const fg = lerpRgb(dim, peak, intensity);

    segs.push({
      text: chars[i]!,
      style: { fg, bold: intensity > 0.78 },
    });
  }
  return segs;
}

/** Theme-based dim + peak (accent lifted lightly toward white). */
function ultraGlowPalette(theme: Theme): { dim: Rgb; peak: Rgb } {
  const base = theme.thinking ?? theme.accent;
  const dim = lerpRgb(theme.fgFaint, base, 0.55);
  // Peak: brighter accent, only a light lift toward white (~30%)
  const peak = lerpRgb(theme.accent, { r: 255, g: 255, b: 255 }, 0.3);
  return { dim, peak };
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
