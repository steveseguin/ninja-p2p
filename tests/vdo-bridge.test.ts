import assert from "node:assert/strict";
import test from "node:test";

import { VDOBridge } from "../src/vdo-bridge.js";
import { createEnvelope, parseEnvelope, type MessageEnvelope, type PeerIdentity } from "../src/protocol.js";

import { readFileSync } from "node:fs";

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

function setFakeSDK(bridge: VDOBridge, sendData: (data: unknown, target?: unknown) => boolean | void): void {
  (bridge as unknown as { sdk: { sendData: (data: unknown, target?: unknown) => boolean | void } }).sdk = { sendData };
}

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
