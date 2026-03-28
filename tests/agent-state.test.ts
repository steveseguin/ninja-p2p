import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getInboxSummary,
  listQueuedAgentActions,
  queueAgentAction,
  writePeersSnapshot,
  storeInboxMessage,
  takeInboxMessages,
  writeAgentSession,
} from "../src/agent-state.js";
import { createEnvelope, type PeerIdentity } from "../src/protocol.js";

const identity: PeerIdentity = {
  streamId: "worker_bot",
  role: "agent",
  name: "Worker",
  instanceId: "abcd1234",
};

test("queueAgentAction writes sortable outbox files", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-state-"));
  try {
    queueAgentAction(dir, { kind: "chat", text: "hello" });
    queueAgentAction(dir, { kind: "dm", target: "human", text: "ping" });
    queueAgentAction(dir, { kind: "response", target: "planner", requestId: "req_123", result: { ok: true } });
    queueAgentAction(dir, { kind: "send_file", target: "worker", filePath: "C:\\temp\\notes.txt", transferKind: "file" });
    queueAgentAction(dir, { kind: "event", topic: "events", eventKind: "task_done", data: { ticket: 1 } });
    const queued = listQueuedAgentActions(dir);
    assert.equal(queued.length, 5);
    assert.equal(queued[0].action.kind, "chat");
    assert.equal(queued[1].action.kind, "dm");
    assert.equal(queued[2].action.kind, "response");
    assert.equal(queued[3].action.kind, "send_file");
    assert.equal(queued[4].action.kind, "event");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storeInboxMessage and takeInboxMessages round-trip envelopes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-state-"));
  try {
    const message = createEnvelope(identity, "chat", { text: "hello" });
    storeInboxMessage(dir, message);
    const read = takeInboxMessages(dir, 10, false);
    assert.equal(read.length, 1);
    assert.deepEqual(read[0].envelope, message);
    assert.equal(takeInboxMessages(dir, 10, true).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getInboxSummary reports senders and stale sessions", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-state-"));
  try {
    writeAgentSession(dir, {
      room: "demo",
      streamId: "codex",
      name: "Codex",
      role: "agent",
      stateDir: dir,
      pid: process.pid,
      connected: true,
      skills: ["cli", "command"],
      topics: ["events"],
      agentProfile: {
        runtime: "codex-cli",
        asks: [{ name: "review", description: "Review a patch" }],
      },
      sharedFolders: [],
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    });
    writePeersSnapshot(dir, [
      {
        streamId: "worker",
        name: "Worker",
        role: "agent",
        connected: true,
        status: "idle",
        statusDetail: "",
        agentProfile: {
          summary: "Implements small patches",
          can: ["edit", "tests"],
          asks: [{ name: "implement", description: "Implement a scoped change" }],
          shares: [{ name: "docs" }],
        },
      },
      { streamId: "human", connected: false },
    ]);

    storeInboxMessage(dir, createEnvelope(identity, "chat", { text: "hello" }));
    storeInboxMessage(dir, createEnvelope(identity, "command", { command: "status" }));
    storeInboxMessage(dir, createEnvelope(identity, "event", { kind: "peer_discovered" }));

    const summary = getInboxSummary(dir);
    assert.equal(summary.connected, true);
    assert.equal(summary.pending, 3);
    assert.equal(summary.peersKnown, 2);
    assert.equal(summary.peersConnected, 1);
    assert.equal(summary.senders[0]?.streamId, "worker_bot");
    assert.equal(summary.senders[0]?.count, 3);
    assert.deepEqual(summary.types, [
      { type: "chat", count: 1 },
      { type: "command", count: 1 },
      { type: "event", count: 1 },
    ]);
    assert.deepEqual(summary.commands, [{ name: "status", count: 1 }]);
    assert.deepEqual(summary.events, [{ kind: "peer_discovered", count: 1 }]);
    assert.deepEqual(summary.peers, [
      {
        streamId: "worker",
        name: "Worker",
        role: "agent",
        connected: true,
        status: "idle",
        statusDetail: "",
        summary: "Implements small patches",
        can: ["edit", "tests"],
        asks: [{ name: "implement", description: "Implement a scoped change" }],
        shares: [{ name: "docs" }],
      },
      {
        streamId: "human",
        name: "human",
        role: "unknown",
        connected: false,
        status: "unknown",
        statusDetail: "",
        summary: null,
        can: [],
        asks: [],
        shares: [],
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
