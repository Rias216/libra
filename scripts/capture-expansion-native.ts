/**
 * Capture native expansion tool outputs to a scratch dir for goal verification.
 * Usage: bun scripts/capture-expansion-native.ts --out <dir>
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { listWindows } from "../src/toolcalling/list-windows.js";
import { clipboardRead } from "../src/toolcalling/clipboard.js";
import { waitForPort } from "../src/toolcalling/wait-port.js";
import { runCheck } from "../src/toolcalling/check.js";
import { runGitTool } from "../src/toolcalling/git-tool.js";
import { ToolExecutor } from "../src/toolcalling/executor.js";
import { runScreenshot } from "../src/toolcalling/screenshot.js";
import { runBrowserDevtools } from "../src/toolcalling/browser-devtools.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const out = resolve(
  arg("--out") ??
    "C:\\Users\\rias\\AppData\\Local\\Temp\\grok-goal-035f9cef2dd1\\implementer\\native-tools",
);
const root = resolve(arg("--cwd") ?? process.cwd());
mkdirSync(out, { recursive: true });
const lines: string[] = [];

function log(s: string) {
  lines.push(s);
  console.log(s);
}

async function main() {
  try {
    const w = await listWindows();
    log(`list_windows: count=${w.length}`);
    writeFileSync(
      join(out, "list_windows.json"),
      JSON.stringify(w.slice(0, 30), null, 2),
    );
  } catch (e) {
    log(`list_windows error: ${e}`);
  }

  try {
    const c = await clipboardRead();
    log(
      `clipboard_read: ok=${c.ok} len=${(c.text ?? "").length} err=${c.error ?? ""}`,
    );
    writeFileSync(join(out, "clipboard.json"), JSON.stringify(c));
  } catch (e) {
    log(`clipboard error: ${e}`);
  }

  try {
    const closed = await waitForPort({ port: 1, timeoutMs: 400 });
    log(`wait_for_port closed: ${JSON.stringify(closed)}`);
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const open = await waitForPort({ port, timeoutMs: 2000, intervalMs: 50 });
    log(`wait_for_port open: ${JSON.stringify(open)}`);
    await new Promise<void>((r) => server.close(() => r()));
    writeFileSync(
      join(out, "wait_port.json"),
      JSON.stringify({ closed, open }, null, 2),
    );
  } catch (e) {
    log(`wait_port error: ${e}`);
  }

  try {
    const ch = await runCheck(root, { eslint: false, timeoutMs: 120_000 });
    log(`check: ok=${ch.ok} diags=${ch.diagnostics.length}`);
    writeFileSync(
      join(out, "check.json"),
      JSON.stringify(
        {
          ok: ch.ok,
          count: ch.diagnostics.length,
          sample: ch.diagnostics.slice(0, 8),
          commands: ch.commands,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    log(`check error: ${e}`);
  }

  for (const action of ["status", "diff", "log"] as const) {
    try {
      const g = await runGitTool(root, action, { limit: 3 });
      log(`git ${action}: ok=${g.ok}`);
      writeFileSync(join(out, `git-${action}.json`), JSON.stringify(g, null, 2));
    } catch (e) {
      log(`git ${action} error: ${e}`);
    }
  }

  try {
    const d = join(out, "patch-ws");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "t.txt"), "a\nb\nc\n");
    const ex = new ToolExecutor(d);
    const r = await ex.run("patch_apply", {
      diff: [
        "--- a/t.txt",
        "+++ b/t.txt",
        "@@ -1,3 +1,3 @@",
        " a",
        "-b",
        "+B",
        " c",
      ].join("\n"),
    });
    log(`patch_apply: ok=${r.ok} out=${r.output}`);
    writeFileSync(
      join(out, "patch.json"),
      JSON.stringify({ ok: r.ok, output: r.output, content: readFileSync(join(d, "t.txt"), "utf8") }),
    );
  } catch (e) {
    log(`patch error: ${e}`);
  }

  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const d = join(out, "img-ws");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "dot.png"), png);
    const ex = new ToolExecutor(d);
    const r = await ex.run("read_image", { path: "dot.png" });
    log(
      `read_image: ok=${r.ok} types=${(r.contentParts ?? []).map((p) => p.type).join(",")}`,
    );
    writeFileSync(
      join(out, "read_image.json"),
      JSON.stringify({
        ok: r.ok,
        types: (r.contentParts ?? []).map((p) => p.type),
        mime: r.data?.mimeType,
      }),
    );
  } catch (e) {
    log(`read_image error: ${e}`);
  }

  // browser tools
  const blog: string[] = [];
  try {
    const r1 = await runScreenshot(root, {
      url: "http://127.0.0.1:1/",
      engine: "cdp",
      cdp_port: 9222,
    });
    blog.push(`screenshot cdp: ok=${r1.ok} out=${String(r1.output).slice(0, 400)}`);
    const r2 = await runScreenshot(root, {
      url: "about:blank",
      engine: "playwright",
    });
    blog.push(
      `screenshot playwright: ok=${r2.ok} out=${String(r2.output).slice(0, 400)}`,
    );
    const r3 = await runBrowserDevtools(root, {
      action: "goto",
      url: "http://example.com",
      cdp_port: 9222,
    });
    blog.push(
      `browser_devtools: ok=${r3.ok} out=${String(r3.output).slice(0, 400)}`,
    );
  } catch (e) {
    blog.push(`browser tools exception: ${e}`);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  blog.push(`playwright in dependencies: ${pkg.dependencies?.playwright ?? "none"}`);
  writeFileSync(join(out, "..", "browser-tools.log"), blog.join("\n"));
  log(blog.join("\n"));

  writeFileSync(join(out, "summary.log"), lines.join("\n"));
  log(`wrote evidence under ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
