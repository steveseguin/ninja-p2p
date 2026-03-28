import assert from "node:assert/strict";
import test from "node:test";

import { VDOBridge } from "../src/vdo-bridge.js";
import { createEnvelope, type PeerIdentity } from "../src/protocol.js";

const me: PeerIdentity = {
  streamId: "planner_bot",
  role: "agent",
  name: "Planner",
  instanceId: "inst_me",
};

const other: PeerIdentity = {
  streamId: "worker_bot",
  role: "agent",
  name: "Worker",
  instanceId: "inst_other",
};

function makeBridge(): VDOBridge {
  return new VDOBridge({
    room: "agents_room",
    streamId: me.streamId,
    identity: {
      streamId: me.streamId,
      role: me.role,
      name: me.name,
    },
    password: false,
  });
}

function setFakeSDK(bridge: VDOBridge, sendData: (data: unknown, target?: unknown) => void): void {
  (bridge as unknown as { sdk: { sendData: (data: unknown, target?: unknown) => void } }).sdk = { sendData };
}

test("reply targets the sender of the original message", () => {
  const bridge = makeBridge();
  const incoming = createEnvelope(other, "chat", { text: "hello" });

  const reply = bridge.reply(incoming, "chat", { text: "hi back" });

  assert.equal(reply.type, "chat");
  assert.equal(reply.to, other.streamId);
  assert.deepEqual(reply.payload, { text: "hi back" });
});

test("ack includes the original message id", () => {
  const bridge = makeBridge();
  const incoming = createEnvelope(other, "event", { kind: "sync" });

  const ack = bridge.ack(incoming, { accepted: true });

  assert.equal(ack.type, "ack");
  assert.equal(ack.to, other.streamId);
  assert.deepEqual(ack.payload, {
    messageId: incoming.id,
    data: { accepted: true },
  });
});

test("commandResponse links back to the originating message", () => {
  const bridge = makeBridge();
  const incoming = createEnvelope(other, "command", { command: "status" });

  const response = bridge.commandResponse(incoming, { status: "idle" });

  assert.equal(response.type, "command_response");
  assert.equal(response.to, other.streamId);
  assert.deepEqual(response.payload, {
    requestId: incoming.id,
    ok: true,
    result: { status: "idle" },
  });
});

test("commandResponse can carry an error", () => {
  const bridge = makeBridge();
  const incoming = createEnvelope(other, "command", { command: "dangerous" });

  const response = bridge.commandResponse(incoming, undefined, "permission denied");

  assert.equal(response.type, "command_response");
  assert.deepEqual(response.payload, {
    requestId: incoming.id,
    ok: false,
    error: "permission denied",
  });
});

test("requestHistory sends a history_request envelope", () => {
  const bridge = makeBridge();

  const request = bridge.requestHistory(other.streamId, 25);

  assert.equal(request.type, "history_request");
  assert.equal(request.to, other.streamId);
  assert.deepEqual(request.payload, { count: 25 });
});

test("sendRaw broadcasts arbitrary data when connected", () => {
  const bridge = makeBridge();
  const sent: Array<{ data: unknown; target?: unknown }> = [];
  setFakeSDK(bridge, (data, target) => {
    sent.push({ data, target });
  });

  const ok = bridge.sendRaw(new Uint8Array([1, 2, 3]).buffer);

  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, undefined);
  assert.ok(sent[0].data instanceof ArrayBuffer);
});

test("sendRaw targets a known peer by UUID", () => {
  const bridge = makeBridge();
  const sent: Array<{ data: unknown; target?: unknown }> = [];
  bridge.peers.addPeer(other.streamId, "uuid_other");
  setFakeSDK(bridge, (data, target) => {
    sent.push({ data, target });
  });

  const ok = bridge.sendRaw({ binary: false }, other.streamId);

  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].target, { UUID: "uuid_other" });
});

test("getSDK returns null before connect", () => {
  const bridge = makeBridge();
  assert.equal(bridge.getSDK(), null);
});
