import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

import {
  appendIncomingTransferChunk,
  beginIncomingTransfer,
  bytesToBase64,
  completeIncomingTransfer,
  createFileAckPayload,
  discardIncomingTransfer,
  MAX_INCOMPLETE_TRANSFERS,
  MAX_BASIC_TRANSFER_SIZE,
  prepareFileTransferFromPath,
} from "../src/file-transfer.js";
import { createMessageId, type FileOfferPayload, type PeerIdentity } from "../src/protocol.js";
import { VDOBridge } from "../src/vdo-bridge.js";

const me: PeerIdentity = {
  streamId: "sender",
  role: "agent",
  name: "Sender",
  instanceId: "inst_sender",
};

const other: PeerIdentity = {
  streamId: "receiver",
  role: "agent",
  name: "Receiver",
  instanceId: "inst_receiver",
};

test("overlapping incoming files with the same name both finish without overwriting", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    const offers = ["first contents", "second contents"].map(text => {
      const data = Buffer.from(text);
      const offer: FileOfferPayload = {
        transferId: createMessageId(), name: "notes.txt", mimeType: "text/plain", kind: "file",
        size: data.length, sha256: createHash("sha256").update(data).digest("hex"),
        chunkSize: 1024, totalChunks: 1,
      };
      beginIncomingTransfer(dir, me, offer);
      appendIncomingTransferChunk(dir, { transferId: offer.transferId, index: 0, totalChunks: 1, data: data.toString("base64") }, me.streamId);
      return offer;
    });
    const first = completeIncomingTransfer(dir, offers[0], me.streamId);
    const second = completeIncomingTransfer(dir, offers[1], me.streamId);
    assert.notEqual(first.savedPath, second.savedPath);
    assert.equal(readFileSync(first.savedPath, "utf8"), "first contents");
    assert.equal(readFileSync(second.savedPath, "utf8"), "second contents");
    assert.deepEqual(completeIncomingTransfer(dir, offers[1], me.streamId), second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeBridge(): VDOBridge {
  return new VDOBridge({
    room: "transfer-room",
    streamId: me.streamId,
    identity: {
      streamId: me.streamId,
      role: me.role,
      name: me.name,
    },
    password: false,
  });
}

test("long valid transfer IDs do not make duplicate filenames exceed filesystem limits", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    const name = `${"a".repeat(170)}.txt`;
    const base: FileOfferPayload = {
      transferId: "a".repeat(128), name, mimeType: "text/plain", kind: "file",
      size: 0, sha256: createHash("sha256").digest("hex"), chunkSize: 1024, totalChunks: 0,
    };
    beginIncomingTransfer(dir, me, base);
    const first = completeIncomingTransfer(dir, base, me.streamId);
    const next = { ...base, transferId: "b".repeat(128) };
    beginIncomingTransfer(dir, me, next);
    const second = completeIncomingTransfer(dir, next, me.streamId);
    assert.notEqual(first.savedPath, second.savedPath);
    assert.equal(readFileSync(first.savedPath).length, 0);
    assert.equal(readFileSync(second.savedPath).length, 0);
    const samePrefix = { ...base, transferId: "b".repeat(127) + "c" };
    beginIncomingTransfer(dir, me, samePrefix);
    const third = completeIncomingTransfer(dir, samePrefix, me.streamId);
    assert.notEqual(third.savedPath, second.savedPath);
    assert.equal(readFileSync(third.savedPath).length, 0);
    assert.equal(readFileSync(second.savedPath).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("download filenames are bounded in UTF-8 without splitting characters", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    const offer: FileOfferPayload = {
      transferId: createMessageId(), name: "📄".repeat(100) + ".txt", mimeType: "text/plain", kind: "file",
      size: 0, sha256: createHash("sha256").digest("hex"), chunkSize: 1024, totalChunks: 0,
    };
    const manifest = beginIncomingTransfer(dir, me, offer);
    assert.ok(Buffer.byteLength(manifest.safeName, "utf8") <= 180);
    assert.equal(Buffer.from(manifest.safeName).toString("utf8"), manifest.safeName);
    const result = completeIncomingTransfer(dir, offer, me.streamId);
    assert.equal(readFileSync(result.savedPath).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("truncation cannot leave a Windows filename ending in a dot or space", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    for (const ending of [".", " "]) {
      const manifest = beginIncomingTransfer(dir, me, {
        transferId: createMessageId(), name: "a".repeat(179) + ending + "tail.txt",
        mimeType: "text/plain", kind: "file", size: 0,
        sha256: createHash("sha256").digest("hex"), chunkSize: 1024, totalChunks: 0,
      });
      assert.equal(/[. ]$/.test(manifest.safeName), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sendFile sends offer, chunk, and complete envelopes to a connected peer", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    const filePath = path.join(dir, "notes.txt");
    writeFileSync(filePath, "hello from ninja-p2p", "utf8");

    const bridge = makeBridge();
    (bridge as unknown as { connected: boolean }).connected = true;
    bridge.peers.addPeer(other.streamId, "uuid_receiver");

    const sent: Array<{ data: Record<string, unknown>; target?: unknown }> = [];
    bridge.bus.setSendDataFn((data, target) => {
      sent.push({ data: data as Record<string, unknown>, target });
    });

    const offer = bridge.sendFile(other.streamId, filePath);

    assert.equal(offer.name, "notes.txt");
    assert.equal(offer.kind, "file");
    assert.equal(sent.length, 3);
    assert.equal(sent[0].data.type, "file_offer");
    assert.equal(sent[1].data.type, "file_chunk");
    assert.equal(sent[2].data.type, "file_complete");
    assert.deepEqual(sent[0].target, { uuid: "uuid_receiver" });
    assert.deepEqual(sent[1].target, { uuid: "uuid_receiver" });
    assert.deepEqual(sent[2].target, { uuid: "uuid_receiver" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sendFile reports when the transport rejects the transfer", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    const filePath = path.join(dir, "notes.txt");
    writeFileSync(filePath, "hello", "utf8");
    const bridge = makeBridge();
    (bridge as unknown as { connected: boolean }).connected = true;
    bridge.peers.addPeer(other.streamId, "uuid_receiver");
    bridge.bus.setSendDataFn(() => false);

    assert.throws(
      () => bridge.sendFile(other.streamId, filePath),
      /did not accept file offer/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incoming file transfer assembles bytes on disk and creates an ack payload", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    const sourcePath = path.join(dir, "tiny.png");
    const sourceBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8]);
    writeFileSync(sourcePath, sourceBytes);

    const prepared = prepareFileTransferFromPath(sourcePath, "image");
    const chunkSize = 1_024;
    const offer: FileOfferPayload = {
      transferId: createMessageId(),
      name: prepared.name,
      mimeType: prepared.mimeType,
      kind: prepared.kind,
      size: prepared.size,
      sha256: prepared.sha256,
      chunkSize,
      totalChunks: Math.ceil(prepared.size / chunkSize),
    };

    beginIncomingTransfer(dir, me, offer);
    for (let index = 0; index < offer.totalChunks; index += 1) {
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, prepared.size);
      appendIncomingTransferChunk(dir, {
        transferId: offer.transferId,
        index,
        totalChunks: offer.totalChunks,
        data: bytesToBase64(prepared.bytes.slice(start, end)),
      });
    }

    const completed = completeIncomingTransfer(dir, {
      transferId: offer.transferId,
      totalChunks: offer.totalChunks,
      size: offer.size,
      sha256: offer.sha256,
    });

    assert.equal(completed.kind, "image");
    assert.equal(completed.mimeType, "image/png");
    assert.deepEqual(new Uint8Array(readFileSync(completed.savedPath)), sourceBytes);

    const ack = createFileAckPayload(completed);
    assert.equal(ack.ok, true);
    assert.equal(ack.savedPath, completed.savedPath);
    assert.equal(ack.sha256, prepared.sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incoming file transfer rejects out-of-order chunks", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    const offer: FileOfferPayload = {
      transferId: createMessageId(),
      name: "notes.txt",
      mimeType: "text/plain",
      kind: "file",
      size: 2_048,
      sha256: "0".repeat(64),
      chunkSize: 1_024,
      totalChunks: 2,
    };
    beginIncomingTransfer(dir, other, offer);

    assert.throws(() => {
      appendIncomingTransferChunk(dir, {
        transferId: offer.transferId,
        index: 1,
        totalChunks: 2,
        data: bytesToBase64(new Uint8Array(1_024)),
      });
    }, /unexpected chunk index/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incoming transfer ids cannot escape the state directory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    assert.throws(
      () => beginIncomingTransfer(dir, other, {
        transferId: "..\\..\\outside",
        name: "notes.txt",
        mimeType: "text/plain",
        kind: "file",
        size: 0,
        sha256: "0".repeat(64),
        chunkSize: 1_024,
        totalChunks: 0,
      }),
      /invalid transfer id/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incoming offers are bounded and internally consistent", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    const base: FileOfferPayload = {
      transferId: createMessageId(),
      name: "large.bin",
      mimeType: "application/octet-stream",
      kind: "file",
      size: MAX_BASIC_TRANSFER_SIZE + 1,
      sha256: "0".repeat(64),
      chunkSize: 1_024,
      totalChunks: 1,
    };
    assert.throws(() => beginIncomingTransfer(dir, other, base), /maximum/);
    assert.throws(
      () => beginIncomingTransfer(dir, other, {
        ...base,
        size: 4_096,
        totalChunks: 3,
      }),
      /does not match/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("damaged manifests without part files do not block incoming transfers", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-transfer-quota-"));
  try {
    mkdirSync(path.join(dir, "transfers"));
    writeFileSync(path.join(dir, "transfers", "damaged_record.json"), "null");
    assert.doesNotThrow(() => beginIncomingTransfer(dir, me, {
      transferId: createMessageId(), name: "empty.txt", mimeType: "text/plain", kind: "file",
      size: 0, sha256: createHash("sha256").digest("hex"), chunkSize: 1024, totalChunks: 0,
    }));
    assert.equal(readFileSync(path.join(dir, "transfers", "damaged_record.json"), "utf8"), "null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("damaged manifests with part files retain conservative quota accounting", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-transfer-quota-"));
  try {
    mkdirSync(path.join(dir, "transfers"));
    for (const [id, content] of [["damaged_one", "null"], ["damaged_two", "{broken"]]) {
      writeFileSync(path.join(dir, "transfers", `${id}.json`), content);
      writeFileSync(path.join(dir, "transfers", `${id}.part`), "keep");
    }
    assert.throws(() => beginIncomingTransfer(dir, me, {
      transferId: createMessageId(), name: "extra.txt", mimeType: "text/plain", kind: "file",
      size: 1, sha256: "0".repeat(64), chunkSize: 1024, totalChunks: 1,
    }), /quota/);
    assert.equal(readFileSync(path.join(dir, "transfers", "damaged_one.part"), "utf8"), "keep");
    assert.equal(readFileSync(path.join(dir, "transfers", "damaged_two.part"), "utf8"), "keep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("part files left without manifests still count against transfer quota", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-transfer-quota-"));
  try {
    mkdirSync(path.join(dir, "transfers"));
    for (const id of ["orphaned_one", "orphaned_two"]) {
      writeFileSync(path.join(dir, "transfers", `${id}.part`), "unfinished data");
    }
    const offer: FileOfferPayload = {
      transferId: createMessageId(), name: "extra.txt", mimeType: "text/plain", kind: "file",
      size: 1, sha256: "0".repeat(64), chunkSize: 1024, totalChunks: 1,
    };
    assert.throws(() => beginIncomingTransfer(dir, me, offer), /quota/);
    assert.equal(discardIncomingTransfer(dir, "orphaned_one", me.streamId), false);
    assert.equal(readFileSync(path.join(dir, "transfers", "orphaned_one.part"), "utf8"), "unfinished data");
    assert.equal(discardIncomingTransfer(dir, "orphaned_one"), true);
    assert.doesNotThrow(() => beginIncomingTransfer(dir, me, offer));
    assert.equal(readFileSync(path.join(dir, "transfers", "orphaned_two.part"), "utf8"), "unfinished data");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit local discard can remove a transfer with unreadable metadata", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-transfer-discard-"));
  try {
    mkdirSync(path.join(dir, "transfers"));
    const id = "damaged_transfer";
    const metadata = path.join(dir, "transfers", `${id}.json`);
    const part = path.join(dir, "transfers", `${id}.part`);
    writeFileSync(metadata, "{broken");
    writeFileSync(part, "unfinished data");
    // A remote sender cannot establish ownership from unreadable metadata.
    assert.equal(discardIncomingTransfer(dir, id, me.streamId), false);
    assert.equal(readFileSync(part, "utf8"), "unfinished data");
    assert.equal(readFileSync(metadata, "utf8"), "{broken");
    // The local API's unscoped discard is an explicit cleanup request.
    assert.equal(discardIncomingTransfer(dir, id), true);
    assert.throws(() => readFileSync(part), { code: "ENOENT" });
    assert.throws(() => readFileSync(metadata), { code: "ENOENT" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incoming chunks must match the offered size and sender", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    const offer: FileOfferPayload = {
      transferId: createMessageId(),
      name: "notes.txt",
      mimeType: "text/plain",
      kind: "file",
      size: 1_024,
      sha256: "0".repeat(64),
      chunkSize: 1_024,
      totalChunks: 1,
    };
    beginIncomingTransfer(dir, other, offer);

    assert.throws(
      () => appendIncomingTransferChunk(dir, {
        transferId: offer.transferId,
        index: 0,
        totalChunks: 1,
        data: bytesToBase64(new Uint8Array(2_048)),
      }, "attacker"),
      /does not own/,
    );
    assert.throws(
      () => appendIncomingTransferChunk(dir, {
        transferId: offer.transferId,
        index: 0,
        totalChunks: 1,
        data: bytesToBase64(new Uint8Array(2_048)),
      }, other.streamId),
      /unexpected chunk length/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale transfers still count toward quota when their files cannot be removed", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  const offer: FileOfferPayload = {
    transferId: createMessageId(), name: "next.txt", mimeType: "text/plain", kind: "file",
    size: 0, sha256: "0".repeat(64), chunkSize: 1024, totalChunks: 0,
  };
  try {
    const manifests = Array.from({ length: MAX_INCOMPLETE_TRANSFERS }, () =>
      beginIncomingTransfer(dir, other, { ...offer, transferId: createMessageId() }));
    for (const manifest of manifests) {
      manifest.updatedAt = 0;
      writeFileSync(path.join(dir, "transfers", `${manifest.transferId}.json`), JSON.stringify(manifest));
    }
    const protectedParts = new Set(manifests.map(manifest => manifest.tempPath));
    const remove = fs.rmSync;
    t.mock.method(fs, "rmSync", (target: fs.PathLike, options?: fs.RmOptions) => {
      if (protectedParts.has(String(target))) throw Object.assign(new Error("file is busy"), { code: "EBUSY" });
      return remove(target, options);
    });
    syncBuiltinESMExports();
    assert.throws(() => beginIncomingTransfer(dir, other, offer), /too many incomplete/);
    for (const part of protectedParts) assert.equal(fs.existsSync(part), true);

    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.doesNotThrow(() => beginIncomingTransfer(dir, other, offer));
    for (const part of protectedParts) assert.equal(fs.existsSync(part), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incomplete transfer count is bounded and failed transfers can be discarded", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    const ids: string[] = [];
    for (let index = 0; index < MAX_INCOMPLETE_TRANSFERS; index += 1) {
      const transferId = createMessageId();
      ids.push(transferId);
      beginIncomingTransfer(dir, other, {
        transferId,
        name: `${index}.txt`,
        mimeType: "text/plain",
        kind: "file",
        size: 0,
        sha256: "0".repeat(64),
        chunkSize: 1_024,
        totalChunks: 0,
      });
    }

    assert.throws(
      () => beginIncomingTransfer(dir, other, {
        transferId: createMessageId(),
        name: "one-too-many.txt",
        mimeType: "text/plain",
        kind: "file",
        size: 0,
        sha256: "0".repeat(64),
        chunkSize: 1_024,
        totalChunks: 0,
      }),
      /too many incomplete/,
    );

    assert.equal(discardIncomingTransfer(dir, ids[0], "attacker"), false);
    assert.equal(discardIncomingTransfer(dir, ids[0], other.streamId), true);
    assert.doesNotThrow(() => beginIncomingTransfer(dir, other, {
      transferId: createMessageId(),
      name: "replacement.txt",
      mimeType: "text/plain",
      kind: "file",
      size: 0,
      sha256: "0".repeat(64),
      chunkSize: 1_024,
      totalChunks: 0,
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
