import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildMenuText,
  buildRoomText,
  buildSidecarCommandResponse,
  composeSidecarAgentProfile,
  createFileTransferEventEnvelope,
  createPeerNoticeEnvelope,
  getAgentStatus,
  flushAgentOutbox,
  handleSidecarHandoff,
  maybeHandleSidecarCommand,
  recordPeerNotice,
  SIDECAR_TOPICS,
} from "../src/cli.js";
import { getAgentReceipt, getInboxSummary, listQueuedAgentActions, pruneAgentArchive, queueAgentAction, storeInboxMessage, takeInboxMessages, writeAgentSession, writePeersSnapshot } from "../src/agent-state.js";
import { createEnvelope, type MessageEnvelope, type PeerIdentity } from "../src/protocol.js";
import { HANDOFF_SKILL, HANDOFF_TTL_MS, readHandoffStatus, writeHandoffStatus } from "../src/handoff.js";
import { VDOBridge } from "../src/vdo-bridge.js";
import { MessageBus } from "../src/message-bus.js";
import { PeerRegistry } from "../src/peer-registry.js";
import { DEFAULT_SSN_TOPIC } from "../src/social-stream.js";

test("npm symlink commands run their entry points on Unix", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-bin-links-"));
  try {
    for (const [source, command, expected] of [
      ["../src/cli.ts", "ninja-p2p", /worker setup/],
      ["../runtime/call-server.mjs", "ninja-p2p-call", /ninja-p2p-call/],
      ["../runtime/relay-server.cjs", "ninja-p2p-relay", /ninja-p2p-relay/],
    ] as const) {
      const alias = path.join(dir, command);
      symlinkSync(fileURLToPath(new URL(source, import.meta.url)), alias);
      const result = spawnSync(process.execPath, ["--import", "tsx", alias, "--help"], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, expected);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("wait honors its timeout even when the polling interval is much longer", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-wait-timeout-"));
  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "wait", "--state-dir", dir, "--timeout", "50", "--interval", "60000",
    ], { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.timedOut, true);
    assert.equal(summary.pending, 0);
    assert.ok(summary.waitedMs >= 50);
    assert.ok(summary.waitedMs < 2000, `waited ${summary.waitedMs}ms despite a 50ms timeout`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start reports relay mistakes instead of detaching an agent that will fail", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-start-relay-"));
  const start = (...args: string[]) => spawnSync(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
    "start", "--room", "relay-check", "--state-dir", dir, ...args,
  ], {
    encoding: "utf8", timeout: 5000, windowsHide: true,
    env: { ...process.env, NINJA_TRANSPORT: undefined, NINJA_RELAY_CONFIG: undefined },
  });
  try {
    const missing = start("--transport", "http", "--relay-config", path.join(dir, "missing.json"));
    assert.equal(missing.status, 1, missing.stdout);
    assert.match(missing.stderr, /Cannot read relay config/);

    const config = path.join(dir, "relay.json");
    writeFileSync(config, JSON.stringify({ url: "https://relay.example.com", token: "t".repeat(32), key: "not-hex" }));
    const badKey = start("--transport", "http", "--relay-config", config);
    assert.equal(badKey.status, 1, badKey.stdout);
    assert.match(badKey.stderr, /64 hexadecimal characters/);

    const ignored = start("--relay-config", config);
    assert.equal(ignored.status, 1, ignored.stdout);
    assert.match(ignored.stderr, /--relay-config needs --transport http/);

    const created = readdirSync(dir);
    assert.ok(!created.includes("agent.log") && !created.includes("session.json"), `no agent was started: ${created.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const me: PeerIdentity = {
  streamId: "codex",
  role: "agent",
  name: "Codex",
  instanceId: "inst_me",
};

const other: PeerIdentity = {
  streamId: "claude",
  role: "agent",
  name: "Claude",
  instanceId: "inst_other",
};

test("reply waiting ignores storage and unrelated replies, preserves messages, and reports expiry", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-reply-wait-"));
  const requestId = "review-request";
  const receipt = createEnvelope(other, "ack", {
    messageId: requestId, senderInstanceId: me.instanceId, forType: "handoff", receipt: "stored",
  }, { to: me.streamId });
  const status = { requestId, peer: other.streamId, senderInstanceId: me.instanceId,
    status: "stored" as const, expiresAt: Date.now() + 60000, attempts: 1, nextAttemptAt: 0, receipt };
  const run = (...extra: string[]) => spawnSync(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
    "receipt", requestId, "--state-dir", dir, "--from", other.streamId, "--timeout", "60", ...extra,
  ], { encoding: "utf8", timeout: 5000, windowsHide: true });
  try {
    writeHandoffStatus(dir, status);
    storeInboxMessage(dir, createEnvelope(other, "command_response", { requestId: "different-request", ok: true, result: "unrelated" }, { to: me.streamId }));
    storeInboxMessage(dir, createEnvelope({ ...other, streamId: "different-peer" }, "command_response", { requestId, ok: true, result: "unrelated" }, { to: me.streamId }));
    const stored = run();
    assert.equal(stored.status, 0, stored.stderr);
    assert.equal(JSON.parse(stored.stdout).status, "stored", "ordinary receipt waits retain their storage meaning");
    const waiting = run("--until", "responded");
    assert.equal(waiting.status, 1, waiting.stderr);
    const timeout = JSON.parse(waiting.stdout);
    assert.equal(timeout.status, "stored");
    assert.equal(timeout.timedOut, true);
    assert.ok(timeout.waitedMs >= 60);
    assert.equal(getInboxSummary(dir).pending, 2, "waiting must not consume unrelated messages");
    const response = createEnvelope(other, "command_response", { requestId, ok: false, error: "Review could not finish" }, { to: me.streamId });
    storeInboxMessage(dir, response);
    const finished = run("--until", "responded");
    assert.equal(finished.status, 0, finished.stderr);
    const result = JSON.parse(finished.stdout);
    assert.equal(result.status, "responded");
    assert.equal(result.receipts.find((item: MessageEnvelope) => item.id === response.id).payload.ok, false, "a reply can report a failure");
    assert.equal(getInboxSummary(dir).pending, 3, "receipt lookup leaves the actual reply available");
    takeInboxMessages(dir, 3);
    pruneAgentArchive(dir, { olderThanDays: 0, keep: 0, apply: true });
    writeHandoffStatus(dir, { ...status, status: "expired", expiresAt: Date.now() - 1, receipt: undefined });
    const expired = run("--until", "responded");
    assert.equal(expired.status, 1, expired.stderr);
    assert.equal(JSON.parse(expired.stdout).status, "expired");
    assert.equal(JSON.parse(expired.stdout).timedOut, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeBridge(identity = me) {
  const bridge = new VDOBridge({
    room: "ai-room",
    streamId: identity.streamId,
    identity: {
      streamId: identity.streamId,
      role: identity.role,
      name: identity.name,
    },
    password: false,
    skills: ["cli", "chat", "command", "sidecar", "discovery"],
    topics: ["events"],
    agentProfile: composeSidecarAgentProfile({
      runtime: "codex-cli",
      provider: "openai",
      model: "gpt-5",
      can: ["review", "tests"],
      asks: [{ name: "implement", description: "Implement a scoped change" }],
    }),
  });
  (bridge as unknown as { connected: boolean }).connected = true;
  return bridge;
}

function announceHandoffPeer(bridge: VDOBridge, identity: PeerIdentity): void {
  bridge.peers.addPeer(identity.streamId, `uuid_${identity.streamId}`);
  bridge.peers.updateFromAnnounce(identity.streamId, identity, {
    skills: [HANDOFF_SKILL], status: "online", version: "test", topics: [],
  });
}

test("handoffs survive dropped receipts and both sidecar restarts without duplicate work", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-handoff-"));
  const senderDir = path.join(dir, "sender");
  const receiverDir = path.join(dir, "receiver");
  try {
    let sender = makeBridge();
    let receiver = makeBridge(other);
    const sent: MessageEnvelope[] = [];
    const delivered: string[] = [];
    let dropReceipts = true;
    const connect = () => {
      announceHandoffPeer(sender, receiver.identity);
      announceHandoffPeer(receiver, sender.identity);
      sender.bus.on("message", message => handleSidecarHandoff(sender, senderDir, message));
      receiver.bus.on("message", message => {
        if (handleSidecarHandoff(receiver, receiverDir, message) === "new") delivered.push(message.id);
      });
      sender.bus.setSendDataFn(data => {
        const message = data as MessageEnvelope;
        sent.push(message);
        receiver.bus.handleIncoming(message);
        receiver.bus.handleIncoming(message); // transport redelivery before consumption
        return true;
      });
      receiver.bus.setSendDataFn(data => {
        // Receipt follows successful storage, even if its return path loses it.
        const messageId = (data as MessageEnvelope).payload as { messageId: string };
        assert.ok(delivered.includes(messageId.messageId) || getInboxSummary(receiverDir).pending > 0);
        if (!dropReceipts) sender.bus.handleIncoming(data as MessageEnvelope);
        return true;
      });
    };
    connect();
    const expected = [0, 1].map(() => queueAgentAction(senderDir, {
      kind: "handoff", target: other.streamId, request: "Review the same text",
    }).id);
    flushAgentOutbox(sender, senderDir);
    assert.deepEqual(delivered, expected, "distinct IDs with identical text are separate work");
    assert.equal(listQueuedAgentActions(senderDir).length, 2, "transport acceptance is not a storage receipt");
    assert.equal(getAgentReceipt(senderDir, expected[0], other.streamId).status, "awaiting_receipt");
    flushAgentOutbox(sender, senderDir);
    assert.equal(sent.length, 2, "retries respect persisted backoff");
    assert.deepEqual(takeInboxMessages(receiverDir, 10).map(item => item.envelope.id), expected);
    pruneAgentArchive(receiverDir, { olderThanDays: 0, keep: 0, apply: true });

    sender = makeBridge();
    receiver = makeBridge(other);
    dropReceipts = false;
    connect();
    for (const id of expected) {
      const status = readHandoffStatus(senderDir, id, other.streamId)!;
      writeHandoffStatus(senderDir, { ...status, nextAttemptAt: 0 });
    }
    flushAgentOutbox(sender, senderDir);
    assert.deepEqual(sent.slice(2), sent.slice(0, 2), "retries preserve IDs and sender instance across restart");
    assert.deepEqual(delivered, expected, "consumption and archive pruning cannot resurrect a handoff");
    assert.deepEqual(takeInboxMessages(receiverDir, 10), []);
    assert.equal(listQueuedAgentActions(senderDir).length, 0);
    for (const id of expected) {
      const receipt = getAgentReceipt(senderDir, id, other.streamId);
      assert.equal(receipt.status, "stored");
      assert.equal(receipt.delivery?.attempts, 2);
      assert.equal(receipt.receipts.length, 1);
    }
    assert.equal(getInboxSummary(senderDir).pending, 0, "storage receipts do not wake the sender");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handoffs require current peer support, expire visibly, and do not hold up ordinary messages", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-handoff-gating-"));
  try {
    const bridge = makeBridge();
    bridge.peers.addPeer(other.streamId, "old-peer");
    const sent: MessageEnvelope[] = [];
    bridge.bus.setSendDataFn(data => { sent.push(data as MessageEnvelope); return true; });
    const queued = queueAgentAction(dir, { kind: "handoff", target: other.streamId, request: "Review" });
    queueAgentAction(dir, { kind: "dm", target: other.streamId, text: "ordinary" });
    flushAgentOutbox(bridge, dir);
    assert.deepEqual(sent.map(message => message.type), ["chat"]);
    assert.equal(getAgentReceipt(dir, queued.id, other.streamId).delivery?.waitingFor, "peer_support");
    announceHandoffPeer(bridge, other);
    bridge.peers.markDisconnected(other.streamId);
    bridge.peers.addPeer(other.streamId, "replacement-peer");
    flushAgentOutbox(bridge, dir);
    assert.equal(sent.length, 1, "old capability announcements cannot authorize a replacement connection");
    announceHandoffPeer(bridge, other);
    bridge.peers.addPeer(other.streamId, `uuid_${other.streamId}`); // duplicate notification on the same connection
    flushAgentOutbox(bridge, dir);
    assert.equal(sent[1].type, "handoff");

    const item = listQueuedAgentActions(dir)[0];
    const expiredAt = Date.now() - 1;
    const createdAt = expiredAt - HANDOFF_TTL_MS;
    const envelope = { ...item.action.envelope!, ts: createdAt, payload: { request: "Review", expiresAt: expiredAt } };
    writeFileSync(item.path, JSON.stringify({ ...item.action, createdAt, envelope }));
    const status = readHandoffStatus(dir, queued.id, other.streamId)!;
    writeHandoffStatus(dir, { ...status, expiresAt: expiredAt });
    flushAgentOutbox(bridge, dir);
    assert.equal(listQueuedAgentActions(dir).length, 0);
    assert.equal(getAgentReceipt(dir, queued.id, other.streamId).status, "expired");
    assert.equal(sent.length, 2);
    const lateReceipt = createEnvelope(other, "ack", {
      messageId: queued.id, senderInstanceId: envelope.from.instanceId, forType: "handoff", receipt: "stored",
    }, { to: me.streamId });
    handleSidecarHandoff(bridge, dir, lateReceipt);
    assert.equal(getAgentReceipt(dir, queued.id, other.streamId).status, "stored");
    assert.equal(getAgentReceipt(dir, queued.id, other.streamId).delivery?.waitingFor, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unrelated acknowledgements cannot complete a handoff", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-handoff-receipts-"));
  try {
    const bridge = makeBridge();
    announceHandoffPeer(bridge, other);
    bridge.bus.setSendDataFn(() => true);
    const action = queueAgentAction(dir, { kind: "handoff", target: other.streamId, request: "Review" });
    flushAgentOutbox(bridge, dir);
    const envelope = listQueuedAgentActions(dir)[0].action.envelope!;
    const ack = createEnvelope(other, "ack", {
      forType: "handoff", receipt: "stored", messageId: action.id, senderInstanceId: envelope.from.instanceId,
    }, { to: me.streamId });
    for (const invalid of [
      { ...ack, to: "someone_else" }, { ...ack, from: { ...other, streamId: "someone_else" } },
      { ...ack, payload: { ...(ack.payload as object), senderInstanceId: "previous_instance" } },
      { ...ack, payload: { messageId: action.id } },
    ]) handleSidecarHandoff(bridge, dir, invalid);
    assert.equal(listQueuedAgentActions(dir).length, 1);
    assert.equal(getAgentReceipt(dir, action.id, other.streamId).status, "awaiting_receipt");
    handleSidecarHandoff(bridge, dir, ack);
    assert.equal(listQueuedAgentActions(dir).length, 0);
    assert.equal(getAgentReceipt(dir, action.id, other.streamId).status, "stored");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a broken receipt transport still leaves new handoffs available to wake and read", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-handoff-return-path-"));
  try {
    const receiver = makeBridge(other);
    announceHandoffPeer(receiver, me);
    receiver.bus.setSendDataFn(() => { throw new Error("return channel closed"); });
    const message = createEnvelope(me, "handoff", { request: "Review", expiresAt: Date.now() + HANDOFF_TTL_MS - 1000 }, { to: other.streamId });
    assert.equal(handleSidecarHandoff(receiver, dir, message), "new");
    assert.deepEqual(takeInboxMessages(dir).map(item => item.envelope.id), [message.id]);
    assert.equal(handleSidecarHandoff(receiver, dir, message), "duplicate");
    assert.deepEqual(takeInboxMessages(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handoffs are never acknowledged before storage or when addressed to another peer", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-handoff-disk-error-"));
  try {
    const receiver = makeBridge(other);
    announceHandoffPeer(receiver, me);
    const sent: object[] = [];
    receiver.bus.setSendDataFn(data => { sent.push(data); return true; });
    const message = createEnvelope(me, "handoff", { request: "Review", expiresAt: Date.now() + 60_000 }, { to: other.streamId });
    assert.equal(handleSidecarHandoff(receiver, dir, { ...message, to: me.streamId }), "rejected");
    writeFileSync(path.join(dir, "handoffs"), "cannot create storage directory here");
    assert.throws(() => handleSidecarHandoff(receiver, dir, message));
    assert.deepEqual(sent, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("get-file preserves whitespace in a listed path instead of selecting another file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-share-path-"));
  try {
    writeFileSync(path.join(dir, "notes.txt"), "wrong file");
    const wanted = path.join(dir, " notes.txt");
    writeFileSync(wanted, "requested file");
    const response = buildSidecarCommandResponse(makeBridge(), dir, "get-file", {
      share: " docs ", path: " notes.txt",
    }, [{ name: "docs", path: dir }], other.streamId);
    assert.equal(response.error, undefined);
    assert.equal(response.transfer?.filePath, wanted);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("direct outbox actions survive offline flushes and sidecar restart", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-outbox-"));
  try {
    const first = makeBridge();
    for (let i = 0; i < 55; i++) queueAgentAction(dir, { kind: "dm", target: other.streamId, text: `mail ${i}` });
    queueAgentAction(dir, { kind: "command", target: other.streamId, command: "review", args: { file: "notes" } });
    queueAgentAction(dir, { kind: "response", target: other.streamId, requestId: "request-1", result: { ok: true } });
    flushAgentOutbox(first, dir);
    assert.equal(listQueuedAgentActions(dir).length, 57);
    assert.equal(first.bus.getOfflineQueueSize(other.streamId), 0);

    const restarted = makeBridge();
    restarted.peers.addPeer(other.streamId, "uuid_new");
    const sent: MessageEnvelope[] = [];
    restarted.bus.setSendDataFn(data => { sent.push(data as MessageEnvelope); return true; });
    flushAgentOutbox(restarted, dir);
    assert.equal(listQueuedAgentActions(dir).length, 0);
    assert.equal(sent.length, 57);
    assert.deepEqual(sent.slice(0, 55).map(m => m.payload), Array.from({ length: 55 }, (_, i) => ({ text: `mail ${i}` })));
    assert.equal(sent[55].type, "command");
    assert.deepEqual(sent[56].payload, { requestId: "request-1", ok: true, result: { ok: true } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed and unknown outbox records neither block valid work nor get deleted", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-outbox-invalid-"));
  try {
    const bridge = makeBridge();
    bridge.peers.addPeer(other.streamId, "uuid_other");
    const sent: unknown[] = [];
    bridge.bus.setSendDataFn(data => { sent.push(data); return true; });
    const valid = queueAgentAction(dir, { kind: "dm", target: other.streamId, text: "valid" });
    const invalid = [42, "text", [], {},
      { ...valid, kind: "future_action" }, { ...valid, text: {} },
      { ...valid, target: null }, { ...valid, envelope: {} },
    ];
    invalid.forEach((record, i) => writeFileSync(path.join(dir, "outbox", `invalid-${i}.json`), JSON.stringify(record)));
    assert.doesNotThrow(() => flushAgentOutbox(bridge, dir));
    assert.equal(sent.length, 1);
    assert.equal(listQueuedAgentActions(dir).length, 0);
    assert.equal(readdirSync(path.join(dir, "outbox")).length, invalid.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outbox retries preserve wire identity and order without blocking other peers", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-outbox-"));
  try {
    const first = makeBridge();
    first.peers.addPeer(other.streamId, "uuid_other");
    first.peers.addPeer("reviewer", "uuid_reviewer");
    queueAgentAction(dir, { kind: "dm", target: other.streamId, text: "first" });
    const retry = queueAgentAction(dir, { kind: "command", target: other.streamId, command: "review" });
    queueAgentAction(dir, { kind: "response", target: other.streamId, requestId: "r1", error: "unavailable" });
    queueAgentAction(dir, { kind: "dm", target: "reviewer", text: "independent" });
    const attempts: MessageEnvelope[] = [];
    first.bus.setSendDataFn(data => {
      const envelope = data as MessageEnvelope;
      attempts.push(envelope);
      return envelope.id !== retry.id;
    });
    flushAgentOutbox(first, dir);
    assert.equal(attempts.length, 3);
    assert.equal(first.bus.historyCount, 2);
    assert.equal(first.bus.getOfflineQueueSize(other.streamId), 0);
    const queued = listQueuedAgentActions(dir);
    assert.equal(queued.length, 2);
    assert.equal(queued[0].action.envelope?.id, retry.id);
    assert.equal(getInboxSummary(dir).queued, 2);

    const restarted = makeBridge();
    restarted.peers.addPeer(other.streamId, "replacement_uuid");
    const sent: MessageEnvelope[] = [];
    restarted.bus.setSendDataFn(data => { sent.push(data as MessageEnvelope); return true; });
    flushAgentOutbox(restarted, dir);
    assert.deepEqual(sent[0], JSON.parse(JSON.stringify(attempts[1])));
    assert.deepEqual(sent[1].payload, { requestId: "r1", ok: false, error: "unavailable" });
    assert.equal(listQueuedAgentActions(dir).length, 0);
    flushAgentOutbox(restarted, dir);
    assert.equal(sent.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing outbox transport leaves the direct action on disk", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-outbox-"));
  try {
    const bridge = makeBridge();
    bridge.peers.addPeer(other.streamId, "uuid_other");
    queueAgentAction(dir, { kind: "dm", target: other.streamId, text: "retry me" });
    bridge.bus.setSendDataFn(() => { throw new Error("channel closed"); });
    flushAgentOutbox(bridge, dir);
    assert.equal(listQueuedAgentActions(dir).length, 1);
    assert.equal(bridge.bus.historyCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedState(stateDir: string): void {
  writeAgentSession(stateDir, {
    room: "ai-room",
    streamId: me.streamId,
    name: me.name,
    role: me.role,
    stateDir,
    pid: process.pid,
    connected: true,
    skills: ["cli", "chat", "command", "sidecar", "discovery"],
    topics: ["events"],
    agentProfile: composeSidecarAgentProfile({
      runtime: "codex-cli",
      provider: "openai",
      model: "gpt-5",
      can: ["review", "tests"],
      asks: [{ name: "implement", description: "Implement a scoped change" }],
    }),
    sharedFolders: [],
    startedAt: Date.now() - 1_000,
    updatedAt: Date.now(),
  });
  writePeersSnapshot(stateDir, [
    { streamId: "claude", connected: true },
    { streamId: "human", connected: false },
  ]);
}

test("composeSidecarAgentProfile appends built-in discovery asks", () => {
  const profile = composeSidecarAgentProfile({
    runtime: "claude-code",
    can: ["review"],
    asks: [{ name: "review", description: "Review a patch" }],
    shares: [{ name: "docs" }],
  });

  assert.equal(profile.runtime, "claude-code");
  assert.deepEqual(profile.can, ["review"]);
  assert.deepEqual(profile.shares, [{ name: "docs" }]);
  assert.ok(profile.asks?.some((ask) => ask.name === "review"));
  assert.ok(profile.asks?.some((ask) => ask.name === "shares"));
  assert.ok(profile.asks?.some((ask) => ask.name === "list-files"));
  assert.ok(profile.asks?.some((ask) => ask.name === "get-file"));
  assert.ok(profile.asks?.some((ask) => ask.name === "capabilities"));
  assert.ok(profile.asks?.some((ask) => ask.name === "status"));
});

test("buildMenuText shows start guidance for Claude defaults", () => {
  const text = buildMenuText({
    room: "",
    streamId: "claude",
    name: "Claude",
    role: "agent",
    password: false,
    waitMs: 1500,
    stateDir: path.join(os.tmpdir(), "ninja-p2p-menu-claude"),
    agentProfile: composeSidecarAgentProfile({
      runtime: "claude-code",
      provider: "anthropic",
    }),
    sharedFolders: [],
  });

  assert.match(text, /\/ninja-p2p start/);
  assert.match(text, /room: \(generated on start\)/);
  assert.match(text, /id: claude/);
});

test("sidecars file Social Stream chat into their inbox", () => {
  // The bus drops events on topics it is not subscribed to, so the bridge's
  // default topic must be one of the sidecar's subscriptions.
  const peers = new PeerRegistry();
  const bus = new MessageBus({ streamId: "claude", role: "agent", name: "Claude", instanceId: "i1" }, peers);
  for (const topic of SIDECAR_TOPICS) bus.subscribe(topic);
  const delivered: string[] = [];
  bus.on("message", (envelope: MessageEnvelope) => delivered.push(envelope.topic ?? ""));
  const bridgeIdentity = { streamId: "ssn_bridge", role: "bridge", name: "Social Stream", instanceId: "b1" };
  bus.handleIncoming(createEnvelope(bridgeIdentity, "event", { kind: "social_chat", text: "hi" }, { topic: DEFAULT_SSN_TOPIC }));
  bus.handleIncoming(createEnvelope(bridgeIdentity, "event", { kind: "build_failed" }, { topic: "events" }));
  assert.deepEqual(delivered, [DEFAULT_SSN_TOPIC, "events"]);
});

test("buildRoomText shows join instructions for other agents", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-room-"));
  try {
    seedState(dir);
    const text = buildRoomText(dir);

    assert.match(text, /room: ai-room/);
    assert.match(text, /Claude: \/ninja-p2p start --room ai-room/);
    assert.match(text, /Generic CLI: ninja-p2p start --room ai-room --id worker/);
    // The seeded agent is already codex, so suggesting --id codex would collide.
    assert.doesNotMatch(text, /--id codex/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildSidecarCommandResponse returns capability details for peers", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    seedState(dir);
    const bridge = makeBridge();
    const response = buildSidecarCommandResponse(bridge, dir, "capabilities");
    assert.equal(response.handled, true);
    assert.deepEqual(response.result, {
      room: "ai-room",
      identity: bridge.identity,
      skills: ["cli", "chat", "command", "sidecar", "discovery"],
      topics: ["events"],
      can: ["review", "tests"],
      shares: [],
      asks: composeSidecarAgentProfile({
        runtime: "codex-cli",
        provider: "openai",
        model: "gpt-5",
        can: ["review", "tests"],
        asks: [{ name: "implement", description: "Implement a scoped change" }],
      }).asks,
      profile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        provider: "openai",
        model: "gpt-5",
        can: ["review", "tests"],
        asks: [{ name: "implement", description: "Implement a scoped change" }],
      }),
      requestExamples: [
        {
          ask: "implement",
          via: "command",
          example: "ninja-p2p command --id <you> codex implement '{\"request\":\"...\"}'",
          command: "implement",
          args: { request: "Please help with implement" },
        },
        {
          ask: "review",
          via: "command",
          example: "ninja-p2p command --id <you> codex review '{\"request\":\"...\"}'",
          command: "review",
          args: { request: "Please help with review" },
        },
        {
          ask: "test",
          via: "command",
          example: "ninja-p2p command --id <you> codex test '{\"request\":\"...\"}'",
          command: "test",
          args: { request: "Please help with test" },
        },
        {
          ask: "help",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> help",
          command: "help",
          args: { request: "Please help with help" },
        },
        {
          ask: "profile",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> profile",
          command: "profile",
          args: { request: "Please help with profile" },
        },
        {
          ask: "whoami",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> whoami",
          command: "whoami",
          args: { request: "Please help with whoami" },
        },
        {
          ask: "capabilities",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> capabilities",
          command: "capabilities",
          args: { request: "Please help with capabilities" },
        },
        {
          ask: "status",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> status",
          command: "status",
          args: { request: "Please help with status" },
        },
        {
          ask: "peers",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> peers",
          command: "peers",
          args: { request: "Please help with peers" },
        },
        {
          ask: "inbox",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> inbox",
          command: "inbox",
          args: { request: "Please help with inbox" },
        },
        {
          ask: "pending",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> pending",
          command: "pending",
          args: { request: "Please help with pending" },
        },
      ],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeHandleSidecarCommand auto-responds to built-in discovery commands", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    seedState(dir);
    const bridge = makeBridge();
    const responses: unknown[] = [];
    (bridge as unknown as {
      commandResponse: (message: unknown, result?: unknown) => unknown;
    }).commandResponse = (_message: unknown, result?: unknown) => {
      responses.push(result);
      return createEnvelope(me, "command_response", result ?? null, { to: other.streamId });
    };

    const handled = maybeHandleSidecarCommand(
      bridge,
      dir,
      createEnvelope(other, "command", { command: "status" }, { to: me.streamId }),
    );

    assert.equal(handled, true);
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0], {
      room: "ai-room",
      identity: bridge.identity,
      connected: true,
      status: "idle",
      statusDetail: "",
      pending: 0,
      queued: 0,
      stale: false,
      peersKnown: 2,
      peersConnected: 1,
      senders: [],
      types: [],
      commands: [],
      events: [],
      peers: [
        {
          streamId: "claude",
          name: "claude",
          role: "unknown",
          connected: true,
          status: "unknown",
          statusDetail: "",
          summary: null,
          can: [],
          asks: [],
          shares: [],
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
      ],
      profile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        provider: "openai",
        model: "gpt-5",
        can: ["review", "tests"],
        asks: [{ name: "implement", description: "Implement a scoped change" }],
      }),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getAgentStatus includes peers and agent profile", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    seedState(dir);
    const status = getAgentStatus(dir) as Record<string, unknown>;
    assert.equal(status.room, "ai-room");
    assert.equal(status.streamId, "codex");
    assert.equal(status.peersKnown, 2);
    assert.equal(status.peersConnected, 1);
    assert.deepEqual(status.types, []);
    assert.deepEqual(status.commands, []);
    assert.deepEqual(status.events, []);
    assert.deepEqual(status.skills, ["cli", "chat", "command", "sidecar", "discovery"]);
    assert.deepEqual(status.topics, ["events"]);
    assert.deepEqual(status.peers, [
      { streamId: "claude", connected: true },
      { streamId: "human", connected: false },
    ]);
    assert.deepEqual(status.agentProfile, composeSidecarAgentProfile({
      runtime: "codex-cli",
      provider: "openai",
      model: "gpt-5",
      can: ["review", "tests"],
      asks: [{ name: "implement", description: "Implement a scoped change" }],
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordPeerNotice emits discovered once and updated on changes", () => {
  const fingerprints = new Map<string, string>();
  const first = recordPeerNotice(fingerprints, other, "peer_discovered", {
    streamId: other.streamId,
    status: "online",
    profile: { runtime: "claude-code" },
  });
  const second = recordPeerNotice(fingerprints, other, "peer_discovered", {
    streamId: other.streamId,
    status: "online",
    profile: { runtime: "claude-code" },
  });
  const third = recordPeerNotice(fingerprints, other, "peer_discovered", {
    streamId: other.streamId,
    status: "busy",
    profile: { runtime: "claude-code" },
  });

  assert.equal((first?.payload as Record<string, unknown>)?.kind, "peer_discovered");
  assert.equal(second, null);
  assert.equal((third?.payload as Record<string, unknown>)?.kind, "peer_updated");
});

test("createPeerNoticeEnvelope builds synthetic inbox events", () => {
  const notice = createPeerNoticeEnvelope(other, "peer_left", {
    streamId: other.streamId,
    status: "offline",
  });
  assert.equal(notice.type, "event");
  assert.deepEqual(notice.payload, {
    kind: "peer_left",
    streamId: other.streamId,
    status: "offline",
  });
});

test("createFileTransferEventEnvelope preserves event kind and transfer kind separately", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    const event = createFileTransferEventEnvelope(other, "file_received", {
      transferId: "transfer_123",
      name: "review.png",
      mimeType: "image/png",
      transferKind: "image",
      size: 68,
    });

    assert.equal(event.type, "event");
    assert.deepEqual(event.payload, {
      transferId: "transfer_123",
      name: "review.png",
      mimeType: "image/png",
      transferKind: "image",
      size: 68,
      kind: "file_received",
    });

    storeInboxMessage(dir, event);
    const summary = getInboxSummary(dir);
    assert.deepEqual(summary.events, [{ kind: "file_received", count: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildSidecarCommandResponse lists shared folders and files", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    const docsDir = path.join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(docsDir, "guide.md"), "# guide\n", "utf8");

    writeAgentSession(dir, {
      room: "ai-room",
      streamId: me.streamId,
      name: me.name,
      role: me.role,
      stateDir: dir,
      pid: process.pid,
      connected: true,
      skills: ["cli", "chat", "command", "sidecar", "discovery"],
      topics: ["events"],
      agentProfile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        shares: [{ name: "docs" }],
      }),
      sharedFolders: [{ name: "docs", path: docsDir }],
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    });
    writePeersSnapshot(dir, []);

    const bridge = new VDOBridge({
      room: "ai-room",
      streamId: me.streamId,
      identity: {
        streamId: me.streamId,
        role: me.role,
        name: me.name,
      },
      password: false,
      skills: ["cli", "chat", "command", "sidecar", "discovery"],
      topics: ["events"],
      agentProfile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        shares: [{ name: "docs" }],
      }),
    });
    (bridge as unknown as { connected: boolean }).connected = true;

    const shares = buildSidecarCommandResponse(bridge, dir, "shares", undefined, [{ name: "docs", path: docsDir }], other.streamId);
    assert.equal(shares.handled, true);
    assert.deepEqual(shares.result, {
      room: "ai-room",
      identity: bridge.identity,
      shares: [{ name: "docs" }],
    });

    const listing = buildSidecarCommandResponse(bridge, dir, "list-files", { share: "docs" }, [{ name: "docs", path: docsDir }], other.streamId);
    assert.equal(listing.handled, true);
    assert.deepEqual(listing.result, {
      share: "docs",
      path: "",
      entries: [
        { name: "guide.md", path: "guide.md", type: "file", size: 8 },
      ],
      truncated: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeHandleSidecarCommand get-file sends a file transfer and command response", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    const docsDir = path.join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(docsDir, "guide.md"), "# guide\n", "utf8");

    writeAgentSession(dir, {
      room: "ai-room",
      streamId: me.streamId,
      name: me.name,
      role: me.role,
      stateDir: dir,
      pid: process.pid,
      connected: true,
      skills: ["cli", "chat", "command", "sidecar", "discovery"],
      topics: ["events"],
      agentProfile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        shares: [{ name: "docs" }],
      }),
      sharedFolders: [{ name: "docs", path: docsDir }],
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    });
    writePeersSnapshot(dir, []);

    const bridge = new VDOBridge({
      room: "ai-room",
      streamId: me.streamId,
      identity: {
        streamId: me.streamId,
        role: me.role,
        name: me.name,
      },
      password: false,
      skills: ["cli", "chat", "command", "sidecar", "discovery"],
      topics: ["events"],
      agentProfile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        shares: [{ name: "docs" }],
      }),
    });
    (bridge as unknown as { connected: boolean }).connected = true;
    bridge.peers.addPeer(other.streamId, "uuid_other");

    const sent: Array<{ data: Record<string, unknown>; target?: unknown }> = [];
    bridge.bus.setSendDataFn((data, target) => {
      sent.push({ data: data as Record<string, unknown>, target });
    });

    const handled = maybeHandleSidecarCommand(
      bridge,
      dir,
      createEnvelope(other, "command", { command: "get-file", args: { share: "docs", path: "guide.md" } }, { to: me.streamId }),
    );

    assert.equal(handled, true);
    assert.deepEqual(sent.map((item) => item.data.type), [
      "file_offer",
      "file_chunk",
      "file_complete",
      "command_response",
    ]);
    const response = sent[3].data.payload as Record<string, unknown>;
    assert.equal(response.ok, true);
    assert.equal((response.result as Record<string, unknown>).name, "guide.md");
    assert.equal((response.result as Record<string, unknown>).transferKind, "file");
    assert.equal(typeof (response.result as Record<string, unknown>).transferId, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
