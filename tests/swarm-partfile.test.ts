/**
 * Two downloads of the same file must not destroy each other.
 *
 * Found live: three `fetch` processes on one machine all opened
 * `<tmp>/ninja-p2p-swarm/<fileId>.part`. They interleaved writes into one file,
 * then the first to finish renamed it away and the rest died on ENOENT — after
 * having already corrupted each other's data.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildManifest, ChunkFile, partPathFor, type SwarmManifest } from "../src/swarm.js";
import { createSeedSession, SwarmSession, type SwarmSend } from "../src/swarm-session.js";

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 17) % 251;
  return out;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-part-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function manifestOf(size = 8_192): SwarmManifest {
  return buildManifest(bytes(size, 3), "payload.bin", "application/octet-stream", 4_096);
}

describe("part file paths", () => {
  it("separates the same file downloaded to different destinations", () => {
    const manifest = manifestOf();
    const a = partPathFor("/work", manifest.fileId, "/downloads/one/payload.bin");
    const b = partPathFor("/work", manifest.fileId, "/downloads/two/payload.bin");
    assert.notEqual(a, b, "different destinations must not share a part file");
  });

  it("is stable for the same destination, so an interrupted fetch resumes", () => {
    const manifest = manifestOf();
    assert.equal(
      partPathFor("/work", manifest.fileId, "/downloads/payload.bin"),
      partPathFor("/work", manifest.fileId, "/downloads/payload.bin"),
    );
  });

  it("normalises the destination rather than keying on the literal string", () => {
    const manifest = manifestOf();
    assert.equal(
      partPathFor("/work", manifest.fileId, path.join("/downloads", "payload.bin")),
      partPathFor("/work", manifest.fileId, path.join("/downloads", "sub", "..", "payload.bin")),
    );
  });

  it("separates different files sharing a destination folder", () => {
    const a = buildManifest(bytes(4_096, 1), "a.bin", "application/octet-stream", 4_096);
    const b = buildManifest(bytes(4_096, 2), "b.bin", "application/octet-stream", 4_096);
    assert.notEqual(
      partPathFor("/work", a.fileId, "/downloads/a.bin"),
      partPathFor("/work", b.fileId, "/downloads/b.bin"),
    );
  });
});

describe("part file locking", () => {
  it("refuses a second exclusive opener of the same part file", () => {
    withTempDir((dir) => {
      const manifest = manifestOf();
      const partPath = path.join(dir, "x.part");

      const first = new ChunkFile(partPath, manifest, true);
      first.open();
      try {
        const second = new ChunkFile(partPath, manifest, true);
        assert.throws(() => second.open(), /already running/);
      } finally {
        first.close();
      }
    });
  });

  it("releases the lock on close, so a retry works", () => {
    withTempDir((dir) => {
      const manifest = manifestOf();
      const partPath = path.join(dir, "x.part");

      const first = new ChunkFile(partPath, manifest, true);
      first.open();
      first.close();
      assert.equal(existsSync(`${partPath}.lock`), false);

      const second = new ChunkFile(partPath, manifest, true);
      second.open();
      second.close();
    });
  });

  it("does not lock a seed session, so several can serve the same file", () => {
    withTempDir((dir) => {
      const data = bytes(8_192, 3);
      const filePath = path.join(dir, "seed.bin");
      writeFileSync(filePath, data);
      const manifest = buildManifest(data, "seed.bin", "application/octet-stream", 4_096);

      const a = new ChunkFile(filePath, manifest, false);
      const b = new ChunkFile(filePath, manifest, false);
      a.open();
      b.open();
      assert.deepEqual([...a.readChunk(0)!], [...b.readChunk(0)!]);
      a.close();
      b.close();
    });
  });

  it("takes over a lock left behind by a process that died", () => {
    withTempDir((dir) => {
      const manifest = manifestOf();
      const partPath = path.join(dir, "x.part");
      const lockPath = `${partPath}.lock`;

      // Simulate an abandoned lock by backdating it past the stale window.
      writeFileSync(lockPath, "99999\n");
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(lockPath, old, old);

      const taker = new ChunkFile(partPath, manifest, true);
      taker.open();
      taker.close();
    });
  });

  it("keeps a live transfer's lock fresh", () => {
    withTempDir((dir) => {
      const manifest = manifestOf();
      const partPath = path.join(dir, "x.part");

      const file = new ChunkFile(partPath, manifest, true);
      file.open();
      const backdated = new Date(Date.now() - 4 * 60_000);
      utimesSync(`${partPath}.lock`, backdated, backdated);

      file.touchLock();

      const age = Date.now() - statSync(`${partPath}.lock`).mtimeMs;
      assert.ok(age < 60_000, `lock should have been refreshed, age was ${age}ms`);
      file.close();
    });
  });

  it("a second download session for the same destination refuses to start", () => {
    withTempDir((dir) => {
      const manifest = manifestOf();
      const savedPath = path.join(dir, "payload.bin");
      const partPath = partPathFor(dir, manifest.fileId, savedPath);
      const send: SwarmSend = {
        request: () => true,
        chunk: () => {},
        have: () => {},
        announce: () => {},
        announceTo: () => {},
      };

      const first = new SwarmSession({ manifest, partPath, savedPath, send });
      first.onChunkData("peer", 0, bytes(4_096, 3).subarray(0, manifest.chunkSize));

      // The conflict surfaces at construction, because a download scans its
      // part file then — better than discovering it once chunks are arriving.
      assert.throws(
        () => new SwarmSession({ manifest, partPath, savedPath, send }),
        /already running/,
      );
      first.close();
    });
  });

  it("several seed sessions can serve one file at once", () => {
    withTempDir((dir) => {
      const data = bytes(8_192, 3);
      const filePath = path.join(dir, "seed.bin");
      writeFileSync(filePath, data);
      const manifest = buildManifest(data, "seed.bin", "application/octet-stream", 4_096);
      const send: SwarmSend = {
        request: () => true,
        chunk: () => {},
        have: () => {},
        announce: () => {},
        announceTo: () => {},
      };

      const a = createSeedSession(manifest, filePath, send);
      const b = createSeedSession(manifest, filePath, send);
      assert.equal(a.onChunkRequest("x", 0), true);
      assert.equal(b.onChunkRequest("y", 0), true, "a seed must not lock out another seed");
      a.close();
      b.close();
    });
  });
});
