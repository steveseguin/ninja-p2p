import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildManifest, ChunkMap, sha256Hex, type SwarmManifest } from "../src/swarm.js";
import { createSeedSession, SwarmSession, type SwarmSend } from "../src/swarm-session.js";

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 17) % 251;
  return out;
}

const sessionsByDir = new Map<string, Set<SwarmSession>>();

function trackSession<T extends SwarmSession>(dir: string, session: T): T {
  let sessions = sessionsByDir.get(dir);
  if (!sessions) {
    sessions = new Set();
    sessionsByDir.set(dir, sessions);
  }
  sessions.add(session);
  return session;
}

function removeTempDir(dir: string): void {
  for (const session of sessionsByDir.get(dir) ?? []) session.close();
  sessionsByDir.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

type Envelope =
  | { type: "request"; from: string; to: string; index: number }
  | { type: "chunk"; from: string; to: string; index: number; data: Uint8Array }
  | { type: "have"; from: string; to: string; index: number }
  | { type: "announce"; from: string; chunks: string }
  | { type: "announceTo"; from: string; to: string; chunks: string };

/**
 * A tiny in-memory swarm. Sessions exchange envelopes through a queue that the
 * test drains, so a whole multi-peer transfer runs deterministically.
 */
class SwarmNetwork {
  readonly sessions = new Map<string, SwarmSession>();
  /** Peers that answer every request with garbage, to test verification. */
  readonly saboteurs = new Map<string, number>();
  /** chunks delivered, keyed "sender->receiver", so we can prove who served whom. */
  readonly servedBy = new Map<string, number>();
  private queue: Envelope[] = [];

  sendFor(peerId: string): SwarmSend {
    return {
      request: (to, index) => {
        this.queue.push({ type: "request", from: peerId, to, index });
        return true;
      },
      chunk: (to, index, data) => this.queue.push({ type: "chunk", from: peerId, to, index, data }),
      have: (indexes, toPeerIds) => {
        for (const to of toPeerIds) {
          for (const index of indexes) this.queue.push({ type: "have", from: peerId, to, index });
        }
      },
      announce: (chunks) => this.queue.push({ type: "announce", from: peerId, chunks }),
      announceTo: (to, chunks) => this.queue.push({ type: "announceTo", from: peerId, to, chunks }),
    };
  }

  deliver(): number {
    const batch = this.queue;
    this.queue = [];

    for (const envelope of batch) {
      if (envelope.type === "request") {
        const sabotageChunkSize = this.saboteurs.get(envelope.to);
        if (sabotageChunkSize !== undefined) {
          // Answer promptly with well-formed but wrong bytes, which is the
          // nastier case: the request completes, so only hashing catches it.
          this.queue.push({
            type: "chunk",
            from: envelope.to,
            to: envelope.from,
            index: envelope.index,
            data: new Uint8Array(sabotageChunkSize),
          });
          continue;
        }
        this.sessions.get(envelope.to)?.onChunkRequest(envelope.from, envelope.index);
      } else if (envelope.type === "announceTo") {
        this.sessions.get(envelope.to)?.onPeerAnnounce(envelope.from, envelope.chunks);
      } else if (envelope.type === "chunk") {
        const accepted = this.sessions.get(envelope.to)?.onChunkData(envelope.from, envelope.index, envelope.data);
        if (accepted) {
          const key = `${envelope.from}->${envelope.to}`;
          this.servedBy.set(key, (this.servedBy.get(key) ?? 0) + 1);
        }
      } else if (envelope.type === "have") {
        this.sessions.get(envelope.to)?.onPeerHave(envelope.from, envelope.index);
      } else {
        for (const [peerId, session] of this.sessions) {
          if (peerId !== envelope.from) session.onPeerAnnounce(envelope.from, envelope.chunks);
        }
      }
    }

    return batch.length;
  }

  /** Run until every named session completes, or fail loudly rather than hang. */
  run(targets: string[], maxRounds = 400): number {
    for (let round = 0; round < maxRounds; round += 1) {
      for (const session of this.sessions.values()) session.pump();
      const moved = this.deliver();
      if (targets.every((id) => this.sessions.get(id)?.isComplete())) return round;
      if (moved === 0) {
        throw new Error(`swarm stalled at round ${round} with no messages in flight`);
      }
    }
    throw new Error("swarm did not converge");
  }

  served(from: string, to: string): number {
    return this.servedBy.get(`${from}->${to}`) ?? 0;
  }
}

function seedFile(dir: string, name: string, data: Uint8Array, chunkSize: number): {
  manifest: SwarmManifest;
  filePath: string;
} {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, data);
  return { manifest: buildManifest(data, name, "application/octet-stream", chunkSize), filePath };
}

test("a leecher downloads a whole file from a single seeder", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarmnet-"));
  try {
    const data = bytes(40_000, 2);
    const { manifest, filePath } = seedFile(dir, "source.bin", data, 4_096);
    const net = new SwarmNetwork();

    net.sessions.set("seed", trackSession(dir, createSeedSession(manifest, filePath, net.sendFor("seed"))));
    net.sessions.set("leech", trackSession(dir, new SwarmSession({
      manifest,
      partPath: path.join(dir, "leech.part"),
      savedPath: path.join(dir, "leech.bin"),
      send: net.sendFor("leech"),
    })));

    net.sessions.get("seed")!.announce();
    net.deliver();
    net.run(["leech"]);

    const result = net.sessions.get("leech")!.finish();
    assert.equal(result.ok, true, result.error);
    assert.equal(sha256Hex(new Uint8Array(readFileSync(result.savedPath!))), manifest.fileId);
  } finally {
    removeTempDir(dir);
  }
});

test("a fresh download claims its part file before the first chunk arrives", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarmnet-"));
  const data = bytes(8_000, 3);
  const manifest = buildManifest(data, "locked.bin", "application/octet-stream", 4_096);
  const partPath = path.join(dir, "shared.part");
  const send: SwarmSend = {
    request: () => true,
    chunk: () => {},
    have: () => {},
    announce: () => {},
    announceTo: () => {},
  };
  let first: SwarmSession | null = null;
  try {
    first = trackSession(dir, new SwarmSession({
      manifest,
      partPath,
      savedPath: path.join(dir, "one.bin"),
      send,
    }));
    assert.throws(
      () => new SwarmSession({
        manifest,
        partPath,
        savedPath: path.join(dir, "two.bin"),
        send,
      }),
      /another download .* already running/,
    );
  } finally {
    first?.close();
    removeTempDir(dir);
  }
});

test("an empty file completes without waiting for a chunk", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarmnet-"));
  try {
    const manifest = buildManifest(new Uint8Array(0), "empty.txt", "text/plain");
    const savedPath = path.join(dir, "empty.txt");
    const session = trackSession(dir, new SwarmSession({
      manifest,
      partPath: path.join(dir, "empty.part"),
      savedPath,
      send: {
        request: () => true,
        chunk: () => {},
        have: () => {},
        announce: () => {},
        announceTo: () => {},
      },
    }));

    assert.equal(session.isComplete(), true);
    const result = session.finish();
    assert.equal(result.ok, true, result.error);
    assert.equal(readFileSync(savedPath).byteLength, 0);
  } finally {
    removeTempDir(dir);
  }
});

test("finish is harmless when called on a seed session", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarmnet-"));
  try {
    const data = bytes(4_000, 5);
    const { manifest, filePath } = seedFile(dir, "seed.bin", data, 1_024);
    const seed = trackSession(dir, createSeedSession(manifest, filePath, {
      request: () => true,
      chunk: () => {},
      have: () => {},
      announce: () => {},
      announceTo: () => {},
    }));
    const result = seed.finish();
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(new Uint8Array(readFileSync(filePath)), data);
  } finally {
    removeTempDir(dir);
  }
});

test("a peer re-serves a file it downloaded, after the original seeder leaves", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarmnet-"));
  try {
    const data = bytes(30_000, 4);
    const { manifest, filePath } = seedFile(dir, "origin.bin", data, 4_096);
    const net = new SwarmNetwork();

    // Phase 1: A pulls the file from the original seeder.
    net.sessions.set("seed", trackSession(dir, createSeedSession(manifest, filePath, net.sendFor("seed"))));
    net.sessions.set("a", trackSession(dir, new SwarmSession({
      manifest,
      partPath: path.join(dir, "a.part"),
      savedPath: path.join(dir, "a.bin"),
      send: net.sendFor("a"),
    })));

    net.sessions.get("seed")!.announce();
    net.deliver();
    net.run(["a"]);
    assert.equal(net.sessions.get("a")!.finish().ok, true);

    // Phase 2: the seeder disappears entirely, and B arrives knowing only A.
    net.sessions.delete("seed");
    const aSeeder = trackSession(
      dir,
      createSeedSession(manifest, path.join(dir, "a.bin"), net.sendFor("a")),
    );
    net.sessions.set("a", aSeeder);

    net.sessions.set("b", trackSession(dir, new SwarmSession({
      manifest,
      partPath: path.join(dir, "b.part"),
      savedPath: path.join(dir, "b.bin"),
      send: net.sendFor("b"),
    })));

    aSeeder.announce();
    net.deliver();
    net.run(["b"]);

    const result = net.sessions.get("b")!.finish();
    assert.equal(result.ok, true, result.error);
    assert.equal(sha256Hex(new Uint8Array(readFileSync(result.savedPath!))), manifest.fileId);
    assert.ok(net.served("a", "b") > 0, "B must have been served by A, not the original seeder");
  } finally {
    removeTempDir(dir);
  }
});

test("a partially complete peer serves what it already has", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarmnet-"));
  try {
    const data = bytes(60_000, 6);
    const { manifest, filePath } = seedFile(dir, "big.bin", data, 4_096);
    const net = new SwarmNetwork();

    net.sessions.set("seed", trackSession(dir, createSeedSession(manifest, filePath, net.sendFor("seed"))));
    const a = trackSession(dir, new SwarmSession({
      manifest,
      partPath: path.join(dir, "a.part"),
      savedPath: path.join(dir, "a.bin"),
      send: net.sendFor("a"),
      maxInFlightTotal: 2,
    }));
    net.sessions.set("a", a);

    net.sessions.get("seed")!.announce();
    net.deliver();

    // Let A get partway, but deliberately not finish.
    for (let i = 0; i < 3; i += 1) {
      for (const session of net.sessions.values()) session.pump();
      net.deliver();
    }
    assert.ok(!a.isComplete(), "A should still be mid-download");
    assert.ok(a.chunkMap().count() > 0, "A should hold some chunks");

    // B joins and can pull from both the seeder and the half-finished A.
    net.sessions.set("b", trackSession(dir, new SwarmSession({
      manifest,
      partPath: path.join(dir, "b.part"),
      savedPath: path.join(dir, "b.bin"),
      send: net.sendFor("b"),
    })));
    net.sessions.get("seed")!.announce();
    a.announce();
    net.deliver();

    net.run(["a", "b"]);

    assert.equal(net.sessions.get("b")!.finish().ok, true);
    assert.ok(net.served("a", "b") > 0, "the partially complete peer should have contributed");
  } finally {
    removeTempDir(dir);
  }
});

test("a peer serving corrupt chunks is detected and routed around", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarmnet-"));
  try {
    const data = bytes(20_000, 8);
    const { manifest, filePath } = seedFile(dir, "honest.bin", data, 4_096);
    const net = new SwarmNetwork();

    net.sessions.set(
      "honest",
      trackSession(dir, createSeedSession(manifest, filePath, net.sendFor("honest"))),
    );

    const leech = trackSession(dir, new SwarmSession({
      manifest,
      partPath: path.join(dir, "leech.part"),
      savedPath: path.join(dir, "leech.bin"),
      send: net.sendFor("leech"),
    }));
    net.sessions.set("leech", leech);

    // A liar that claims to hold everything and answers with well-formed
    // garbage. It stays in the swarm the whole time; scoring has to route
    // around it rather than the test quietly removing it.
    net.saboteurs.set("liar", manifest.chunkSize);
    leech.setPeerChunks("liar", ChunkMap.full(manifest.totalChunks));

    net.sessions.get("honest")!.announce();
    net.deliver();
    net.run(["leech"]);

    const result = leech.finish();
    assert.equal(result.ok, true, result.error);
    assert.equal(sha256Hex(new Uint8Array(readFileSync(result.savedPath!))), manifest.fileId);

    assert.ok((leech.statsFor("liar")?.failures ?? 0) > 0, "the liar should have been caught");
    assert.equal(leech.statsFor("liar")?.delivered ?? 0, 0, "none of its chunks were accepted");
    assert.ok(net.served("honest", "leech") > 0, "the honest peer supplied the real bytes");
  } finally {
    removeTempDir(dir);
  }
});

test("requests that never come back time out and are charged to the peer", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarmnet-"));
  try {
    const data = bytes(16_000, 10);
    const manifest = buildManifest(data, "silent.bin", "application/octet-stream", 4_096);

    let clock = 1_000;
    const sent: number[] = [];
    const session = trackSession(dir, new SwarmSession({
      manifest,
      partPath: path.join(dir, "s.part"),
      savedPath: path.join(dir, "s.bin"),
      now: () => clock,
      requestTimeoutMs: 5_000,
      send: {
        request: (_peer, index) => sent.push(index),
        chunk: () => {},
        have: () => {},
        announce: () => {},
        announceTo: () => {},
      },
    }));

    session.setPeerChunks("ghost", ChunkMap.full(manifest.totalChunks));
    assert.ok(session.pump() > 0, "should issue requests");
    assert.ok(sent.length > 0);

    // The peer never answers.
    assert.equal(session.expireTimeouts(), 0, "not yet past the timeout");
    clock += 6_000;
    const expired = session.expireTimeouts();
    assert.ok(expired > 0, "outstanding requests should expire");
    assert.equal(session.statsFor("ghost")!.failures, expired);
    assert.equal(session.progress().inFlight, 0, "expired requests must free their slots");
  } finally {
    removeTempDir(dir);
  }
});

test("removing a peer frees the chunks it owed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarmnet-"));
  try {
    const data = bytes(16_000, 12);
    const manifest = buildManifest(data, "gone.bin", "application/octet-stream", 4_096);
    const session = trackSession(dir, new SwarmSession({
      manifest,
      partPath: path.join(dir, "g.part"),
      savedPath: path.join(dir, "g.bin"),
      send: { request: () => true, chunk: () => {}, have: () => {}, announce: () => {}, announceTo: () => {} },
    }));

    session.setPeerChunks("leaver", ChunkMap.full(manifest.totalChunks));
    session.pump();
    assert.ok(session.progress().inFlight > 0);

    session.removePeer("leaver");
    assert.equal(session.progress().inFlight, 0, "their outstanding requests are never arriving");
    assert.equal(session.peerCount(), 0);
  } finally {
    removeTempDir(dir);
  }
});

test("progress reports and finish refuses an incomplete transfer", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarmnet-"));
  try {
    const data = bytes(12_000, 14);
    const manifest = buildManifest(data, "p.bin", "application/octet-stream", 4_096);
    const session = trackSession(dir, new SwarmSession({
      manifest,
      partPath: path.join(dir, "p.part"),
      savedPath: path.join(dir, "p.bin"),
      send: { request: () => true, chunk: () => {}, have: () => {}, announce: () => {}, announceTo: () => {} },
    }));

    const before = session.progress();
    assert.equal(before.totalChunks, 3);
    assert.equal(before.haveChunks, 0);
    assert.equal(before.percent, 0);
    assert.equal(before.complete, false);

    const failed = session.finish();
    assert.equal(failed.ok, false);
    assert.match(failed.error!, /incomplete/);

    session.onChunkData("x", 0, data.subarray(0, 4_096));
    assert.equal(session.progress().haveChunks, 1);
    assert.equal(session.progress().percent, 33);
  } finally {
    removeTempDir(dir);
  }
});

test("a duplicate chunk from a slower peer is accepted without penalty", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarmnet-"));
  try {
    const data = bytes(8_000, 16);
    const manifest = buildManifest(data, "d.bin", "application/octet-stream", 4_096);
    const session = trackSession(dir, new SwarmSession({
      manifest,
      partPath: path.join(dir, "d.part"),
      savedPath: path.join(dir, "d.bin"),
      send: { request: () => true, chunk: () => {}, have: () => {}, announce: () => {}, announceTo: () => {} },
    }));

    assert.equal(session.onChunkData("fast", 0, data.subarray(0, 4_096)), true);
    // The same chunk arriving late from another peer is a race, not a fault.
    assert.equal(session.onChunkData("slow", 0, data.subarray(0, 4_096)), true);
    assert.equal(session.statsFor("slow")?.failures ?? 0, 0);
    assert.equal(session.chunkMap().count(), 1);
  } finally {
    removeTempDir(dir);
  }
});
