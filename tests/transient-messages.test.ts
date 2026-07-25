/**
 * Swarm traffic must not be treated as durable.
 *
 * Two bugs found live, both from the same assumption. A chunk request that
 * failed to send was queued and replayed later, asking for something the
 * requester already had. And every swarm message entered the 200-entry history
 * ring, so a few seconds of transfer evicted the entire conversation that
 * `history_request` exists to replay.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MessageBus } from "../src/message-bus.js";
import { PeerRegistry } from "../src/peer-registry.js";
import { isTransientType, type PeerIdentity } from "../src/protocol.js";

const me: PeerIdentity = { streamId: "me", role: "agent", name: "Me", instanceId: "i1" };

function makeBus(accept: boolean): { bus: MessageBus; peers: PeerRegistry; sent: number } {
  const peers = new PeerRegistry();
  peers.addPeer("them", "uuid-them");
  const bus = new MessageBus(me, peers);
  const state = { bus, peers, sent: 0 };
  bus.setSendDataFn(() => {
    state.sent += 1;
    return accept;
  });
  return state;
}

describe("transient message classification", () => {
  it("covers every swarm type and nothing else", () => {
    for (const type of ["swarm_offer", "swarm_announce", "swarm_request", "swarm_chunk", "swarm_have"] as const) {
      assert.equal(isTransientType(type), true, type);
    }
    for (const type of ["chat", "command", "ack", "event", "file_offer", "history_replay"] as const) {
      assert.equal(isTransientType(type), false, type);
    }
  });
});

describe("history is not flooded by transfers", () => {
  it("keeps swarm traffic out of the history ring", () => {
    const { bus } = makeBus(true);
    bus.broadcast("chat", { text: "the message that matters" });
    for (let i = 0; i < 500; i += 1) {
      bus.trySend("them", "swarm_request", { fileId: "f", index: i });
      bus.tryBroadcast("swarm_have", { fileId: "f", indexes: [i] });
    }

    const history = bus.getHistory();
    assert.equal(history.length, 1, "a transfer must not evict the conversation");
    assert.equal(history[0].type, "chat");
  });

  it("keeps them out even when sent through the durable path by mistake", () => {
    const { bus } = makeBus(true);
    bus.broadcast("chat", { text: "keep me" });
    for (let i = 0; i < 500; i += 1) {
      bus.send("them", "swarm_chunk", { fileId: "f", index: i, data: "" });
    }
    assert.equal(bus.getHistory().length, 1);
  });
});

describe("transient sends are not replayed", () => {
  it("does not queue a failed transient send", () => {
    const { bus } = makeBus(false);
    bus.send("them", "swarm_request", { fileId: "f", index: 1 });
    // A request replayed minutes later asks for a chunk we already have.
    assert.equal(bus.getOfflineQueueSize("them"), 0);
  });

  it("still queues a failed durable send", () => {
    const { bus } = makeBus(false);
    bus.send("them", "chat", { text: "hello" });
    assert.equal(bus.getOfflineQueueSize("them"), 1, "ordinary messages must still survive an outage");
  });
});

describe("trySend reports what happened", () => {
  it("returns true when the transport accepts", () => {
    const { bus } = makeBus(true);
    assert.equal(bus.trySend("them", "swarm_request", { fileId: "f", index: 0 }), true);
  });

  it("returns false when the transport refuses", () => {
    const { bus } = makeBus(false);
    assert.equal(bus.trySend("them", "swarm_request", { fileId: "f", index: 0 }), false);
  });

  it("returns false for a peer that is not connected, without sending", () => {
    const state = makeBus(true);
    state.peers.markDisconnected("them");
    assert.equal(state.bus.trySend("them", "swarm_request", { fileId: "f", index: 0 }), false);
    assert.equal(state.sent, 0, "nothing should reach the transport");
  });
});
