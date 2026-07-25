import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  decodeChunkFrame,
  encodeChunkFrame,
  isBinaryFileId,
  SWARM_FRAME_CHUNK,
  SWARM_WIRE_HEADER_BYTES,
  SWARM_WIRE_VERSION,
} from "../src/swarm-wire.js";

const FILE_ID = "a".repeat(64);

describe("swarm wire format", () => {
  it("round-trips a chunk", () => {
    const data = new Uint8Array(randomBytes(4096));
    const frame = encodeChunkFrame(FILE_ID, 7, data);
    const decoded = decodeChunkFrame(frame);

    assert.ok(decoded);
    assert.equal(decoded.fileId, FILE_ID);
    assert.equal(decoded.index, 7);
    assert.deepEqual([...decoded.data], [...data]);
  });

  it("round-trips a real sha256-shaped id, not just a repeated digit", () => {
    const fileId = "3b1f7a0c9d2e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e";
    const frame = encodeChunkFrame(fileId, 0, new Uint8Array([1, 2, 3]));
    assert.equal(decodeChunkFrame(frame)!.fileId, fileId);
  });

  it("costs 40 bytes regardless of payload size", () => {
    const frame = encodeChunkFrame(FILE_ID, 0, new Uint8Array(64_000));
    assert.equal(frame.length - 64_000, SWARM_WIRE_HEADER_BYTES);
    // The overhead this replaces was 33%, so state the win as a test.
    assert.ok(SWARM_WIRE_HEADER_BYTES / 64_000 < 0.001);
  });

  it("handles an empty payload", () => {
    const decoded = decodeChunkFrame(encodeChunkFrame(FILE_ID, 3, new Uint8Array(0)));
    assert.equal(decoded!.data.length, 0);
    assert.equal(decoded!.index, 3);
  });

  it("carries a chunk index above 16 bits", () => {
    // A 4 GB file at 64 KB chunks is ~65,536 chunks, so this is not exotic.
    const decoded = decodeChunkFrame(encodeChunkFrame(FILE_ID, 1_000_000, new Uint8Array([9])));
    assert.equal(decoded!.index, 1_000_000);
  });

  it("copies the payload rather than viewing the received buffer", () => {
    const frame = encodeChunkFrame(FILE_ID, 0, new Uint8Array([1, 2, 3]));
    const decoded = decodeChunkFrame(frame)!;
    frame[SWARM_WIRE_HEADER_BYTES] = 99;
    // Holding a view would pin the whole received frame alive for as long as
    // any chunk of it is referenced, and would alias if the buffer is reused.
    assert.equal(decoded.data[0], 1);
  });

  it("decodes correctly when the frame sits at a non-zero byte offset", () => {
    const frame = encodeChunkFrame(FILE_ID, 42, new Uint8Array([7, 8]));
    const padded = new Uint8Array(frame.length + 16);
    padded.set(frame, 16);
    const view = padded.subarray(16);

    const decoded = decodeChunkFrame(view);
    assert.equal(decoded!.index, 42, "DataView must respect byteOffset");
    assert.deepEqual([...decoded!.data], [7, 8]);
  });

  it("ignores frames that are not ours instead of throwing", () => {
    assert.equal(decodeChunkFrame(new Uint8Array(0)), null);
    assert.equal(decodeChunkFrame(new Uint8Array(SWARM_WIRE_HEADER_BYTES - 1)), null);

    const wrongMagic = encodeChunkFrame(FILE_ID, 0, new Uint8Array([1]));
    wrongMagic[0] = 0x5a;
    assert.equal(decodeChunkFrame(wrongMagic), null);

    const wrongVersion = encodeChunkFrame(FILE_ID, 0, new Uint8Array([1]));
    wrongVersion[2] = SWARM_WIRE_VERSION + 1;
    assert.equal(decodeChunkFrame(wrongVersion), null);

    const wrongType = encodeChunkFrame(FILE_ID, 0, new Uint8Array([1]));
    wrongType[3] = SWARM_FRAME_CHUNK + 1;
    assert.equal(decodeChunkFrame(wrongType), null);
  });

  it("refuses to encode an id the header cannot represent", () => {
    assert.throws(() => encodeChunkFrame("not-hex", 0, new Uint8Array([1])), /hex id/);
    assert.throws(() => encodeChunkFrame("A".repeat(64), 0, new Uint8Array([1])), /hex id/);
    assert.throws(() => encodeChunkFrame("a".repeat(63), 0, new Uint8Array([1])), /hex id/);
  });

  it("refuses an index the header cannot represent", () => {
    assert.throws(() => encodeChunkFrame(FILE_ID, -1, new Uint8Array()), /index out of range/);
    assert.throws(() => encodeChunkFrame(FILE_ID, 2 ** 32, new Uint8Array()), /index out of range/);
    assert.throws(() => encodeChunkFrame(FILE_ID, 1.5, new Uint8Array()), /index out of range/);
  });

  it("gates ids the same way encoding does", () => {
    assert.equal(isBinaryFileId(FILE_ID), true);
    assert.equal(isBinaryFileId("A".repeat(64)), false, "uppercase would encode to different bytes");
    assert.equal(isBinaryFileId("legacy-id"), false);
    assert.equal(isBinaryFileId(""), false);
  });
});
