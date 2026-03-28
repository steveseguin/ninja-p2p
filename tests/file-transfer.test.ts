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

test("incoming file transfer assembles bytes on disk and creates an ack payload", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-transfer-"));
  try {
    const sourcePath = path.join(dir, "tiny.png");
    const sourceBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8]);
    writeFileSync(sourcePath, sourceBytes);

    const prepared = prepareFileTransferFromPath(sourcePath, "image");
    const chunkSize = 4;
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
      size: 6,
      sha256: "abc",
      chunkSize: 3,
      totalChunks: 2,
    };
    beginIncomingTransfer(dir, other, offer);

    assert.throws(() => {
      appendIncomingTransferChunk(dir, {
        transferId: offer.transferId,
        index: 1,
        totalChunks: 2,
        data: bytesToBase64(new Uint8Array([1, 2, 3])),
      });
    }, /unexpected chunk index/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
