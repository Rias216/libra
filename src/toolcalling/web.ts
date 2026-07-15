/**
 * Web tools — search + fetch for the agent harness.
 * No API key required: DuckDuckGo HTML/lite + Instant Answer, Wikipedia fallback.
 */

const UA =
  "Mozilla/5.0 (compatible; LibraHarness/0.1; +https://github.com/libra-tui)";
const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_CHARS = 24_000;
const MAX_SNIPPET = 400;

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

export interface WebSearchResult {
  ok: boolean;
  query: string;
  results: WebSearchHit[];
  provider: string;
  error?: string;
}

export interface WebFetchResult {
  ok: boolean;
  status: number;
  url: string;
  finalUrl?: string;
  contentType?: string;
  title?: string;
  content: string;
  truncated?: boolean;
  error?: string;
}

function timeoutSignal(
  ms: number,
  parent?: AbortSignal,
): AbortSignal {
  const t = AbortSignal.timeout(ms);
  if (parent && typeof AbortSignal.any === "function") {
    return AbortSignal.any([parent, t]);
  }
  if (parent?.aborted) {
    return parent;
  }
  return t;
}

/** DuckDuckGo Instant Answer API (free, no key) — good for facts / abstracts. */
async function ddgInstant(
  query: string,
  signal?: AbortSignal,
): Promise<WebSearchHit[]> {
  const url =
    "https://api.duckduckgo.com/?" +
    new URLSearchParams({
      q: query,
      format: "json",
      no_html: "1",
      skip_disambig: "1",
    }).toString();
  const res = await fetch(url, {
    signal: timeoutSignal(SEARCH_TIMEOUT_MS, signal),
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: Array<{
      Text?: string;
      FirstURL?: string;
      Topics?: Array<{ Text?: string; FirstURL?: string }>;
    }>;
    Results?: Array<{ Text?: string; FirstURL?: string }>;
  };
  const hits: WebSearchHit[] = [];
  if (data.AbstractText && data.AbstractURL) {
    hits.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      snippet: data.AbstractText.slice(0, MAX_SNIPPET),
      source: "ddg-instant",
    });
  }
  const pushRelated = (t: { Text?: string; FirstURL?: string }) => {
    if (!t.FirstURL || !t.Text) return;
    hits.push({
      title: t.Text.split(" - ")[0]!.slice(0, 120),
      url: t.FirstURL,
      snippet: t.Text.slice(0, MAX_SNIPPET),
      source: "ddg-related",
    });
  };
  for (const r of data.Results ?? []) pushRelated(r);
  for (const rt of data.RelatedTopics ?? []) {
    if (rt.FirstURL) pushRelated(rt);
    for (const nested of rt.Topics ?? []) pushRelated(nested);
  }
  return hits;
}

/**
 * DuckDuckGo HTML search results page (no key).
 * Parses classic result blocks; best-effort if markup shifts.
 */
async function ddgHtmlSearch(
  query: string,
  signal?: AbortSignal,
): Promise<WebSearchHit[]> {
  const url =
    "https://html.duckduckgo.com/html/?" +
    new URLSearchParams({ q: query }).toString();
  const res = await fetch(url, {
    signal: timeoutSignal(SEARCH_TIMEOUT_MS, signal),
    headers: {
      "User-Agent": UA,
      Accept: "text/html",
    },
    redirect: "follow",
  });
  if (!res.ok) return [];
  const html = await res.text();
  return parseDdgHtml(html);
}

export function parseDdgHtml(html: string): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  // Result links: class="result__a" href="..."
  const re =
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>|class="result__snippet"[^>]*>([\s\S]*?)<)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && hits.length < 12) {
    let href = decodeHtml(m[1] ?? "");
    // DDG redirect: //duckduckgo.com/l/?uddg=<encoded>
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]!);
      } catch {
        /* keep */
      }
    }
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:\/\//i.test(href)) continue;
    if (/duckduckgo\.com/i.test(href) && !uddg) continue;
    const title = stripTags(m[2] ?? "").trim();
    const snippet = stripTags(m[3] ?? m[4] ?? "").trim();
    if (!title) continue;
    hits.push({
      title: title.slice(0, 200),
      url: href,
      snippet: snippet.slice(0, MAX_SNIPPET),
      source: "ddg-html",
    });
  }
  // Fallback simpler pattern
  if (hits.length === 0) {
    const re2 =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re2.exec(html)) !== null && hits.length < 10) {
      let href = decodeHtml(m[1] ?? "");
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) {
        try {
          href = decodeURIComponent(uddg[1]!);
        } catch {
          /* */
        }
      }
      if (href.startsWith("//")) href = "https:" + href;
      if (!/^https?:\/\//i.test(href)) continue;
      hits.push({
        title: stripTags(m[2] ?? "").slice(0, 200),
        url: href,
        snippet: "",
        source: "ddg-html",
      });
    }
  }
  return hits;
}

/** Wikipedia OpenSearch as last-resort provider. */
async function wikiSearch(
  query: string,
  signal?: AbortSignal,
): Promise<WebSearchHit[]> {
  const url =
    "https://en.wikipedia.org/w/api.php?" +
    new URLSearchParams({
      action: "opensearch",
      search: query,
      limit: "8",
      namespace: "0",
      format: "json",
      origin: "*",
    }).toString();
  const res = await fetch(url, {
    signal: timeoutSignal(SEARCH_TIMEOUT_MS, signal),
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as [
    string,
    string[],
    string[],
    string[],
  ];
  const titles = data[1] ?? [];
  const descs = data[2] ?? [];
  const links = data[3] ?? [];
  const hits: WebSearchHit[] = [];
  for (let i = 0; i < titles.length; i++) {
    hits.push({
      title: titles[i]!,
      url: links[i] ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(titles[i]!)}`,
      snippet: (descs[i] ?? "").slice(0, MAX_SNIPPET),
      source: "wikipedia",
    });
  }
  return hits;
}

function dedupeHits(hits: WebSearchHit[]): WebSearchHit[] {
  const seen = new Set<string>();
  const out: WebSearchHit[] = [];
  for (const h of hits) {
    const key = h.url.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * Multi-provider web search. Prefer DDG HTML, merge Instant Answer + wiki.
 */
export async function webSearch(
  query: string,
  opts?: { maxResults?: number; signal?: AbortSignal },
): Promise<WebSearchResult> {
  const q = query.trim();
  if (!q) {
    return {
      ok: false,
      query: q,
      results: [],
      provider: "none",
      error: "empty query",
    };
  }
  const max = opts?.maxResults ?? 8;
  const signal = opts?.signal;
  const providers: string[] = [];
  let hits: WebSearchHit[] = [];
  const errors: string[] = [];

  try {
    const htmlHits = await ddgHtmlSearch(q, signal);
    if (htmlHits.length) {
      hits = hits.concat(htmlHits);
      providers.push("ddg-html");
    }
  } catch (e) {
    errors.push(`ddg-html: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const instant = await ddgInstant(q, signal);
    if (instant.length) {
      hits = instant.concat(hits);
      providers.push("ddg-instant");
    }
  } catch (e) {
    errors.push(`ddg-instant: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (hits.length < 3) {
    try {
      const wiki = await wikiSearch(q, signal);
      if (wiki.length) {
        hits = hits.concat(wiki);
        providers.push("wikipedia");
      }
    } catch (e) {
      errors.push(`wikipedia: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  hits = dedupeHits(hits).slice(0, max);
  if (hits.length === 0) {
    return {
      ok: false,
      query: q,
      results: [],
      provider: providers.join("+") || "none",
      error: errors.join("; ") || "no results",
    };
  }
  return {
    ok: true,
    query: q,
    results: hits,
    provider: providers.join("+") || "unknown",
  };
}

export function formatWebSearchForModel(r: WebSearchResult): string {
  if (!r.ok && r.results.length === 0) {
    return `web_search failed for "${r.query}": ${r.error ?? "unknown"}\nProviders tried: ${r.provider}`;
  }
  const lines = [
    `Query: ${r.query}`,
    `Provider: ${r.provider}`,
    `Results (${r.results.length}):`,
    "",
  ];
  r.results.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.title}`);
    lines.push(`   URL: ${h.url}`);
    if (h.snippet) lines.push(`   ${h.snippet}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}

/** Upgrade http→https when safe; validate URL. */
export function normalizeFetchUrl(raw: string): string {
  let u = raw.trim();
  if (!u) throw new Error("url is empty");
  if (!/^https?:\/\//i.test(u)) {
    // allow bare domains
    if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(u)) {
      u = "https://" + u;
    } else {
      throw new Error("url must be http(s) or a bare domain");
    }
  }
  // upgrade http → https for public fetches (many sites redirect anyway)
  if (u.startsWith("http://")) {
    u = "https://" + u.slice("http://".length);
  }
  const parsed = new URL(u);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("unsupported protocol");
  }
  return parsed.toString();
}

/**
 * HTML → readable text: strip scripts/styles, tags, collapse whitespace.
 * Also pull <title> when present.
 */
export function htmlToText(html: string): { title?: string; text: string } {
  let s = html;
  const titleM = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM
    ? decodeHtml(stripTags(titleM[1]!)).trim()
    : undefined;
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ");
  s = stripTags(s);
  s = decodeHtml(s);
  s = s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { title, text: s };
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

export function decodeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

export async function webFetchUrl(
  rawUrl: string,
  opts?: { signal?: AbortSignal; maxChars?: number },
): Promise<WebFetchResult> {
  let url: string;
  try {
    url = normalizeFetchUrl(rawUrl);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      url: rawUrl,
      content: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const maxChars = opts?.maxChars ?? MAX_FETCH_CHARS;
  try {
    const res = await fetch(url, {
      signal: timeoutSignal(FETCH_TIMEOUT_MS, opts?.signal),
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      },
      redirect: "follow",
    });
    const contentType = res.headers.get("content-type") ?? undefined;
    const finalUrl = res.url || url;
    const buf = await res.arrayBuffer();
    // Reject obvious binary
    const bytes = new Uint8Array(buf.slice(0, 16));
    if (
      bytes.length >= 4 &&
      ((bytes[0] === 0x89 && bytes[1] === 0x50) || // PNG
        (bytes[0] === 0xff && bytes[1] === 0xd8) || // JPEG
        (bytes[0] === 0x25 && bytes[1] === 0x50) || // PDF %P
        (bytes[0] === 0x50 && bytes[1] === 0x4b)) // ZIP
    ) {
      return {
        ok: false,
        status: res.status,
        url,
        finalUrl,
        contentType,
        content: "",
        error: "binary content not supported by web_fetch (use specialized tools)",
      };
    }
    let raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    let title: string | undefined;
    const isHtml =
      /html/i.test(contentType ?? "") ||
      /^\s*</.test(raw.slice(0, 200));
    if (isHtml) {
      const converted = htmlToText(raw);
      title = converted.title;
      raw = converted.text;
    }
    let truncated = false;
    if (raw.length > maxChars) {
      raw = raw.slice(0, maxChars) + "\n\n…[truncated]";
      truncated = true;
    }
    return {
      ok: res.ok,
      status: res.status,
      url,
      finalUrl,
      contentType,
      title,
      content: raw,
      truncated,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      url,
      content: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function formatWebFetchForModel(r: WebFetchResult): string {
  if (!r.ok && !r.content) {
    return `web_fetch failed: ${r.error ?? "unknown"} (url=${r.url})`;
  }
  const head = [
    `URL: ${r.finalUrl ?? r.url}`,
    r.status ? `HTTP ${r.status}` : null,
    r.title ? `Title: ${r.title}` : null,
    r.contentType ? `Content-Type: ${r.contentType}` : null,
    r.truncated ? "truncated: true" : null,
  ]
    .filter(Boolean)
    .join("\n");
  return `${head}\n\n${r.content || "(empty)"}`;
}
