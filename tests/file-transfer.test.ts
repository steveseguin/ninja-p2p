import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
