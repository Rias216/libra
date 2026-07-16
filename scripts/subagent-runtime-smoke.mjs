/**
 * Scripted multi-agent runtime smoke against shipped SubagentRuntime.
 * Usage (from repo root): bun scripts/subagent-runtime-smoke.mjs [out.log]
 */
import { writeFileSync } from "node:fs";
import { SubagentRuntime } from "../src/agent/subagent/runtime.ts";
import {
  buildMultiAgentTools,
  buildPeerTools,
  buildPeerChildSystemAddon,
  buildMultiAgentSystemAddon,
} from "../src/agent/subagent/tools.ts";
import { listSpawnableRoles } from "../src/agent/subagent/roles.ts";
import {
  isParentAgentId,
  formatParentMailboxNotices,
} from "../src/agent/subagent/types.ts";

const outPath =
  process.argv[2] ||
  "C:/Users/rias/AppData/Local/Temp/grok-goal-60a0c01374ae/implementer/subagent-runtime.log";

const lines = [];
const log = (m) => {
  lines.push(String(m));
  console.log(m);
};

function okResult(content) {
  return {
    content,
    tool_calls: [],
    finish_reason: "stop",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const chatImpl = async (req) => {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  const content = String(last?.content ?? "");
  if (content.includes("[peer message") || content.includes("PEER")) {
    return okResult(`got-peer:${content.slice(0, 64)}`);
  }
  return okResult(`summary:${content.slice(0, 48)}`);
};

const rt = new SubagentRuntime({
  parentProvider: "openai",
  parentModel: "gpt-test",
  cwd: process.cwd(),
  depth: 0,
  config: {
    enabled: true,
    maxConcurrent: 6,
    maxDepth: 1,
    jobMaxRuntimeSeconds: 30,
    autoSpawn: false,
    peerMessaging: true,
    roles: [],
  },
  chatImpl,
});
rt.beginTurn("smoke");

const a = await rt.spawn({ agent_type: "explorer", message: "map A" });
const b = await rt.spawn({ agent_type: "worker", message: "build B" });
log(`spawn A ok=${a.ok} id=${a.agent_id} status=${a.status}`);
log(`spawn B ok=${b.ok} id=${b.agent_id} status=${b.status}`);
if (a.agent_id === b.agent_id) throw new Error("ids must differ");

const wait = await rt.wait({
  agent_ids: [String(a.agent_id), String(b.agent_id)],
  timeout_ms: 15_000,
});
log(`wait ok=${wait.ok}`);
for (const row of wait.agents) {
  log(
    `  agent ${row.agent_id} status=${row.status} resultLen=${String(row.result ?? "").length}`,
  );
  if (!row.result) throw new Error("empty summary");
}

const idA = String(a.agent_id);
const resumed = await rt.spawn({
  resume_from: idA,
  message: "second pass refine",
});
log(`resume ok=${resumed.ok} id=${resumed.agent_id}`);
await rt.wait({ agent_ids: [idA], timeout_ms: 15_000 });
const th = rt.getThread(idA);
const users = th.history.filter((h) => h.role === "user").map((h) => h.content);
log(`resume users=${JSON.stringify(users)}`);
if (!users.includes("map A") || !users.includes("second pass refine")) {
  throw new Error("resume history missing messages");
}

const peer = await rt.messageAgent(
  { agent_id: String(b.agent_id), message: "PEER findings src/x.ts:1" },
  idA,
);
log(`peer handoff ok=${peer.ok}`);
await rt.wait({ agent_ids: [String(b.agent_id)], timeout_ms: 15_000 });
const thB = rt.getThread(String(b.agent_id));
log(`peer result=${thB.result}`);
if (!/got-peer|PEER|findings/i.test(String(thB.result ?? ""))) {
  throw new Error("peer payload not reflected in B result");
}

const toRoot = await rt.messageAgent(
  { agent_id: "parent", message: "ROOT progress from child" },
  idA,
);
log(
  `child→root ok=${toRoot.ok} delivered_to=${toRoot.delivered_to} from=${toRoot.from}`,
);
if (toRoot.delivered_to !== "parent_mailbox") {
  throw new Error("parent mailbox miss");
}
const notices = rt.drainCompletionNotices();
log(`parent notices:\n${notices}`);
if (!notices.includes("ROOT progress") || !notices.includes("agent_message")) {
  throw new Error("parent drain missing child message");
}

const deep = new SubagentRuntime({
  parentProvider: "openai",
  parentModel: "gpt-test",
  cwd: process.cwd(),
  depth: 1,
  config: {
    enabled: true,
    maxConcurrent: 4,
    maxDepth: 1,
    jobMaxRuntimeSeconds: 10,
    autoSpawn: false,
    peerMessaging: true,
    roles: [],
  },
  chatImpl,
});
const denied = await deep.spawn({ message: "nope" });
log(`over-depth spawn ok=${denied.ok} code=${denied.code}`);
if (denied.ok || denied.code !== "max_depth") {
  throw new Error("depth deny failed");
}
log(`over-depth schemas empty=${deep.schemas().length === 0}`);

// Shared-runtime nested depth: maxDepth=2, A spawns B, B cannot spawn C
const nest = new SubagentRuntime({
  parentProvider: "openai",
  parentModel: "gpt-test",
  cwd: process.cwd(),
  depth: 0,
  config: {
    enabled: true,
    maxConcurrent: 8,
    maxDepth: 2,
    jobMaxRuntimeSeconds: 30,
    autoSpawn: true,
    peerMessaging: true,
    roles: [],
  },
  chatImpl,
});
nest.beginTurn("nested");
const na = await nest.spawn({ agent_type: "worker", message: "A" });
const idNA = String(na.agent_id);
await nest.wait({ agent_ids: [idNA], timeout_ms: 15_000 });
const nb = await nest.dispatch(
  "spawn_agent",
  { agent_type: "explorer", message: "B from A" },
  idNA,
);
log(`nested A→B ok=${nb.ok} depth=${nb.data?.depth} spawned_by=${nb.data?.spawned_by}`);
if (!nb.ok || nb.data?.depth !== 2) throw new Error("A→B depth should be 2");
const idNB = String(nb.data.agent_id);
await nest.wait({ agent_ids: [idNB], timeout_ms: 15_000 });
const nc = await nest.dispatch(
  "spawn_agent",
  { message: "C from B — must deny" },
  idNB,
);
log(`nested B→C ok=${nc.ok} code=${nc.data?.code} caller_depth=${nc.data?.caller_depth}`);
if (nc.ok || nc.data?.code !== "max_depth") {
  throw new Error("B→C must be denied at maxDepth=2");
}
const peers = buildPeerTools();
log(`peer tools=${peers.map((t) => t.function.name).join(",")}`);
if (peers.some((t) => t.function.name === "spawn_agent")) {
  throw new Error("peer tools must not include spawn");
}

const roles = listSpawnableRoles([]);
const full = buildMultiAgentTools(roles);
log(`root tools=${full.map((t) => t.function.name).join(",")}`);
const msgTool = full.find((t) => t.function.name === "message_agent");
log(
  `message_agent desc has parent=${/parent|root/i.test(msgTool.function.description)}`,
);
const addon = buildMultiAgentSystemAddon({
  roles,
  maxThreads: 6,
  maxDepth: 1,
  proactive: false,
  peerMessaging: true,
});
log(`addon parent messaging=${/parent|root|child/i.test(addon)}`);
log(
  `child addon parent=${/parent|root/i.test(buildPeerChildSystemAddon("agent_x"))}`,
);
log(
  `isParentAgentId parent=${isParentAgentId("parent")} root=${isParentAgentId("root")}`,
);
log(
  `format sample=${formatParentMailboxNotices([{ from: "a1", message: "hi", at: 1 }]).slice(0, 80)}`,
);

log("SMOKE_OK");
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`wrote ${outPath}`);
process.exit(0);
