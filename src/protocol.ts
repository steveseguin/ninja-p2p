/**
 * P2P Message Protocol
 *
 * Defines the wire format for all messages exchanged over VDO.Ninja
 * WebRTC data channels. This module has zero dependencies on stevesbot
 * internals — it can be extracted and reused by any bot.
 */

import { randomBytes, randomUUID } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type MessageType =
  | "chat"
  | "announce"
  | "skill_update"
  | "command"
  | "command_response"
  | "file_offer"
  | "file_chunk"
  | "file_complete"
  | "file_ack"
  | "event"
  | "ping"
  | "pong"
  | "ack"
  | "history_replay"
  | "history_request"
  // Swarm transfer. High volume and machine-only: these must never reach an
  // agent inbox, or a single file would bury every real message.
  | "swarm_offer"
  | "swarm_announce"
  | "swarm_request"
  | "swarm_chunk"
  | "swarm_have";

/**
 * Messages that are only worth delivering right now.
 *
 * Swarm traffic is high volume and time-sensitive: a chunk request replayed
 * from an offline queue minutes later asks for something the requester already
 * has, and a history ring full of chunk requests has evicted every real message
 * a peer asking for history actually wanted. Neither is retained or replayed —
 * anything missed is re-announced on the next interval.
 */
export const TRANSIENT_MESSAGE_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  "swarm_offer",
  "swarm_announce",
  "swarm_request",
  "swarm_chunk",
  "swarm_have",
]);

export function isTransientType(type: MessageType): boolean {
  return TRANSIENT_MESSAGE_TYPES.has(type);
}

export type PeerIdentity = {
  streamId: string;
  role: string;
  name: string;
  instanceId: string;
};

export type AgentAsk = {
  name: string;
  description: string;
  via?: "command" | "chat" | "event";
  example?: string;
};

export type SharedFolderSummary = {
  name: string;
  description?: string;
};

export type AgentProfile = {
  runtime?: string;
  provider?: string;
  model?: string;
  summary?: string;
  workspace?: string;
  can?: string[];
  asks?: AgentAsk[];
  shares?: SharedFolderSummary[];
};

/** Announces that a file exists in the swarm and describes how it is chunked. */
export type SwarmOfferPayload = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  chunkHashes: string[];
};

/** A peer's full chunk bitfield, base64 encoded. */
export type SwarmAnnouncePayload = {
  fileId: string;
  totalChunks: number;
  chunks: string;
};

export type SwarmRequestPayload = {
  fileId: string;
  index: number;
  /**
   * Set when the requester can receive the chunk as raw bytes on the binary
   * lane. Carrying it on the request rather than negotiating up front means
   * there is no capability table to keep in sync and no window where a peer
   * that just joined is assumed to be one thing or the other — each request
   * states how its own reply should come back.
   */
  bin?: 1;
};

export type SwarmChunkPayload = {
  fileId: string;
  index: number;
  data: string;
};

/** Incremental "I now hold these chunks", so peers learn without a full re-announce. */
export type SwarmHavePayload = {
  fileId: string;
  /** Batched indexes. Preferred; one message can carry a whole burst. */
  indexes?: number[];
  /** Single index, kept so a peer running an older build is still understood. */
  index?: number;
};

export type FileTransferKind = "file" | "image";

export type FileOfferPayload = {
  transferId: string;
  name: string;
  mimeType: string;
  kind: FileTransferKind;
  size: number;
  sha256: string;
  chunkSize: number;
  totalChunks: number;
};

export type FileChunkPayload = {
  transferId: string;
  index: number;
  totalChunks: number;
  data: string;
};

export type FileCompletePayload = {
  transferId: string;
  totalChunks: number;
  size: number;
  sha256: string;
};

export type FileAckPayload = {
  transferId: string;
  ok: boolean;
  name?: string;
  mimeType?: string;
  kind?: FileTransferKind;
  size?: number;
  sha256?: string;
  savedPath?: string;
  error?: string;
};

export type MessageEnvelope = {
  v: 1;
  id: string;
  type: MessageType;
  from: PeerIdentity;
  to: string | null;
  topic: string | null;
  ts: number;
  payload: unknown;
};

export type AnnouncePayload = {
  skills: string[];
  status: string;
  statusDetail?: string;
  version: string;
  topics: string[];
  agent?: AgentProfile;
};

export type SkillUpdatePayload = {
  skills: string[];
  status: string;
  statusDetail?: string;
  agent?: AgentProfile;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a short unique message ID. */
export function createMessageId(): string {
  return randomBytes(12).toString("base64url");
}

/** Generate a unique instance ID (per-process, distinguishes restarts). */
export function createInstanceId(): string {
  return randomUUID().slice(0, 8);
}

/** Generate a cryptographically random room name. */
export function generateRoomName(): string {
  return "clawd_" + randomBytes(16).toString("hex");
}

/** Create a full message envelope. */
export function createEnvelope(
  from: PeerIdentity,
  type: MessageType,
  payload: unknown,
  options?: { to?: string | null; topic?: string | null },
): MessageEnvelope {
  return {
    v: 1,
    id: createMessageId(),
    type,
    from,
    to: options?.to ?? null,
    topic: options?.topic ?? null,
    ts: Date.now(),
    payload,
  };
}

/** Validate that a received object looks like a MessageEnvelope. */
export function isValidEnvelope(data: unknown): data is MessageEnvelope {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.v === 1 &&
    typeof d.id === "string" &&
    typeof d.type === "string" &&
    typeof d.from === "object" &&
    d.from !== null &&
    typeof (d.from as Record<string, unknown>).streamId === "string" &&
    typeof d.ts === "number"
  );
}

/** Parse raw data received from a data channel into an envelope. Returns null on failure. */
export function parseEnvelope(raw: unknown): MessageEnvelope | null {
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (isValidEnvelope(data)) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Wrap a payload into a sendable JSON object.
 * The VDO.Ninja SDK sends objects via sendData — this ensures our envelope
 * is the top-level object sent over the wire.
 */
export function envelopeToWire(envelope: MessageEnvelope): object {
  return { ...envelope };
}
