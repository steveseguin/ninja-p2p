import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
  const bytes = new Uint8Array(readFileSync(resolved));
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

  const normalizedChunkSize = Math.max(1_024, chunkSize);
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

  bridge.bus.send(targetStreamId, "file_offer", offer);

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
    bridge.bus.send(targetStreamId, "file_chunk", payload);
  }

  bridge.bus.send(targetStreamId, "file_complete", {
    transferId,
    totalChunks,
    size: prepared.size,
    sha256: prepared.sha256,
  } satisfies FileCompletePayload);

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
  const paths = getTransferPaths(stateDir, offer.transferId);
  mkdirSync(paths.transfersDir, { recursive: true });
  mkdirSync(paths.downloadsDir, { recursive: true });

  const existing = readTransferManifest(stateDir, offer.transferId);
  if (existing) {
    return existing;
  }

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
): IncomingTransferManifest {
  const manifest = mustReadTransferManifest(stateDir, payload.transferId);
  if (manifest.completedAt) {
    return manifest;
  }
  if (payload.index !== manifest.receivedChunks) {
    throw new Error(`unexpected chunk index ${payload.index}; expected ${manifest.receivedChunks}`);
  }
  if (payload.totalChunks !== manifest.totalChunks) {
    throw new Error(`unexpected totalChunks ${payload.totalChunks}; expected ${manifest.totalChunks}`);
  }

  const bytes = base64ToBytes(payload.data);
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
): CompletedTransferResult {
  const manifest = mustReadTransferManifest(stateDir, payload.transferId);
  if (!manifest.completedAt) {
    if (payload.totalChunks !== manifest.totalChunks) {
      throw new Error(`unexpected totalChunks ${payload.totalChunks}; expected ${manifest.totalChunks}`);
    }
    if (manifest.receivedChunks !== manifest.totalChunks) {
      throw new Error(`transfer incomplete: received ${manifest.receivedChunks}/${manifest.totalChunks} chunks`);
    }
    if (manifest.receivedBytes !== manifest.size || payload.size !== manifest.size) {
      throw new Error(`transfer size mismatch: received ${manifest.receivedBytes}, expected ${manifest.size}`);
    }

    const bytes = new Uint8Array(readFileSync(manifest.tempPath));
    const sha256 = sha256Hex(bytes);
    if (sha256 !== manifest.sha256 || payload.sha256 !== manifest.sha256) {
      throw new Error("transfer sha256 mismatch");
    }

    renameSync(manifest.tempPath, manifest.savedPath);
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

function mustReadTransferManifest(stateDir: string, transferId: string): IncomingTransferManifest {
  const manifest = readTransferManifest(stateDir, transferId);
  if (!manifest) {
    throw new Error(`unknown transfer: ${transferId}`);
  }
  return manifest;
}

function getTransferPaths(stateDir: string, transferId: string): TransferPaths {
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
  return path.join(downloadsDir, `${base}_${transferId}${ext}`);
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name || "download");
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_") || "download";
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

export function readSavedTransferBytes(savedPath: string): Uint8Array {
  return new Uint8Array(readFileSync(savedPath));
}

export function getSavedTransferSize(savedPath: string): number {
  return statSync(savedPath).size;
}
