/**
 * UI font / glyph profiles.
 *
 * Terminals own the real typeface; Libra stores a preferred family
 * (applied via OSC where supported) and a glyph profile that changes
 * how the TUI draws UI chrome.
 */

export interface FontProfile {
  name: string;
  displayName: string;
  description: string;
  /** Preferred terminal font family (hint; best-effort OSC) */
  family: string;
  /** Glyph set for chrome / spinners / borders */
  glyphs: "ascii" | "box" | "rounded";
  /** Prefer bold accents in headers */
  boldUi: boolean;
}

export const FONT_PROFILES: FontProfile[] = [
  {
    name: "default",
    displayName: "Default",
    description: "ASCII chrome, system mono",
    family: "",
    glyphs: "ascii",
    boldUi: true,
  },
  {
    name: "jetbrains",
    displayName: "JetBrains Mono",
    description: "JetBrains Mono + box drawing",
    family: "JetBrains Mono",
    glyphs: "box",
    boldUi: true,
  },
  {
    name: "cascadia",
    displayName: "Cascadia Code",
    description: "Cascadia Code (Windows Terminal)",
    family: "Cascadia Code",
    glyphs: "box",
    boldUi: true,
  },
  {
    name: "fira",
    displayName: "Fira Code",
    description: "Fira Code + ligature-friendly",
    family: "Fira Code",
    glyphs: "box",
    boldUi: true,
  },
  {
    name: "iosevka",
    displayName: "Iosevka",
    description: "Iosevka narrow coding font",
    family: "Iosevka",
    glyphs: "rounded",
    boldUi: false,
  },
  {
    name: "hack",
    displayName: "Hack",
    description: "Hack monospace",
    family: "Hack",
    glyphs: "ascii",
    boldUi: true,
  },
  {
    name: "sf-mono",
    displayName: "SF Mono",
    description: "Apple SF Mono",
    family: "SF Mono",
    glyphs: "box",
    boldUi: true,
  },
  {
    name: "comic",
    displayName: "Comic Mono",
    description: "Casual mono + rounded UI",
    family: "Comic Mono",
    glyphs: "rounded",
    boldUi: false,
  },
];

export function resolveFont(name: string): FontProfile {
  return (
    FONT_PROFILES.find((f) => f.name === name.toLowerCase()) ??
    FONT_PROFILES[0]!
  );
}

/**
 * Best-effort request that the terminal switch typeface.
 * Supported by some xterm-compatible terminals (OSC 50).
 * No-ops silently elsewhere.
 */
export function fontChangeSequence(family: string, size?: number): string {
  if (!family) return "";
  // OSC 50 ; FontName \a  (xterm)
  const spec = size ? `${family}:size=${size}` : family;
  return `\x1b]50;${spec}\x07`;
}

export interface GlyphSet {
  hline: string;
  vline: string;
  prompt: string;
  assistant: string;
  user: string;
  thumb: string;
  track: string;
  spinner: string[];
}

export function glyphsFor(profile: FontProfile): GlyphSet {
  switch (profile.glyphs) {
    case "box":
      return {
        hline: "─",
        vline: "│",
        prompt: "❯",
        assistant: "◆",
        user: "❯",
        thumb: "█",
        track: "│",
        spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
      };
    case "rounded":
      return {
        hline: "─",
        vline: "│",
        prompt: "›",
        assistant: "●",
        user: "›",
        thumb: "●",
        track: "·",
        spinner: ["◐", "◓", "◑", "◒"],
      };
    default:
      return {
        hline: "-",
        vline: "|",
        prompt: ">",
        assistant: "*",
        user: ">",
        thumb: "#",
        track: "|",
        // OpenCode-style braille loader even on the ascii chrome profile
        spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
      };
  }
}
