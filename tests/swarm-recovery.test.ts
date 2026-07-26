/**
 * Behaviour after a connection is disrupted.
 *
 * Found live by closing a downloader's signalling socket mid-transfer: chunk
 * requests still arrived at the seeder, the seeder's send reported success, the
 * data channel stayed open, and the bytes never landed. Nothing below the
 * application notices a path like that, so the application has to.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildManifest, ChunkMap, type SwarmManifest } from "../src/swarm.js";
import { SwarmSession, type SwarmSend } from "../src/swarm-session.js";

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

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-recovery-"));
  try {
    return fn(dir);
  } finally {
    for (const session of sessionsByDir.get(dir) ?? []) session.close();
    sessionsByDir.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

type Harness = {
  session: SwarmSession;
  manifest: SwarmManifest;
  requests: Array<{ peerId: string; index: number }>;
  accept: { value: boolean };
  clock: { now: number };
};

/** Deliver a chunk's real bytes, so it verifies and counts as a round trip. */
function deliver(h: Harness, index: number): boolean {
  const data = bytes(40_000, 4);
  const start = index * h.manifest.chunkSize;
  const end = Math.min(start + h.manifest.chunkSize, h.manifest.size);
  return h.session.onChunkData("a", index, data.subarray(start, end));
}

function harness(dir: string, peers: string[]): Harness {
  const data = bytes(40_000, 4);
  const manifest = buildManifest(data, "x.bin", "application/octet-stream", 4_096);
  const requests: Array<{ peerId: string; index: number }> = [];
  const accept = { value: true };
  const clock = { now: 1_000_000 };

  const send: SwarmSend = {
    request: (peerId, index) => {
      if (!accept.value) return false;
      requests.push({ peerId, index });
      return true;
    },
    chunk: () => {},
    have: () => {},
    announce: () => {},
    announceTo: () => {},
  };

  const session = trackSession(dir, new SwarmSession({
    manifest,
    partPath: path.join(dir, "x.part"),
    savedPath: path.join(dir, "x.bin"),
    send,
    now: () => clock.now,
  }));
  for (const peerId of peers) {
    session.setPeerChunks(peerId, ChunkMap.full(manifest.totalChunks));
  }
  return { session, manifest, requests, accept, clock };
}

describe("a request the transport refused", () => {
  it("does not occupy an in-flight slot", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      h.accept.value = false;

      assert.equal(h.session.pump(), 0, "nothing left, so nothing is outstanding");
      assert.equal(h.session.progress().inFlight, 0);
    });
  });

  it("is retried on the next pump rather than waiting out a timeout", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      h.accept.value = false;
      h.session.pump();

      // The transport recovers. Nothing about the clock has moved, so a chunk
      // held hostage by a phantom in-flight entry would still be stuck here.
      h.accept.value = true;
      assert.ok(h.session.pump() > 0, "the chunk should be requestable immediately");
    });
  });

  it("still records the ones that were accepted", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      const issued = h.session.pump();
      assert.ok(issued > 0);
      assert.equal(h.session.progress().inFlight, issued);
    });
  });
});

describe("abandoning outstanding requests", () => {
  it("frees every slot and reports how many", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      const issued = h.session.pump();

      assert.equal(h.session.abandonInFlight(), issued);
      assert.equal(h.session.progress().inFlight, 0);
    });
  });

  it("blames nobody, because the outage was ours", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      h.session.pump();
      h.session.abandonInFlight();

      // Scoring a peer down for our own reconnect would send the next requests
      // to the wrong places.
      assert.equal(h.session.statsFor("a")?.failures, 0);
    });
  });
});

describe("spotting a peer that has gone quiet", () => {
  it("reports nobody while requests are still fresh", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      h.session.pump();
      assert.deepEqual(h.session.unresponsivePeers(3), []);
    });
  });

  it("reports a peer only after a run of timeouts", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      for (let round = 0; round < 2; round += 1) {
        h.session.pump();
        h.clock.now += 20_000;
        h.session.expireTimeouts();
      }
      // Two rounds of four requests is already past the threshold.
      assert.deepEqual(h.session.unresponsivePeers(3), ["a"]);
      assert.deepEqual(h.session.unresponsivePeers(100), [], "a high bar means no accusation");
    });
  });

  it("forgives a peer the moment anything arrives", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      h.session.pump();
      h.clock.now += 20_000;
      h.session.expireTimeouts();
      assert.deepEqual(h.session.unresponsivePeers(1), ["a"]);

      // A delivery proves the path carries, whatever came before it.
      const chunk = bytes(40_000, 4).subarray(0, h.manifest.chunkSize);
      h.session.onChunkData("a", 0, chunk);
      assert.deepEqual(h.session.unresponsivePeers(1), []);
    });
  });

  it("does not confuse one slow peer with another that is fine", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a", "b"]);
      h.session.pump();
      h.clock.now += 20_000;
      h.session.expireTimeouts();

      const chunk = bytes(40_000, 4).subarray(0, h.manifest.chunkSize);
      h.session.onChunkData("b", 0, chunk);

      assert.deepEqual(h.session.unresponsivePeers(1), ["a"]);
    });
  });

  it("forgets a peer once its connection is being rebuilt", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      h.session.pump();
      h.clock.now += 20_000;
      h.session.expireTimeouts();

      h.session.clearUnresponsive("a");
      // Otherwise the rebuild would be requested again on the very next pump.
      assert.deepEqual(h.session.unresponsivePeers(1), []);
    });
  });

  it("forgets a peer that leaves", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      h.session.pump();
      h.clock.now += 20_000;
      h.session.expireTimeouts();

      h.session.removePeer("a");
      assert.deepEqual(h.session.unresponsivePeers(1), []);
    });
  });
});

describe("the request timeout", () => {
  it("gives an unmeasured peer the full ceiling", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      h.session.pump();

      h.clock.now += 14_000;
      assert.equal(h.session.expireTimeouts(), 0, "nothing is known about this peer yet");
      h.clock.now += 2_000;
      assert.ok(h.session.expireTimeouts() > 0);
    });
  });

  it("shortens for a peer measured to be fast", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      h.session.pump();

      // Deliver a chunk that was actually requested: round-trip time is only
      // recorded against a request we issued, and piece selection is random, so
      // picking index 0 blindly measures nothing about 60% of the time.
      h.clock.now += 80;
      deliver(h, h.requests[0].index);
      h.session.pump();

      h.clock.now += 4_000;
      // A loss on a peer answering in 80ms should not cost fifteen seconds.
      assert.ok(h.session.expireTimeouts() > 0, "a fast peer should be written off sooner");
    });
  });

  it("never drops below the floor, so a busy peer is not called broken", () => {
    withTempDir((dir) => {
      const h = harness(dir, ["a"]);
      h.session.pump();
      h.clock.now += 80;
      deliver(h, h.requests[0].index);
      h.session.pump();

      // 12 x 80ms is under a second, but a peer serving several downloaders can
      // easily take that long without having failed at all.
      h.clock.now += 2_000;
      assert.equal(h.session.expireTimeouts(), 0, "under the floor must never expire");
    });
  });
});

describe("a part file is still written correctly after all this", () => {
  it("accepts a chunk and reports it held", () => {
    withTempDir((dir) => {
      const data = bytes(40_000, 4);
      const h = harness(dir, ["a"]);
      writeFileSync(path.join(dir, "unused"), "");
      h.session.pump();
      h.session.onChunkData("a", 0, data.subarray(0, h.manifest.chunkSize));
      assert.equal(h.session.chunkMap().has(0), true);
      h.session.close();
    });
  });
});
