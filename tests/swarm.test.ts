import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildManifest,
  ChunkFile,
  ChunkMap,
  chunkLength,
  chunkOffset,
  createPeerStats,
  manifestsAgree,
  planChunkRequests,
  recordPeerRtt,
  scorePeer,
  sha256Hex,
  UNKNOWN_PEER_RTT_MS,
  type SwarmPeerState,
} from "../src/swarm.js";

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * seed + 7) % 251;
  return out;
}

function peer(peerId: string, chunks: ChunkMap, inFlight = 0, stats?: SwarmPeerState["stats"]): SwarmPeerState {
  return { peerId, chunks, inFlight, stats };
}

// ── ChunkMap ─────────────────────────────────────────────────────────────────

test("ChunkMap tracks presence and completeness", () => {
  const map = new ChunkMap(10);
  assert.equal(map.count(), 0);
  assert.equal(map.isComplete(), false);

  assert.equal(map.set(3), true);
  assert.equal(map.set(3), false, "setting twice must not double count");
  assert.equal(map.has(3), true);
  assert.equal(map.has(4), false);
  assert.equal(map.count(), 1);
  assert.deepEqual(map.missing().length, 9);

  for (let i = 0; i < 10; i += 1) map.set(i);
  assert.equal(map.isComplete(), true);
  assert.deepEqual(map.missing(), []);
});

test("ChunkMap ignores out-of-range indices", () => {
  const map = new ChunkMap(4);
  assert.equal(map.set(-1), false);
  assert.equal(map.set(4), false);
  assert.equal(map.has(-1), false);
  assert.equal(map.has(99), false);
  assert.equal(map.count(), 0);
});

test("ChunkMap survives a base64 round trip", () => {
  const map = new ChunkMap(20);
  for (const index of [0, 5, 9, 19]) map.set(index);

  const restored = ChunkMap.fromBase64(map.toBase64(), 20);
  assert.equal(restored.count(), 4);
  for (const index of [0, 5, 9, 19]) assert.equal(restored.has(index), true, `index ${index}`);
  assert.equal(restored.has(1), false);
});

test("ChunkMap.fromBase64 tolerates a short payload", () => {
  // A peer on an older build could send a shorter bitfield; treat the tail as
  // "not held" rather than throwing and dropping the peer entirely.
  const restored = ChunkMap.fromBase64(Buffer.from([0b0000_0101]).toString("base64"), 20);
  assert.equal(restored.totalChunks, 20);
  assert.equal(restored.has(0), true);
  assert.equal(restored.has(2), true);
  assert.equal(restored.has(19), false);
});

test("ChunkMap.full marks everything and clone is independent", () => {
  const full = ChunkMap.full(8);
  assert.equal(full.isComplete(), true);

  const copy = full.clone();
  const partial = new ChunkMap(8);
  partial.set(1);
  assert.equal(copy.count(), 8);
  assert.equal(partial.count(), 1);
});

test("ChunkMap handles a zero-chunk (empty) file", () => {
  const map = new ChunkMap(0);
  assert.equal(map.isComplete(), true);
  assert.deepEqual(map.missing(), []);
});

// ── Peer scoring ─────────────────────────────────────────────────────────────

test("scorePeer prefers measured-fast peers but still tries unknown ones", () => {
  const chunks = ChunkMap.full(4);
  const fast = peer("fast", chunks, 0, { rttMs: 40, failures: 0, delivered: 5 });
  const unknown = peer("unknown", chunks, 0);
  const slow = peer("slow", chunks, 0, { rttMs: 900, failures: 0, delivered: 5 });

  assert.ok(scorePeer(fast) < scorePeer(unknown));
  assert.ok(scorePeer(unknown) < scorePeer(slow));
  assert.equal(scorePeer(unknown), UNKNOWN_PEER_RTT_MS);
});

test("scorePeer punishes failures hard enough to route around a bad peer", () => {
  const chunks = ChunkMap.full(4);
  const flaky = peer("flaky", chunks, 0, { rttMs: 10, failures: 2, delivered: 50 });
  const honestButSlow = peer("slow", chunks, 0, { rttMs: 800, failures: 0, delivered: 50 });

  // A peer that serves corrupt chunks should lose to one that is merely slow.
  assert.ok(scorePeer(flaky) > scorePeer(honestButSlow));
});

test("scorePeer accounts for queue depth", () => {
  const chunks = ChunkMap.full(4);
  const idle = peer("a", chunks, 0, { rttMs: 100, failures: 0, delivered: 0 });
  const busy = peer("b", chunks, 3, { rttMs: 100, failures: 0, delivered: 0 });
  assert.ok(scorePeer(idle) < scorePeer(busy));
});

test("recordPeerRtt smooths samples and rejects nonsense", () => {
  const stats = createPeerStats();
  recordPeerRtt(stats, 100);
  assert.equal(stats.rttMs, 100, "first sample seeds the average");

  recordPeerRtt(stats, 200);
  assert.ok(stats.rttMs! > 100 && stats.rttMs! < 200, "should move toward the new sample, not jump to it");

  const before = stats.rttMs;
  recordPeerRtt(stats, Number.NaN);
  recordPeerRtt(stats, -5);
  assert.equal(stats.rttMs, before, "bad samples must be ignored");
});

// ── Piece selection ──────────────────────────────────────────────────────────

test("planChunkRequests fetches the rarest chunk first", () => {
  const have = new ChunkMap(4);

  // Only the seeder holds chunk 3; chunks 0-2 are held by both peers. That
  // makes 3 the single copy at risk if the seeder leaves.
  const seeder = ChunkMap.full(4);
  const partial = new ChunkMap(4);
  [0, 1, 2].forEach((i) => partial.set(i));

  const plans = planChunkRequests(have, [peer("a", seeder), peer("b", partial)], new Set(), {
    maxInFlightTotal: 1,
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0].index, 3);
  assert.equal(plans[0].peerId, "a", "only the seeder can serve it");
});

test("planChunkRequests still prefers rarity over the tie-break", () => {
  const have = new ChunkMap(4);
  const only = new ChunkMap(4);
  [1, 2, 3].forEach((i) => only.set(i));
  const both = new ChunkMap(4);
  [2, 3].forEach((i) => both.set(i));

  // Chunk 1 is held by one peer and 2 and 3 by two, so 1 must win regardless of
  // how the random tie-break falls.
  for (let trial = 0; trial < 25; trial += 1) {
    const plans = planChunkRequests(have, [peer("a", only), peer("b", both)], new Set(), {
      maxInFlightTotal: 1,
    });
    assert.equal(plans[0].index, 1, "rarest must win before ties are considered");
  }
});

test("planChunkRequests breaks rarity ties randomly so downloaders diverge", () => {
  // Deterministic index tie-breaking made every downloader ask for the same
  // chunks in the same order, so they never held anything to trade and could
  // not serve each other at all. Measured live: three leechers against one
  // seeder ran at exactly one third the speed of one, with no peer-to-peer
  // traffic. This is the behaviour that fixed it.
  const chosen = new Set<number>();
  for (let trial = 0; trial < 200; trial += 1) {
    const have = new ChunkMap(8);
    const everything = ChunkMap.full(8);
    const plans = planChunkRequests(have, [peer("a", everything)], new Set(), {
      maxInFlightTotal: 1,
    });
    chosen.add(plans[0].index);
  }
  assert.ok(chosen.size > 1, `expected varied first picks, always got ${[...chosen]}`);
});

test("planChunkRequests is deterministic when handed a fixed tie-break source", () => {
  const have = new ChunkMap(4);
  const only = new ChunkMap(4);
  [1, 2, 3].forEach((i) => only.set(i));

  // An injected source keeps planning reproducible for anyone who needs it.
  const plan = () => {
    let n = 0;
    const sequence = [0.9, 0.1, 0.5];
    return planChunkRequests(have, [peer("a", only)], new Set(), {
      maxInFlightTotal: 1,
      random: () => sequence[n++ % sequence.length],
    });
  };
  assert.deepEqual(plan(), [{ peerId: "a", index: 2 }], "lowest tie-break value wins");
  assert.deepEqual(plan(), plan(), "same source, same plan");
});

test("planChunkRequests never requests what we have or what is already in flight", () => {
  const have = new ChunkMap(5);
  have.set(0);
  have.set(1);

  const plans = planChunkRequests(have, [peer("a", ChunkMap.full(5))], new Set([2]));
  const indices = plans.map((p) => p.index).sort();
  assert.deepEqual(indices, [3, 4]);
});

test("planChunkRequests respects the per-peer and total in-flight caps", () => {
  const have = new ChunkMap(50);
  const peers = [peer("a", ChunkMap.full(50)), peer("b", ChunkMap.full(50))];

  const plans = planChunkRequests(have, peers, new Set(), {
    maxInFlightPerPeer: 2,
    maxInFlightTotal: 10,
  });

  assert.equal(plans.length, 4, "two peers times two slots each");
  const perPeer = new Map<string, number>();
  for (const plan of plans) perPeer.set(plan.peerId, (perPeer.get(plan.peerId) ?? 0) + 1);
  assert.equal(perPeer.get("a"), 2);
  assert.equal(perPeer.get("b"), 2);
});

test("planChunkRequests accounts for requests already outstanding", () => {
  const have = new ChunkMap(20);
  const peers = [peer("a", ChunkMap.full(20), 4), peer("b", ChunkMap.full(20), 0)];

  const plans = planChunkRequests(have, peers, new Set(), { maxInFlightPerPeer: 4 });
  assert.ok(plans.length > 0);
  assert.ok(plans.every((p) => p.peerId === "b"), "peer a is already at capacity");
});

test("planChunkRequests spreads work rather than dumping it on one peer", () => {
  const have = new ChunkMap(20);
  const peers = [peer("a", ChunkMap.full(20)), peer("b", ChunkMap.full(20))];

  const plans = planChunkRequests(have, peers, new Set(), {
    maxInFlightPerPeer: 8,
    maxInFlightTotal: 8,
  });

  const perPeer = new Map<string, number>();
  for (const plan of plans) perPeer.set(plan.peerId, (perPeer.get(plan.peerId) ?? 0) + 1);
  assert.equal(perPeer.get("a"), 4);
  assert.equal(perPeer.get("b"), 4);
});

test("planChunkRequests routes around a peer with failures", () => {
  const have = new ChunkMap(4);
  const good = peer("good", ChunkMap.full(4), 0, { rttMs: 100, failures: 0, delivered: 10 });
  const bad = peer("bad", ChunkMap.full(4), 0, { rttMs: 5, failures: 3, delivered: 10 });

  const plans = planChunkRequests(have, [good, bad], new Set(), { maxInFlightTotal: 1 });
  assert.equal(plans[0].peerId, "good");
});

test("planChunkRequests skips chunks nobody has", () => {
  const have = new ChunkMap(4);
  const partial = new ChunkMap(4);
  partial.set(1);

  const plans = planChunkRequests(have, [peer("a", partial)], new Set());
  assert.deepEqual(plans.map((p) => p.index), [1]);
});

test("planChunkRequests returns nothing when there are no peers", () => {
  assert.deepEqual(planChunkRequests(new ChunkMap(4), [], new Set()), []);
});

test("planChunkRequests returns nothing once the total cap is already used", () => {
  const have = new ChunkMap(10);
  const plans = planChunkRequests(have, [peer("a", ChunkMap.full(10), 5)], new Set(), {
    maxInFlightTotal: 5,
  });
  assert.deepEqual(plans, []);
});

// ── Manifest ─────────────────────────────────────────────────────────────────

test("buildManifest hashes each chunk and the whole file", () => {
  const data = bytes(5_000);
  const manifest = buildManifest(data, "notes.txt", "text/plain", 2_048);

  assert.equal(manifest.size, 5_000);
  assert.equal(manifest.chunkSize, 2_048);
  assert.equal(manifest.totalChunks, 3);
  assert.equal(manifest.chunkHashes.length, 3);
  assert.equal(manifest.fileId, sha256Hex(data));
  assert.equal(manifest.chunkHashes[0], sha256Hex(data.subarray(0, 2_048)));
  assert.equal(manifest.chunkHashes[2], sha256Hex(data.subarray(4_096, 5_000)), "last chunk is short");
});

test("buildManifest enforces a floor on chunk size", () => {
  const manifest = buildManifest(bytes(4_000), "a.bin", "application/octet-stream", 10);
  assert.equal(manifest.chunkSize, 1_024);
});

test("buildManifest handles an empty file", () => {
  const manifest = buildManifest(new Uint8Array(0), "empty.txt", "text/plain");
  assert.equal(manifest.totalChunks, 0);
  assert.deepEqual(manifest.chunkHashes, []);
});

test("manifestsAgree rejects a peer describing different bytes", () => {
  const data = bytes(4_000);
  const mine = buildManifest(data, "a.bin", "application/octet-stream", 1_024);

  assert.equal(manifestsAgree(mine, { ...mine }), true);
  assert.equal(manifestsAgree(mine, { ...mine, size: 4_001 }), false);
  assert.equal(manifestsAgree(mine, { ...mine, chunkSize: 2_048 }), false);
  assert.equal(manifestsAgree(mine, { ...mine, fileId: "deadbeef" }), false);

  // Same id and shape, but the chunk hashes describe other content.
  const tampered = { ...mine, chunkHashes: [...mine.chunkHashes] };
  tampered.chunkHashes[1] = sha256Hex(bytes(10, 9));
  assert.equal(manifestsAgree(mine, tampered), false);
});

test("chunkOffset and chunkLength describe the last short chunk correctly", () => {
  const manifest = { size: 5_000, chunkSize: 2_048 };
  assert.equal(chunkOffset(2, 2_048), 4_096);
  assert.equal(chunkLength(0, manifest), 2_048);
  assert.equal(chunkLength(2, manifest), 904);
  assert.equal(chunkLength(9, manifest), 0);
});

// ── ChunkFile ────────────────────────────────────────────────────────────────

test("ChunkFile reassembles a file from out-of-order chunks", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarm-"));
  try {
    const data = bytes(5_000, 3);
    const manifest = buildManifest(data, "out-of-order.bin", "application/octet-stream", 2_048);
    const target = path.join(dir, "out.part");
    const file = new ChunkFile(target, manifest);

    // Deliberately reversed: this is the whole point of positional writes.
    for (const index of [2, 0, 1]) {
      const start = index * manifest.chunkSize;
      const slice = data.subarray(start, start + chunkLength(index, manifest));
      assert.equal(file.writeChunk(index, slice), true, `chunk ${index}`);
    }
    file.close();

    const assembled = new Uint8Array(readFileSync(target));
    assert.equal(assembled.byteLength, data.byteLength);
    assert.equal(sha256Hex(assembled), manifest.fileId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ChunkFile rejects a chunk that fails its hash", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarm-"));
  try {
    const data = bytes(3_000, 5);
    const manifest = buildManifest(data, "bad.bin", "application/octet-stream", 1_024);
    const file = new ChunkFile(path.join(dir, "bad.part"), manifest);

    const corrupted = Uint8Array.from(data.subarray(0, 1_024));
    corrupted[0] ^= 0xff;

    assert.equal(file.writeChunk(0, corrupted), false, "corrupt chunk must be refused");
    assert.equal(file.writeChunk(0, data.subarray(0, 1_024)), true, "the real chunk still works");
    file.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ChunkFile rejects wrong-length and out-of-range chunks", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarm-"));
  try {
    const data = bytes(3_000, 7);
    const manifest = buildManifest(data, "x.bin", "application/octet-stream", 1_024);
    const file = new ChunkFile(path.join(dir, "x.part"), manifest);

    assert.equal(file.writeChunk(0, data.subarray(0, 512)), false, "short chunk");
    assert.equal(file.writeChunk(99, data.subarray(0, 1_024)), false, "index past the end");
    assert.equal(file.writeChunk(-1, data.subarray(0, 1_024)), false, "negative index");
    file.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ChunkFile can re-serve a chunk it already holds", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarm-"));
  try {
    const data = bytes(4_000, 11);
    const manifest = buildManifest(data, "seed.bin", "application/octet-stream", 1_024);
    const file = new ChunkFile(path.join(dir, "seed.part"), manifest);

    const original = data.subarray(1_024, 2_048);
    assert.equal(file.writeChunk(1, original), true);

    // This is what makes swarming work: a partial downloader is already a seeder.
    const served = file.readChunk(1);
    assert.ok(served);
    assert.equal(sha256Hex(served), manifest.chunkHashes[1]);
    assert.deepEqual([...served], [...original]);

    assert.equal(file.readChunk(99), null);
    file.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ChunkFile resumes an interrupted transfer from disk", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-swarm-"));
  try {
    const data = bytes(4_000, 13);
    const manifest = buildManifest(data, "resume.bin", "application/octet-stream", 1_024);
    const target = path.join(dir, "resume.part");

    const first = new ChunkFile(target, manifest);
    first.writeChunk(0, data.subarray(0, 1_024));
    first.close();

    // A fresh handle over the same path must see the earlier chunk.
    const second = new ChunkFile(target, manifest);
    const recovered = second.readChunk(0);
    assert.ok(recovered);
    assert.equal(sha256Hex(recovered), manifest.chunkHashes[0]);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
