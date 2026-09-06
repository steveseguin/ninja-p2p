#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.NINJA_P2P_TEST_PACKAGE_ROOT
  ? path.resolve(process.env.NINJA_P2P_TEST_PACKAGE_ROOT)
  : path.resolve(scriptDir, "..");
const distUrl = (name) => pathToFileURL(path.join(packageRoot, "dist", name)).href;
const [
  { SwarmManager },
  { SWARM_INLINE_MANIFEST_HASHES, SWARM_MANIFEST_PAGE_HASHES },
  { VDOBridge },
] = await Promise.all([
  import(distUrl("swarm-manager.js")),
  import(distUrl("swarm.js")),
  import(distUrl("vdo-bridge.js")),
]);

const baseDir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-live-swarm-"));
const room = `swarm-live-${randomBytes(6).toString("hex")}`;
const sourcePath = path.join(baseDir, "source", "paged-swarm.bin");
const downloadDir = path.join(baseDir, "downloads");
const sourceWorkDir = path.join(baseDir, "source-work");
const fetchWorkDir = path.join(baseDir, "fetch-work");
const impaired = process.argv.includes("--impaired");
const forceTurn = process.argv.includes("--relay");
const large = process.argv.includes("--large");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs = 60_000, intervalMs = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function bridge(streamId, role, name) {
  return new VDOBridge({
    room,
    streamId,
    identity: { streamId, role, name },
    password: false,
    forceTurn,
    skills: ["swarm", "file-transfer"],
    topics: [],
  });
}

async function main() {
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  mkdirSync(downloadDir, { recursive: true });
  // Both fixtures require paging. Keep controlled-loss runs smaller: each
  // unanswered request exercises the real production timeout, not a test override.
  writeFileSync(sourcePath, randomBytes((impaired && !large ? 512 : 2048) * 1024));

  const seedBridge = bridge("live-swarm-seed", "seeder", "Live Swarm Seeder");
  const fetchBridge = bridge("live-swarm-fetch", "fetcher", "Live Swarm Fetcher");
  const seedLog = [];
  const fetchLog = [];
  let completion = null;
  let transferError = null;
  let offerBytes = 0;
  let manifestRequests = 0;
  let manifestPages = 0;
  let binaryFrames = 0;
  let droppedChunks = 0;
  let droppedPages = 0;
  let delayedChunks = 0;
  let resumedChunks = 0;
  let progressTimer;
  const attemptedChunks = new Set();
  const sendBinary = seedBridge.sendBinaryTo.bind(seedBridge);
  const trySend = seedBridge.bus.trySend.bind(seedBridge.bus);
  if (impaired) {
    // Application-message loss over real WebRTC, not an OS packet-loss emulator.
    seedBridge.sendBinaryTo = async (to, bytes) => {
      const index = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(36, false);
      const first = !attemptedChunks.has(index);
      attemptedChunks.add(index);
      if (first && index % 17 === 0) { droppedChunks++; return true; }
      delayedChunks++;
      await sleep(index % 5 === 0 ? 80 : 20);
      return sendBinary(to, bytes);
    };
    seedBridge.bus.trySend = (to, type, payload) => {
      if (type === "swarm_manifest_page" && payload.page === 0 && droppedPages === 0) {
        droppedPages++;
        return true;
      }
      return trySend(to, type, payload);
    };
  }

  seedBridge.bus.on("message:swarm_manifest_request", () => {
    manifestRequests += 1;
  });
  fetchBridge.bus.on("message:swarm_offer", (envelope) => {
    offerBytes = Math.max(offerBytes, Buffer.byteLength(JSON.stringify(envelope.payload)));
  });
  fetchBridge.bus.on("message:swarm_manifest_page", () => {
    manifestPages += 1;
  });
  fetchBridge.on("binary", () => {
    binaryFrames += 1;
  });

  const seedManager = new SwarmManager({
    bridge: seedBridge,
    downloadDir: path.join(baseDir, "unused-seed-downloads"),
    workDir: sourceWorkDir,
    pumpIntervalMs: 25,
    announceIntervalMs: 500,
    log: (message) => seedLog.push(message),
    onError: (message) => {
      transferError = `seeder: ${message}`;
    },
  });
  const createFetchManager = () => new SwarmManager({
    bridge: fetchBridge,
    downloadDir,
    workDir: fetchWorkDir,
    pumpIntervalMs: 25,
    announceIntervalMs: 500,
    log: (message) => fetchLog.push(message),
    onComplete: (value) => {
      completion = value;
    },
    onError: (message) => {
      transferError = `fetcher: ${message}`;
    },
  });
  let fetchManager = createFetchManager();

  seedManager.start();
  fetchManager.start();

  try {
    await Promise.all([seedBridge.connect(), fetchBridge.connect()]);
    await waitFor(
      "both WebRTC peers",
      () => seedBridge.peers.connectedCount === 1 && fetchBridge.peers.connectedCount === 1,
      30_000,
    );

    const manifest = seedManager.seed(sourcePath, 1_024);
    assert.ok(
      manifest.totalChunks > SWARM_INLINE_MANIFEST_HASHES,
      "fixture must require a paged manifest",
    );

    const offer = await waitFor(
      "the paged swarm offer",
      () => fetchManager.resolveOffer(manifest.fileId),
      30_000,
    );
    assert.equal(offer.manifestReady, false, "large manifests must not ride in the initial offer");
    assert.ok(offerBytes > 0 && offerBytes < 4_096, `initial offer was unexpectedly large: ${offerBytes}`);
    const transferStartedAt = Date.now();
    assert.equal(fetchManager.fetch(manifest.fileId), true);
    if (large) {
      progressTimer = setInterval(() => console.log(JSON.stringify({
        elapsedMs: Date.now() - transferStartedAt, droppedChunks, delayedChunks,
        progress: fetchManager.progress(),
      })), 10_000);
      progressTimer.unref();
    }

    if (impaired) {
      await waitFor("partial progress before restart", () => {
        if (transferError) throw new Error(transferError);
        return (fetchManager.sessionFor(manifest.fileId)?.progress().haveChunks ?? 0) >= 128;
      });
      const before = fetchManager.sessionFor(manifest.fileId).progress();
      assert.ok(!before.complete, "restart fixture must still be downloading");
      fetchManager.stop();
      await fetchBridge.disconnect();
      fetchManager = createFetchManager();
      fetchManager.start();
      // Resume from disk, not the old session's memory.
      fetchManager.fetch(manifest.fileId);
      await fetchBridge.connect();
      await waitFor("resumed session after reconnect", () => fetchManager.sessionFor(manifest.fileId));
      resumedChunks = fetchManager.sessionFor(manifest.fileId).progress().haveChunks;
      assert.ok(resumedChunks >= before.haveChunks, "verified chunks must survive a fresh manager and connection");
    }

    const result = await waitFor(
      "the swarm download",
      () => {
        if (transferError) throw new Error(transferError);
        return completion;
      },
      large ? 240_000 : 120_000,
    );

    const expectedPages = Math.ceil(manifest.totalChunks / SWARM_MANIFEST_PAGE_HASHES);
    assert.ok(manifestRequests >= 1, "fetcher never requested manifest pages");
    assert.ok(manifestPages >= expectedPages, `received ${manifestPages}/${expectedPages} manifest pages`);
    assert.equal(result.manifest.fileId, manifest.fileId);
    assert.equal(sha256(result.savedPath), sha256(sourcePath), "downloaded bytes differ from the source");
    const uuid = fetchBridge.peers.getPeer("live-swarm-seed")?.uuid;
    const quality = uuid ? await fetchBridge.getSDK().getPeerQuality(uuid) : null;
    if (forceTurn) assert.equal(quality?.relayed, true, "relay run must verify a selected relay candidate");
    if (impaired) {
      assert.ok(droppedChunks > 0 && delayedChunks > 0 && droppedPages === 1);
      assert.ok(fetchLog.some(line => line.includes("timed out")), "dropped chunks must exercise timeout recovery");
    }

    console.log(JSON.stringify({
      packageRoot,
      room,
      impaired,
      forceTurn,
      large,
      candidatePairType: quality?.candidatePairType ?? null,
      relayed: quality?.relayed ?? null,
      droppedChunks,
      droppedPages,
      delayedChunks,
      resumedChunks,
      elapsedMs: Date.now() - transferStartedAt,
      bytes: manifest.size,
      chunks: manifest.totalChunks,
      manifestPages,
      manifestRequests,
      initialOfferBytes: offerBytes,
      transport: binaryFrames > 0 ? "binary" : "base64",
      binaryFrames,
      sha256: manifest.fileId,
      seedLog: seedLog.slice(-5),
      fetchLog: fetchLog.slice(-5),
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ impaired, forceTurn, droppedChunks, droppedPages,
      delayedChunks, resumedChunks, progress: fetchManager.progress(),
      seedLog: seedLog.slice(-12), fetchLog: fetchLog.slice(-12) }, null, 2));
    throw error;
  } finally {
    clearInterval(progressTimer);
    seedManager.stop();
    fetchManager.stop();
    await Promise.allSettled([seedBridge.disconnect(), fetchBridge.disconnect()]);
  }
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// VDOBridge.disconnect() has already awaited native teardown. Exiting directly
// avoids a known @roamhq/wrtc destructor failure during Node's natural shutdown,
// which otherwise turns a successful multi-peer validation into exit code 1.
process.exit(exitCode);
