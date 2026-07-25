/**
 * Swarm binary wire format
 *
 * Chunks used to travel as base64 inside a JSON envelope, because the SDK
 * stringified everything before it reached the data channel. `sendBinary` gives
 * us a real byte lane, so a chunk now goes out as a 40-byte header followed by
 * the payload untouched — 0.06% overhead on a 64 KB chunk instead of 33%.
 *
 * The lane carries no routing of its own: `binaryReceived` tells us which peer
 * sent bytes and nothing else. So the frame has to identify the file and the
 * chunk itself, and has to be self-describing enough that a future frame type
 * can share the lane without ambiguity.
 *
 *   0       magic 'N'
 *   1       magic 'J'
 *   2       version
 *   3       frame type
 *   4..35   fileId, 32 raw bytes (the sha256 the hex id encodes)
 *   36..39  chunk index, uint32 big-endian
 *   40..    payload
 */

export const SWARM_WIRE_MAGIC_0 = 0x4e; // 'N'
export const SWARM_WIRE_MAGIC_1 = 0x4a; // 'J'
export const SWARM_WIRE_VERSION = 1;
export const SWARM_FRAME_CHUNK = 1;
export const SWARM_WIRE_HEADER_BYTES = 40;

const FILE_ID_BYTES = 32;
const HEX_FILE_ID = /^[0-9a-f]{64}$/;

export type SwarmChunkFrame = {
  fileId: string;
  index: number;
  data: Uint8Array;
};

/**
 * Whether a content id can ride the binary lane.
 *
 * Ids are sha256 hex, so this is true for anything we produce. A peer that
 * offers something else is not lied to or dropped — it just gets the base64
 * path, which imposes no constraints on the id at all.
 */
export function isBinaryFileId(fileId: string): boolean {
  return HEX_FILE_ID.test(fileId);
}

export function encodeChunkFrame(fileId: string, index: number, data: Uint8Array): Uint8Array {
  if (!isBinaryFileId(fileId)) {
    throw new Error(`fileId is not a 64-character hex id: ${fileId}`);
  }
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error(`chunk index out of range: ${index}`);
  }

  const frame = new Uint8Array(SWARM_WIRE_HEADER_BYTES + data.length);
  frame[0] = SWARM_WIRE_MAGIC_0;
  frame[1] = SWARM_WIRE_MAGIC_1;
  frame[2] = SWARM_WIRE_VERSION;
  frame[3] = SWARM_FRAME_CHUNK;

  for (let i = 0; i < FILE_ID_BYTES; i += 1) {
    frame[4 + i] = Number.parseInt(fileId.slice(i * 2, i * 2 + 2), 16);
  }

  const view = new DataView(frame.buffer, frame.byteOffset);
  view.setUint32(36, index, false);

  frame.set(data, SWARM_WIRE_HEADER_BYTES);
  return frame;
}

/**
 * Parse a frame, or return null if it is not one of ours.
 *
 * Null rather than throwing: the binary lane is shared with anything else the
 * application chooses to put on it, and a frame we do not recognise is somebody
 * else's business, not an error.
 */
export function decodeChunkFrame(bytes: Uint8Array): SwarmChunkFrame | null {
  if (bytes.length < SWARM_WIRE_HEADER_BYTES) return null;
  if (bytes[0] !== SWARM_WIRE_MAGIC_0 || bytes[1] !== SWARM_WIRE_MAGIC_1) return null;
  if (bytes[2] !== SWARM_WIRE_VERSION) return null;
  if (bytes[3] !== SWARM_FRAME_CHUNK) return null;

  let fileId = "";
  for (let i = 0; i < FILE_ID_BYTES; i += 1) {
    fileId += bytes[4 + i].toString(16).padStart(2, "0");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const index = view.getUint32(36, false);

  // Copy rather than subarray: the payload outlives the frame — it is hashed,
  // written to disk, and may be re-served — and holding a view would pin the
  // whole received buffer alive for as long as any chunk of it is referenced.
  const data = bytes.slice(SWARM_WIRE_HEADER_BYTES);

  return { fileId, index, data };
}
