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

test("keyword handles remain stable when another trigger is removed", () => {
  const { bus } = makeBus();
  const fired: string[] = [];
  const first = bus.onKeyword("hello", () => fired.push("first"));
  const second = bus.onKeyword("hello", () => fired.push("second"));
  bus.removeTrigger(first);
  bus.removeTrigger(second);
  bus.handleIncoming(createEnvelope(otherIdentity, "chat", "hello"));
  assert.deepEqual(fired, []);
});

test("a keyword handler that re-registers itself runs once per message", () => {
  const { bus } = makeBus();
  let calls = 0;
  let handle: number;
  const handler = () => {
    calls++;
    bus.removeTrigger(handle);
    // Bound the old live-iterator behavior so a regression fails instead of hanging.
    if (calls < 4) handle = bus.onKeyword("hello", handler);
  };
  handle = bus.onKeyword("hello", handler);
  bus.handleIncoming(createEnvelope(otherIdentity, "chat", "hello"));
  assert.equal(calls, 1);
  bus.handleIncoming(createEnvelope(otherIdentity, "chat", "hello"));
  assert.equal(calls, 2);
});

test("trigger dispatch honors removals and defers new handlers until the next message", () => {
  const { bus } = makeBus();
  const fired: string[] = [];
  let later: number;
  bus.onKeyword("hello", () => {
    fired.push("first");
    bus.removeTrigger(later);
    bus.onKeyword("hello", () => fired.push("new"));
  });
  later = bus.onKeyword("hello", () => fired.push("removed"));
  bus.handleIncoming(createEnvelope(otherIdentity, "chat", "hello"));
  assert.deepEqual(fired, ["first"]);
  fired.length = 0;
  bus.handleIncoming(createEnvelope(otherIdentity, "chat", "hello"));
  assert.deepEqual(fired, ["first", "new"]);
});

test("requesting zero history entries returns no messages", () => {
  const { bus } = makeBus();
  bus.send(otherIdentity.streamId, "chat", { text: "private history" });
  assert.equal(bus.historyCount, 1);
  assert.deepEqual(bus.getHistory(0), []);
  assert.deepEqual(bus.getHistoryForPeer(otherIdentity.streamId, 0), []);
  assert.equal(bus.getHistory(1).length, 1);
});

test("history protocol traffic is delivered without evicting or nesting conversation history", () => {
  const { bus } = makeBus({ historySize: 2 });
  const chat = createEnvelope(otherIdentity, "chat", { text: "keep this conversation" });
  bus.handleIncoming(chat);
  const delivered: MessageEnvelope[] = [];
  bus.on("message", envelope => delivered.push(envelope));
  const request = createEnvelope(otherIdentity, "history_request", { count: 2 });
  const replay = createEnvelope(otherIdentity, "history_replay", chat);
  bus.handleIncoming(request);
  bus.handleIncoming(replay);
  assert.deepEqual(delivered, [request, replay]);
  assert.deepEqual(bus.getHistory(), [chat]);
});

test("stale keyword handles cannot remove triggers registered after clear", () => {
  const { bus } = makeBus();
  const old = bus.onKeyword("hello", () => {});
  bus.clear();
  let fired = false;
  bus.onKeyword("hello", () => { fired = true; });
  bus.removeTrigger(old);
  bus.handleIncoming(createEnvelope(otherIdentity, "chat", "hello"));
  assert.equal(fired, true);
});

test("non-string chat fields cannot throw during keyword matching", () => {
  const { bus } = makeBus();
  let fired = false;
  bus.onKeyword("hello", () => { fired = true; });
  assert.doesNotThrow(() => bus.handleIncoming(createEnvelope(otherIdentity, "chat", {
    text: { toString: null, valueOf: null },
  })));
  assert.equal(fired, false);
});

test("invalid queue limits are rejected before they can cause an endless trim loop", () => {
  for (const value of [-1, NaN, Infinity, 1.5]) {
    assert.throws(() => makeBus({ historySize: value }), /historySize/);
    assert.throws(() => makeBus({ offlineQueueSize: value }), /offlineQueueSize/);
  }
  const { bus } = makeBus({ historySize: 0, offlineQueueSize: 0 });
  bus.send("absent", "chat", "hello");
  assert.equal(bus.historyCount, 0);
  assert.equal(bus.getOfflineQueueSize("absent"), 0);
});

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
  assert.deepEqual(sent[0].target, { uuid: "uuid_other" });
});

test("send falls back to streamID when uuid is not known", () => {
  const { bus, sent } = makeBus();
  const env = bus.send("other", "chat", { text: "hi" });
  assert.equal(env.to, "other");
  assert.equal(sent.length, 0); // unknown peer is queued instead

  bus.setSendDataFn((data, target) => {
    sent.push({ data, target });
  });
  const directEnv = createEnvelope(myIdentity, "chat", { text: "manual" }, { to: "other" });
  (bus as unknown as { rawSend: (env: MessageEnvelope, target: string | null) => void }).rawSend(directEnv, "other");
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

test("send queues when a connected peer data channel is not ready", () => {
  const peers = new PeerRegistry();
  const bus = new MessageBus(myIdentity, peers);
  peers.addPeer("other", "uuid_other");
  bus.setSendDataFn(() => false);

  bus.send("other", "chat", { text: "race-safe" });

  assert.equal(bus.getOfflineQueueSize("other"), 1);
});

test("new direct commands do not overtake queued commands after transport recovery", () => {
  const { bus, peers, sent } = makeBus();
  peers.addPeer("other", "uuid_other");
  bus.setSendDataFn(() => false);
  const first = bus.send("other", "command", { command: "create" });
  bus.setSendDataFn((data, target) => { sent.push({ data, target }); return true; });
  const second = bus.send("other", "command", { command: "use" });
  bus.flushOfflineQueue("other");
  assert.deepEqual(sent.map(item => (item.data as MessageEnvelope).id), [first.id, second.id]);
  assert.equal(bus.getOfflineQueueSize("other"), 0);
});

test("a refused queue head blocks later commands but not transient traffic or other peers", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");
  peers.addPeer("third", "uuid_third");
  bus.setSendDataFn(() => false);
  const first = bus.send("other", "command", { command: "create" });
  const accepted: MessageEnvelope[] = [];
  bus.setSendDataFn(data => {
    const message = data as MessageEnvelope;
    if (message.id === first.id) return false;
    accepted.push(message);
    return true;
  });
  const second = bus.send("other", "command", { command: "use" });
  assert.deepEqual(accepted, []);
  assert.equal(bus.getOfflineQueueSize("other"), 2);
  const transient = bus.send("other", "swarm_request", { fileId: "a".repeat(64), index: 0 });
  const unrelated = bus.send("third", "chat", "hello");
  assert.deepEqual(accepted.map(message => message.id), [transient.id, unrelated.id]);
  bus.setSendDataFn(data => { accepted.push(data as MessageEnvelope); return true; });
  assert.deepEqual(bus.flushOfflineQueue("other"), [first, second]);
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

  const queued = bus.send("other", "chat", { text: "queued" });
  assert.equal(sent.length, 0);

  // Simulate reconnect
  peers.addPeer("other", "uuid_other");
  const flushed = bus.flushOfflineQueue("other");
  assert.equal(flushed.length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].target, { uuid: "uuid_other" });
  assert.equal((sent[0].data as MessageEnvelope).type, "chat");
  assert.equal((sent[0].data as MessageEnvelope).id, queued.id);
  assert.equal(bus.getOfflineQueueSize("other"), 0);
});

test("a throwing transport does not replay messages accepted earlier in the flush", () => {
  for (const failureIndex of [0, 1]) {
    const { bus, peers } = makeBus();
    const queued = [
      bus.send("other", "command", { command: "first" }),
      bus.send("other", "command", { command: "second" }),
    ];
    peers.addPeer("other", "uuid_other");
    const accepted: string[] = [];
    const failure = new Error("transport failed");
    bus.setSendDataFn(data => {
      if (accepted.length === failureIndex) throw failure;
      accepted.push((data as MessageEnvelope).id);
      return true;
    });

    assert.throws(() => bus.flushOfflineQueue("other"), error => error === failure);
    assert.equal(bus.getOfflineQueueSize("other"), queued.length - failureIndex);
    bus.setSendDataFn(data => {
      accepted.push((data as MessageEnvelope).id);
      return true;
    });
    assert.deepEqual(bus.flushOfflineQueue("other"), queued.slice(failureIndex));
    assert.deepEqual(accepted, queued.map(message => message.id));
    assert.equal(bus.getOfflineQueueSize("other"), 0);
  }
});

test("flushOfflineQueue returns empty for peer with no queue", () => {
  const { bus } = makeBus();
  assert.deepEqual(bus.flushOfflineQueue("nonexistent"), []);
});

test("flushOfflineQueue preserves messages when the channel rejects them", () => {
  const peers = new PeerRegistry();
  const bus = new MessageBus(myIdentity, peers);
  peers.addPeer("other", "uuid_other");
  peers.markDisconnected("other");
  bus.send("other", "chat", { text: "keep me" });
  peers.addPeer("other", "uuid_other");
  bus.setSendDataFn(() => false);

  assert.deepEqual(bus.flushOfflineQueue("other"), []);
  assert.equal(bus.getOfflineQueueSize("other"), 1);
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

test("global keyword triggers match consistently across messages", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");
  let triggered = 0;
  bus.onKeyword(/help/gi, () => { triggered += 1; });

  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "help once" }));
  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "help twice" }));

  assert.equal(triggered, 2);
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

test("keyword trigger errors do not crash when no error listener is attached", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");
  bus.onKeyword("boom", () => {
    throw new Error("trigger failed");
  });

  assert.doesNotThrow(() => {
    bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "boom now" }));
  });
});

test("keyword trigger errors still emit error when a listener is attached", () => {
  const { bus, peers } = makeBus();
  peers.addPeer("other", "uuid_other");
  const errors: unknown[] = [];
  bus.on("error", (err) => {
    errors.push(err);
  });
  bus.onKeyword("boom", () => {
    throw new Error("trigger failed");
  });

  bus.handleIncoming(createEnvelope(otherIdentity, "chat", { text: "boom now" }));

  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "trigger failed");
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
