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
  | "history_request";

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
