import {
  appendFileSync,
  constants,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createMessageId,
  type FileAckPayload,
  type FileChunkPayload,
  type FileCompletePayload,
  type FileOfferPayload,
  type FileTransferKind,
  type PeerIdentity,
} from "./protocol.js";
import type { VDOBridge } from "./vdo-bridge.js";

export const DEFAULT_TRANSFER_CHUNK_SIZE = 12_000;
/** The simple transfer path buffers at the sender; use swarm transfer above this. */
export const MAX_BASIC_TRANSFER_SIZE = 256 * 1024 * 1024;
export const MAX_BASIC_TRANSFER_CHUNK_SIZE = 1024 * 1024;
export const MAX_BASIC_TRANSFER_CHUNKS = Math.ceil(MAX_BASIC_TRANSFER_SIZE / 1_024);
export const MAX_INCOMPLETE_TRANSFER_BYTES = 512 * 1024 * 1024;
export const MAX_INCOMPLETE_TRANSFERS = 16;
export const INCOMPLETE_TRANSFER_STALE_MS = 24 * 60 * 60_000;
export const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type PreparedFileTransfer = {
  name: string;
  filePath: string;
  mimeType: string;
  kind: FileTransferKind;
  bytes: Uint8Array;
  size: number;
  sha256: string;
};

export type IncomingTransferManifest = {
  transferId: string;
  from: PeerIdentity;
  name: string;
  safeName: string;
  mimeType: string;
  kind: FileTransferKind;
  size: number;
  sha256: string;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number;
  receivedBytes: number;
  tempPath: string;
  savedPath: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type CompletedTransferResult = {
  transferId: string;
  name: string;
  mimeType: string;
  kind: FileTransferKind;
  size: number;
  sha256: string;
  savedPath: string;
};

type TransferPaths = {
  transfersDir: string;
  downloadsDir: string;
  manifestPath: string;
  tempPath: string;
};

export function prepareFileTransferFromPath(filePath: string, kind: FileTransferKind = "file"): PreparedFileTransfer {
  const resolved = path.resolve(filePath);
  const file = statSync(resolved);
  if (!file.isFile()) throw new Error(`not a file: ${resolved}`);
  if (file.size > MAX_BASIC_TRANSFER_SIZE) {
    throw new Error(
      `file is ${file.size} bytes; simple transfers are limited to ${MAX_BASIC_TRANSFER_SIZE} bytes ` +
        "(use `ninja-p2p seed` / `fetch` for larger files)",
    );
  }
  const bytes = new Uint8Array(readFileSync(resolved));
  if (bytes.byteLength > MAX_BASIC_TRANSFER_SIZE) {
    throw new Error(`file grew beyond the ${MAX_BASIC_TRANSFER_SIZE}-byte simple-transfer limit while reading`);
  }
  const name = path.basename(resolved);
  return {
    name,
    filePath: resolved,
    mimeType: guessMimeType(name, kind),
    kind,
    bytes,
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

export function sendPreparedFileTransfer(
  bridge: VDOBridge,
  targetStreamId: string,
  prepared: PreparedFileTransfer,
  chunkSize = DEFAULT_TRANSFER_CHUNK_SIZE,
): FileOfferPayload {
  if (!bridge.isConnected()) {
    throw new Error("bridge is not connected");
  }
  if (!bridge.peers.isConnected(targetStreamId)) {
    throw new Error(`peer is not connected: ${targetStreamId}`);
  }

  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new Error(`invalid chunk size: ${chunkSize}`);
  }
  if (prepared.size > MAX_BASIC_TRANSFER_SIZE) {
    throw new Error(`simple transfers are limited to ${MAX_BASIC_TRANSFER_SIZE} bytes`);
  }
  const normalizedChunkSize = Math.max(1_024, Math.floor(chunkSize));
  if (normalizedChunkSize > MAX_BASIC_TRANSFER_CHUNK_SIZE) {
    throw new Error(`chunk size exceeds ${MAX_BASIC_TRANSFER_CHUNK_SIZE} bytes`);
  }
  const totalChunks = prepared.size === 0 ? 0 : Math.ceil(prepared.size / normalizedChunkSize);
  const transferId = createMessageId();

  const offer: FileOfferPayload = {
    transferId,
    name: prepared.name,
    mimeType: prepared.mimeType,
    kind: prepared.kind,
    size: prepared.size,
    sha256: prepared.sha256,
    chunkSize: normalizedChunkSize,
    totalChunks,
  };

  if (!bridge.bus.trySend(targetStreamId, "file_offer", offer)) {
    throw new Error(`peer did not accept file offer: ${targetStreamId}`);
  }

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * normalizedChunkSize;
    const end = Math.min(start + normalizedChunkSize, prepared.size);
    const chunk = prepared.bytes.slice(start, end);
    const payload: FileChunkPayload = {
      transferId,
      index,
      totalChunks,
      data: bytesToBase64(chunk),
    };
    if (!bridge.bus.trySend(targetStreamId, "file_chunk", payload)) {
      throw new Error(`peer stopped accepting ${prepared.name} at chunk ${index}/${totalChunks}`);
    }
  }

  if (!bridge.bus.trySend(targetStreamId, "file_complete", {
    transferId,
    totalChunks,
    size: prepared.size,
    sha256: prepared.sha256,
  } satisfies FileCompletePayload)) {
    throw new Error(`peer did not accept completion for ${prepared.name}`);
  }

  return offer;
}

export function sendFileFromPath(
  bridge: VDOBridge,
  targetStreamId: string,
  filePath: string,
  kind: FileTransferKind = "file",
  chunkSize = DEFAULT_TRANSFER_CHUNK_SIZE,
): FileOfferPayload {
  return sendPreparedFileTransfer(bridge, targetStreamId, prepareFileTransferFromPath(filePath, kind), chunkSize);
}

export function beginIncomingTransfer(
  stateDir: string,
  from: PeerIdentity,
  offer: FileOfferPayload,
): IncomingTransferManifest {
  validateFileOffer(offer);
  if (!from || typeof from.streamId !== "string" || !from.streamId) {
    throw new Error("file offer has no valid sender");
  }
  const paths = getTransferPaths(stateDir, offer.transferId);
  mkdirSync(paths.transfersDir, { recursive: true });
  mkdirSync(paths.downloadsDir, { recursive: true });

  const existing = readTransferManifest(stateDir, offer.transferId);
  if (existing) {
    if (
      existing.from.streamId !== from.streamId ||
      existing.name !== offer.name ||
      existing.size !== offer.size ||
      existing.sha256 !== offer.sha256 ||
      existing.chunkSize !== offer.chunkSize ||
      existing.totalChunks !== offer.totalChunks
    ) {
      throw new Error(`transfer id is already in use: ${offer.transferId}`);
    }
    return existing;
  }
  enforceIncomingTransferQuota(stateDir, offer.size);

  writeFileSync(paths.tempPath, new Uint8Array(0));

  const safeName = sanitizeFileName(offer.name);
  const manifest: IncomingTransferManifest = {
    transferId: offer.transferId,
    from,
    name: offer.name,
    safeName,
    mimeType: offer.mimeType,
    kind: offer.kind,
    size: offer.size,
    sha256: offer.sha256,
    chunkSize: offer.chunkSize,
    totalChunks: offer.totalChunks,
    receivedChunks: 0,
    receivedBytes: 0,
    tempPath: paths.tempPath,
    savedPath: chooseSavedPath(paths.downloadsDir, safeName, offer.transferId),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  writeManifest(paths.manifestPath, manifest);
  return manifest;
}

export function appendIncomingTransferChunk(
  stateDir: string,
  payload: FileChunkPayload,
  fromStreamId?: string,
): IncomingTransferManifest {
  validateTransferId(payload?.transferId);
  const manifest = mustReadTransferManifest(stateDir, payload.transferId);
  if (fromStreamId && manifest.from.streamId !== fromStreamId) {
    throw new Error(`chunk sender does not own transfer ${payload.transferId}`);
  }
  if (manifest.completedAt) {
    return manifest;
  }
  if (!Number.isInteger(payload.index) || payload.index < 0 || payload.index >= manifest.totalChunks) {
    throw new Error(`invalid chunk index ${payload.index}`);
  }
  if (payload.index !== manifest.receivedChunks) {
    throw new Error(`unexpected chunk index ${payload.index}; expected ${manifest.receivedChunks}`);
  }
  if (payload.totalChunks !== manifest.totalChunks) {
    throw new Error(`unexpected totalChunks ${payload.totalChunks}; expected ${manifest.totalChunks}`);
  }
  if (typeof payload.data !== "string" || !BASE64_PATTERN.test(payload.data)) {
    throw new Error("chunk data is not valid base64");
  }

  const bytes = base64ToBytes(payload.data);
  const expectedLength = Math.min(
    manifest.chunkSize,
    manifest.size - payload.index * manifest.chunkSize,
  );
  if (bytes.byteLength !== expectedLength) {
    throw new Error(`unexpected chunk length ${bytes.byteLength}; expected ${expectedLength}`);
  }
  if (manifest.receivedBytes + bytes.byteLength > manifest.size) {
    throw new Error("chunk would exceed the offered file size");
  }
  appendFileSync(manifest.tempPath, bytes);
  manifest.receivedChunks += 1;
  manifest.receivedBytes += bytes.byteLength;
  manifest.updatedAt = Date.now();
  writeManifest(getTransferPaths(stateDir, payload.transferId).manifestPath, manifest);
  return manifest;
}

export function completeIncomingTransfer(
  stateDir: string,
  payload: FileCompletePayload,
  fromStreamId?: string,
): CompletedTransferResult {
  validateTransferId(payload?.transferId);
  const manifest = mustReadTransferManifest(stateDir, payload.transferId);
  if (fromStreamId && manifest.from.streamId !== fromStreamId) {
    throw new Error(`completion sender does not own transfer ${payload.transferId}`);
  }
  if (!manifest.completedAt) {
    if (!Number.isInteger(payload.totalChunks) || !Number.isSafeInteger(payload.size)) {
      throw new Error("invalid completion metadata");
    }
    if (typeof payload.sha256 !== "string" || !SHA256_PATTERN.test(payload.sha256)) {
      throw new Error("invalid completion sha256");
    }
    if (payload.totalChunks !== manifest.totalChunks) {
      throw new Error(`unexpected totalChunks ${payload.totalChunks}; expected ${manifest.totalChunks}`);
    }
    if (manifest.receivedChunks !== manifest.totalChunks) {
      throw new Error(`transfer incomplete: received ${manifest.receivedChunks}/${manifest.totalChunks} chunks`);
    }
    if (manifest.receivedBytes !== manifest.size || payload.size !== manifest.size) {
      throw new Error(`transfer size mismatch: received ${manifest.receivedBytes}, expected ${manifest.size}`);
    }

    const file = sha256File(manifest.tempPath);
    if (file.size !== manifest.size) {
      throw new Error(`transfer size mismatch on disk: ${file.size}, expected ${manifest.size}`);
    }
    if (file.sha256 !== manifest.sha256 || payload.sha256 !== manifest.sha256) {
      throw new Error("transfer sha256 mismatch");
    }

    moveFileExclusive(manifest.tempPath, manifest.savedPath);
    manifest.completedAt = Date.now();
    manifest.updatedAt = manifest.completedAt;
    writeManifest(getTransferPaths(stateDir, payload.transferId).manifestPath, manifest);
  }

  return {
    transferId: manifest.transferId,
    name: manifest.name,
    mimeType: manifest.mimeType,
    kind: manifest.kind,
    size: manifest.size,
    sha256: manifest.sha256,
    savedPath: manifest.savedPath,
  };
}

export function createFileAckPayload(result: CompletedTransferResult): FileAckPayload {
  return {
    transferId: result.transferId,
    ok: true,
    name: result.name,
    mimeType: result.mimeType,
    kind: result.kind,
    size: result.size,
    sha256: result.sha256,
    savedPath: result.savedPath,
  };
}

export function createFailedFileAckPayload(transferId: string, error: unknown): FileAckPayload {
  return {
    transferId,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function readTransferManifest(stateDir: string, transferId: string): IncomingTransferManifest | null {
  const manifestPath = getTransferPaths(stateDir, transferId).manifestPath;
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf8")) as IncomingTransferManifest;
}

/**
 * Remove a transfer that cannot be completed. Sender matching prevents a peer
 * from aborting somebody else's transfer by guessing its id.
 */
export function discardIncomingTransfer(
  stateDir: string,
  transferId: string,
  expectedSender?: string,
): boolean {
  try {
    validateTransferId(transferId);
    const manifest = readTransferManifest(stateDir, transferId);
    if (expectedSender && manifest?.from.streamId !== expectedSender) return false;
    const paths = getTransferPaths(stateDir, transferId);
    rmSync(paths.tempPath, { force: true });
    rmSync(paths.manifestPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function mustReadTransferManifest(stateDir: string, transferId: string): IncomingTransferManifest {
  const manifest = readTransferManifest(stateDir, transferId);
  if (!manifest) {
    throw new Error(`unknown transfer: ${transferId}`);
  }
  return manifest;
}

function getTransferPaths(stateDir: string, transferId: string): TransferPaths {
  validateTransferId(transferId);
  const transfersDir = path.join(path.resolve(stateDir), "transfers");
  const downloadsDir = path.join(path.resolve(stateDir), "downloads");
  return {
    transfersDir,
    downloadsDir,
    manifestPath: path.join(transfersDir, `${transferId}.json`),
    tempPath: path.join(transfersDir, `${transferId}.part`),
  };
}

function writeManifest(manifestPath: string, manifest: IncomingTransferManifest): void {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function chooseSavedPath(downloadsDir: string, safeName: string, transferId: string): string {
  const parsed = path.parse(safeName);
  const base = parsed.name || "download";
  const ext = parsed.ext || "";
  const direct = path.join(downloadsDir, safeName || `download_${transferId}`);
  if (!existsSync(direct)) {
    return direct;
  }
  const tagged = path.join(downloadsDir, `${base}_${transferId}${ext}`);
  if (!existsSync(tagged)) return tagged;
  for (let suffix = 2; suffix < 100_000; suffix += 1) {
    const candidate = path.join(downloadsDir, `${base}_${transferId}_${suffix}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`could not choose a free destination for ${safeName}`);
}

function sanitizeFileName(name: string): string {
  let safe = path.basename(name || "download")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180) || "download";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  return safe;
}

function guessMimeType(name: string, kind: FileTransferKind): string {
  const ext = path.extname(name).toLowerCase();
  const known: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
  };
  return known[ext] ?? (kind === "image" ? "image/*" : "application/octet-stream");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function validateTransferId(transferId: unknown): asserts transferId is string {
  if (typeof transferId !== "string" || !TRANSFER_ID_PATTERN.test(transferId)) {
    throw new Error("invalid transfer id");
  }
}

function validateFileOffer(offer: FileOfferPayload): void {
  if (!offer || typeof offer !== "object") throw new Error("file offer is not an object");
  validateTransferId(offer.transferId);
  if (typeof offer.name !== "string" || !offer.name.trim() || offer.name.length > 1_024 || offer.name.includes("\0")) {
    throw new Error("invalid file name");
  }
  if (typeof offer.mimeType !== "string" || offer.mimeType.length > 256) {
    throw new Error("invalid mime type");
  }
  if (offer.kind !== "file" && offer.kind !== "image") throw new Error("invalid transfer kind");
  if (!Number.isSafeInteger(offer.size) || offer.size < 0 || offer.size > MAX_BASIC_TRANSFER_SIZE) {
    throw new Error(`invalid file size; maximum is ${MAX_BASIC_TRANSFER_SIZE} bytes`);
  }
  if (typeof offer.sha256 !== "string" || !SHA256_PATTERN.test(offer.sha256)) {
    throw new Error("invalid file sha256");
  }
  if (
    !Number.isInteger(offer.chunkSize) ||
    offer.chunkSize < 1_024 ||
    offer.chunkSize > MAX_BASIC_TRANSFER_CHUNK_SIZE
  ) {
    throw new Error("invalid file chunk size");
  }
  if (
    !Number.isInteger(offer.totalChunks) ||
    offer.totalChunks < 0 ||
    offer.totalChunks > MAX_BASIC_TRANSFER_CHUNKS
  ) {
    throw new Error("invalid file chunk count");
  }
  const expected = offer.size === 0 ? 0 : Math.ceil(offer.size / offer.chunkSize);
  if (offer.totalChunks !== expected) {
    throw new Error(`file chunk count ${offer.totalChunks} does not match size/chunkSize (${expected})`);
  }
}

function moveFileExclusive(source: string, destination: string): void {
  try {
    linkSync(source, destination);
    try {
      rmSync(source);
    } catch {
      // The destination is already a complete independent directory entry.
      // A leftover temp file is cleanup debt, not a failed delivery.
    }
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(`destination already exists: ${destination}`);
    if (existsSync(destination)) throw error;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") throw error;
  }

  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  try {
    rmSync(source);
  } catch {
    // See the hard-link path above.
  }
}

function enforceIncomingTransferQuota(stateDir: string, incomingSize: number): void {
  const transfersDir = path.join(path.resolve(stateDir), "transfers");
  if (!existsSync(transfersDir)) return;

  let activeCount = 0;
  let promisedBytes = 0;
  const now = Date.now();
  for (const name of readdirSync(transfersDir)) {
    if (!name.endsWith(".json")) continue;
    const transferId = name.slice(0, -5);
    if (!TRANSFER_ID_PATTERN.test(transferId)) continue;

    let manifest: IncomingTransferManifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(transfersDir, name), "utf8")) as IncomingTransferManifest;
    } catch {
      continue;
    }
    if (manifest.completedAt || !existsSync(path.join(transfersDir, `${transferId}.part`))) continue;
    if (Number.isFinite(manifest.updatedAt) && now - manifest.updatedAt >= INCOMPLETE_TRANSFER_STALE_MS) {
      discardIncomingTransfer(stateDir, transferId);
      continue;
    }

    activeCount += 1;
    promisedBytes += Number.isSafeInteger(manifest.size) && manifest.size >= 0
      ? manifest.size
      : MAX_BASIC_TRANSFER_SIZE;
  }

  if (activeCount >= MAX_INCOMPLETE_TRANSFERS) {
    throw new Error(`too many incomplete file transfers (${activeCount}/${MAX_INCOMPLETE_TRANSFERS})`);
  }
  if (promisedBytes + incomingSize > MAX_INCOMPLETE_TRANSFER_BYTES) {
    throw new Error(
      `incomplete file transfers would exceed the ${MAX_INCOMPLETE_TRANSFER_BYTES}-byte quota`,
    );
  }
}

function sha256File(filePath: string): { sha256: string; size: number } {
  const fd = openSync(filePath, "r");
  try {
    const hash = createHash("sha256");
    const buffer = new Uint8Array(1024 * 1024);
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    return { sha256: hash.digest("hex"), size: position };
  } finally {
    closeSync(fd);
  }
}

export function readSavedTransferBytes(savedPath: string): Uint8Array {
  return new Uint8Array(readFileSync(savedPath));
}

export function getSavedTransferSize(savedPath: string): number {
  return statSync(savedPath).size;
}
