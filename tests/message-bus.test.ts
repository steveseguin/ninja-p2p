import test from "node:test";
import assert from "node:assert/strict";
import { MessageBus } from "../src/message-bus.js";
import { PeerRegistry } from "../src/peer-registry.js";
import { createEnvelope, type PeerIdentity, type MessageEnvelope } from "../src/protocol.js";

const myIdentity: PeerIdentity = {
  streamId: "me",
  role: "test",
  name: "TestBot",
  instanceId: "inst_me",
};

const otherIdentity: PeerIdentity = {
  streamId: "other",
  role: "test",
  name: "OtherBot",
  instanceId: "inst_other",
};

function makeBus(opts?: { historySize?: number; offlineQueueSize?: number }): { bus: MessageBus; peers: PeerRegistry; sent: Array<{ data: object; target?: unknown }> } {
  const peers = new PeerRegistry();
  const bus = new MessageBus(myIdentity, peers, opts);
  const sent: Array<{ data: object; target?: unknown }> = [];
  bus.setSendDataFn((data, target) => {
    sent.push({ data, target });
  });
  return { bus, peers, sent };
}

// ── Subscriptions ────────────────────────────────────────────────────────

test("subscribe and unsubscribe manage topics", () => {
  const { bus } = makeBus();
  assert.ok(!bus.isSubscribed("events"));
  bus.subscribe("events");
  assert.ok(bus.isSubscribed("events"));
  assert.deepEqual(bus.getSubscriptions(), ["events"]);
  bus.unsubscribe("events");
  assert.ok(!bus.isSubscribed("events"));
});

// ── Sending ──────────────────────────────────────────────────────────────

test("broadcast sends to all peers via sendDataFn", () => {
  const { bus, sent } = makeBus();
  const env = bus.broadcast("chat", { text: "hello" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, undefined); // no target = broadcast
  assert.equal(env.type, "chat");
  assert.equal(env.to, null);
});

test("broadcast with topic sets topic on envelope", () => {
  const { bus, sent } = makeBus();
  const env = bus.broadcast("event", { kind: "test" }, "events");
  assert.equal(env.topic, "events");
  assert.equal(sent.length, 1);
});

test("send targets a specific peer", () => {
  const { bus, peers, sent } = makeBus();
  peers.addPeer("other", "uuid_other");
  const env = bus.send("other", "chat", { text: "hi" });
  assert.equal(env.to, "other");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].target, { streamID: "other" });
});

test("send to offline peer queues the message", () => {
  const { bus, peers, sent } = makeBus();
  peers.addPeer("other", "uuid_other");
  peers.markDisconnected("other");

  bus.send("other", "chat", { text: "queued" });
  assert.equal(sent.length, 0); // not sent immediately
  assert.equal(bus.getOfflineQueueSize("other"), 1);
});

test("publish sends with topic", () => {
  const { bus, sent } = makeBus();
  const env = bus.publish("events", "event", { kind: "test" });
  assert.equal(env.topic, "events");
  assert.equal(sent.length, 1);
});

// ── Receiving ────────────────────────────────────────────────────────────

test("handleIncoming emits message event", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");

  let received: MessageEnvelope | undefined;
  bus.on("message", (env: MessageEnvelope) => { received = env; });

  const incoming = createEnvelope(otherIdentity, "chat", { text: "hello" });
  bus.handleIncoming(incoming);

  assert.ok(received);
  assert.equal((received as MessageEnvelope).type, "chat");
});

test("handleIncoming emits typed event", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");

  let received = false;
  bus.on("message:chat", () => { received = true; });

  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "hi" }));
  assert.ok(received);
});

test("handleIncoming emits topic event", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");
  bus.subscribe("events");

  let received = false;
  bus.on("topic:events", () => { received = true; });

  bus.handleIncoming(createEnvelope(otherIdentity, "event", { kind: "test" }, { topic: "events" }));
  assert.ok(received);
});

test("handleIncoming skips messages from self", () => {
  const { bus } = makeBus();
  let received = false;
  bus.on("message", () => { received = true; });

  bus.handleIncoming(createEnvelope(myIdentity, "chat", { text: "self" }));
  assert.ok(!received);
});

test("handleIncoming skips unsubscribed topic messages", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");

  let received = false;
  bus.on("message", () => { received = true; });

  // Not subscribed to "private" topic
  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "hi" }, { topic: "private" }));
  assert.ok(!received);
});

test("handleIncoming delivers announce even without subscription", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");

  let received = false;
  bus.on("message", () => { received = true; });

  bus.handleIncoming(createEnvelope(otherIdentity, "announce", { skills: [] }, { topic: "whatever" }));
  assert.ok(received);
});

test("handleIncoming skips messages addressed to someone else", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");

  let received = false;
  bus.on("message", () => { received = true; });

  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "not for me" }, { to: "someone_else" }));
  assert.ok(!received);
});

test("handleIncoming delivers messages addressed to us", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");

  let received = false;
  bus.on("message", () => { received = true; });

  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "for me" }, { to: "me" }));
  assert.ok(received);
});

// ── History ──────────────────────────────────────────────────────────────

test("history stores sent messages", () => {
  const { bus } = makeBus();
  bus.broadcast("chat", { text: "one" });
  bus.broadcast("chat", { text: "two" });
  const history = bus.getHistory();
  assert.equal(history.length, 2);
  assert.deepEqual((history[0].payload as Record<string, unknown>).text, "one");
});

test("history stores received messages", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");
  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "hi" }));
  assert.equal(bus.getHistory().length, 1);
});

test("history does not store pings", () => {
  const { bus } = makeBus();
  bus.broadcast("ping", { ts: Date.now() });
  assert.equal(bus.getHistory().length, 0);
});

test("history respects size limit", () => {
  const { bus } = makeBus({ historySize: 3 });
  for (let i = 0; i < 5; i++) {
    bus.broadcast("chat", { text: `msg_${i}` });
  }
  const history = bus.getHistory();
  assert.equal(history.length, 3);
  assert.deepEqual((history[0].payload as Record<string, unknown>).text, "msg_2");
});

test("getHistory with count limits results", () => {
  const { bus } = makeBus();
  for (let i = 0; i < 10; i++) {
    bus.broadcast("chat", { text: `msg_${i}` });
  }
  const recent = bus.getHistory(3);
  assert.equal(recent.length, 3);
  assert.deepEqual((recent[0].payload as Record<string, unknown>).text, "msg_7");
});

test("getHistoryForPeer filters by peer", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");
  peers.addPeer("third", "uuid_third");

  bus.send("other", "chat", { text: "to other" });
  bus.send("third", "chat", { text: "to third" });
  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "from other" }));

  const peerHistory = bus.getHistoryForPeer("other");
  assert.equal(peerHistory.length, 2); // sent to other + received from other
});

// ── Offline Queue ────────────────────────────────────────────────────────

test("offline queue stores messages for disconnected peers", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");
  peers.markDisconnected("other");

  bus.send("other", "chat", { text: "queued_1" });
  bus.send("other", "chat", { text: "queued_2" });
  assert.equal(bus.getOfflineQueueSize("other"), 2);
  assert.deepEqual(bus.getOfflineQueuePeers(), ["other"]);
});

test("offline queue respects size limit", () => {
  const { bus, peers } = makeBus({ offlineQueueSize: 2 });
  peers.addPeer("other", "uuid_other");
  peers.markDisconnected("other");

  bus.send("other", "chat", { text: "msg_1" });
  bus.send("other", "chat", { text: "msg_2" });
  bus.send("other", "chat", { text: "msg_3" });
  assert.equal(bus.getOfflineQueueSize("other"), 2);
});

test("flushOfflineQueue sends queued messages and clears queue", () => {
  const { bus, peers, sent } = makeBus();
  peers.addPeer("other", "uuid_other");
  peers.markDisconnected("other");

  bus.send("other", "chat", { text: "queued" });
  assert.equal(sent.length, 0);

  // Simulate reconnect
  peers.addPeer("other", "uuid_other");
  const flushed = bus.flushOfflineQueue("other");
  assert.equal(flushed.length, 1);
  assert.equal(sent.length, 1); // history_replay sent
  assert.equal(bus.getOfflineQueueSize("other"), 0);
});

test("flushOfflineQueue returns empty for peer with no queue", () => {
  const { bus } = makeBus();
  assert.deepEqual(bus.flushOfflineQueue("nonexistent"), []);
});

// ── Keyword Triggers ─────────────────────────────────────────────────────

test("keyword trigger fires on matching chat message", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");

  let triggered = false;
  bus.onKeyword("help", (msg) => {
    triggered = true;
    assert.equal(msg.type, "chat");
  });

  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "I need help please" }));
  assert.ok(triggered);
});

test("keyword trigger does not fire on non-matching message", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");

  let triggered = false;
  bus.onKeyword("help", () => { triggered = true; });

  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "everything is fine" }));
  assert.ok(!triggered);
});

test("keyword trigger works with RegExp", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");

  let triggered = false;
  bus.onKeyword(/@stevesbot/i, () => { triggered = true; });

  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "hey @StevesBot wake up" }));
  assert.ok(triggered);
});

test("keyword trigger reads text from payload.message too", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");

  let triggered = false;
  bus.onKeyword("alert", () => { triggered = true; });

  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { message: "alert! something happened" }));
  assert.ok(triggered);
});

test("removeTrigger stops the trigger from firing", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");

  let count = 0;
  const idx = bus.onKeyword("test", () => { count++; });

  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "test 1" }));
  assert.equal(count, 1);

  bus.removeTrigger(idx);
  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "test 2" }));
  assert.equal(count, 1); // should not increment
});

// ── Clear ────────────────────────────────────────────────────────────────

test("clear resets all state", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");
  bus.subscribe("events");
  bus.broadcast("chat", { text: "hi" });
  bus.onKeyword("test", () => {});

  bus.clear();
  assert.equal(bus.getHistory().length, 0);
  assert.ok(!bus.isSubscribed("events"));
  assert.deepEqual(bus.getSubscriptions(), []);
});
