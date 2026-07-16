/**
 * Theme system inspired by Grok CLI:
 * - Named palettes with full RGB
 * - Runtime quantization to truecolor / 256 / 16 / mono
 * - Live preview via picker onPreview
 */

export type ColorLevel = "truecolor" | "256" | "16" | "mono";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Theme {
  name: string;
  displayName: string;
  description?: string;
  /** Requires truecolor to look right (hidden on weaker terminals) */
  truecolorOnly?: boolean;
  bg: Rgb;
  bgElevated: Rgb;
  bgSubtle: Rgb;
  fg: Rgb;
  fgMuted: Rgb;
  fgFaint: Rgb;
  border: Rgb;
  accent: Rgb;
  accentUser: Rgb;
  accentAssistant: Rgb;
  accentSystem: Rgb;
  tool: Rgb;
  toolRunning: Rgb;
  toolOk: Rgb;
  toolError: Rgb;
  thinking: Rgb;
  diffAdd: Rgb;
  diffDel: Rgb;
  diffMeta: Rgb;
  success: Rgb;
  warn: Rgb;
  error: Rgb;
  info: Rgb;
  spinner: Rgb;
  selection: Rgb;
  /** Full-width code panel background */
  codeBg: Rgb;
  /** Line-number gutter in code boxes */
  codeGutter: Rgb;
  synKeyword: Rgb;
  synString: Rgb;
  synComment: Rgb;
  synNumber: Rgb;
  synFunction: Rgb;
  synType: Rgb;
  synOperator: Rgb;
  synProperty: Rgb;
}

/**
 * Build a theme. Explicit fields win; any omitted semantic slots are
 * derived from the theme's own palette (toolOk → success, etc.) so
 * partial definitions never leak libra-night violet/cyan into other
 * palettes (context bar, status, glow, diffs).
 */
function t(
  partial: Partial<Theme> & { name: string; displayName: string },
): Theme {
  const base = { ...defaults, ...partial };
  const own = <K extends keyof Theme>(k: K): boolean =>
    Object.prototype.hasOwnProperty.call(partial, k);

  // Palette-native anchors (prefer explicit partial, else post-merge base)
  const toolOk = own("toolOk") ? base.toolOk : own("tool") ? base.tool : base.toolOk;
  const toolError = own("toolError") ? base.toolError : base.toolError;
  const toolRunning = own("toolRunning") ? base.toolRunning : base.toolRunning;
  const accent = base.accent;
  const accentUser = base.accentUser;
  const fgMuted = base.fgMuted;

  const codeBg = own("codeBg") ? base.codeBg : base.bgElevated;
  const codeGutter = own("codeGutter") ? base.codeGutter : base.fgFaint;
  // Syntax: derive from palette so every theme stays coherent
  const synKeyword = own("synKeyword") ? base.synKeyword : accent;
  const synString = own("synString") ? base.synString : toolOk;
  const synComment = own("synComment") ? base.synComment : base.fgFaint;
  const synNumber = own("synNumber") ? base.synNumber : base.toolRunning;
  const synFunction = own("synFunction") ? base.synFunction : accentUser;
  const synType = own("synType") ? base.synType : base.thinking;
  const synOperator = own("synOperator") ? base.synOperator : fgMuted;
  const synProperty = own("synProperty") ? base.synProperty : base.tool;

  return {
    ...base,
    toolOk,
    toolError,
    toolRunning,
    accentSystem: own("accentSystem") ? base.accentSystem : fgMuted,
    thinking: own("thinking") ? base.thinking : accent,
    success: own("success") ? base.success : toolOk,
    warn: own("warn") ? base.warn : toolRunning,
    error: own("error") ? base.error : toolError,
    info: own("info") ? base.info : accentUser,
    spinner: own("spinner") ? base.spinner : accent,
    diffAdd: own("diffAdd") ? base.diffAdd : toolOk,
    diffDel: own("diffDel") ? base.diffDel : toolError,
    diffMeta: own("diffMeta") ? base.diffMeta : fgMuted,
    codeBg,
    codeGutter,
    synKeyword,
    synString,
    synComment,
    synNumber,
    synFunction,
    synType,
    synOperator,
    synProperty,
  };
}

const defaults = {
  bg: { r: 14, g: 16, b: 22 },
  bgElevated: { r: 22, g: 25, b: 34 },
  bgSubtle: { r: 30, g: 34, b: 46 },
  fg: { r: 224, g: 228, b: 238 },
  fgMuted: { r: 148, g: 156, b: 176 },
  fgFaint: { r: 90, g: 98, b: 118 },
  border: { r: 48, g: 54, b: 72 },
  accent: { r: 167, g: 139, b: 250 },
  accentUser: { r: 125, g: 211, b: 252 },
  accentAssistant: { r: 167, g: 139, b: 250 },
  accentSystem: { r: 148, g: 163, b: 184 },
  tool: { r: 94, g: 234, b: 212 },
  toolRunning: { r: 251, g: 191, b: 36 },
  toolOk: { r: 74, g: 222, b: 128 },
  toolError: { r: 248, g: 113, b: 113 },
  thinking: { r: 167, g: 139, b: 250 },
  diffAdd: { r: 74, g: 222, b: 128 },
  diffDel: { r: 248, g: 113, b: 113 },
  diffMeta: { r: 148, g: 163, b: 184 },
  success: { r: 74, g: 222, b: 128 },
  warn: { r: 251, g: 191, b: 36 },
  error: { r: 248, g: 113, b: 113 },
  info: { r: 125, g: 211, b: 252 },
  spinner: { r: 167, g: 139, b: 250 },
  selection: { r: 55, g: 48, b: 90 },
  codeBg: { r: 22, g: 25, b: 34 },
  codeGutter: { r: 90, g: 98, b: 118 },
  synKeyword: { r: 167, g: 139, b: 250 },
  synString: { r: 74, g: 222, b: 128 },
  synComment: { r: 90, g: 98, b: 118 },
  synNumber: { r: 251, g: 191, b: 36 },
  synFunction: { r: 125, g: 211, b: 252 },
  synType: { r: 196, g: 167, b: 231 },
  synOperator: { r: 148, g: 156, b: 176 },
  synProperty: { r: 94, g: 234, b: 212 },
};

const night = t({
  name: "libra-night",
  displayName: "Libra Night",
  description: "Default dark, violet accent",
});

const day = t({
  name: "libra-day",
  displayName: "Libra Day",
  description: "Light terminal",
  bg: { r: 250, g: 250, b: 252 },
  bgElevated: { r: 241, g: 243, b: 247 },
  bgSubtle: { r: 228, g: 232, b: 240 },
  fg: { r: 28, g: 32, b: 42 },
  fgMuted: { r: 90, g: 98, b: 118 },
  fgFaint: { r: 140, g: 148, b: 168 },
  border: { r: 200, g: 206, b: 220 },
  accent: { r: 109, g: 40, b: 217 },
  accentUser: { r: 2, g: 132, b: 199 },
  accentAssistant: { r: 109, g: 40, b: 217 },
  accentSystem: { r: 100, g: 116, b: 139 },
  tool: { r: 13, g: 148, b: 136 },
  toolRunning: { r: 202, g: 138, b: 4 },
  toolOk: { r: 22, g: 163, b: 74 },
  toolError: { r: 220, g: 38, b: 38 },
  thinking: { r: 109, g: 40, b: 217 },
  diffAdd: { r: 22, g: 163, b: 74 },
  diffDel: { r: 220, g: 38, b: 38 },
  diffMeta: { r: 100, g: 116, b: 139 },
  success: { r: 22, g: 163, b: 74 },
  warn: { r: 202, g: 138, b: 4 },
  error: { r: 220, g: 38, b: 38 },
  info: { r: 2, g: 132, b: 199 },
  spinner: { r: 109, g: 40, b: 217 },
  selection: { r: 233, g: 213, b: 255 },
});

const tokyo = t({
  name: "tokyo-night",
  displayName: "Tokyo Night",
  description: "Blue-tinted dark",
  truecolorOnly: true,
  bg: { r: 26, g: 27, b: 38 },
  bgElevated: { r: 36, g: 40, b: 59 },
  bgSubtle: { r: 41, g: 46, b: 66 },
  fg: { r: 192, g: 202, b: 245 },
  fgMuted: { r: 86, g: 95, b: 137 },
  fgFaint: { r: 65, g: 72, b: 104 },
  border: { r: 41, g: 46, b: 66 },
  accent: { r: 122, g: 162, b: 247 },
  accentUser: { r: 125, g: 207, b: 255 },
  accentAssistant: { r: 187, g: 154, b: 247 },
  accentSystem: { r: 86, g: 95, b: 137 },
  tool: { r: 115, g: 218, b: 202 },
  toolRunning: { r: 224, g: 175, b: 104 },
  toolOk: { r: 158, g: 206, b: 106 },
  toolError: { r: 247, g: 118, b: 142 },
  thinking: { r: 187, g: 154, b: 247 },
  diffAdd: { r: 158, g: 206, b: 106 },
  diffDel: { r: 247, g: 118, b: 142 },
  diffMeta: { r: 86, g: 95, b: 137 },
  success: { r: 158, g: 206, b: 106 },
  warn: { r: 224, g: 175, b: 104 },
  error: { r: 247, g: 118, b: 142 },
  info: { r: 125, g: 207, b: 255 },
  spinner: { r: 122, g: 162, b: 247 },
  selection: { r: 41, g: 46, b: 66 },
});

const catppuccin = t({
  name: "catppuccin-mocha",
  displayName: "Catppuccin Mocha",
  description: "Soft pastels on deep base",
  truecolorOnly: true,
  bg: { r: 30, g: 30, b: 46 },
  bgElevated: { r: 49, g: 50, b: 68 },
  bgSubtle: { r: 69, g: 71, b: 90 },
  fg: { r: 205, g: 214, b: 244 },
  fgMuted: { r: 166, g: 173, b: 200 },
  fgFaint: { r: 108, g: 112, b: 134 },
  border: { r: 69, g: 71, b: 90 },
  accent: { r: 203, g: 166, b: 247 }, // mauve
  accentUser: { r: 137, g: 180, b: 250 }, // blue
  accentAssistant: { r: 203, g: 166, b: 247 },
  tool: { r: 148, g: 226, b: 213 }, // teal
  toolRunning: { r: 249, g: 226, b: 175 }, // yellow
  toolOk: { r: 166, g: 227, b: 161 }, // green
  toolError: { r: 243, g: 139, b: 168 }, // red
  thinking: { r: 180, g: 190, b: 254 }, // lavender
  selection: { r: 69, g: 71, b: 90 },
});

const rosePine = t({
  name: "rose-pine",
  displayName: "Rosé Pine",
  description: "Muted mauve dark",
  truecolorOnly: true,
  bg: { r: 25, g: 23, b: 36 },
  bgElevated: { r: 31, g: 29, b: 46 },
  bgSubtle: { r: 38, g: 35, b: 53 },
  fg: { r: 224, g: 222, b: 244 },
  fgMuted: { r: 144, g: 140, b: 170 },
  fgFaint: { r: 110, g: 106, b: 134 },
  border: { r: 38, g: 35, b: 53 },
  accent: { r: 196, g: 167, b: 231 }, // iris
  accentUser: { r: 156, g: 207, b: 216 }, // foam
  accentAssistant: { r: 246, g: 193, b: 119 }, // gold
  tool: { r: 156, g: 207, b: 216 },
  toolRunning: { r: 246, g: 193, b: 119 },
  toolOk: { r: 158, g: 206, b: 147 }, // pine
  toolError: { r: 235, g: 111, b: 146 }, // love
  thinking: { r: 196, g: 167, b: 231 },
  selection: { r: 38, g: 35, b: 53 },
});

const nord = t({
  name: "nord",
  displayName: "Nord",
  description: "Arctic blue-gray",
  truecolorOnly: true,
  bg: { r: 46, g: 52, b: 64 },
  bgElevated: { r: 59, g: 66, b: 82 },
  bgSubtle: { r: 67, g: 76, b: 94 },
  fg: { r: 236, g: 239, b: 244 },
  fgMuted: { r: 216, g: 222, b: 233 },
  fgFaint: { r: 129, g: 161, b: 193 },
  border: { r: 76, g: 86, b: 106 },
  accent: { r: 136, g: 192, b: 208 }, // nord8
  accentUser: { r: 129, g: 161, b: 193 }, // nord9
  accentAssistant: { r: 143, g: 188, b: 187 }, // nord7
  tool: { r: 163, g: 190, b: 140 }, // nord14
  toolRunning: { r: 235, g: 203, b: 139 }, // nord13
  toolOk: { r: 163, g: 190, b: 140 },
  toolError: { r: 191, g: 97, b: 106 }, // nord11
  thinking: { r: 180, g: 142, b: 173 }, // nord15
  selection: { r: 67, g: 76, b: 94 },
});

const dracula = t({
  name: "dracula",
  displayName: "Dracula",
  description: "Classic purple horror",
  truecolorOnly: true,
  bg: { r: 40, g: 42, b: 54 },
  bgElevated: { r: 68, g: 71, b: 90 },
  bgSubtle: { r: 98, g: 114, b: 164 },
  fg: { r: 248, g: 248, b: 242 },
  fgMuted: { r: 189, g: 147, b: 249 },
  fgFaint: { r: 98, g: 114, b: 164 },
  border: { r: 68, g: 71, b: 90 },
  accent: { r: 189, g: 147, b: 249 }, // purple
  accentUser: { r: 139, g: 233, b: 253 }, // cyan
  accentAssistant: { r: 255, g: 121, b: 198 }, // pink
  tool: { r: 80, g: 250, b: 123 }, // green
  toolRunning: { r: 241, g: 250, b: 140 }, // yellow
  toolOk: { r: 80, g: 250, b: 123 },
  toolError: { r: 255, g: 85, b: 85 }, // red
  thinking: { r: 189, g: 147, b: 249 },
  selection: { r: 68, g: 71, b: 90 },
});

const gruvbox = t({
  name: "gruvbox-dark",
  displayName: "Gruvbox Dark",
  description: "Warm retro earth tones",
  truecolorOnly: true,
  bg: { r: 40, g: 40, b: 40 },
  bgElevated: { r: 60, g: 56, b: 54 },
  bgSubtle: { r: 80, g: 73, b: 69 },
  fg: { r: 235, g: 219, b: 178 },
  fgMuted: { r: 168, g: 153, b: 132 },
  fgFaint: { r: 146, g: 131, b: 116 },
  border: { r: 80, g: 73, b: 69 },
  accent: { r: 254, g: 128, b: 25 }, // orange
  accentUser: { r: 131, g: 165, b: 152 }, // aqua
  accentAssistant: { r: 211, g: 134, b: 155 }, // purple
  tool: { r: 184, g: 187, b: 38 }, // green
  toolRunning: { r: 250, g: 189, b: 47 }, // yellow
  toolOk: { r: 184, g: 187, b: 38 },
  toolError: { r: 251, g: 73, b: 52 }, // red
  thinking: { r: 211, g: 134, b: 155 },
  selection: { r: 80, g: 73, b: 69 },
});

const solarized = t({
  name: "solarized-dark",
  displayName: "Solarized Dark",
  description: "Ethan Schoonover classic",
  truecolorOnly: true,
  bg: { r: 0, g: 43, b: 54 },
  bgElevated: { r: 7, g: 54, b: 66 },
  bgSubtle: { r: 88, g: 110, b: 117 },
  fg: { r: 131, g: 148, b: 150 },
  fgMuted: { r: 147, g: 161, b: 161 },
  fgFaint: { r: 88, g: 110, b: 117 },
  // base01 — distinct from bgElevated so borders/tracks stay visible
  border: { r: 88, g: 110, b: 117 },
  accent: { r: 38, g: 139, b: 210 }, // blue
  accentUser: { r: 42, g: 161, b: 152 }, // cyan
  accentAssistant: { r: 108, g: 113, b: 196 }, // violet
  tool: { r: 133, g: 153, b: 0 }, // green
  toolRunning: { r: 181, g: 137, b: 0 }, // yellow
  toolOk: { r: 133, g: 153, b: 0 },
  toolError: { r: 220, g: 50, b: 47 }, // red
  thinking: { r: 211, g: 54, b: 130 }, // magenta
  selection: { r: 7, g: 54, b: 66 },
});

const monokai = t({
  name: "monokai",
  displayName: "Monokai",
  description: "Vibrant code-editor dark",
  truecolorOnly: true,
  bg: { r: 39, g: 40, b: 34 },
  bgElevated: { r: 60, g: 60, b: 52 },
  bgSubtle: { r: 73, g: 72, b: 62 },
  fg: { r: 248, g: 248, b: 242 },
  fgMuted: { r: 117, g: 113, b: 94 },
  fgFaint: { r: 117, g: 113, b: 94 },
  border: { r: 73, g: 72, b: 62 },
  accent: { r: 174, g: 129, b: 255 }, // purple
  accentUser: { r: 102, g: 217, b: 239 }, // cyan
  accentAssistant: { r: 249, g: 38, b: 114 }, // pink
  tool: { r: 166, g: 226, b: 46 }, // green
  toolRunning: { r: 230, g: 219, b: 116 }, // yellow
  toolOk: { r: 166, g: 226, b: 46 },
  toolError: { r: 249, g: 38, b: 114 },
  thinking: { r: 174, g: 129, b: 255 },
  selection: { r: 73, g: 72, b: 62 },
});

const oscura = t({
  name: "oscura",
  displayName: "Oscura Midnight",
  description: "Deep purple midnight",
  truecolorOnly: true,
  bg: { r: 12, g: 12, b: 18 },
  bgElevated: { r: 22, g: 20, b: 32 },
  bgSubtle: { r: 36, g: 32, b: 52 },
  fg: { r: 230, g: 225, b: 245 },
  fgMuted: { r: 150, g: 140, b: 180 },
  fgFaint: { r: 90, g: 80, b: 120 },
  border: { r: 50, g: 42, b: 72 },
  accent: { r: 180, g: 120, b: 255 },
  accentUser: { r: 120, g: 200, b: 255 },
  accentAssistant: { r: 200, g: 140, b: 255 },
  tool: { r: 100, g: 230, b: 200 },
  toolRunning: { r: 230, g: 180, b: 100 },
  toolOk: { r: 120, g: 220, b: 150 },
  toolError: { r: 240, g: 100, b: 130 },
  thinking: { r: 180, g: 120, b: 255 },
  selection: { r: 40, g: 30, b: 70 },
});

const oneDark = t({
  name: "one-dark",
  displayName: "One Dark",
  description: "Atom / VS Code classic",
  truecolorOnly: true,
  bg: { r: 40, g: 44, b: 52 },
  bgElevated: { r: 49, g: 54, b: 63 },
  bgSubtle: { r: 57, g: 63, b: 73 },
  fg: { r: 171, g: 178, b: 191 },
  fgMuted: { r: 92, g: 99, b: 112 },
  fgFaint: { r: 92, g: 99, b: 112 },
  border: { r: 57, g: 63, b: 73 },
  accent: { r: 198, g: 120, b: 221 }, // purple
  accentUser: { r: 97, g: 175, b: 239 }, // blue
  accentAssistant: { r: 224, g: 108, b: 117 }, // red
  tool: { r: 152, g: 195, b: 121 }, // green
  toolRunning: { r: 229, g: 192, b: 123 }, // yellow
  toolOk: { r: 152, g: 195, b: 121 },
  toolError: { r: 224, g: 108, b: 117 },
  thinking: { r: 198, g: 120, b: 221 },
  selection: { r: 57, g: 63, b: 73 },
});

const zinc = t({
  name: "zinc",
  displayName: "Zinc",
  description: "Neutral gray, no tint",
  bg: { r: 24, g: 24, b: 27 },
  bgElevated: { r: 39, g: 39, b: 42 },
  bgSubtle: { r: 63, g: 63, b: 70 },
  fg: { r: 250, g: 250, b: 250 },
  fgMuted: { r: 161, g: 161, b: 170 },
  fgFaint: { r: 113, g: 113, b: 122 },
  border: { r: 63, g: 63, b: 70 },
  accent: { r: 228, g: 228, b: 231 },
  accentUser: { r: 161, g: 161, b: 170 },
  accentAssistant: { r: 212, g: 212, b: 216 },
  tool: { r: 161, g: 161, b: 170 },
  toolRunning: { r: 212, g: 212, b: 216 },
  toolOk: { r: 163, g: 230, b: 53 },
  toolError: { r: 248, g: 113, b: 113 },
  thinking: { r: 212, g: 212, b: 216 },
  selection: { r: 63, g: 63, b: 70 },
});

/** Canonical themes (for picker order) */
export const THEME_ORDER = [
  "libra-night",
  "libra-day",
  "tokyo-night",
  "catppuccin-mocha",
  "rose-pine",
  "nord",
  "dracula",
  "gruvbox-dark",
  "solarized-dark",
  "monokai",
  "oscura",
  "one-dark",
  "zinc",
];

export const THEMES: Record<string, Theme> = {
  "libra-night": night,
  night: night,
  dark: night,
  "libra-day": day,
  day: day,
  light: day,
  "tokyo-night": tokyo,
  tokyo: tokyo,
  tokyonight: tokyo,
  "catppuccin-mocha": catppuccin,
  catppuccin: catppuccin,
  mocha: catppuccin,
  "rose-pine": rosePine,
  rosepine: rosePine,
  nord: nord,
  dracula: dracula,
  "gruvbox-dark": gruvbox,
  gruvbox: gruvbox,
  "solarized-dark": solarized,
  solarized: solarized,
  monokai: monokai,
  oscura: oscura,
  "oscura-midnight": oscura,
  "one-dark": oneDark,
  onedark: oneDark,
  zinc: zinc,
};

export function resolveTheme(name: string): Theme {
  return THEMES[name.toLowerCase()] ?? night;
}

export function listThemes(): Theme[] {
  return THEME_ORDER.map((n) => THEMES[n]!).filter(Boolean);
}

export function detectColorLevel(): ColorLevel {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") {
    return "mono";
  }
  if (
    process.env.COLORTERM === "truecolor" ||
    process.env.COLORTERM === "24bit" ||
    process.env.TERM_PROGRAM === "iTerm.app" ||
    process.env.TERM_PROGRAM === "Apple_Terminal" ||
    process.env.WT_SESSION ||
    process.env.TERM?.includes("truecolor")
  ) {
    return "truecolor";
  }
  if (process.platform === "win32") {
    return "truecolor";
  }
  if (process.env.TERM?.includes("256") || process.env.TERM === "xterm-kitty") {
    return "256";
  }
  return "256";
}
