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
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

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

const quietSend: SwarmSend = {
  request: () => true, chunk() {}, have() {}, announce() {}, announceTo() {},
};

describe("seed source ownership", () => {
  it("rejects invalid request timeouts before creating a part file", () => {
    withTempDir(dir => {
      for (const requestTimeoutMs of [NaN, Infinity, -1]) {
        const part = path.join(dir, "timeout.part");
        let session: SwarmSession | undefined;
        try {
          assert.throws(() => {
            session = new SwarmSession({ manifest: manifestOf(), partPath: part,
              savedPath: path.join(dir, "done.bin"), send: quietSend, requestTimeoutMs });
          }, /requestTimeoutMs/);
          assert.equal(existsSync(part), false);
        } finally {
          session?.close();
        }
      }
    });
  });

  it("rejects invalid request limits before claiming a download part", () => {
    withTempDir(dir => {
      const part = path.join(dir, "invalid-options.part");
      assert.throws(() => new SwarmSession({
        manifest: manifestOf(), partPath: part, savedPath: path.join(dir, "done.bin"),
        send: quietSend, maxInFlightTotal: NaN,
      }), /maxInFlight/);
      assert.equal(existsSync(part), false);
      assert.equal(existsSync(`${part}.lock`), false);
    });
  });

  it("does not serve source bytes that changed after the manifest was advertised", () => {
    withTempDir(dir => {
      const data = bytes(8192, 3);
      const source = path.join(dir, "edited-source.bin");
      writeFileSync(source, data);
      const sent: number[] = [];
      const seed = createSeedSession(manifestOf(), source, { ...quietSend, chunk(_peer, index) { sent.push(index); } });
      try {
        assert.equal(seed.onChunkRequest("peer", 0), true);
        const changed = Uint8Array.from(data);
        changed[0] ^= 255;
        writeFileSync(source, changed);
        assert.equal(seed.onChunkRequest("peer", 0), false);
        assert.equal(seed.onChunkRequest("peer", 1), true, "unchanged chunks remain usable");
        assert.deepEqual(sent, [0, 1]);
        writeFileSync(source, data);
        assert.equal(seed.onChunkRequest("peer", 0), true, "restoring the advertised bytes permits serving again");
      } finally {
        seed.close();
      }
    });
  });

  it("download construction releases its part lock when resume scanning throws", (t) => {
    withTempDir(dir => {
      const part = path.join(dir, "download.part");
      const failure = Object.assign(new Error("resume read failed"), { code: "EIO" });
      let opened: ChunkFile | undefined;
      t.mock.method(ChunkFile.prototype, "scanVerified", function (this: ChunkFile) {
        opened = this;
        this.open();
        throw failure;
      });
      try {
        assert.throws(() => new SwarmSession({ manifest: manifestOf(), partPath: part, savedPath: path.join(dir, "done.bin"), send: quietSend }), error => error === failure);
        assert.equal(existsSync(`${part}.lock`), false);
      } finally {
        opened?.close();
        t.mock.restoreAll();
      }
    });
  });

  it("discarding a download still removes its owned part file and lock", () => {
    withTempDir(dir => {
      const part = path.join(dir, "download.part");
      const download = new SwarmSession({ manifest: manifestOf(), partPath: part, savedPath: path.join(dir, "done.bin"), send: quietSend });
      assert.equal(existsSync(part), true);
      download.discard();
      assert.equal(existsSync(part), false);
      assert.equal(existsSync(`${part}.lock`), false);
    });
  });

  it("serves a source that only permits read-only opens", (t) => {
    withTempDir(dir => {
      const manifest = manifestOf();
      const source = path.join(dir, "source.bin");
      writeFileSync(source, bytes(8192, 3));
      const open = fs.openSync;
      t.mock.method(fs, "openSync", (file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        if (String(file) === source && flags !== "r") throw Object.assign(new Error("read-only source"), { code: "EACCES" });
        return open(file, flags, mode);
      });
      syncBuiltinESMExports();
      const seed = createSeedSession(manifest, source, quietSend);
      try {
        assert.equal(seed.onChunkRequest("peer", 0), true);
      } finally {
        seed.close();
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  });

  it("does not recreate a deleted source while answering a chunk request", () => {
    withTempDir(dir => {
      const source = path.join(dir, "missing.bin");
      const seed = createSeedSession(manifestOf(), source, quietSend);
      try {
        assert.equal(seed.onChunkRequest("peer", 0), false);
        assert.equal(existsSync(source), false);
      } finally { seed.close(); }
    });
  });

  it("discarding a seed session never deletes the user's source file", () => {
    withTempDir(dir => {
      const source = path.join(dir, "source.bin");
      writeFileSync(source, bytes(8192, 3));
      const seed = createSeedSession(manifestOf(), source, quietSend);
      seed.discard();
      assert.equal(existsSync(source), true);
    });
  });
});

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
  it("a failed lock write preserves the error and permits an immediate retry", (t) => {
    withTempDir(dir => {
      const part = path.join(dir, "failed-lock.part");
      const file = new ChunkFile(part, manifestOf(), true);
      const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      t.mock.method(fs, "writeSync", () => { throw failure; });
      syncBuiltinESMExports();
      try {
        assert.throws(() => file.open(), error => error === failure);
        assert.equal(existsSync(`${part}.lock`), false);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        file.close();
      }
      const retry = new ChunkFile(part, manifestOf(), true);
      try {
        retry.open();
        retry.assertExclusiveLock();
      } finally {
        retry.close();
      }
    });
  });

  it("short writes still produce a complete usable lock token", (t) => {
    withTempDir(dir => {
      const file = new ChunkFile(path.join(dir, "short-lock.part"), manifestOf(), true);
      const write = fs.writeSync;
      t.mock.method(fs, "writeSync", (fd: number, data: string | Uint8Array, offset?: number, length?: number | string, position?: number) => {
        if (typeof data === "string") return write(fd, data.slice(0, 2), undefined, "utf8");
        return write(fd, data, offset, Math.min(2, length as number), position);
      });
      syncBuiltinESMExports();
      try {
        file.open();
        file.assertExclusiveLock();
      } finally {
        file.close();
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  });

  it("a former owner cannot finalize a file after stale takeover", () => {
    withTempDir(dir => {
      const manifest = manifestOf();
      const part = path.join(dir, "taken.part");
      const savedPath = path.join(dir, "done.bin");
      const first = new SwarmSession({ manifest, partPath: part, savedPath, send: quietSend });
      const data = bytes(8192, 3);
      first.onChunkData("peer", 0, data.subarray(0, 4096));
      first.onChunkData("peer", 1, data.subarray(4096));
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(`${part}.lock`, old, old);
      const second = new ChunkFile(part, manifest, true);
      second.open();
      try {
        const result = first.finish();
        assert.equal(result.ok, false);
        assert.match(result.error!, /lock/);
        assert.equal(existsSync(savedPath), false);
        assert.equal(existsSync(part), true);
        assert.equal(existsSync(`${part}.lock`), true);
      } finally {
        first.close();
        second.close();
      }
    });
  });

  it("a former lock owner cannot keep writing after stale takeover", () => {
    withTempDir(dir => {
      const manifest = manifestOf();
      const part = path.join(dir, "taken.part");
      const first = new ChunkFile(part, manifest, true);
      const second = new ChunkFile(part, manifest, true);
      first.open();
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(`${part}.lock`, old, old);
      second.open();
      try {
        first.touchLock();
        assert.throws(() => first.writeChunk(0, bytes(8192, 3).subarray(0, 4096)), /lock/);
        assert.equal(statSync(part).size, 0);
        first.close();
        assert.equal(second.writeChunk(0, bytes(8192, 3).subarray(0, 4096)), true);
      } finally {
        first.close();
        second.close();
      }
    });
  });

  it("discard cannot remove a part file claimed by another download", () => {
    withTempDir(dir => {
      const manifest = manifestOf();
      const part = path.join(dir, "taken.part");
      const first = new SwarmSession({ manifest, partPath: part, savedPath: path.join(dir, "done.bin"), send: quietSend });
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(`${part}.lock`, old, old);
      const second = new ChunkFile(part, manifest, true);
      second.open();
      try {
        first.discard();
        assert.equal(existsSync(part), true);
        assert.equal(existsSync(`${part}.lock`), true);
      } finally {
        first.close();
        second.close();
      }
    });
  });

  it("discard holds the lock until the part file is removed", (t) => {
    withTempDir(dir => {
      const part = path.join(dir, "discard.part");
      const session = new SwarmSession({ manifest: manifestOf(), partPath: part, savedPath: path.join(dir, "done.bin"), send: quietSend });
      const remove = fs.rmSync;
      let heldDuringRemoval = false;
      t.mock.method(fs, "rmSync", (target: fs.PathLike, options?: fs.RmOptions) => {
        if (String(target) === part) heldDuringRemoval = existsSync(`${part}.lock`);
        return remove(target, options);
      });
      syncBuiltinESMExports();
      try {
        session.discard();
        assert.equal(heldDuringRemoval, true);
        assert.equal(existsSync(part), false);
      } finally {
        session.close();
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  });

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
