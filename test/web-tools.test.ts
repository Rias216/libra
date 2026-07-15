/**
 * Unit + live smoke tests for web_search / web_fetch.
 */
import assert from "node:assert/strict";
import {
  decodeHtml,
  htmlToText,
  normalizeFetchUrl,
  parseDdgHtml,
  webFetchUrl,
  webSearch,
} from "../src/toolcalling/web.js";
import { ToolExecutor } from "../src/toolcalling/executor.js";
import { createDefaultRegistry } from "../src/toolcalling/registry.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test("normalizeFetchUrl upgrades bare domains and http", () => {
  assert.equal(normalizeFetchUrl("example.com/path"), "https://example.com/path");
  assert.equal(
    normalizeFetchUrl("http://example.com"),
    "https://example.com/",
  );
  assert.throws(() => normalizeFetchUrl("ftp://x"), /protocol|http/i);
});

test("htmlToText strips scripts and extracts title", () => {
  const { title, text } = htmlToText(
    `<html><head><title>Hello &amp; World</title><script>evil()</script></head>` +
      `<body><h1>Hi</h1><p>Paragraph one.</p><style>.x{}</style></body></html>`,
  );
  assert.equal(title, "Hello & World");
  assert.match(text, /Hi/);
  assert.match(text, /Paragraph one/);
  assert.ok(!/evil/.test(text));
  assert.ok(!/\.x/.test(text));
});

test("parseDdgHtml extracts results from fixture markup", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Page</a>
      <a class="result__snippet">A short snippet about example.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://docs.example.org/api">API Docs</a>
      <a class="result__snippet">Official documentation</a>
    </div>
  `;
  const hits = parseDdgHtml(html);
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => /example\.com|docs\.example/.test(h.url)));
  assert.ok(hits[0]!.title.length > 0);
});

test("decodeHtml entities", () => {
  assert.equal(decodeHtml("a &amp; b &lt;c&gt;"), "a & b <c>");
});

test("registry exposes web_search schema to the model", () => {
  const reg = createDefaultRegistry();
  const names = reg.schemas().map((t) => t.function.name);
  assert.ok(names.includes("web_search"), `missing web_search in ${names}`);
  assert.ok(names.includes("web_fetch"));
});

test("web_search live returns results for a common query", async () => {
  const r = await webSearch("TypeScript official documentation site", {
    maxResults: 5,
  });
  // Network may fail in restricted envs — soft assert with diagnostics
  if (!r.ok && r.results.length === 0) {
    console.error("web_search soft-fail:", r.error, r.provider);
    // still require the function not to throw and return structure
    assert.equal(typeof r.query, "string");
    return;
  }
  assert.ok(r.results.length >= 1, JSON.stringify(r));
  assert.ok(r.results[0]!.url.startsWith("http"));
  assert.ok(r.results[0]!.title.length > 0);
});

test("web_fetch live example.com", async () => {
  const r = await webFetchUrl("example.com");
  if (!r.ok && !r.content) {
    console.error("web_fetch soft-fail:", r.error);
    assert.equal(typeof r.url, "string");
    return;
  }
  assert.ok(r.content.length > 20);
  assert.match(r.content, /Example Domain|example/i);
});

test("ToolExecutor web_search + web_fetch integration", async () => {
  const ex = new ToolExecutor(process.cwd());
  const search = await ex.run("web_search", {
    query: "MDN JavaScript Array map",
    max_results: 4,
  });
  // ok may be false if network blocked
  assert.ok(typeof search.output === "string");
  if (search.ok) {
    assert.match(search.output, /Query:|Results|http/i);
  }

  const fetchR = await ex.run("web_fetch", {
    url: "https://example.com",
  });
  if (fetchR.ok) {
    assert.match(fetchR.output, /Example|example/i);
  }
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ok  — ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL — ${t.name}`);
    console.log(e);
  }
}
console.log(`web-tools: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
