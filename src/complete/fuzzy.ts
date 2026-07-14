/**
 * Fuzzy matcher tuned for slash commands and file paths.
 * Prefer prefix / contiguous matches so suggestions match the empty-tab order.
 */

export interface FuzzyHit {
  item: string;
  score: number;
  positions: number[];
}

/**
 * Score how well `query` matches `item`.
 * Higher is better. Returns null if no match.
 */
export function fuzzyScore(query: string, item: string): FuzzyHit | null {
  if (!query) {
    return { item, score: 0, positions: [] };
  }
  const q = query.toLowerCase().replace(/^\/+/, "");
  const t = item.toLowerCase().replace(/^\/+/, "");
  if (!q) return { item, score: 0, positions: [] };

  // Exact
  if (t === q) {
    return { item, score: 100_000, positions: range(0, item.length) };
  }

  // Prefix (command-name style) — strongest practical match
  if (t.startsWith(q)) {
    return {
      item,
      score: 50_000 - (t.length - q.length) + q.length * 10,
      positions: range(0, q.length),
    };
  }

  // Contiguous substring
  const subAt = t.indexOf(q);
  if (subAt >= 0) {
    // Prefer earlier occurrence and basename hits
    const base = basename(t);
    const inBase = base.includes(q);
    return {
      item,
      score: (inBase ? 30_000 : 15_000) - subAt * 10 - t.length + q.length * 5,
      positions: range(subAt, subAt + q.length),
    };
  }

  // Basename prefix (paths)
  const base = basename(t);
  if (base.startsWith(q)) {
    return {
      item,
      score: 40_000 - base.length,
      positions: basenamePositions(item, q.length),
    };
  }
  if (base.includes(q)) {
    const at = base.indexOf(q);
    return {
      item,
      score: 25_000 - at * 5,
      positions: basenamePositions(item, q.length, at),
    };
  }

  // Token-prefix: match start of each /-separated or camelCase token
  const tokenHit = tokenPrefixScore(q, item, t);
  if (tokenHit) return tokenHit;

  // Subsequence only if query is short enough relative to item
  // (avoids wild mismatches like "th" → random long paths)
  if (q.length >= 3 || t.length <= 12) {
    const sub = subsequenceScore(q, item, t);
    if (sub) return sub;
  }

  return null;
}

export function fuzzyFilter(
  query: string,
  items: string[],
  limit = 12,
): FuzzyHit[] {
  const q = query.trim();
  if (!q) {
    // Empty query: preserve input order (catalog order)
    return items.slice(0, limit).map((item) => ({
      item,
      score: 0,
      positions: [] as number[],
    }));
  }

  const hits: FuzzyHit[] = [];
  for (const item of items) {
    const hit = fuzzyScore(q, item);
    if (hit) hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score || a.item.localeCompare(b.item));
  return hits.slice(0, limit);
}

/**
 * Filter objects by a string key, preserving richer data.
 */
export function fuzzyFilterBy<T>(
  query: string,
  items: T[],
  keyFn: (item: T) => string,
  limit = 12,
): Array<{ item: T; score: number; key: string }> {
  const keys = items.map(keyFn);
  const hits = fuzzyFilter(query, keys, limit * 3);
  const out: Array<{ item: T; score: number; key: string }> = [];
  const used = new Set<number>();
  for (const h of hits) {
    const idx = keys.findIndex((k, i) => !used.has(i) && k === h.item);
    if (idx < 0) continue;
    used.add(idx);
    out.push({ item: items[idx]!, score: h.score, key: h.item });
    if (out.length >= limit) break;
  }
  return out;
}

function tokenPrefixScore(
  q: string,
  item: string,
  t: string,
): FuzzyHit | null {
  // Split on non-alnum
  const parts = t.split(/[^a-z0-9]+/).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith(q)) {
      const at = t.indexOf(part);
      return {
        item,
        score: 20_000 - at,
        positions: range(Math.max(0, at), Math.max(0, at) + q.length),
      };
    }
  }
  // Initials: "sr" matches "search_replace"
  if (q.length >= 2 && q.length <= 6) {
    const initials = parts.map((p) => p[0] ?? "").join("");
    if (initials.startsWith(q)) {
      return { item, score: 18_000 - t.length, positions: [] };
    }
  }
  return null;
}

function subsequenceScore(
  q: string,
  item: string,
  t: string,
): FuzzyHit | null {
  const positions: number[] = [];
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      positions.push(i);
      if (i === prev + 1) score += 20;
      else score += 6;
      if (i === 0 || isBoundary(item, i)) score += 20;
      prev = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  score += q.length * 10;
  score -= item.length;
  const span = positions[positions.length - 1]! - positions[0]! + 1;
  score -= span * 3;
  // Reject very sparse matches
  if (span > q.length * 6) return null;
  return { item, score: Math.max(1, score), positions };
}

function basename(t: string): string {
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i >= 0 ? t.slice(i + 1) : t;
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

function basenamePositions(
  item: string,
  len: number,
  offsetInBase = 0,
): number[] {
  const slash = Math.max(item.lastIndexOf("/"), item.lastIndexOf("\\"));
  const baseStart = slash + 1;
  return range(baseStart + offsetInBase, baseStart + offsetInBase + len);
}

function isBoundary(s: string, i: number): boolean {
  const c = s[i - 1];
  return (
    c === "/" ||
    c === "\\" ||
    c === "-" ||
    c === "_" ||
    c === "." ||
    c === " "
  );
}
