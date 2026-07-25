/**
 * Coverage for the swarm manager.
 *
 * This module had no test file, and four of the bugs found in a day of live
 * testing lived here: the startup stall, the shared part file, the have-message
 * flood, and requests counted as outstanding whether or not they were sent.
 * Every test below stands for something that was once broken or is easy to
 * break.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { SwarmManager } from "../src/swarm-manager.js";
import { buildManifest, ChunkMap, maxSafeChunkSize, sha256Hex } from "../src/swarm.js";
import { encodeChunkFrame } from "../src/swarm-wire.js";
import { createEnvelope, type MessageEnvelope, type MessageType, type PeerIdentity } from "../src/protocol.js";

type Sent = { to: string | null; type: MessageType; payload: any };

/** A bridge that records everything instead of touching a network. */
class FakeBridge extends EventEmitter {
  readonly sent: Sent[] = [];
  readonly binary: Array<{ to: string; bytes: Uint8Array }> = [];
  readonly revived: string[] = [];
  binarySupported = true;
  binaryAccepts = true;
  messageLimit: number | null = null;

  readonly bus = new (class extends EventEmitter {
    constructor(private readonly owner: FakeBridge) { super(); }
    trySend(to: string, type: MessageType, payload: unknown): boolean {
      this.owner.sent.push({ to, type, payload });
      return true;
    }
    tryBroadcast(type: MessageType, payload: unknown): boolean {
      this.owner.sent.push({ to: null, type, payload });
      return true;
    }
    send(to: string, type: MessageType, payload: unknown): unknown {
      this.owner.sent.push({ to, type, payload });
      return null;
    }
    broadcast(type: MessageType, payload: unknown): unknown {
      this.owner.sent.push({ to: null, type, payload });
      return null;
    }
  })(this);

  supportsBinary(): boolean { return this.binarySupported; }
  async sendBinaryTo(to: string, bytes: Uint8Array): Promise<boolean> {
    if (!this.binaryAccepts) return false;
    this.binary.push({ to, bytes });
    return true;
  }
  smallestMaxMessageSize(): number | null { return this.messageLimit; }
  revivePeer(streamId: string): boolean { this.revived.push(streamId); return true; }

  /** Deliver a message as if it arrived from a peer. */
  deliver(from: string, type: MessageType, payload: unknown): void {
    const identity: PeerIdentity = { streamId: from, role: "agent", name: from, instanceId: "x" };
    const envelope: MessageEnvelope = createEnvelope(identity, type, payload);
    this.bus.emit(`message:${type}`, envelope);
  }

  ofType(type: MessageType): Sent[] { return this.sent.filter((s) => s.type === type); }
}

function withManager<T>(
  fn: (ctx: { manager: SwarmManager; bridge: FakeBridge; dir: string; logs: string[] }) => T,
  options: Partial<{ messageLimit: number | null; binarySupported: boolean }> = {},
): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-mgr-"));
  const bridge = new FakeBridge();
  if (options.messageLimit !== undefined) bridge.messageLimit = options.messageLimit;
  if (options.binarySupported !== undefined) bridge.binarySupported = options.binarySupported;
  const logs: string[] = [];
  const manager = new SwarmManager({
    bridge: bridge as unknown as import("../src/vdo-bridge.js").VDOBridge,
    downloadDir: path.join(dir, "dl"),
    workDir: path.join(dir, "work"),
    log: (m) => logs.push(m),
  });
  manager.start();
  try {
    return fn({ manager, bridge, dir, logs });
  } finally {
    manager.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeFile(dir: string, name: string, size = 40_000, seed = 3): string {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) data[i] = (i * 31 + seed * 17) % 251;
  const filePath = path.join(dir, name);
  writeFileSync(filePath, data);
  return filePath;
}

describe("seeding", () => {
  it("publishes an offer the room can act on", () => {
    withManager(({ manager, bridge, dir }) => {
      const manifest = manager.seed(makeFile(dir, "a.bin"));
      const offers = bridge.ofType("swarm_offer");

      assert.equal(offers.length, 1);
      assert.equal(offers[0].to, null, "the first offer is for everyone");
      assert.equal(offers[0].payload.fileId, manifest.fileId);
      assert.equal(offers[0].payload.chunkHashes.length, manifest.totalChunks);
    });
  });

  it("keeps the chunk size the transport can actually carry", () => {
    withManager(({ manager, dir }) => {
      // The base64 fallback of a 64000-byte chunk is 85336 bytes, which a peer
      // negotiating the spec-minimum 65536 would refuse.
      const manifest = manager.seed(makeFile(dir, "a.bin"), 64_000);
      assert.equal(manifest.chunkSize, maxSafeChunkSize(65_536));
      assert.ok(manifest.chunkSize < 64_000);
    }, { messageLimit: 65_536 });
  });

  it("leaves the chunk size alone when the transport can carry it", () => {
    withManager(({ manager, dir }) => {
      assert.equal(manager.seed(makeFile(dir, "a.bin"), 64_000).chunkSize, 64_000);
    }, { messageLimit: 262_144 });
  });

  it("refuses a path that is not a file", () => {
    withManager(({ manager, dir }) => {
      assert.throws(() => manager.seed(path.join(dir, "missing.bin")), /not a file/);
    });
  });
});

describe("offers arriving from peers", () => {
  it("remembers a wanted file until its offer shows up", () => {
    withManager(({ manager, bridge, dir }) => {
      const manifest = buildManifest(new Uint8Array(readFileSync(makeFile(dir, "a.bin"))), "a.bin", "application/octet-stream", 4_096);

      assert.equal(manager.fetch(manifest.fileId), false, "no offer yet");
      bridge.deliver("seed", "swarm_offer", manifest);
      assert.ok(manager.sessionFor(manifest.fileId), "the offer should start it");
    });
  });

  it("rejects an offer that contradicts one already known", () => {
    withManager(({ manager, bridge, dir, logs }) => {
      const manifest = manager.seed(makeFile(dir, "a.bin"));
      // Same content id, different bytes: one of them is lying, and trading
      // chunks with a liar corrupts the file.
      bridge.deliver("liar", "swarm_offer", { ...manifest, chunkHashes: manifest.chunkHashes.map(() => "0".repeat(64)) });

      assert.ok(logs.some((l) => /rejecting conflicting offer/.test(l)));
    });
  });

  it("ignores a malformed offer instead of throwing", () => {
    withManager(({ manager, bridge }) => {
      bridge.deliver("junk", "swarm_offer", { fileId: "abc" });
      bridge.deliver("junk", "swarm_offer", null);
      assert.deepEqual(manager.knownOffers(), []);
    });
  });

  it("finds an offer by name or id prefix, and refuses to guess", () => {
    withManager(({ manager, dir }) => {
      const a = manager.seed(makeFile(dir, "a.bin", 40_000, 1));
      manager.seed(makeFile(dir, "b.bin", 40_000, 2));

      assert.equal(manager.resolveOffer("a.bin")?.fileId, a.fileId);
      assert.equal(manager.resolveOffer(a.fileId.slice(0, 10))?.fileId, a.fileId);
      assert.equal(manager.resolveOffer("nope"), null);
      assert.equal(manager.resolveOffer(""), null);
    });
  });
});

describe("greeting and answering peers", () => {
  it("sends a new peer the catalogue directly, not to the whole room", () => {
    withManager(({ manager, bridge, dir }) => {
      manager.seed(makeFile(dir, "a.bin"));
      bridge.sent.length = 0;

      bridge.emit("peer:announce", { streamId: "newcomer" });

      const offers = bridge.ofType("swarm_offer");
      assert.equal(offers.length, 1);
      // A manifest is one hash per chunk — megabytes for a large file, so
      // re-broadcasting on every join would be very expensive.
      assert.equal(offers[0].to, "newcomer");
    });
  });

  it("answers a peer's bitfield when it can help, so it need not wait", () => {
    withManager(({ manager, bridge, dir }) => {
      const manifest = manager.seed(makeFile(dir, "a.bin"));
      bridge.sent.length = 0;

      bridge.deliver("leech", "swarm_announce", {
        fileId: manifest.fileId,
        totalChunks: manifest.totalChunks,
        chunks: new ChunkMap(manifest.totalChunks).toBase64(),
      });

      const replies = bridge.ofType("swarm_announce").filter((s) => s.to === "leech");
      assert.equal(replies.length, 1, "waiting for the next broadcast cost 2.6s of a 4.0s transfer");
    });
  });

  it("stays quiet toward a peer it cannot help, so the exchange terminates", () => {
    withManager(({ manager, bridge, dir }) => {
      const manifest = manager.seed(makeFile(dir, "a.bin"));
      bridge.sent.length = 0;

      bridge.deliver("other", "swarm_announce", {
        fileId: manifest.fileId,
        totalChunks: manifest.totalChunks,
        chunks: ChunkMap.full(manifest.totalChunks).toBase64(),
      });

      assert.equal(bridge.ofType("swarm_announce").filter((s) => s.to === "other").length, 0);
    });
  });

  it("answers a given peer at most once per second", () => {
    withManager(({ manager, bridge, dir }) => {
      const manifest = manager.seed(makeFile(dir, "a.bin"));
      const empty = new ChunkMap(manifest.totalChunks).toBase64();
      bridge.sent.length = 0;

      for (let i = 0; i < 5; i += 1) {
        bridge.deliver("leech", "swarm_announce", {
          fileId: manifest.fileId, totalChunks: manifest.totalChunks, chunks: empty,
        });
      }
      assert.equal(bridge.ofType("swarm_announce").filter((s) => s.to === "leech").length, 1);
    });
  });
});

describe("serving chunks", () => {
  it("sends binary when the requester says it can take it", async () => {
    await withManager(async ({ manager, bridge, dir }) => {
      const manifest = manager.seed(makeFile(dir, "a.bin"));
      bridge.deliver("leech", "swarm_request", { fileId: manifest.fileId, index: 0, bin: 1 });
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(bridge.binary.length, 1);
      assert.equal(bridge.ofType("swarm_chunk").length, 0, "binary must not also go as base64");
    });
  });

  it("falls back to base64 for a requester that cannot", () => {
    withManager(({ manager, bridge, dir }) => {
      const manifest = manager.seed(makeFile(dir, "a.bin"));
      bridge.deliver("old", "swarm_request", { fileId: manifest.fileId, index: 0 });

      assert.equal(bridge.ofType("swarm_chunk").length, 1);
      assert.equal(bridge.binary.length, 0);
    });
  });

  it("falls back rather than stranding a requester when the lane refuses", async () => {
    await withManager(async ({ manager, bridge, dir }) => {
      const manifest = manager.seed(makeFile(dir, "a.bin"));
      bridge.binaryAccepts = false;

      bridge.deliver("leech", "swarm_request", { fileId: manifest.fileId, index: 0, bin: 1 });
      await new Promise((r) => setTimeout(r, 10));

      // Silence here would stall the requester until its request timed out,
      // once per chunk.
      assert.equal(bridge.ofType("swarm_chunk").length, 1);
    });
  });

  it("ignores a request for a file it does not have", () => {
    withManager(({ manager, bridge }) => {
      bridge.deliver("leech", "swarm_request", { fileId: "f".repeat(64), index: 0, bin: 1 });
      assert.equal(bridge.binary.length, 0);
      assert.deepEqual(manager.progress(), []);
    });
  });
});

describe("receiving chunks", () => {
  it("accepts a binary frame and credits the chunk", () => {
    withManager(({ manager, bridge, dir }) => {
      const filePath = makeFile(dir, "a.bin");
      const data = new Uint8Array(readFileSync(filePath));
      const manifest = buildManifest(data, "a.bin", "application/octet-stream", 4_096);

      bridge.deliver("seed", "swarm_offer", manifest);
      manager.fetch(manifest.fileId);

      const chunk = data.subarray(0, manifest.chunkSize);
      bridge.emit("binary", { streamId: "seed", bytes: encodeChunkFrame(manifest.fileId, 0, chunk) });

      assert.equal(manager.sessionFor(manifest.fileId)!.chunkMap().has(0), true);
    });
  });

  it("leaves bytes on the lane that are not ours alone", () => {
    withManager(({ manager, bridge, dir }) => {
      const data = new Uint8Array(readFileSync(makeFile(dir, "a.bin")));
      const manifest = buildManifest(data, "a.bin", "application/octet-stream", 4_096);
      bridge.deliver("seed", "swarm_offer", manifest);
      manager.fetch(manifest.fileId);

      // The binary lane belongs to the application; another feature may use it.
      bridge.emit("binary", { streamId: "seed", bytes: new Uint8Array([1, 2, 3, 4, 5]) });
      assert.equal(manager.sessionFor(manifest.fileId)!.chunkMap().count(), 0);
    });
  });

  it("writes the finished file and keeps serving it", () => {
    withManager(({ manager, bridge, dir }) => {
      const filePath = makeFile(dir, "a.bin", 12_288);
      const data = new Uint8Array(readFileSync(filePath));
      const manifest = buildManifest(data, "a.bin", "application/octet-stream", 4_096);

      bridge.deliver("seed", "swarm_offer", manifest);
      manager.fetch(manifest.fileId);
      for (let i = 0; i < manifest.totalChunks; i += 1) {
        const start = i * manifest.chunkSize;
        bridge.emit("binary", {
          streamId: "seed",
          bytes: encodeChunkFrame(manifest.fileId, i, data.subarray(start, start + manifest.chunkSize)),
        });
      }

      const saved = path.join(dir, "dl", "a.bin");
      assert.equal(sha256Hex(new Uint8Array(readFileSync(saved))), manifest.fileId);
      // Dropping out here is exactly what starves a swarm: the peer that just
      // finished is its newest complete source.
      assert.equal(manager.sessionFor(manifest.fileId)!.isComplete(), true);
    });
  });
});

describe("reacting to the connection", () => {
  it("re-plans outstanding requests when the socket comes back", () => {
    withManager(({ manager, bridge, dir, logs }) => {
      const data = new Uint8Array(readFileSync(makeFile(dir, "a.bin")));
      const manifest = buildManifest(data, "a.bin", "application/octet-stream", 4_096);
      bridge.deliver("seed", "swarm_offer", manifest);
      manager.fetch(manifest.fileId);

      const session = manager.sessionFor(manifest.fileId)!;
      session.setPeerChunks("seed", ChunkMap.full(manifest.totalChunks));
      session.pump();
      assert.ok(session.progress().inFlight > 0);

      bridge.emit("ws:reconnected", {});

      assert.equal(session.progress().inFlight, 0, "those requests went to connections that are gone");
      assert.ok(logs.some((l) => /re-planning/.test(l)));
    });
  });

  it("forgets a peer that leaves", () => {
    withManager(({ manager, bridge, dir }) => {
      const data = new Uint8Array(readFileSync(makeFile(dir, "a.bin")));
      const manifest = buildManifest(data, "a.bin", "application/octet-stream", 4_096);
      bridge.deliver("seed", "swarm_offer", manifest);
      manager.fetch(manifest.fileId);

      const session = manager.sessionFor(manifest.fileId)!;
      session.setPeerChunks("seed", ChunkMap.full(manifest.totalChunks));
      assert.equal(session.peerCount(), 1);

      bridge.emit("peer:disconnected", { streamId: "seed" });
      assert.equal(session.peerCount(), 0);
    });
  });

  it("understands a have message from an older peer", () => {
    withManager(({ manager, bridge, dir }) => {
      const data = new Uint8Array(readFileSync(makeFile(dir, "a.bin")));
      const manifest = buildManifest(data, "a.bin", "application/octet-stream", 4_096);
      bridge.deliver("seed", "swarm_offer", manifest);
      manager.fetch(manifest.fileId);

      // Older builds send a single `index`; current ones send `indexes`.
      bridge.deliver("seed", "swarm_have", { fileId: manifest.fileId, index: 2 });
      bridge.deliver("seed", "swarm_have", { fileId: manifest.fileId, indexes: [4, 5] });

      const session = manager.sessionFor(manifest.fileId)!;
      assert.equal(session.peerCount(), 1);
    });
  });
});
