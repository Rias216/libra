/**
 * Capture browser_devtools console_log evidence against a live CDP port.
 * Usage: bun scripts/capture-console-log.ts --port 9333 --out <dir>
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runBrowserDevtools } from "../src/toolcalling/browser-devtools.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const port = Number(arg("--port") ?? 9333);
const out = resolve(
  arg("--out") ??
    "C:\\Users\\rias\\AppData\\Local\\Temp\\grok-goal-035f9cef2dd1\\implementer",
);
mkdirSync(out, { recursive: true });

async function main() {
  // Seed a console message then collect
  const seed = await runBrowserDevtools(process.cwd(), {
    action: "eval",
    expression:
      "console.log('hello-from-eval'); console.warn('warn-from-eval'); 42",
    cdp_port: port,
  });
  console.log("eval", seed.ok, String(seed.output).slice(0, 200));

  const r = await runBrowserDevtools(process.cwd(), {
    action: "console_log",
    cdp_port: port,
    wait_ms: 800,
  });
  const body = typeof r.output === "string" ? r.output : JSON.stringify(r.output);
  console.log("console_log", r.ok, body.slice(0, 1000));
  writeFileSync(join(out, "browser-console-log.json"), body);

  let parsed: { messages?: unknown[]; count?: number } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    /* ignore */
  }
  const count = parsed.count ?? (parsed.messages?.length ?? 0);
  if (!r.ok || count < 1) {
    console.error("FAIL: expected console messages, got", body.slice(0, 500));
    process.exit(1);
  }
  console.log("OK messages=", count);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
