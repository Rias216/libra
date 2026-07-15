/**
 * Multi-agent v1 (Codex-style) unit suite — no live LLM.
 */

import { Suite, assert, assertEq, assertIncludes } from "../runner.js";
import {
  DEFAULT_AGENT_SETTINGS,
  loadAgentSettings,
  saveAgentSettings,
} from "../../../src/agent/config.js";
import {
  canonicalRoleId,
  listSpawnableRoles,
  resolveRole,
} from "../../../src/agent/subagent/roles.js";
import {
  buildMultiAgentTools,
  buildMultiAgentSystemAddon,
  isMultiAgentTool,
  MULTI_AGENT_TOOL_NAMES,
} from "../../../src/agent/subagent/tools.js";
import { SubagentRuntime } from "../../../src/agent/subagent/runtime.js";

export function suiteSubagent(): Suite {
  const s = new Suite("subagent-v1");

  s.test("role aliases map explore→explorer, implement→worker", () => {
    assertEq(canonicalRoleId("explore"), "explorer");
    assertEq(canonicalRoleId("implement"), "worker");
    assertEq(canonicalRoleId("explorer"), "explorer");
  });

  s.test("resolveRole explorer is read-only", () => {
    const r = resolveRole("explorer", DEFAULT_AGENT_SETTINGS.subagents.roles);
    assertEq(r.sandbox, "read-only");
    assert(r.permissions.write === "deny", "write denied");
    assert(r.toolsets.includes("fs"), "fs");
    assert(!r.toolsets.includes("shell"), "no shell");
  });

  s.test("resolveRole worker can write", () => {
    const r = resolveRole("worker", DEFAULT_AGENT_SETTINGS.subagents.roles);
    assertEq(r.sandbox, "workspace-write");
    assert(r.toolsets.includes("shell"), "shell");
  });

  s.test("listSpawnableRoles includes codex builtins + config", () => {
    const roles = listSpawnableRoles(DEFAULT_AGENT_SETTINGS.subagents.roles);
    const ids = new Set(roles.map((r) => r.id));
    assert(ids.has("default"), "default");
    assert(ids.has("explorer"), "explorer");
    assert(ids.has("worker"), "worker");
    assert(ids.has("review"), "review");
  });

  s.test("multi-agent tool schemas", () => {
    const roles = listSpawnableRoles(DEFAULT_AGENT_SETTINGS.subagents.roles);
    const tools = buildMultiAgentTools(roles);
    const names = tools.map((t) => t.function.name);
    for (const n of MULTI_AGENT_TOOL_NAMES) {
      assert(names.includes(n), `missing ${n}`);
      assert(isMultiAgentTool(n), n);
    }
    const spawn = tools.find((t) => t.function.name === "spawn_agent")!;
    assert(
      (spawn.function.parameters as { required?: string[] }).required?.includes(
        "message",
      ),
      "message required",
    );
  });

  s.test("system addon mentions spawn and limits", () => {
    const roles = listSpawnableRoles(DEFAULT_AGENT_SETTINGS.subagents.roles);
    const text = buildMultiAgentSystemAddon({
      roles,
      maxThreads: 6,
      maxDepth: 1,
      proactive: true,
    });
    assertIncludes(text, "spawn_agent");
    assertIncludes(text, "wait_agent");
    assertIncludes(text, "Proactive");
    assertIncludes(text, "max concurrent threads: 6");
  });

  s.test("runtime: depth >= maxDepth yields no schemas", () => {
    const rt = new SubagentRuntime({
      parentProvider: "openrouter",
      parentModel: "test",
      cwd: process.cwd(),
      depth: 1,
      config: {
        ...DEFAULT_AGENT_SETTINGS.subagents,
        maxDepth: 1,
      },
    });
    assertEq(rt.schemas().length, 0);
    assertEq(rt.canSpawn, false);
  });

  s.test("runtime: spawn requires message", async () => {
    const rt = new SubagentRuntime({
      parentProvider: "openrouter",
      parentModel: "test",
      cwd: process.cwd(),
      depth: 0,
      config: { ...DEFAULT_AGENT_SETTINGS.subagents, enabled: true },
    });
    const r = await rt.dispatch("spawn_agent", { agent_type: "explorer" });
    assert(!r.ok, "should fail");
    assertIncludes(r.output.toLowerCase(), "message");
  });

  s.test("runtime: list_agents empty", async () => {
    const rt = new SubagentRuntime({
      parentProvider: "openrouter",
      parentModel: "test",
      cwd: process.cwd(),
      depth: 0,
      config: { ...DEFAULT_AGENT_SETTINGS.subagents },
    });
    const r = await rt.dispatch("list_agents", {});
    assert(r.ok, r.output);
    const data = JSON.parse(r.output) as { agents: unknown[] };
    assertEq(data.agents.length, 0);
  });

  s.test("runtime: max_depth spawn denied at child depth", async () => {
    const rt = new SubagentRuntime({
      parentProvider: "openrouter",
      parentModel: "test",
      cwd: process.cwd(),
      depth: 1,
      config: {
        ...DEFAULT_AGENT_SETTINGS.subagents,
        maxDepth: 1,
      },
    });
    const r = await rt.dispatch("spawn_agent", {
      agent_type: "explorer",
      message: "map the codebase",
    });
    assert(!r.ok, "depth deny");
    assertIncludes(r.output, "max_depth");
  });

  s.test("config defaults match Codex (threads=6, depth=1)", () => {
    // Don't clobber user config permanently — only check DEFAULT
    assertEq(DEFAULT_AGENT_SETTINGS.subagents.maxConcurrent, 6);
    assertEq(DEFAULT_AGENT_SETTINGS.subagents.maxDepth, 1);
    assertEq(DEFAULT_AGENT_SETTINGS.subagents.jobMaxRuntimeSeconds, 600);
  });

  s.test("ultra forces autoSpawn + subagents enabled", () => {
    const prev = loadAgentSettings();
    try {
      const ultra = saveAgentSettings({ reasoning: { custom: "ultra" } });
      assert(ultra.subagents.enabled, "enabled");
      assert(ultra.subagents.autoSpawn, "autoSpawn");
      const fusion = saveAgentSettings({
        reasoning: { custom: "ultra-fusion" },
      });
      assert(fusion.subagents.autoSpawn, "fusion autoSpawn");
    } finally {
      // restore prior custom mode best-effort
      saveAgentSettings({
        reasoning: { custom: prev.reasoning.custom },
        subagents: prev.subagents,
      });
    }
  });

  return s;
}
