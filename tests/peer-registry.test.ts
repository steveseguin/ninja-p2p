import test from "node:test";
import assert from "node:assert/strict";
import { PeerRegistry } from "../src/peer-registry.js";
import type { PeerIdentity, AnnouncePayload, SkillUpdatePayload } from "../src/protocol.js";

function makeIdentity(streamId: string): PeerIdentity {
  return { streamId, role: "test", name: "Test " + streamId, instanceId: "inst_1" };
}

function makeAnnounce(skills: string[] = []): AnnouncePayload {
  return { skills, status: "idle", version: "0.1.2", topics: ["events"] };
}

test("addPeer creates and returns a peer record", () => {
  const reg = new PeerRegistry();
  const peer = reg.addPeer("bot_1", "uuid_1");
  assert.equal(peer.streamId, "bot_1");
  assert.equal(peer.uuid, "uuid_1");
  assert.ok(peer.connected);
  assert.equal(peer.identity, null);
  assert.deepEqual(peer.skills, []);
});

test("adding a UUID that matches another peer's stream ID does not merge identities", () => {
  const reg = new PeerRegistry();
  const first = reg.addPeer("uuid_second", "uuid_first");
  const second = reg.addPeer("second", "uuid_second");
  assert.notEqual(first, second);
  assert.equal(second.streamId, "second");
  assert.equal(second.uuid, "uuid_second");
  assert.equal(reg.streamIdForUuid("uuid_first"), "uuid_second");
  assert.equal(reg.streamIdForUuid("uuid_second"), "second");
  assert.equal(reg.getAllPeers().length, 2);
});

test("reconnecting a peer does not delete a different peer named after its new UUID", () => {
  const reg = new PeerRegistry();
  const unrelated = reg.addPeer("uuid_new", "uuid_unrelated");
  const original = reg.addPeer("bot", "uuid_old");
  reg.markDisconnected("bot");
  assert.equal(reg.addPeer("bot", "uuid_new"), original);
  assert.equal(reg.getPeer("uuid_new"), unrelated);
  assert.equal(reg.streamIdForUuid("uuid_unrelated"), "uuid_new");
  assert.equal(reg.streamIdForUuid("uuid_new"), "bot");
  assert.equal(reg.streamIdForUuid("uuid_old"), undefined);
  assert.equal(reg.getAllPeers().length, 2);
});

test("addPeer re-activates existing disconnected peer", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  reg.markDisconnected("bot_1");

  const reactivated = reg.addPeer("bot_1", "uuid_2");
  assert.ok(reactivated.connected);
  assert.equal(reactivated.uuid, "uuid_2");
});

test("markDisconnected sets connected=false", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  const peer = reg.markDisconnected("bot_1");
  assert.ok(peer);
  assert.ok(!peer!.connected);
});

test("markDisconnected emits one leave for one state transition", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  let leaves = 0;
  reg.on("peer:leave", () => { leaves += 1; });

  reg.markDisconnected("bot_1");
  reg.markDisconnected("uuid_1");

  assert.equal(leaves, 1);
});

test("markDisconnected works with uuid", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  const peer = reg.markDisconnected("uuid_1");
  assert.ok(peer);
  assert.ok(!peer!.connected);
});

test("markDisconnected returns undefined for unknown peer", () => {
  const reg = new PeerRegistry();
  assert.equal(reg.markDisconnected("nonexistent"), undefined);
});

test("removePeer fully removes a peer", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  assert.ok(reg.removePeer("bot_1"));
  assert.equal(reg.getPeer("bot_1"), undefined);
  assert.equal(reg.connectedCount, 0);
});

test("rekeyPeer renames a temporary uuid-keyed record to the real streamId", () => {
  const reg = new PeerRegistry();
  reg.addPeer("uuid_1", "uuid_1");
  const peer = reg.rekeyPeer("uuid_1", "bot_1");
  assert.ok(peer);
  assert.equal(peer!.streamId, "bot_1");
  assert.equal(reg.getPeer("uuid_1")?.streamId, "bot_1");
  assert.equal(reg.getPeer("bot_1")?.uuid, "uuid_1");
  assert.equal(reg.getAllPeers().length, 1);
});

test("rekeyPeer refuses an occupied stream ID without merging unrelated connections", () => {
  for (const connected of [true, false]) {
    const reg = new PeerRegistry();
    const original = reg.addPeer("bot_1", "uuid_old");
    if (!connected) reg.markDisconnected("bot_1");
    const temporary = reg.addPeer("uuid_new", "uuid_new");
    assert.equal(reg.rekeyPeer("uuid_new", "bot_1"), undefined);
    assert.equal(reg.getPeer("bot_1"), original);
    assert.equal(reg.getPeer("uuid_new"), temporary);
    assert.equal(reg.streamIdForUuid("uuid_old"), "bot_1");
    assert.equal(reg.streamIdForUuid("uuid_new"), "uuid_new");
    assert.equal(original.connected, connected);
    assert.equal(reg.getAllPeers().length, 2);
  }
});

test("a conflicting rekey cannot leave an alias that attaches to a later peer", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_old");
  reg.addPeer("uuid_new", "uuid_new");
  reg.rekeyPeer("uuid_new", "bot_1");
  reg.removePeer("bot_1");
  const replacement = reg.addPeer("bot_1", "uuid_replacement");
  assert.notEqual(reg.getPeer("uuid_new"), replacement);
  reg.removePeer("uuid_new");
  assert.equal(reg.getPeer("bot_1"), replacement);
  assert.equal(reg.streamIdForUuid("uuid_new"), undefined);
});

test("addPeer merges late uuid-only connection events into the existing streamId peer", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  const peer = reg.addPeer("uuid_1", "uuid_1");
  assert.ok(peer);
  assert.equal(peer!.streamId, "bot_1");
  assert.equal(reg.getAllPeers().length, 1);
});

test("addPeer promotes a temporary UUID record when connection metadata supplies the stream ID", () => {
  const reg = new PeerRegistry();
  const temporary = reg.addPeer("uuid_1", "uuid_1");
  const resolved = reg.addPeer("bot_1", "uuid_1");
  assert.equal(resolved, temporary);
  assert.equal(resolved.streamId, "bot_1");
  assert.equal(reg.getPeer("bot_1"), resolved);
  assert.equal(reg.streamIdForUuid("uuid_1"), "bot_1");
  assert.equal(reg.getAllPeers().length, 1);
});

test("late connection metadata cannot rename an already resolved peer", () => {
  const reg = new PeerRegistry();
  const peer = reg.addPeer("bot_1", "uuid_1");
  reg.addPeer("different_bot", "uuid_1");
  assert.equal(peer.streamId, "bot_1");
  assert.equal(reg.getPeer("different_bot"), undefined);
  assert.equal(reg.streamIdForUuid("uuid_1"), "bot_1");
});

test("updateFromAnnounce fills identity and skills", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  const identity = makeIdentity("bot_1");
  const announce = {
    ...makeAnnounce(["skill_a", "skill_b"]),
    agent: {
      runtime: "codex-cli",
      can: ["review"],
      asks: [{ name: "review", description: "Review a patch" }],
    },
  };
  const peer = reg.updateFromAnnounce("bot_1", identity, announce);
  assert.ok(peer);
  assert.deepEqual(peer!.identity, identity);
  assert.deepEqual(peer!.skills, ["skill_a", "skill_b"]);
  assert.equal(peer!.status, "idle");
  assert.deepEqual(peer!.topics, ["events"]);
  assert.deepEqual(peer!.agentProfile, announce.agent);
});

test("updateFromSkillUpdate changes skills and status", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  reg.updateFromAnnounce("bot_1", makeIdentity("bot_1"), makeAnnounce(["old"]));

  const update: SkillUpdatePayload = {
    skills: ["new_a", "new_b"],
    status: "busy",
    statusDetail: "working",
    agent: {
      provider: "anthropic",
      can: ["plan", "review"],
    },
  };
  const peer = reg.updateFromSkillUpdate("bot_1", update);
  assert.ok(peer);
  assert.deepEqual(peer!.skills, ["new_a", "new_b"]);
  assert.equal(peer!.status, "busy");
  assert.equal(peer!.statusDetail, "working");
  assert.deepEqual(peer!.agentProfile, update.agent);
});

test("a replacement peer announcement clears capabilities no longer advertised", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  reg.updateFromAnnounce("bot_1", makeIdentity("bot_1"), {
    ...makeAnnounce(), agent: { can: ["review"], runtime: "codex-cli" },
  });
  reg.markDisconnected("bot_1");
  reg.addPeer("bot_1", "uuid_2");
  reg.updateFromAnnounce("bot_1", {
    ...makeIdentity("bot_1"), instanceId: "inst_2",
  }, makeAnnounce());
  assert.equal(reg.getPeer("bot_1")!.agentProfile, null);
});

test("a skill update without a profile preserves the advertised profile", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  const agent = { can: ["review"], runtime: "codex-cli" };
  reg.updateFromAnnounce("bot_1", makeIdentity("bot_1"), { ...makeAnnounce(), agent });
  reg.updateFromSkillUpdate("bot_1", { skills: [], status: "busy" });
  assert.deepEqual(reg.getPeer("bot_1")!.agentProfile, agent);
});

test("getConnectedPeers filters by connected status", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  reg.addPeer("bot_2", "uuid_2");
  reg.addPeer("bot_3", "uuid_3");
  reg.markDisconnected("bot_2");

  const connected = reg.getConnectedPeers();
  assert.equal(connected.length, 2);
  assert.ok(connected.some((p) => p.streamId === "bot_1"));
  assert.ok(connected.some((p) => p.streamId === "bot_3"));
});

test("connectedCount is accurate", () => {
  const reg = new PeerRegistry();
  assert.equal(reg.connectedCount, 0);
  reg.addPeer("a", "u1");
  assert.equal(reg.connectedCount, 1);
  reg.addPeer("b", "u2");
  assert.equal(reg.connectedCount, 2);
  reg.markDisconnected("a");
  assert.equal(reg.connectedCount, 1);
});

test("isConnected checks connection status", () => {
  const reg = new PeerRegistry();
  assert.ok(!reg.isConnected("nonexistent"));
  reg.addPeer("bot_1", "uuid_1");
  assert.ok(reg.isConnected("bot_1"));
  assert.ok(reg.isConnected("uuid_1")); // resolve by uuid
  reg.markDisconnected("bot_1");
  assert.ok(!reg.isConnected("bot_1"));
});

test("touch updates lastSeenAt", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  const before = reg.getPeer("bot_1")!.lastSeenAt;
  // Small delay to ensure timestamp changes
  reg.touch("bot_1");
  assert.ok(reg.getPeer("bot_1")!.lastSeenAt >= before);
});

test("pruneStale removes old disconnected peers", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  reg.addPeer("bot_2", "uuid_2");
  reg.markDisconnected("bot_1");

  // Force lastSeenAt to be old
  const peer = reg.getPeer("bot_1")!;
  peer.lastSeenAt = Date.now() - 100_000;

  const pruned = reg.pruneStale(50_000);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].streamId, "bot_1");
  assert.equal(reg.getPeer("bot_1"), undefined);
  // bot_2 should still be there (connected)
  assert.ok(reg.getPeer("bot_2"));
});

test("toJSON returns serializable snapshot", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  reg.updateFromAnnounce("bot_1", makeIdentity("bot_1"), {
    ...makeAnnounce(["chat"]),
    agent: {
      runtime: "claude-code",
      asks: [{ name: "status", description: "Return current status" }],
    },
  });
  const json = reg.toJSON();
  assert.ok(Array.isArray(json));
  assert.equal(json.length, 1);
  const entry = json[0] as Record<string, unknown>;
  assert.equal(entry.streamId, "bot_1");
  assert.equal(entry.name, "Test bot_1");
  assert.equal(entry.role, "test");
  assert.ok(entry.connected);
  assert.deepEqual(entry.agentProfile, {
    runtime: "claude-code",
    asks: [{ name: "status", description: "Return current status" }],
  });
});

test("clear removes all peers", () => {
  const reg = new PeerRegistry();
  reg.addPeer("a", "u1");
  reg.addPeer("b", "u2");
  reg.clear();
  assert.equal(reg.connectedCount, 0);
  assert.equal(reg.getAllPeers().length, 0);
});

test("emits peer:join on addPeer", () => {
  const reg = new PeerRegistry();
  let fired = false;
  reg.on("peer:join", () => { fired = true; });
  reg.addPeer("bot_1", "uuid_1");
  assert.ok(fired);
});

test("emits peer:leave on markDisconnected", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  let fired = false;
  reg.on("peer:leave", () => { fired = true; });
  reg.markDisconnected("bot_1");
  assert.ok(fired);
});

test("emits peer:update on announce", () => {
  const reg = new PeerRegistry();
  reg.addPeer("bot_1", "uuid_1");
  let field = "";
  reg.on("peer:update", (_peer, f) => { field = f; });
  reg.updateFromAnnounce("bot_1", makeIdentity("bot_1"), makeAnnounce([]));
  assert.equal(field, "announce");
});
