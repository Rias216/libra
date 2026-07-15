/**
 * Header + status bar chrome.
 * Top-right: plain main / peer models (no rainbow badges).
 * Bottom: phase spinner + context usage bar + reasoning-mode glow.
 */

import type { HarnessState } from "../core/types.js";
import type { ProviderId } from "../auth/types.js";
import { stringWidth } from "./ansi.js";
import type { Rgb, Theme } from "./theme.js";
import type { Row } from "./components/parts.js";
import { spinnerFrame } from "./components/parts.js";
import { loadAgentSettings } from "../agent/config.js";
import { getEffortForModel } from "../agent/reasoning.js";
import { getModelContextWindow, parseModelKey } from "../auth/models.js";
import { DEFAULT_COMPACT_TOKEN_BUDGET } from "../agent/compaction.js";

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
let modelsLabelCache: { key: string; value: string } | null = null;

function formatMainPeerModels(state: HarnessState): string {
  const main = formatModelLabel(
    state.session.provider,
    state.session.model,
  );
  try {
    const cfg = loadAgentSettings();
    const peerKey =
      cfg.reasoning.custom === "ultra-fusion"
        ? (cfg.reasoning.fusion.modelKeys[0] ?? "")
        : "";
    const cacheKey = `${main}|${cfg.reasoning.custom}|${peerKey}`;
    if (modelsLabelCache?.key === cacheKey) return modelsLabelCache.value;

    let value = main;
    if (cfg.reasoning.custom === "ultra-fusion") {
      if (peerKey) {
        const ref = parseModelKey(peerKey);
        const peer = ref
          ? formatModelLabel(ref.provider, ref.model)
          : peerKey;
        value = `${main} / ${peer}`;
      } else {
        value = `${main} / peer:auto`;
      }
    }
    modelsLabelCache = { key: cacheKey, value };
    return value;
  } catch {
    return main;
  }
}

/** xai + grok-4.5 → xai/grok-4.5 ; openrouter + tencent/hy3 → tencent/hy3 */
function formatModelLabel(provider: string, model: string): string {
  if (!model || model === "unset" || model === "none") return "—";
  // Model id already namespaced (OpenRouter style)
  if (model.includes("/")) return truncate(model, 36);
  return truncate(`${provider}/${model}`, 36);
}

/** Fallback context window when the model catalog has no figure. */
export const DEFAULT_CONTEXT_WINDOW = Math.round(
  DEFAULT_COMPACT_TOKEN_BUDGET / 0.8,
);

export function resolveContextUsage(state: HarnessState): {
  used: number;
  limit: number;
  ratio: number;
} {
  const limitRaw = getModelContextWindow(
    state.session.provider,
    state.session.model,
  );
  const limit =
    limitRaw != null && limitRaw > 1024 ? limitRaw : DEFAULT_CONTEXT_WINDOW;
  // Prefer latest request prompt_tokens (true context fill); else session input
  const used = Math.max(
    0,
    state.tokens.lastPrompt ??
      (state.tokens.input > 0 ? state.tokens.input : 0),
  );
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  return { used, limit, ratio };
}

/**
 * Visual context fill bar + counts (OpenCode-style footer).
 * `barWidth` is the number of block cells in the meter.
 */
export function formatContextBar(
  used: number,
  limit: number,
  barWidth = 12,
): { bar: string; label: string; ratio: number; percent: number } {
  const lim = Math.max(1, limit);
  const u = Math.max(0, used);
  const ratio = Math.min(1, u / lim);
  const filled = Math.max(0, Math.min(barWidth, Math.round(ratio * barWidth)));
  const empty = barWidth - filled;
  const bar = `${"█".repeat(filled)}${"░".repeat(empty)}`;
  const percent = Math.round(ratio * 100);
  const label = `${formatCompactCount(u)}/${formatCompactCount(lim)} ${percent}%`;
  return { bar, label, ratio, percent };
}

/**
 * Color for the filled portion of the context meter.
 * Uses only theme semantic tokens so every palette stays coherent
 * (accent → info → warn → error as fill grows).
 */
export function contextBarColor(ratio: number, theme: Theme): Rgb {
  if (ratio >= 0.9) return theme.error;
  if (ratio >= 0.75) return theme.warn;
  if (ratio >= 0.5) return theme.info;
  return theme.accent;
}

export function renderContextBarSegments(
  used: number,
  limit: number,
  theme: Theme,
  barWidth = 12,
): Row["segments"] {
  const { bar, label, ratio } = formatContextBar(used, limit, barWidth);
  const fill = contextBarColor(ratio, theme);
  // Split bar into filled/empty for two-tone paint
  const filledN = Math.round(Math.min(1, used / Math.max(1, limit)) * barWidth);
  const filled = bar.slice(0, filledN);
  const empty = bar.slice(filledN);
  // Empty track: fgFaint (always readable on bgElevated; border can equal
  // elevated bg on some palettes and disappear).
  return [
    { text: "ctx ", style: { fg: theme.fgFaint } },
    ...(filled
      ? [{ text: filled, style: { fg: fill } }]
      : []),
    ...(empty
      ? [{ text: empty, style: { fg: theme.fgFaint } }]
      : []),
    { text: ` ${label}`, style: { fg: theme.fgMuted } },
  ];
}

export interface StatusExtra {
  scroll?: string;
  completeOpen?: boolean;
  pickerOpen?: boolean;
  /** Live generation rate (tokens / second) */
  tokensPerSec?: number;
  /** Realised paint frames / second while agent is busy */
  framesPerSec?: number;
  /** Override context bar width (cells). Default scales with terminal. */
  contextBarWidth?: number;
}

/**
 * Bottom-most footer: full-width context meter.
 * `ctx ████████░░░░  61k/128k 48%          session 120k · 60t/s`
 */
export function renderContextFooter(
  state: HarnessState,
  theme: Theme,
  width: number,
  extra?: StatusExtra,
): Row {
  const ctx = resolveContextUsage(state);
  // Prefer a wide meter on the dedicated footer line
  const barW =
    extra?.contextBarWidth ??
    Math.min(28, Math.max(10, Math.floor(width * 0.28)));
  const segs: Row["segments"] = [
    ...renderContextBarSegments(ctx.used, ctx.limit, theme, barW),
  ];

  const sessionTotal = state.tokens.input + state.tokens.output;
  const rateBits: string[] = [];
  if (sessionTotal > 0) {
    rateBits.push(`Σ ${formatCompactCount(sessionTotal)}`);
  }
  const tps =
    extra?.tokensPerSec != null &&
    Number.isFinite(extra.tokensPerSec) &&
    extra.tokensPerSec > 0
      ? Math.round(extra.tokensPerSec)
      : 0;
  const fps =
    extra?.framesPerSec != null &&
    Number.isFinite(extra.framesPerSec) &&
    extra.framesPerSec > 0
      ? Math.round(extra.framesPerSec)
      : 0;
  if (tps > 0) rateBits.push(`${tps}t/s`);
  if (fps > 0) rateBits.push(`${fps}f`);

  if (rateBits.length) {
    segs.push({
      text: `  ·  ${rateBits.join(" · ")}`,
      style: { fg: theme.fgFaint },
    });
  }

  const usedW = segs.reduce((n, s) => n + stringWidth(s.text), 0);
  if (usedW < width) {
    segs.push({ text: " ".repeat(width - usedW), style: {} });
  }
  // Elevate the whole footer strip so the meter reads as a dedicated bar
  return {
    segments: segs.map((s) => ({
      text: s.text,
      style: { ...s.style, bg: theme.bgElevated },
    })),
  };
}

export function renderStatus(
  state: HarnessState,
  theme: Theme,
  width: number,
  tick: number,
  focus: "prompt" | "scrollback",
  extra?: StatusExtra,
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
    // OpenCode-style braille loader (via setSpinnerGlyphs / BRAILLE_SPINNER)
    phaseText = `${spinnerFrame(tick)} ${state.activityLabel ?? phase}`;
    phaseStyle = { fg: theme.spinner };
  }

  const mode = reasoningModeDisplay(state);
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
  const mid = `  |  ${focusHint}${scroll}`;
  const segs: Row["segments"] = [
    { text: left, style: phaseStyle },
    { text: mid, style: { fg: theme.fgFaint } },
  ];

  const used = stringWidth(left + mid);
  const room = width - used - 1;
  if (room > 8) {
    const glowSegs = mode
      ? animatedGlowSegments(mode.label, mode.kind, tick, theme)
      : [];
    const glowW = mode ? stringWidth(mode.label) + 2 : 0;
    const keysRoom = Math.max(0, room - glowW);
    const keysShown = keys.slice(0, keysRoom);
    const pad = Math.max(
      1,
      room - glowW - stringWidth(keysShown),
    );
    segs.push({ text: " ".repeat(Math.min(pad, room)), style: {} });
    segs.push(...glowSegs);
    if (mode) {
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

/** Status-bar reasoning mode: harness profile or native effort. */
export type ReasoningModeKind =
  | "ultra-fusion"
  | "ultra"
  | "max"
  | "xhigh"
  | "high"
  | "medium"
  | "low"
  | "minimal"
  | "none"
  | "off"
  | "default"
  | string;

export interface ReasoningModeDisplay {
  label: string;
  kind: ReasoningModeKind;
}

/** Cached mode label — key includes config fingerprint so saves invalidate. */
let modeDisplayCache: {
  key: string;
  value: ReasoningModeDisplay | null;
} | null = null;

/**
 * Bottom-right label for the active reasoning mode.
 * Ultra / Ultra + Fusion take priority over native effort.
 * Effort levels (Max, High, Medium, …) show when no harness profile is on.
 * Hidden only for model-default (omit) effort.
 */
export function reasoningModeDisplay(
  state: HarnessState,
): ReasoningModeDisplay | null {
  try {
    const cfg = loadAgentSettings(); // memory-cached
    const provider = state.session.provider;
    const model = state.session.model;
    const per =
      cfg.reasoning.perModelEffort?.[`${provider}/${model}`] ??
      cfg.reasoning.perModelEffort?.[model] ??
      "";
    const cacheKey = `${provider}|${model}|${cfg.reasoning.custom}|${cfg.reasoning.effort}|${per}`;
    if (modeDisplayCache && modeDisplayCache.key === cacheKey) {
      return modeDisplayCache.value;
    }

    const custom = cfg.reasoning.custom;
    let value: ReasoningModeDisplay | null = null;
    if (custom === "ultra-fusion") {
      value = { label: "Ultra + Fusion", kind: "ultra-fusion" };
    } else if (custom === "ultra") {
      value = { label: "Ultra", kind: "ultra" };
    } else {
      let effort: string;
      if (
        provider &&
        provider !== "none" &&
        model &&
        model !== "unset"
      ) {
        effort = getEffortForModel(provider as ProviderId, model);
      } else {
        effort = cfg.reasoning.effort ?? "default";
      }

      if (effort && effort !== "default") {
        value = { label: statusEffortLabel(effort), kind: effort };
      }
    }
    modeDisplayCache = { key: cacheKey, value };
    return value;
  } catch {
    return null;
  }
}

/** Compact status-bar labels (shorter than full picker labels). */
function statusEffortLabel(effort: string): string {
  switch (effort) {
    case "none":
      return "None";
    case "off":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "XHigh";
    case "max":
      return "Max";
    default:
      // Title-case unknown tokens
      return effort.charAt(0).toUpperCase() + effort.slice(1);
  }
}

/**
 * Compact count: 850 → "850", 1200 → "1.2k", 120000 → "120k".
 */
export function formatCompactCount(n: number): string {
  const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  if (v < 1000) return String(v);
  if (v < 10_000) {
    const s = (v / 1000).toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}k`;
  }
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  if (v < 10_000_000) {
    const s = (v / 1_000_000).toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}M`;
  }
  return `${Math.round(v / 1_000_000)}M`;
}

/**
 * Status-bar token label: `120k / 60t / 28f` (total · tokens/sec · paint fps).
 * When rate is 0 / unknown, just the compact total. FPS only when provided.
 * Pass totalTokens=0 to emit rate/fps only (context bar owns the count).
 */
export function formatTokenStatus(
  totalTokens: number,
  tokensPerSec?: number,
  framesPerSec?: number,
): string {
  const total = formatCompactCount(totalTokens);
  const rate =
    tokensPerSec != null && Number.isFinite(tokensPerSec) && tokensPerSec > 0
      ? Math.round(tokensPerSec)
      : 0;
  const fps =
    framesPerSec != null && Number.isFinite(framesPerSec) && framesPerSec > 0
      ? Math.round(framesPerSec)
      : 0;
  if (rate <= 0 && fps <= 0) return total;
  if (rate > 0 && fps > 0) return `${total} / ${rate}t / ${fps}f`;
  if (rate > 0) return `${total} / ${rate}t`;
  return `${total} / ${fps}f`;
}

/**
 * Seamless soft sheen across the reasoning-mode label.
 *
 * Traveling cosine lobe over theme-derived colors for that mode —
 * continuous gradients between neighboring characters, mild bright tip.
 * ~0.9s per loop at 30fps for a 14-char label.
 */
const GLOW_SPEED = 0.39; // chars / tick (~25% slower than 0.52)
const GLOW_HALF = 2.6; // half-width of the soft lobe (chars)

function animatedGlowSegments(
  label: string,
  kind: ReasoningModeKind,
  tick: number,
  theme: Theme,
): Row["segments"] {
  const chars = [...label];
  const n = chars.length;
  if (n === 0) return [];

  const { dim, peak } = modeGlowPalette(kind, theme);
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

/**
 * Per-mode color pairs drawn from the active theme so every palette
 * (night, day, tokyo, catppuccin, …) stays coherent.
 *
 * Intensity ladder (quiet → loud):
 *   off/none → minimal → low → medium → high → xhigh/max → ultra → ultra-fusion
 */
function modeGlowPalette(
  kind: ReasoningModeKind,
  theme: Theme,
): { dim: Rgb; peak: Rgb } {
  const base = modeBaseColor(kind, theme);
  // Quieter modes sit closer to faint; louder modes sit closer to base
  const dimMix = modeDimMix(kind);
  const dim = lerpRgb(theme.fgFaint, base, dimMix);
  // Peak: lift base toward theme.fg (near-white on dark palettes, ink on
  // light) so glow never hardcodes pure white against a day theme.
  const peakLift = modePeakLift(kind);
  const peak = lerpRgb(base, theme.fg, peakLift);
  return { dim, peak };
}

function modeBaseColor(kind: ReasoningModeKind, theme: Theme): Rgb {
  switch (kind) {
    case "ultra-fusion":
      // Multi-model: thinking (reasoning) accent — most distinctive
      return theme.thinking ?? theme.accent;
    case "ultra":
      return theme.accent;
    case "max":
      return theme.accentAssistant ?? theme.accent;
    case "xhigh":
      return theme.accentAssistant ?? theme.thinking ?? theme.accent;
    case "high":
      return theme.thinking ?? theme.accent;
    case "medium":
      return theme.info;
    case "low":
      return theme.tool;
    case "minimal":
      return theme.fgMuted;
    case "none":
    case "off":
      return theme.fgFaint;
    default:
      return theme.fgMuted;
  }
}

/** How strongly dim leans toward the mode color (0–1). */
function modeDimMix(kind: ReasoningModeKind): number {
  switch (kind) {
    case "ultra-fusion":
    case "ultra":
      return 0.55;
    case "max":
    case "xhigh":
      return 0.5;
    case "high":
      return 0.48;
    case "medium":
      return 0.45;
    case "low":
      return 0.4;
    case "minimal":
      return 0.35;
    case "none":
    case "off":
      return 0.25;
    default:
      return 0.4;
  }
}

/** How much peak lifts toward theme.fg (0–1). */
function modePeakLift(kind: ReasoningModeKind): number {
  switch (kind) {
    case "ultra-fusion":
    case "ultra":
      return 0.3;
    case "max":
    case "xhigh":
      return 0.28;
    case "high":
      return 0.25;
    case "medium":
      return 0.22;
    case "low":
      return 0.18;
    case "minimal":
      return 0.12;
    case "none":
    case "off":
      return 0.08;
    default:
      return 0.2;
  }
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
