/**
 * Covers the startup handshake and the chunk-size guard.
 *
 * The stall these tests pin down was invisible to every existing test: the
 * in-memory harness announces on demand, so it never waited on a timer. On a
 * live 5 MB transfer it was 2.6s of a 4.0s total.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildManifest,
  ChunkMap,
  maxSafeChunkSize,
  SWARM_ENVELOPE_HEADROOM,
  type SwarmManifest,
} from "../src/swarm.js";
import { createSeedSession, SwarmSession, type SwarmSend } from "../src/swarm-session.js";

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 17) % 251;
  return out;
}

type Sent = { kind: "announce" | "announceTo"; to?: string; chunks: string };

function recordingSend(log: Sent[]): SwarmSend {
  return {
    request: () => true,
    chunk: () => {},
    have: () => {},
    announce: (chunks) => log.push({ kind: "announce", chunks }),
    announceTo: (to, chunks) => log.push({ kind: "announceTo", to, chunks }),
  };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-startup-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seeded(dir: string, chunkSize: number): { manifest: SwarmManifest; filePath: string } {
  const data = bytes(40_000, 5);
  const filePath = path.join(dir, "source.bin");
  writeFileSync(filePath, data);
  return { manifest: buildManifest(data, "source.bin", "application/octet-stream", chunkSize), filePath };
}

describe("announce handshake", () => {
  it("a seeder can help a peer holding nothing", () => {
    withTempDir((dir) => {
      const { manifest, filePath } = seeded(dir, 4_096);
      const seed = createSeedSession(manifest, filePath, recordingSend([]));

      seed.onPeerAnnounce("leech", new ChunkMap(manifest.totalChunks).toBase64());
      assert.equal(seed.canHelp("leech"), true);
    });
  });

  it("a peer holding nothing cannot help the seeder, so the exchange terminates", () => {
    withTempDir((dir) => {
      const { manifest } = seeded(dir, 4_096);
      const leech = new SwarmSession({
        manifest,
        partPath: path.join(dir, "l.part"),
        savedPath: path.join(dir, "l.bin"),
        send: recordingSend([]),
      });

      // Without this the reply to a reply would loop forever between two peers.
      leech.onPeerAnnounce("seed", ChunkMap.full(manifest.totalChunks).toBase64());
      assert.equal(leech.canHelp("seed"), false);
    });
  });

  it("a complete peer cannot be helped by a partial one", () => {
    withTempDir((dir) => {
      const { manifest, filePath } = seeded(dir, 4_096);
      const partial = createSeedSession(manifest, filePath, recordingSend([]));
      partial.onPeerAnnounce("full", ChunkMap.full(manifest.totalChunks).toBase64());
      assert.equal(partial.canHelp("full"), false);
    });
  });

  it("a partial peer can help another partial peer with a different slice", () => {
    withTempDir((dir) => {
      const { manifest, filePath } = seeded(dir, 4_096);
      const seed = createSeedSession(manifest, filePath, recordingSend([]));

      const theirs = new ChunkMap(manifest.totalChunks);
      theirs.set(0);
      seed.onPeerAnnounce("other", theirs.toBase64());
      assert.equal(seed.canHelp("other"), true);
    });
  });

  it("says nothing about a peer it has never heard from", () => {
    withTempDir((dir) => {
      const { manifest, filePath } = seeded(dir, 4_096);
      const seed = createSeedSession(manifest, filePath, recordingSend([]));
      assert.equal(seed.canHelp("stranger"), false);
    });
  });

  it("announceTo targets one peer rather than the room", () => {
    withTempDir((dir) => {
      const log: Sent[] = [];
      const { manifest, filePath } = seeded(dir, 4_096);
      const seed = createSeedSession(manifest, filePath, recordingSend(log));

      seed.announceTo("leech");

      assert.equal(log.length, 1);
      assert.equal(log[0].kind, "announceTo");
      assert.equal(log[0].to, "leech");
      // The bitfield must be the real one, or the peer learns nothing useful.
      assert.equal(ChunkMap.fromBase64(log[0].chunks, manifest.totalChunks).count(), manifest.totalChunks);
    });
  });
});

describe("chunk size guard", () => {
  it("leaves room for base64 inflation and the envelope", () => {
    // A chunk must survive being base64-encoded inside a JSON message.
    const limit = 262_144;
    const safe = maxSafeChunkSize(limit);
    const base64Length = Math.ceil(safe / 3) * 4;
    assert.ok(base64Length + SWARM_ENVELOPE_HEADROOM <= limit, `${base64Length} must fit ${limit}`);
  });

  it("would have caught the default chunk size against the spec floor", () => {
    // Every WebRTC implementation must support 65536. Our 64000 default becomes
    // 85336 bytes once base64-encoded, so the fallback path would have failed
    // against such a peer — the bug this guard exists for.
    const safe = maxSafeChunkSize(65_536);
    assert.ok(safe < 64_000, `expected the guard to shrink 64000, got ${safe}`);
    assert.ok(safe > 0);
  });

  it("never returns a useless or negative size", () => {
    assert.ok(maxSafeChunkSize(0) >= 1_024);
    assert.ok(maxSafeChunkSize(SWARM_ENVELOPE_HEADROOM) >= 1_024);
    assert.ok(maxSafeChunkSize(-1) >= 1_024);
  });

  it("grows with the limit", () => {
    assert.ok(maxSafeChunkSize(1_048_576) > maxSafeChunkSize(262_144));
    assert.ok(maxSafeChunkSize(262_144) > maxSafeChunkSize(65_536));
  });
});
