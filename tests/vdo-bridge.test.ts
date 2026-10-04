import assert from "node:assert/strict";
import test from "node:test";

import { VDOBridge } from "../src/vdo-bridge.js";
import { createEnvelope, parseEnvelope, type MessageEnvelope, type PeerIdentity } from "../src/protocol.js";

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version as string;

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

test("invalid heartbeat intervals fail before connection startup", () => {
  for (const heartbeatMs of [NaN, Infinity, -1, 2 ** 31]) {
    assert.throws(() => new VDOBridge({
      room: "test", streamId: me.streamId, identity: me, heartbeatMs,
    }), /heartbeatMs/);
  }
});

test("heartbeat timing cannot be changed by mutating the constructor options", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const options = { room: "test", streamId: me.streamId, identity: me, heartbeatMs: 1000 };
  const bridge = new VDOBridge(options);
  let sent = 0;
  setFakeSDK(bridge, () => { sent++; });
  Object.assign(bridge, { connected: true });
  const internal = bridge as unknown as { startHeartbeat(): void; stopHeartbeat(): void };
  try {
    options.heartbeatMs = 1;
    internal.startHeartbeat();
    t.mock.timers.tick(1);
    assert.equal(sent, 0);
    t.mock.timers.tick(999);
    assert.equal(sent, 1);
  } finally {
    internal.stopHeartbeat();
    t.mock.timers.reset();
  }
});

function setFakeSDK(bridge: VDOBridge, sendData: (data: unknown, target?: unknown) => boolean | void): void {
  (bridge as unknown as { sdk: { sendData: (data: unknown, target?: unknown) => boolean | void } }).sdk = { sendData };
}

function wireTestSDK(bridge: VDOBridge) {
  const handlers = new Map<string, (event: any) => void>();
  const sent: unknown[] = [];
  Object.assign(bridge, { sdk: {
    addEventListener(name: string, handler: (event: any) => void) { handlers.set(name, handler); },
    sendData(data: unknown) { sent.push(data); return true; },
  } });
  (bridge as unknown as { wireSDKEvents(): void }).wireSDKEvents();
  return { handlers, sent };
}

test("disconnect cleans up a partially initialized SDK", async () => {
  const bridge = makeBridge();
  let closed = 0;
  Object.assign(bridge, { sdk: {
    sendData() {}, leaveRoom() {},
    async disconnect() { closed++; },
  } });
  await bridge.disconnect();
  assert.equal(closed, 1);
  assert.equal(bridge.getSDK(), null);
});

test("late stream metadata lets data-channel opening flush the stream's queued messages", () => {
  const bridge = makeBridge();
  const { handlers, sent } = wireTestSDK(bridge);
  bridge.bus.setSendDataFn(data => { sent.push(data); return true; });
  const queued = bridge.bus.send(other.streamId, "chat", { text: "queued before discovery" });
  handlers.get("peerConnected")!({ detail: { uuid: "remote_uuid" } });
  handlers.get("peerConnected")!({ detail: { uuid: "remote_uuid", streamID: other.streamId } });
  handlers.get("dataChannelOpen")!({ detail: { uuid: "remote_uuid", streamID: other.streamId } });
  assert.equal(bridge.bus.getOfflineQueueSize(other.streamId), 0);
  assert.ok(sent.some(wire => parseEnvelope(wire)?.id === queued.id));
  assert.equal(bridge.peers.streamIdForUuid("remote_uuid"), other.streamId);
});

test("callbacks from a replaced SDK cannot change peers or send through its replacement", () => {
  const bridge = makeBridge();
  const old = wireTestSDK(bridge);
  const current = wireTestSDK(bridge);
  current.handlers.get("peerConnected")!({ detail: { uuid: "new_uuid", streamID: other.streamId } });

  old.handlers.get("peerConnected")!({ detail: { uuid: "old_uuid", streamID: other.streamId } });
  old.handlers.get("dataChannelOpen")!({ detail: { uuid: "old_uuid", streamID: other.streamId } });
  old.handlers.get("reconnecting")!({});

  assert.equal(bridge.peers.getPeer(other.streamId)!.uuid, "new_uuid");
  assert.equal(current.sent.length, 0);
  assert.equal(bridge.isRestoring(), false);
  current.handlers.get("dataChannelOpen")!({ detail: { uuid: "new_uuid", streamID: other.streamId } });
  assert.equal(current.sent.length, 1);
});

test("callbacks after SDK teardown cannot resurrect peers", async () => {
  const bridge = makeBridge();
  const old = wireTestSDK(bridge);
  Object.assign(bridge.getSDK()!, { leaveRoom() {}, async disconnect() {} });
  await bridge.disconnect();
  old.handlers.get("peerConnected")!({ detail: { uuid: "old_uuid", streamID: other.streamId } });
  old.handlers.get("reconnecting")!({});
  assert.equal(bridge.peers.connectedCount, 0);
  assert.equal(bridge.isRestoring(), false);
});

test("overlapping connect calls share one SDK and one room announcement", async () => {
  const require = createRequire(import.meta.url);
  const sdkPath = require.resolve("@vdoninja/sdk");
  const previous = require.cache[sdkPath];
  let instances = 0;
  let announcements = 0;
  class FakeSDK {
    constructor() { instances++; }
    addEventListener() {}
    async connect() {}
    async joinRoom() {}
    async announce() { announcements++; }
    sendData() {}
    leaveRoom() {}
    async disconnect() {}
  }
  require.cache[sdkPath] = { exports: FakeSDK } as NodeJS.Module;
  const bridge = makeBridge();
  try {
    await Promise.all([bridge.connect(), bridge.connect()]);
    assert.equal(instances, 1);
    assert.equal(announcements, 1);
  } finally {
    await bridge.disconnect();
    if (previous) require.cache[sdkPath] = previous;
    else delete require.cache[sdkPath];
  }
});

test("disconnect during announcement cannot resurrect a connected bridge", async () => {
  const require = createRequire(import.meta.url);
  const sdkPath = require.resolve("@vdoninja/sdk");
  const previous = require.cache[sdkPath];
  let finish!: () => void;
  let entered!: () => void;
  const announced = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  class FakeSDK {
    addEventListener() {}
    async connect() {}
    async joinRoom() {}
    announce() { entered(); return pending; }
    sendData() {}
    leaveRoom() {}
    async disconnect() {}
  }
  require.cache[sdkPath] = { exports: FakeSDK } as NodeJS.Module;
  const bridge = makeBridge();
  try {
    const connecting = bridge.connect();
    const rejected = assert.rejects(connecting, /cancelled/);
    await announced;
    await bridge.disconnect();
    finish();
    await rejected;
    assert.equal(bridge.isConnected(), false);
    assert.equal(bridge.getSDK(), null);
    await bridge.connect();
    assert.equal(bridge.isConnected(), true, "a cancelled startup must allow a later retry");
  } finally {
    finish();
    await bridge.disconnect();
    if (previous) require.cache[sdkPath] = previous;
    else delete require.cache[sdkPath];
  }
});

test("failed room startup awaits SDK cleanup and preserves the original error", async () => {
  const require = createRequire(import.meta.url);
  const sdkPath = require.resolve("@vdoninja/sdk");
  const previous = require.cache[sdkPath];
  let closed = 0;
  const failure = new Error("room join failed");
  class FakeSDK {
    addEventListener() {}
    async connect() {}
    async joinRoom() { throw failure; }
    sendData() {}
    leaveRoom() {}
    async disconnect() { closed++; }
  }
  require.cache[sdkPath] = { exports: FakeSDK } as NodeJS.Module;
  try {
    const bridge = makeBridge();
    await assert.rejects(bridge.connect(), error => error === failure);
    assert.equal(closed, 1);
    assert.equal(bridge.getSDK(), null);
    assert.equal(bridge.isConnected(), false);
  } finally {
    if (previous) require.cache[sdkPath] = previous;
    else delete require.cache[sdkPath];
  }
});

test("concurrent disconnect callers share teardown and one completion event", async () => {
  const bridge = makeBridge();
  let closed = 0;
  let completed = 0;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  Object.assign(bridge, { connected: true, restoring: true, sdk: {
    sendData() {}, leaveRoom() {},
    disconnect() { closed++; return pending; },
  } });
  bridge.on("disconnected", () => { completed++; });
  const first = bridge.disconnect();
  const second = bridge.disconnect();
  await Promise.resolve();
  finish();
  await Promise.all([first, second]);
  assert.equal(closed, 1);
  assert.equal(completed, 1);
  assert.equal(bridge.isRestoring(), false);
});

test("successful teardown does not leave a five-second timer holding Node open", () => {
  const source = new URL("../src/vdo-bridge.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { VDOBridge } from ${JSON.stringify(source)};
    const bridge = new VDOBridge({ room: 'test', streamId: 'test', identity: { streamId: 'test', role: 'test', name: 'test' } });
    Object.assign(bridge, { connected: true, sdk: {
      sendData() {}, leaveRoom() {}, async disconnect() {}
    } });
    await bridge.disconnect();
  `], { encoding: "utf8", timeout: 3500 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test("late disconnect from an old UUID cannot disconnect a replacement peer", () => {
  const bridge = makeBridge();
  const { handlers } = wireTestSDK(bridge);
  bridge.peers.addPeer(other.streamId, "old_uuid");
  bridge.peers.addPeer(other.streamId, "new_uuid");
  handlers.get("dataChannelOpen")!({ detail: { uuid: "new_uuid", streamID: other.streamId } });
  handlers.get("peerDisconnected")!({ detail: { uuid: "old_uuid", streamID: other.streamId } });
  assert.equal(bridge.peers.isConnected(other.streamId), true);
  assert.equal((bridge as unknown as { canAttemptSDKSend(target: unknown): boolean })
    .canAttemptSDKSend({ uuid: "new_uuid" }), true);
});

test("bridge ignores protocol messages addressed to another peer before handling them", () => {
  const bridge = makeBridge();
  const { handlers, sent } = wireTestSDK(bridge);
  bridge.peers.addPeer(other.streamId, "uuid_worker");
  for (const type of ["ping", "history_request", "announce"] as const) {
    handlers.get("dataReceived")!({ detail: {
      uuid: "uuid_worker",
      data: createEnvelope(other, type, {}, { to: "someone_else" }),
    } });
  }
  assert.equal(sent.length, 0);
  assert.equal(bridge.peers.getPeer(other.streamId)?.identity, null);
});

test("malformed presence payloads do not throw or change peer state", () => {
  const bridge = makeBridge();
  const { handlers } = wireTestSDK(bridge);
  bridge.peers.addPeer(other.streamId, "uuid_worker");
  for (const type of ["announce", "skill_update"] as const) {
    for (const payload of [null, undefined, [], "invalid"]) {
      assert.doesNotThrow(() => handlers.get("dataReceived")!({ detail: {
        uuid: "uuid_worker", data: createEnvelope(other, type, payload),
      } }));
    }
  }
  assert.equal(bridge.peers.getPeer(other.streamId)?.identity, null);
});

test("malformed presence fields cannot poison the registry or reach discovery listeners", () => {
  const bridge = makeBridge();
  const { handlers } = wireTestSDK(bridge);
  bridge.peers.addPeer(other.streamId, "remote_uuid");
  bridge.peers.updateFromAnnounce(other.streamId, other, { skills: ["review"], status: "idle", topics: [], version: "1" });
  let delivered = 0;
  bridge.on("peer:announce", () => { delivered++; });
  bridge.bus.on("message:skill_update", () => { delivered++; });
  for (const type of ["announce", "skill_update"] as const) {
    for (const payload of [
      { skills: "review" }, { skills: [null] }, { status: {} },
      { topics: "events" }, { agent: [] }, { agent: { asks: "review" } },
      { agent: { asks: [null] } }, { agent: { can: [1] } },
      { agent: { shares: [null] } },
    ]) {
      handlers.get("dataReceived")!({ detail: { uuid: "remote_uuid", data: createEnvelope(other, type, payload) } });
    }
  }
  assert.equal(delivered, 0);
  assert.deepEqual(bridge.peers.getPeer(other.streamId)!.skills, ["review"]);
  assert.equal(bridge.peers.getPeer(other.streamId)!.status, "idle");
});

test("presence validation allows partial updates and unknown extension fields", () => {
  const bridge = makeBridge();
  const { handlers } = wireTestSDK(bridge);
  const payload = { skills: ["review"], agent: { asks: [{ name: "review", description: "Review", extra: true }], extra: true }, extra: true };
  let delivered: unknown;
  bridge.on("peer:announce", event => { delivered = event.announce; });
  handlers.get("dataReceived")!({ detail: { uuid: "remote_uuid", data: createEnvelope(other, "announce", payload) } });
  assert.deepEqual(delivered, payload);
  handlers.get("dataReceived")!({ detail: { uuid: "remote_uuid", data: createEnvelope(other, "skill_update", { status: "busy" }) } });
  assert.deepEqual(bridge.peers.getPeer(other.streamId)!.skills, ["review"]);
  assert.equal(bridge.peers.getPeer(other.streamId)!.status, "busy");
});

test("initial announces work before stream discovery and accept older UUID routes", () => {
  const bridge = makeBridge();
  const { handlers, sent } = wireTestSDK(bridge);
  Object.assign(bridge.getSDK()!, { state: { uuid: "our_uuid" } });
  handlers.get("dataChannelOpen")!({ detail: { uuid: "uuid_worker" } });
  assert.equal(parseEnvelope(sent[0])?.to, null);
  handlers.get("dataReceived")!({ detail: {
    uuid: "uuid_worker",
    data: createEnvelope(other, "announce", { skills: ["review"] }, { to: "our_uuid" }),
  } });
  assert.deepEqual(bridge.peers.getPeer(other.streamId)?.skills, ["review"]);
});

test("wireSDKEvents views existing and newly added peers without duplicating view calls", () => {
  const bridge = makeBridge();
  const handlers = new Map<string, (event: { detail?: { list?: Array<{ streamID?: string }>; streamID?: string } }) => void>();
  const viewed: Array<{ streamId: string; options: { audio: boolean; video: boolean } }> = [];

  (bridge as unknown as {
    sdk: {
      addEventListener: (name: string, handler: (event: { detail?: { list?: Array<{ streamID?: string }>; streamID?: string } }) => void) => void;
      view: (streamId: string, options: { audio: boolean; video: boolean }) => void;
    };
    wireSDKEvents: () => void;
  }).sdk = {
    addEventListener(name, handler) {
      handlers.set(name, handler);
    },
    view(streamId, options) {
      viewed.push({ streamId, options });
    },
  };

  (bridge as unknown as { wireSDKEvents: () => void }).wireSDKEvents();

  handlers.get("listing")?.({ detail: { list: [{ streamID: other.streamId }, { streamID: me.streamId }] } });
  handlers.get("videoaddedtoroom")?.({ detail: { streamID: other.streamId } });
  handlers.get("streamAdded")?.({ detail: { streamID: "reviewer_bot" } });

  assert.deepEqual(viewed, [
    { streamId: other.streamId, options: { audio: false, video: false } },
    { streamId: "reviewer_bot", options: { audio: false, video: false } },
  ]);
});

test("SDK-targeted protocol replies use the published lowercase uuid target", () => {
  const bridge = makeBridge();
  const handlers = new Map<string, (event: any) => void>();
  const sent: Array<{ data: unknown; target?: unknown }> = [];

  (bridge as unknown as {
    sdk: {
      addEventListener: (name: string, handler: (event: any) => void) => void;
      sendData: (data: unknown, target?: unknown) => boolean;
    };
    wireSDKEvents: () => void;
  }).sdk = {
    addEventListener(name, handler) {
      handlers.set(name, handler);
    },
    sendData(data, target) {
      sent.push({ data, target });
      return true;
    },
  };
  (bridge as unknown as { wireSDKEvents: () => void }).wireSDKEvents();

  handlers.get("dataChannelOpen")?.({
    detail: { uuid: "uuid_worker", streamID: other.streamId },
  });

  assert.equal(parseEnvelope(sent[0]?.data)?.type, "announce");
  assert.deepEqual(sent[0]?.target, { uuid: "uuid_worker" });
  assert.equal(
    Object.prototype.hasOwnProperty.call(sent[0]?.target ?? {}, "UUID"),
    false,
  );
});

test("duplicate SDK disconnect notifications produce one logical disconnect", () => {
  const bridge = makeBridge();
  const handlers = new Map<string, (event: any) => void>();
  (bridge as unknown as {
    sdk: {
      addEventListener: (name: string, handler: (event: any) => void) => void;
    };
    wireSDKEvents: () => void;
  }).sdk = {
    addEventListener(name, handler) {
      handlers.set(name, handler);
    },
  };
  (bridge as unknown as { wireSDKEvents: () => void }).wireSDKEvents();
  bridge.peers.addPeer(other.streamId, "uuid_worker");

  let bridgeDisconnects = 0;
  let registryLeaves = 0;
  bridge.on("peer:disconnected", () => { bridgeDisconnects += 1; });
  bridge.peers.on("peer:leave", () => { registryLeaves += 1; });

  handlers.get("peerDisconnected")?.({
    detail: { uuid: "uuid_worker", streamID: other.streamId },
  });
  handlers.get("peerDisconnected")?.({ detail: { uuid: "uuid_worker" } });
  handlers.get("peerDisconnected")?.({
    detail: { uuid: "uuid_worker", streamID: other.streamId },
  });

  assert.equal(bridgeDisconnects, 1);
  assert.equal(registryLeaves, 1);
  assert.equal(bridge.peers.getPeer(other.streamId)?.connected, false);
});

test("SDK sends wait for dataChannelOpen unless fallback is explicit", () => {
  const bridge = makeBridge();
  const handlers = new Map<string, (event: any) => void>();
  (bridge as unknown as {
    sdk: {
      addEventListener: (name: string, handler: (event: any) => void) => void;
      sendData: () => boolean;
    };
    wireSDKEvents: () => void;
  }).sdk = {
    addEventListener(name, handler) {
      handlers.set(name, handler);
    },
    sendData() {
      return true;
    },
  };
  (bridge as unknown as { wireSDKEvents: () => void }).wireSDKEvents();

  const canSend = (target?: unknown): boolean => (
    bridge as unknown as { canAttemptSDKSend: (value?: unknown) => boolean }
  ).canAttemptSDKSend(target);

  bridge.peers.addPeer(other.streamId, "uuid_worker");
  assert.equal(canSend(), false);
  assert.equal(canSend({ uuid: "uuid_worker" }), false);
  assert.equal(canSend({ allowFallback: true }), true);

  handlers.get("dataChannelOpen")?.({
    detail: { uuid: "uuid_worker", streamID: other.streamId },
  });
  assert.equal(canSend(), true);
  assert.equal(canSend({ uuid: "uuid_worker" }), true);

  handlers.get("peerDisconnected")?.({ detail: { uuid: "uuid_worker" } });
  assert.equal(canSend(), false);
});

test("an established connection cannot impersonate another stream id", () => {
  const bridge = makeBridge();
  const handlers = new Map<string, (event: any) => void>();
  (bridge as unknown as {
    sdk: {
      addEventListener: (name: string, handler: (event: any) => void) => void;
      sendData: () => boolean;
    };
    wireSDKEvents: () => void;
  }).sdk = {
    addEventListener(name, handler) {
      handlers.set(name, handler);
    },
    sendData() {
      return true;
    },
  };
  (bridge as unknown as { wireSDKEvents: () => void }).wireSDKEvents();

  bridge.peers.addPeer(other.streamId, "uuid_worker");
  bridge.peers.addPeer("attacker", "uuid_attacker");
  const received: string[] = [];
  bridge.bus.on("message:chat", (envelope) => received.push(envelope.from.streamId));

  handlers.get("dataReceived")?.({
    detail: {
      uuid: "uuid_attacker",
      data: createEnvelope(other, "chat", { text: "spoofed" }),
    },
  });
  assert.deepEqual(received, []);

  handlers.get("dataReceived")?.({
    detail: {
      uuid: "uuid_worker",
      data: createEnvelope(other, "chat", { text: "real" }),
    },
  });
  assert.deepEqual(received, [other.streamId]);
});

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

test("history replay never exposes direct messages involving other peers", () => {
  const bridge = makeBridge();
  const handlers = new Map<string, (event: any) => void>();
  const sent: unknown[] = [];
  (bridge as unknown as {
    sdk: {
      addEventListener: (name: string, handler: (event: any) => void) => void;
      sendData: (data: unknown) => boolean;
    };
    wireSDKEvents: () => void;
  }).sdk = {
    addEventListener(name, handler) {
      handlers.set(name, handler);
    },
    sendData(data) {
      sent.push(data);
      return true;
    },
  };
  (bridge as unknown as { wireSDKEvents: () => void }).wireSDKEvents();
  bridge.peers.addPeer(other.streamId, "uuid_other");

  const third: PeerIdentity = {
    streamId: "reviewer_bot",
    role: "agent",
    name: "Reviewer",
    instanceId: "inst_third",
  };
  bridge.bus.broadcast("chat", { text: "public" });
  bridge.bus.send(other.streamId, "chat", { text: "to requester" });
  bridge.bus.send(third.streamId, "chat", { text: "private outgoing" });
  bridge.bus.handleIncoming(createEnvelope(other, "chat", { text: "from requester" }, { to: me.streamId }));
  bridge.bus.handleIncoming(createEnvelope(third, "chat", { text: "private incoming" }, { to: me.streamId }));

  handlers.get("dataReceived")?.({
    detail: {
      uuid: "uuid_other",
      data: createEnvelope(other, "history_request", { count: 200 }, { to: me.streamId }),
    },
  });

  const replayed = sent
    .map((value) => parseEnvelope(value))
    .filter((value): value is MessageEnvelope => value?.type === "history_replay")
    .map((value) => (value.payload as MessageEnvelope).payload as { text?: string })
    .map((payload) => payload.text);
  assert.deepEqual(replayed, ["public", "to requester", "from requester"]);
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
  assert.deepEqual(sent[0].target, { allowFallback: true });
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
  assert.deepEqual(sent[0].target, { uuid: "uuid_other", allowFallback: true });
});

test("binary helpers use the SDK 1.4.1 lane and expose its limits", async () => {
  const bridge = makeBridge();
  const sent: Array<{ bytes: Uint8Array; uuid: string }> = [];
  bridge.peers.addPeer(other.streamId, "uuid_other");

  (bridge as unknown as {
    sdk: {
      sendBinary: (bytes: Uint8Array, uuid: string) => Promise<boolean>;
      getBufferedAmount: (uuid: string, label: string) => number;
      getMaxMessageSize: (uuid: string) => number;
    };
  }).sdk = {
    async sendBinary(bytes, uuid) {
      sent.push({ bytes, uuid });
      return true;
    },
    getBufferedAmount(uuid, label) {
      assert.equal(uuid, "uuid_other");
      assert.equal(label, "bin");
      return 4096;
    },
    getMaxMessageSize(uuid) {
      assert.equal(uuid, "uuid_other");
      return 262144;
    },
  };

  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(bridge.supportsBinary(), true);
  assert.equal(await bridge.sendBinaryTo(other.streamId, bytes), true);
  assert.deepEqual(sent, [{ bytes, uuid: "uuid_other" }]);
  assert.equal(bridge.bufferedBytesFor(other.streamId), 4096);
  assert.equal(bridge.maxMessageSizeFor(other.streamId), 262144);
});

test("sendRaw reports an SDK-level rejected send", () => {
  const bridge = makeBridge();
  setFakeSDK(bridge, () => false);

  assert.equal(bridge.sendRaw({ test: true }), false);
});

test("sendRaw does not crash when the SDK throws and no error listener is attached", () => {
  const bridge = makeBridge();
  setFakeSDK(bridge, () => {
    throw new Error("boom");
  });

  const ok = bridge.sendRaw({ test: true }, other.streamId);

  assert.equal(ok, false);
});

test("sendRaw still emits error when a listener is attached", () => {
  const bridge = makeBridge();
  const errors: unknown[] = [];
  bridge.on("error", (err) => {
    errors.push(err);
  });
  setFakeSDK(bridge, () => {
    throw new Error("boom");
  });

  const ok = bridge.sendRaw({ test: true }, other.streamId);

  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "boom");
});

test("getSDK returns null before connect", () => {
  const bridge = makeBridge();
  assert.equal(bridge.getSDK(), null);
});

test("getAnnouncePayload includes the configured agent profile", () => {
  const bridge = new VDOBridge({
    room: "agents_room",
    streamId: me.streamId,
    identity: {
      streamId: me.streamId,
      role: me.role,
      name: me.name,
    },
    password: false,
    skills: ["chat", "command"],
    topics: ["events"],
    agentProfile: {
      runtime: "claude-code",
      can: ["review"],
      asks: [{ name: "review", description: "Review a patch" }],
    },
  });

  assert.deepEqual(bridge.getAnnouncePayload(), {
    skills: ["chat", "command"],
    status: "idle",
    statusDetail: "",
    // Asserted against package.json, not a literal. A literal here is the same
    // drift that had peers being told a version nobody had updated.
    version: packageVersion,
    topics: ["events"],
    agent: {
      runtime: "claude-code",
      can: ["review"],
      asks: [{ name: "review", description: "Review a patch" }],
    },
  });
});

test("updateAgentProfile broadcasts a skill update when connected", () => {
  const bridge = makeBridge();
  const broadcasts: Array<{ type: string; payload: unknown }> = [];
  (bridge as unknown as { connected: boolean }).connected = true;
  (bridge as unknown as {
    bus: { broadcast: (type: string, payload: unknown) => void };
  }).bus = {
    broadcast(type: string, payload: unknown) {
      broadcasts.push({ type, payload });
    },
  };

  bridge.updateAgentProfile({
    provider: "openai",
    can: ["edit"],
  });

  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].type, "skill_update");
  assert.deepEqual(broadcasts[0].payload, {
    skills: [],
    status: "idle",
    statusDetail: "",
    agent: {
      provider: "openai",
      can: ["edit"],
    },
  });
});


test("a rejected discovery view reports its error and permits a later retry", async () => {
  const bridge = makeBridge();
  const { handlers } = wireTestSDK(bridge);
  const failure = new Error("Not connected to signaling server");
  const errors: unknown[] = [];
  bridge.on("error", error => errors.push(error));
  let attempts = 0;
  Object.assign(bridge.getSDK()!, {
    view() { attempts++; return Promise.reject(failure); },
  });
  handlers.get("streamAdded")!({ detail: { streamID: other.streamId } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, [failure]);
  handlers.get("streamAdded")!({ detail: { streamID: other.streamId } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.deepEqual(errors, [failure, failure]);
});

test("a synchronous discovery view failure still reports and permits retry", () => {
  const bridge = makeBridge();
  const { handlers } = wireTestSDK(bridge);
  const errors: unknown[] = [];
  bridge.on("error", error => errors.push(error));
  let attempts = 0;
  Object.assign(bridge.getSDK()!, {
    view() { attempts++; throw new Error("adapter refused view"); },
  });
  handlers.get("streamAdded")!({ detail: { streamID: other.streamId } });
  handlers.get("streamAdded")!({ detail: { streamID: other.streamId } });
  assert.equal(attempts, 2);
  assert.equal(errors.length, 2);
});

test("an obsolete discovery view failure does not clear a newer attempt", async () => {
  const bridge = makeBridge();
  const { handlers } = wireTestSDK(bridge);
  let rejectOld!: (error: Error) => void;
  const old = new Promise<void>((_, reject) => { rejectOld = reject; });
  let attempts = 0;
  const errors: unknown[] = [];
  bridge.on("error", error => errors.push(error));
  Object.assign(bridge.getSDK()!, {
    view() { return ++attempts === 1 ? old : Promise.resolve(); },
  });
  handlers.get("streamAdded")!({ detail: { streamID: other.streamId } });
  handlers.get("reconnected")!({});
  handlers.get("streamAdded")!({ detail: { streamID: other.streamId } });
  rejectOld(new Error("previous attempt failed late"));
  await new Promise(resolve => setImmediate(resolve));
  handlers.get("streamAdded")!({ detail: { streamID: other.streamId } });
  assert.equal(attempts, 2, "the replacement must remain deduplicated");
  assert.deepEqual(errors, []);
});

test("a discovery view rejection after teardown is handled without new bridge errors", async () => {
  const bridge = makeBridge();
  const { handlers } = wireTestSDK(bridge);
  let rejectView!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => { rejectView = reject; });
  const errors: unknown[] = [];
  bridge.on("error", error => errors.push(error));
  Object.assign(bridge.getSDK()!, {
    view() { return pending; }, stopViewing() {}, leaveRoom() {}, async disconnect() {},
  });
  handlers.get("streamAdded")!({ detail: { streamID: other.streamId } });
  await bridge.disconnect();
  rejectView(new Error("view cancelled by shutdown"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.equal(bridge.getSDK(), null);
});
