#!/usr/bin/env bun
/**
 * OUTSIDE the Libra agent loop.
 *
 * After a self-review / self-upgrade:
 *  1. Wait for the Libra process to finish (or for a status signal)
 *  2. typecheck + build the install
 *  3. If that fails → restore the pre-review source backup, rebuild
 *  4. Relaunch Libra into the same .libe session
 *
 * Usage:
 *   bun scripts/self-review-relaunch.mjs --handoff <path-to-handoff.json>
 *
 * Also installed to ~/.libra/self-review/relaunch.mjs so it still runs
 * even if the live tree is mid-breakage.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function log(msg, handoff) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
  try {
    if (handoff?.logPath) {
      mkdirSync(dirname(handoff.logPath), { recursive: true });
      writeFileSync(handoff.logPath, line + "\n", { flag: "a" });
    }
  } catch {
    /* */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function run(cmd, args, cwd, timeoutMs = 180_000) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
    windowsHide: true,
    shell: false,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").slice(-4000),
    stderr: (r.stderr || "").slice(-4000),
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

function restoreBackup(backupDir, libraRoot) {
  const manPath = join(backupDir, "MANIFEST.json");
  if (!existsSync(manPath)) {
    throw new Error(`MANIFEST missing in backup: ${backupDir}`);
  }
  const manifest = JSON.parse(readFileSync(manPath, "utf8"));
  const files = manifest.files || [];
  let n = 0;
  for (const rel of files) {
    const src = join(backupDir, ...String(rel).split("/"));
    if (!existsSync(src)) continue;
    const dest = join(libraRoot, ...String(rel).split("/"));
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      n++;
    } catch {
      /* skip one file */
    }
  }
  return { restored: n, id: manifest.id };
}

function verifyInstall(bunExe, libraRoot, handoff) {
  log("verify: typecheck…", handoff);
  const tc = run(bunExe, ["run", "typecheck"], libraRoot, 300_000);
  if (!tc.ok) {
    log(`typecheck FAILED: ${tc.stderr || tc.stdout || tc.error}`, handoff);
    return { ok: false, step: "typecheck", detail: tc };
  }
  log("verify: build…", handoff);
  const build = run(bunExe, ["run", "build"], libraRoot, 300_000);
  if (!build.ok) {
    log(`build FAILED: ${build.stderr || build.stdout || build.error}`, handoff);
    return { ok: false, step: "build", detail: build };
  }
  // Smoke: can we load the CLI?
  const cliJs = join(libraRoot, "dist", "cli.js");
  const cliTs = join(libraRoot, "src", "cli.ts");
  let smoke;
  if (existsSync(cliJs)) {
    smoke = run(bunExe, [cliJs, "--version"], libraRoot, 30_000);
  } else if (existsSync(cliTs)) {
    smoke = run(bunExe, [cliTs, "--version"], libraRoot, 30_000);
  } else {
    return { ok: false, step: "smoke", detail: { error: "no dist/cli.js or src/cli.ts" } };
  }
  if (!smoke.ok) {
    log(`smoke --version FAILED: ${smoke.stderr || smoke.stdout || smoke.error}`, handoff);
    return { ok: false, step: "smoke", detail: smoke };
  }
  log(`verify ok: ${String(smoke.stdout || "").trim()}`, handoff);
  return { ok: true };
}

function launchLibra(bunExe, libraRoot, handoff, notice) {
  const cliJs = join(libraRoot, "dist", "cli.js");
  const cliTs = join(libraRoot, "src", "cli.ts");
  const entry = existsSync(cliJs) ? cliJs : cliTs;
  const args = [entry];
  if (handoff.sessionPath) {
    args.push(`--resume=${handoff.sessionPath}`);
  }
  if (notice) {
    args.push(`--notice=${notice}`);
  }
  if (handoff.theme) {
    args.push(`--theme=${handoff.theme}`);
  }
  const cwd = handoff.userCwd || process.cwd();
  log(`launch: ${bunExe} ${args.join(" ")} (cwd=${cwd})`, handoff);

  const child = spawn(bunExe, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: {
      ...process.env,
      LIBRA_SELF_REVIEW_RELAUNCH: "1",
    },
  });
  child.unref();
  return child.pid ?? 0;
}

async function waitForParentOrDone(handoff) {
  const maxMs = handoff.maxWaitMs ?? 3 * 60 * 60 * 1000; // 3h
  const start = Date.now();
  let lastStatus = null;

  while (Date.now() - start < maxMs) {
    const st = readJson(handoff.statusPath);
    if (st?.phase && st.phase !== lastStatus) {
      lastStatus = st.phase;
      log(`status: ${st.phase}`, handoff);
    }
    if (
      st?.phase === "agent_done" ||
      st?.phase === "agent_failed" ||
      st?.phase === "request_relaunch"
    ) {
      // Give parent a moment to flush session + exit alt screen
      await sleep(800);
      // Wait until parent is gone so we don't fight for the TTY
      const deadline = Date.now() + 15_000;
      while (pidAlive(handoff.parentPid) && Date.now() < deadline) {
        await sleep(200);
      }
      if (pidAlive(handoff.parentPid)) {
        log(`parent pid ${handoff.parentPid} still alive — sending SIGTERM`, handoff);
        try {
          process.kill(handoff.parentPid, "SIGTERM");
        } catch {
          /* */
        }
        await sleep(500);
      }
      return st;
    }
    if (!pidAlive(handoff.parentPid)) {
      log("parent process exited", handoff);
      // Parent died without status — still try verify/relaunch
      await sleep(400);
      return st || { phase: "parent_exit" };
    }
    await sleep(400);
  }
  log("timeout waiting for self-review", handoff);
  return { phase: "timeout" };
}

async function main() {
  const handoffPath = arg("--handoff");
  if (!handoffPath || !existsSync(handoffPath)) {
    console.error("usage: bun self-review-relaunch.mjs --handoff <file.json>");
    process.exit(2);
  }

  const handoff = readJson(handoffPath);
  if (!handoff?.libraRoot || !handoff?.backupDir) {
    console.error("invalid handoff file");
    process.exit(2);
  }

  const bunExe = handoff.bunPath || process.execPath;
  log(`supervisor start handoff=${handoffPath}`, handoff);
  writeJson(handoff.statusPath, {
    phase: "supervisor_waiting",
    at: new Date().toISOString(),
    pid: process.pid,
  });

  const st = await waitForParentOrDone(handoff);
  log(`proceeding after ${st?.phase}`, handoff);

  // Final session flush may still be on disk from parent
  writeJson(handoff.statusPath, {
    phase: "verifying",
    at: new Date().toISOString(),
  });

  let restored = false;
  let verify = verifyInstall(bunExe, handoff.libraRoot, handoff);

  if (!verify.ok) {
    log(`install broken at ${verify.step} — restoring backup ${handoff.backupId}`, handoff);
    writeJson(handoff.statusPath, {
      phase: "restoring",
      at: new Date().toISOString(),
      failedStep: verify.step,
    });
    try {
      const r = restoreBackup(handoff.backupDir, handoff.libraRoot);
      restored = true;
      log(`restored ${r.restored} files from ${r.id}`, handoff);
    } catch (err) {
      log(`restore FAILED: ${err?.message || err}`, handoff);
      writeJson(join(homedir(), ".libra", "self-review", "last-relaunch.json"), {
        ok: false,
        restored: false,
        error: String(err?.message || err),
        at: new Date().toISOString(),
        handoffId: handoff.handoffId,
      });
      process.exit(1);
    }
    verify = verifyInstall(bunExe, handoff.libraRoot, handoff);
    if (!verify.ok) {
      log(`still broken after restore (${verify.step})`, handoff);
      writeJson(join(homedir(), ".libra", "self-review", "last-relaunch.json"), {
        ok: false,
        restored: true,
        error: `verify failed after restore: ${verify.step}`,
        at: new Date().toISOString(),
        handoffId: handoff.handoffId,
      });
      // Still try to launch something
    }
  }

  const notice = restored
    ? `Self-review relaunch: build/open failed — auto-restored source backup ${handoff.backupId}. Session resumed.`
    : `Self-review complete — relaunched into your previous session (backup ${handoff.backupId}).`;

  writeJson(join(homedir(), ".libra", "self-review", "last-relaunch.json"), {
    ok: verify.ok,
    restored,
    backupId: handoff.backupId,
    sessionPath: handoff.sessionPath,
    notice,
    at: new Date().toISOString(),
    handoffId: handoff.handoffId,
    agentPhase: st?.phase,
  });

  writeJson(handoff.statusPath, {
    phase: "launching",
    at: new Date().toISOString(),
    restored,
  });

  try {
    const pid = launchLibra(bunExe, handoff.libraRoot, handoff, notice);
    log(`launched libra pid=${pid}`, handoff);
    writeJson(handoff.statusPath, {
      phase: "launched",
      at: new Date().toISOString(),
      childPid: pid,
      restored,
    });
  } catch (err) {
    log(`launch failed: ${err?.message || err}`, handoff);
    // Last resort: restore + try again
    if (!restored) {
      try {
        restoreBackup(handoff.backupDir, handoff.libraRoot);
        verifyInstall(bunExe, handoff.libraRoot, handoff);
        const pid = launchLibra(
          bunExe,
          handoff.libraRoot,
          handoff,
          `Self-review launch failed — restored backup ${handoff.backupId} and relaunched.`,
        );
        log(`launched after emergency restore pid=${pid}`, handoff);
        process.exit(0);
      } catch (e2) {
        log(`emergency relaunch failed: ${e2?.message || e2}`, handoff);
        process.exit(1);
      }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
