import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isValidEnvelope, type MessageEnvelope } from "./protocol.js";

export const HANDOFF_SKILL = "handoff-v1";
export const HANDOFF_TTL_MS = 86_400_000;

export type HandoffPayload = { request: string; expiresAt: number };
export type HandoffStatus = {
  requestId: string;
  peer: string;
  senderInstanceId: string;
  status: "queued" | "awaiting_receipt" | "stored" | "expired";
  expiresAt: number;
  attempts: number;
  nextAttemptAt: number;
  waitingFor?: "peer_connection" | "peer_support";
  receipt?: MessageEnvelope;
};
type StoredHandoff = { envelope: MessageEnvelope; receivedAt: number; path: string };

export function isHandoffRequest(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(JSON.stringify(value), "utf8") <= 32_000;
}

export function isHandoff(envelope: MessageEnvelope): envelope is MessageEnvelope & { payload: HandoffPayload } {
  if (!isValidEnvelope(envelope) || envelope.type !== "handoff" || !envelope.to || envelope.topic !== null) return false;
  const payload = envelope.payload as Partial<HandoffPayload> | null;
  return !!payload && isHandoffRequest(payload.request) && Number.isSafeInteger(payload.expiresAt) &&
    payload.expiresAt! > envelope.ts && payload.expiresAt! - envelope.ts <= HANDOFF_TTL_MS;
}

/** One immutable record is the inbox entry AND the deduplication ledger. */
export function storeHandoff(stateDir: string, envelope: MessageEnvelope, now = Date.now()): "new" | "duplicate" | "rejected" {
  if (!isHandoff(envelope) || envelope.ts > now + 60_000) return "rejected";
  const file = handoffFile(stateDir, envelope);
  if (existsSync(file)) {
    const stored = readJson(file) as Partial<StoredHandoff> | null;
    if (!stored || !isValidEnvelope(stored.envelope) || !isHandoff(stored.envelope) ||
      typeof stored.receivedAt !== "number" || !Number.isFinite(stored.receivedAt)) {
      throw new Error("invalid stored handoff; preserve and repair the local record before acknowledging it");
    }
    const original = stored.envelope;
    return original.id === envelope.id && original.from.streamId === envelope.from.streamId &&
      original.from.instanceId === envelope.from.instanceId && original.to === envelope.to && original.ts === envelope.ts &&
      original.payload.request === envelope.payload.request && original.payload.expiresAt === envelope.payload.expiresAt
      ? "duplicate" : "rejected";
  }
  if (envelope.payload.expiresAt <= now) return "rejected";
  writeJson(file, { envelope, receivedAt: now });
  return "new";
}

export function listHandoffInbox(stateDir: string): StoredHandoff[] {
  const dir = path.join(path.resolve(stateDir), "handoffs");
  if (!existsSync(dir)) return [];
  const items: StoredHandoff[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    if (existsSync(`${file}.read`)) continue;
    const item = readJson(file) as Partial<StoredHandoff> | null;
    if (item && isValidEnvelope(item.envelope) && isHandoff(item.envelope) && typeof item.receivedAt === "number" &&
      Number.isFinite(item.receivedAt) && file === handoffFile(stateDir, item.envelope)) {
      items.push({ envelope: item.envelope, receivedAt: item.receivedAt, path: file });
    }
  }
  return items;
}

/** Atomic claim: simultaneous CLI readers cannot consume the same handoff. */
export function claimHandoff(stateDir: string, item: StoredHandoff): boolean {
  if (item.path !== handoffFile(stateDir, item.envelope)) throw new Error("invalid handoff record path");
  try {
    mkdirSync(`${item.path}.read`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function readHandoffStatus(stateDir: string, requestId: string, peer: string): HandoffStatus | null {
  const value = readJson(statusFile(stateDir, requestId, peer)) as HandoffStatus | null;
  if (!value || value.requestId !== requestId || value.peer !== peer || typeof value.senderInstanceId !== "string" ||
    !["queued", "awaiting_receipt", "stored", "expired"].includes(value.status) ||
    !Number.isSafeInteger(value.expiresAt) || !Number.isSafeInteger(value.attempts) || value.attempts < 0 ||
    !Number.isSafeInteger(value.nextAttemptAt)) return null;
  if (value.status === "stored") {
    if (!isValidEnvelope(value.receipt) || !isHandoffReceipt(value.receipt) || value.receipt.from.streamId !== peer) return null;
    const payload = value.receipt.payload as { messageId: string; senderInstanceId: string };
    if (payload.messageId !== requestId || payload.senderInstanceId !== value.senderInstanceId) return null;
  }
  return value;
}

export function writeHandoffStatus(stateDir: string, status: HandoffStatus): void {
  writeJson(statusFile(stateDir, status.requestId, status.peer), status);
}

export function initialHandoffStatus(envelope: MessageEnvelope & { payload: HandoffPayload }): HandoffStatus {
  return {
    requestId: envelope.id, peer: envelope.to!, senderInstanceId: envelope.from.instanceId,
    status: "queued", expiresAt: envelope.payload.expiresAt, attempts: 0, nextAttemptAt: 0,
  };
}

export function isHandoffReceipt(envelope: MessageEnvelope): boolean {
  if (!isValidEnvelope(envelope) || envelope.type !== "ack" || !envelope.payload || typeof envelope.payload !== "object") return false;
  const payload = envelope.payload as Record<string, unknown>;
  return payload.forType === "handoff" && payload.receipt === "stored" &&
    typeof payload.messageId === "string" && typeof payload.senderInstanceId === "string";
}

/** Match the exact sender instance as well as the request ID and reporting peer. */
export function acceptHandoffReceipt(stateDir: string, envelope: MessageEnvelope, streamId: string): boolean {
  if (!isHandoffReceipt(envelope) || envelope.to !== streamId || envelope.topic !== null) return false;
  const payload = envelope.payload as { messageId: string; senderInstanceId: string };
  const status = readHandoffStatus(stateDir, payload.messageId, envelope.from.streamId);
  if (!status || status.senderInstanceId !== payload.senderInstanceId) return false;
  if (status.status !== "stored") {
    const stored: HandoffStatus = { ...status, status: "stored", receipt: envelope };
    delete stored.waitingFor;
    writeHandoffStatus(stateDir, stored);
  }
  return true;
}

function handoffFile(stateDir: string, envelope: MessageEnvelope): string {
  return path.join(path.resolve(stateDir), "handoffs", `${hash([envelope.from.streamId, envelope.from.instanceId, envelope.id])}.json`);
}

function statusFile(stateDir: string, id: string, peer: string): string {
  return path.join(path.resolve(stateDir), "handoff-status", `${hash([id, peer])}.json`);
}

function hash(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function readJson(file: string): unknown {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      if (!isTransientWindowsLock(error, attempt)) throw error;
      pause(20);
    }
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value));
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temp, file); return; }
      catch (error) {
        if (!isTransientWindowsLock(error, attempt)) throw error;
        pause(20);
      }
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Windows readers and scanners can briefly lock a file being replaced; retry for at most 100 ms. */
function isTransientWindowsLock(error: unknown, attempt: number): boolean {
  return process.platform === "win32" && attempt < 5 &&
    ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
