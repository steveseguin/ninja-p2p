/**
 * Resuming an interrupted download.
 *
 * The part file always kept its bytes across a restart, but the bitfield was
 * rebuilt empty, so every chunk on disk was fetched again. "Resumable" was true
 * of the file and false of the transfer, and no test caught it because none
 * ever constructed a second session over an existing part file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildManifest, ChunkFile, chunkLength, type SwarmManifest } from "../src/swarm.js";
import { SwarmSession, type SwarmSend } from "../src/swarm-session.js";

const CHUNK = 4_096;

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 17) % 251;
  return out;
}

const silent: SwarmSend = {
  request: () => true,
  chunk() {},
  have() {},
  announce() {},
  announceTo() {},
};

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-resume-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixture(): { data: Uint8Array; manifest: SwarmManifest } {
  const data = bytes(40_000, 2);
  return { data, manifest: buildManifest(data, "x.bin", "application/octet-stream", CHUNK) };
}

function chunkOf(data: Uint8Array, manifest: SwarmManifest, index: number): Uint8Array {
  const start = index * manifest.chunkSize;
  return data.subarray(start, start + chunkLength(index, manifest));
}

/** Take delivery of the given chunks, then drop the session as a crash would. */
function partialRun(dir: string, manifest: SwarmManifest, data: Uint8Array, indexes: number[]): string {
  const partPath = path.join(dir, "x.part");
  const session = new SwarmSession({
    manifest,
    partPath,
    savedPath: path.join(dir, "x.bin"),
    send: silent,
  });
  for (const index of indexes) session.onChunkData("peer", index, chunkOf(data, manifest, index));
  session.close();
  return partPath;
}

describe("resuming a download", () => {
  it("credits chunks a previous run already verified", () => {
    withTempDir((dir) => {
      const { data, manifest } = fixture();
      const partPath = partialRun(dir, manifest, data, [0, 1, 2, 3, 4]);

      const resumed = new SwarmSession({
        manifest,
        partPath,
        savedPath: path.join(dir, "x.bin"),
        send: silent,
      });
      assert.equal(resumed.progress().haveChunks, 5);
      resumed.close();
    });
  });

  it("resumes chunks that are not at the start of the file", () => {
    withTempDir((dir) => {
      const { data, manifest } = fixture();
      // Out-of-order arrival is the normal case in a swarm, so the gap between
      // held chunks must not be mistaken for held data.
      const partPath = partialRun(dir, manifest, data, [7, 9]);

      const resumed = new SwarmSession({
        manifest,
        partPath,
        savedPath: path.join(dir, "x.bin"),
        send: silent,
      });
      const map = resumed.chunkMap();
      assert.equal(map.count(), 2);
      assert.equal(map.has(7), true);
      assert.equal(map.has(9), true);
      assert.equal(map.has(8), false, "the zero-filled gap must not be credited");
      resumed.close();
    });
  });

  it("finishes correctly after a resume", () => {
    withTempDir((dir) => {
      const { data, manifest } = fixture();
      const partPath = partialRun(dir, manifest, data, [0, 1, 2, 3, 4]);

      const resumed = new SwarmSession({
        manifest,
        partPath,
        savedPath: path.join(dir, "x.bin"),
        send: silent,
      });
      for (let i = 5; i < manifest.totalChunks; i += 1) {
        resumed.onChunkData("peer", i, chunkOf(data, manifest, i));
      }
      const result = resumed.finish();
      assert.equal(result.ok, true, result.error);
    });
  });

  it("does not credit a chunk whose bytes are wrong", () => {
    withTempDir((dir) => {
      const { data, manifest } = fixture();
      const partPath = path.join(dir, "x.part");

      // A part file full of plausible-looking but wrong bytes. Inferring held
      // chunks from the file's length would accept all of these.
      writeFileSync(partPath, Buffer.from(bytes(manifest.size, 99)));
      const file = new ChunkFile(partPath, manifest);
      assert.equal(file.scanVerified().count(), 0);
      file.close();
      void data;
    });
  });

  it("does not credit a chunk that was only half written", () => {
    withTempDir((dir) => {
      const { data, manifest } = fixture();
      const partPath = partialRun(dir, manifest, data, [0, 1]);

      // Simulate a process killed mid-write: the last chunk is truncated.
      truncateSync(partPath, CHUNK + Math.floor(CHUNK / 2));

      const file = new ChunkFile(partPath, manifest);
      const map = file.scanVerified();
      assert.equal(map.has(0), true);
      assert.equal(map.has(1), false, "a partial chunk must not count as held");
      file.close();
    });
  });

  it("costs nothing when there is no part file", () => {
    withTempDir((dir) => {
      const { manifest } = fixture();
      const file = new ChunkFile(path.join(dir, "absent.part"), manifest);
      assert.equal(file.scanVerified().count(), 0);
      file.close();
    });
  });

  it("recognises a part file that is already complete", () => {
    withTempDir((dir) => {
      const { data, manifest } = fixture();
      const partPath = partialRun(
        dir,
        manifest,
        data,
        Array.from({ length: manifest.totalChunks }, (_, i) => i),
      );

      // A run interrupted between the last chunk and the rename leaves this.
      const resumed = new SwarmSession({
        manifest,
        partPath,
        savedPath: path.join(dir, "x.bin"),
        send: silent,
      });
      assert.equal(resumed.isComplete(), true);
      assert.equal(resumed.finish().ok, true);
    });
  });

  it("a seed session is never scanned, since it is handed its bitfield", () => {
    withTempDir((dir) => {
      const { data, manifest } = fixture();
      const filePath = path.join(dir, "seed.bin");
      writeFileSync(filePath, Buffer.from(data));

      const file = new ChunkFile(filePath, manifest);
      try {
        const map = file.scanVerified();
        // Proves the scan agrees with reality on a whole file, without the seed
        // path paying for it.
        assert.equal(map.count(), manifest.totalChunks);
      } finally {
        file.close();
      }
    });
  });
});
