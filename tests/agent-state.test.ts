import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

import {
  getInboxSummary,
  listQueuedAgentActions,
  queueAgentAction,
  prepareQueuedAgentEnvelope,
  writePeersSnapshot,
  readPeersSnapshot,
  storeInboxMessage,
  takeInboxMessages,
  writeAgentSession,
} from "../src/agent-state.js";
import { createEnvelope, parseEnvelope, type PeerIdentity } from "../src/protocol.js";

const identity: PeerIdentity = {
  streamId: "worker_bot",
  role: "agent",
  name: "Worker",
  instanceId: "abcd1234",
};

test("cached outbox envelopes must match the action recipient, type, and identity", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-outbox-envelope-"));
  try {
    const valid = queueAgentAction(dir, { kind: "command", target: "worker", command: "status" });
    const validPath = listQueuedAgentActions(dir)[0].path;
    const envelope = prepareQueuedAgentEnvelope(validPath, valid, identity)!;
    for (const [index, change] of [{ to: "different-peer" }, { type: "chat" }, { id: "different-message" }].entries()) {
      writeFileSync(path.join(dir, "outbox", `inconsistent-${index}.json`), JSON.stringify({
        ...valid, envelope: { ...envelope, ...change },
      }));
    }
    assert.deepEqual(listQueuedAgentActions(dir).map(item => item.path), [validPath]);
    assert.equal(readdirSync(path.join(dir, "outbox")).length, 4, "inconsistent work remains available for inspection");
    // Persisted sender identity survives a restart; only action/envelope agreement matters.
    assert.deepEqual(prepareQueuedAgentEnvelope(validPath, { ...valid, envelope }, { ...identity, instanceId: "restarted" }), envelope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed peer snapshot does not prevent inbox and outbox summaries", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-peers-invalid-"));
  try {
    storeInboxMessage(dir, createEnvelope(identity, "chat", { text: "waiting" }));
    queueAgentAction(dir, { kind: "dm", target: "peer", text: "queued" });
    for (const snapshot of [{ peers: [] }, "invalid", 42, true]) {
      writePeersSnapshot(dir, snapshot);
      const summary = getInboxSummary(dir);
      assert.equal(summary.pending, 1);
      assert.equal(summary.queued, 1);
      assert.equal(summary.peersKnown, 0);
      assert.deepEqual(summary.peers, []);
      assert.deepEqual(readPeersSnapshot(dir), snapshot, "reading must not rewrite the damaged snapshot");
    }
    writePeersSnapshot(dir, [null, { streamId: "peer", connected: true }]);
    assert.equal(getInboxSummary(dir).peersConnected, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed saved inbox records do not block valid mail or get consumed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-inbox-invalid-"));
  try {
    const valid = createEnvelope(identity, "chat", { text: "valid mail" });
    storeInboxMessage(dir, valid);
    const inbox = path.join(dir, "inbox");
    const malformed = [{}, [], 42, { envelope: {} }, { envelope: { ...valid, from: null } }];
    malformed.forEach((item, index) => writeFileSync(path.join(inbox, `invalid-${index}.json`), JSON.stringify(item)));
    assert.equal(getInboxSummary(dir).pending, 1);
    assert.deepEqual(takeInboxMessages(dir, 20).map(item => item.envelope.id), [valid.id]);
    assert.equal(getInboxSummary(dir).pending, 0);
    assert.equal(readdirSync(inbox).length, malformed.length);
    assert.equal(readdirSync(path.join(dir, "archive")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid inbox counts cannot archive an unintended batch of messages", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-inbox-count-"));
  try {
    for (const ts of [1, 2, 3]) storeInboxMessage(dir, { ...createEnvelope(identity, "chat", "mail"), ts });
    for (const count of [-1, -20, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      for (const peek of [false, true]) {
        assert.throws(() => takeInboxMessages(dir, count, peek), /count/);
        assert.equal(getInboxSummary(dir).pending, 3);
        assert.equal(readdirSync(path.join(dir, "archive")).length, 0);
      }
    }
    assert.deepEqual(takeInboxMessages(dir, 0), []);
    assert.equal(takeInboxMessages(dir, 2).length, 2);
    assert.equal(getInboxSummary(dir).pending, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid legacy inbox filenames remain readable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-inbox-legacy-"));
  try {
    const envelope = createEnvelope(identity, "chat", { text: "old mail" });
    mkdirSync(path.join(dir, "inbox"), { recursive: true });
    writeFileSync(path.join(dir, "inbox", "legacy-message-id.json"), JSON.stringify({ envelope, receivedAt: 123 }));
    const [item] = takeInboxMessages(dir, 1);
    assert.deepEqual(item.envelope, envelope);
    assert.equal(item.receivedAt, 123);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent inbox readers only return messages they successfully claim", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-inbox-read-"));
  const rename = fs.renameSync;
  try {
    const messages = [1, 2, 3].map(ts => ({ ...createEnvelope(identity, "chat", { text: `mail ${ts}` }), ts }));
    for (const message of messages) storeInboxMessage(dir, message);
    let raced = false;
    t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (!raced) {
        raced = true;
        rename(...args); // Another reader claims this record after our listing.
      }
      return rename(...args);
    });
    syncBuiltinESMExports();
    const taken = takeInboxMessages(dir, 1);
    assert.deepEqual(taken.map(item => item.envelope.id), [messages[1].id]);
    assert.deepEqual(takeInboxMessages(dir, 10, true).map(item => item.envelope.id), [messages[2].id]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inbox reads preserve mail when archiving is denied, and zero reads claim nothing", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-inbox-read-"));
  try {
    storeInboxMessage(dir, createEnvelope(identity, "chat", { text: "keep me" }));
    const failure = Object.assign(new Error("archive denied"), { code: "EACCES" });
    t.mock.method(fs, "renameSync", () => { throw failure; });
    syncBuiltinESMExports();
    assert.deepEqual(takeInboxMessages(dir, 0), []);
    assert.throws(() => takeInboxMessages(dir, 1), error => error === failure);
    assert.equal(takeInboxMessages(dir, 1, true).length, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic state replacement retries a temporary Windows sharing violation", { skip: process.platform !== "win32" }, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-state-lock-"));
  const rename = fs.renameSync;
  try {
    writePeersSnapshot(dir, ["old"]);
    let attempts = 0;
    t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (++attempts < 3) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      return rename(...args);
    });
    syncBuiltinESMExports();
    writePeersSnapshot(dir, ["new"]);
    assert.equal(attempts, 3);
    assert.deepEqual(readPeersSnapshot(dir), ["new"]);
    assert.equal(readdirSync(dir).some(name => name.endsWith(".tmp")), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed atomic replacement preserves old state and removes its temporary file", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-state-lock-"));
  try {
    writePeersSnapshot(dir, ["old"]);
    const failure = Object.assign(new Error("permission denied"), { code: "EPERM" });
    let attempts = 0;
    t.mock.method(fs, "renameSync", () => { attempts++; throw failure; });
    syncBuiltinESMExports();
    assert.throws(() => writePeersSnapshot(dir, ["new"]), error => error === failure);
    assert.ok(attempts <= 6, "retry must be bounded");
    assert.deepEqual(readPeersSnapshot(dir), ["old"]);
    assert.equal(readdirSync(dir).some(name => name.endsWith(".tmp")), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inbox filenames isolate peer-controlled IDs and sender collisions", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-state-"));
  try {
    for (const id of ["../escape", "..\\escape", "name:stream", "normal-id"]) {
      const message = createEnvelope(identity, "chat", { text: "hello" });
      message.id = id;
      assert.ok(parseEnvelope(message), "IDs are opaque protocol strings");
      const stored = storeInboxMessage(dir, message);
      assert.equal(path.dirname(stored.path), path.join(dir, "inbox"));
      assert.match(path.basename(stored.path), /^[A-Za-z0-9_.-]+$/);
      storeInboxMessage(dir, message);
      storeInboxMessage(dir, { ...message, from: { ...identity, streamId: "another" } });
    }
    assert.equal(readdirSync(path.join(dir, "inbox")).length, 8);
    assert.equal(takeInboxMessages(dir, 20, true).length, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("existing inbox filenames remain readable and can be archived", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-state-"));
  try {
    const message = createEnvelope(identity, "chat", { text: "existing mail" });
    mkdirSync(path.join(dir, "inbox"));
    writeFileSync(path.join(dir, "inbox", `${message.ts}_${message.id}.json`),
      JSON.stringify({ envelope: message, receivedAt: Date.now() }));
    const items = takeInboxMessages(dir);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].envelope, message);
    assert.equal(path.dirname(items[0].path), path.join(dir, "archive"));
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
