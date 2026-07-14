/**
 * Tool arg normalization + fingerprinting for cache / dedupe.
 * Supports both Libra-native names and Fusion catalog aliases.
 */

/** Stable JSON with sorted keys (for fingerprints). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

/**
 * Canonical tool names (Libra internal). Catalog aliases map here for
 * fingerprinting so `write` and `write_file` share cache keys when args match.
 */
export function canonicalToolName(name: string): string {
  switch (name) {
    case "write_file":
      return "write";
    case "edit_file":
      return "search_replace";
    case "run_shell":
      return "run_terminal_command";
    default:
      return name;
  }
}

/**
 * Fill defaults / normalize paths and catalog ↔ native arg aliases so
 * `{}` and `{target_directory:"."}` / `{path:"."}` hash the same for list_dir.
 */
export function normalizeToolArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  // Drop undefined / empty-string noise
  for (const k of Object.keys(out)) {
    if (out[k] === undefined || out[k] === "") delete out[k];
  }

  const canon = canonicalToolName(name);

  // Catalog path aliases → native field names (and vice versa for catalog)
  switch (name) {
    case "list_dir": {
      if (out.path != null && out.target_directory == null) {
        out.target_directory = out.path;
        delete out.path;
      }
      break;
    }
    case "read_file": {
      if (out.path != null && out.target_file == null) {
        out.target_file = out.path;
        delete out.path;
      }
      break;
    }
    case "write_file":
    case "write": {
      if (out.path != null && out.file_path == null) {
        out.file_path = out.path;
        delete out.path;
      }
      break;
    }
    case "edit_file":
    case "search_replace": {
      if (out.path != null && out.file_path == null) {
        out.file_path = out.path;
        delete out.path;
      }
      break;
    }
    case "run_shell": {
      if (out.timeout_s != null && out.timeout_ms == null) {
        const s = Number(out.timeout_s);
        if (Number.isFinite(s)) out.timeout_ms = Math.round(s * 1000);
        delete out.timeout_s;
      }
      break;
    }
    default:
      break;
  }

  switch (canon) {
    case "list_dir": {
      const d = out.target_directory;
      if (d == null || d === "" || d === "./" || d === ".\\") {
        out.target_directory = ".";
      } else if (typeof d === "string") {
        out.target_directory =
          d.replace(/\\/g, "/").replace(/\/+$/, "") || ".";
      }
      break;
    }
    case "read_file": {
      if (typeof out.target_file === "string") {
        out.target_file = out.target_file.replace(/\\/g, "/");
      }
      break;
    }
    case "write":
    case "search_replace": {
      if (typeof out.file_path === "string") {
        out.file_path = out.file_path.replace(/\\/g, "/");
      }
      break;
    }
    case "grep": {
      if (out.path == null || out.path === "") out.path = ".";
      if (typeof out.path === "string") {
        out.path = out.path.replace(/\\/g, "/");
      }
      break;
    }
    case "glob": {
      if (typeof out.pattern === "string") {
        out.pattern = out.pattern.replace(/\\/g, "/");
      }
      break;
    }
    case "run_terminal_command": {
      if (out.timeout_ms == null) out.timeout_ms = 30_000;
      break;
    }
    case "calc": {
      if (typeof out.expression === "string") {
        // Trim only; preserve expression for hard checks that want exact match
        out.expression = out.expression.trim();
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** Cache key for a tool invocation. */
export function toolFingerprint(
  name: string,
  args: Record<string, unknown>,
): string {
  const n = normalizeToolArgs(name, args);
  return `${canonicalToolName(name)}:${stableJson(n)}`;
}

/** Parse tool arguments JSON with repair. */
export function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return { _value: v };
  } catch {
    // Try mild repair: trailing commas
    try {
      const repaired = raw.replace(/,\s*([}\]])/g, "$1");
      const v = JSON.parse(repaired);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
    } catch {
      /* */
    }
    return { _raw: raw };
  }
}
