import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createMessageId,
  createEnvelope,
  isValidEnvelope,
  type AgentAsk,
  type AgentProfile,
  type FileTransferKind,
  type MessageEnvelope,
  type MessageType,
  type PeerIdentity,
  type SharedFolderSummary,
} from "./protocol.js";
import type { SharedFolderConfig } from "./shared-folders.js";
import { claimHandoff, HANDOFF_TTL_MS, isHandoff, isHandoffRequest, listHandoffInbox, readHandoffStatus } from "./handoff.js";

export type AgentSessionState = {
  room: string;
  streamId: string;
  name: string;
  role: string;
  stateDir: string;
  pid: number;
  connected: boolean;
  transport?: "webrtc" | "http";
  skills: string[];
  topics: string[];
  agentProfile: AgentProfile | null;
  sharedFolders: SharedFolderConfig[];
  startedAt: number;
  updatedAt: number;
};

export type QueuedAgentAction = { envelope?: MessageEnvelope } & (
  | { id: string; createdAt: number; kind: "chat"; text: string }
  | { id: string; createdAt: number; kind: "dm"; target: string; text: string }
  | { id: string; createdAt: number; kind: "handoff"; target: string; request: string }
  | { id: string; createdAt: number; kind: "send_file"; target: string; filePath: string; transferKind: FileTransferKind }
  | { id: string; createdAt: number; kind: "command"; target: string; command: string; args?: unknown }
  | { id: string; createdAt: number; kind: "response"; target: string; requestId: string; result?: unknown; error?: string }
  | { id: string; createdAt: number; kind: "event"; topic: string; eventKind: string; data?: unknown }
  | { id: string; createdAt: number; kind: "status"; status: string; detail?: string });

export type QueuedAgentActionInput =
  | { kind: "chat"; text: string }
  | { kind: "dm"; target: string; text: string }
  | { kind: "handoff"; target: string; request: string }
  | { kind: "send_file"; target: string; filePath: string; transferKind: FileTransferKind }
  | { kind: "command"; target: string; command: string; args?: unknown }
  | { kind: "response"; target: string; requestId: string; result?: unknown; error?: string }
  | { kind: "event"; topic: string; eventKind: string; data?: unknown }
  | { kind: "status"; status: string; detail?: string };

export type InboxMessage = {
  envelope: MessageEnvelope;
  receivedAt: number;
  path: string;
};

export type PeerInboxSummary = {
  streamId: string;
  name: string;
  role: string;
  connected: boolean;
  status: string;
  statusDetail: string;
  summary: string | null;
  can: string[];
  asks: AgentAsk[];
  shares: SharedFolderSummary[];
};

export type InboxSummary = {
  connected: boolean;
  pending: number;
  queued: number;
  room: string | null;
  streamId: string | null;
  stale: boolean;
  peersKnown: number;
  peersConnected: number;
  senders: Array<{ streamId: string; name: string; count: number }>;
  types: Array<{ type: string; count: number }>;
  commands: Array<{ name: string; count: number }>;
  events: Array<{ kind: string; count: number }>;
  peers: PeerInboxSummary[];
};

const SESSION_FILE = "session.json";
const PEERS_FILE = "peers.json";
let lastQueuedActionAt = 0;

type StatePaths = {
  stateDir: string;
  inboxDir: string;
  archiveDir: string;
  outboxDir: string;
  sessionFile: string;
  peersFile: string;
};

export function ensureAgentState(stateDir: string): StatePaths {
  const resolved = path.resolve(stateDir);
  const paths: StatePaths = {
    stateDir: resolved,
    inboxDir: path.join(resolved, "inbox"),
    archiveDir: path.join(resolved, "archive"),
    outboxDir: path.join(resolved, "outbox"),
    sessionFile: path.join(resolved, SESSION_FILE),
    peersFile: path.join(resolved, PEERS_FILE),
  };

  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.inboxDir, { recursive: true });
  mkdirSync(paths.archiveDir, { recursive: true });
  mkdirSync(paths.outboxDir, { recursive: true });
  return paths;
}

export function writeAgentSession(stateDir: string, session: AgentSessionState): void {
  const paths = ensureAgentState(stateDir);
  writeJsonAtomic(paths.sessionFile, session);
}

export function readAgentSession(stateDir: string): AgentSessionState | null {
  const paths = ensureAgentState(stateDir);
  return readJsonFile<AgentSessionState>(paths.sessionFile);
}

export function writePeersSnapshot(stateDir: string, peers: unknown): void {
  const paths = ensureAgentState(stateDir);
  writeJsonAtomic(paths.peersFile, peers);
}

export function readPeersSnapshot(stateDir: string): unknown {
  const paths = ensureAgentState(stateDir);
  return readJsonFile(paths.peersFile) ?? [];
}

export function queueAgentAction(
  stateDir: string,
  action: QueuedAgentActionInput,
): QueuedAgentAction {
  if (action.kind === "handoff" && (!isHandoffRequest(action.request) || !action.target ||
    action.target.length > 128 || action.target.includes("\0"))) throw new Error("invalid handoff target or request");
  const paths = ensureAgentState(stateDir);
  const queued = {
    ...action,
    id: createMessageId(),
    // Date.now() can repeat during a burst. Keep timestamps monotonic so the
    // filesystem outbox remains FIFO even when several actions share a tick.
    createdAt: nextQueuedActionTimestamp(),
  } as QueuedAgentAction;
  const filename = `${queued.createdAt}_${queued.id}.json`;
  writeJsonAtomic(path.join(paths.outboxDir, filename), queued);
  return queued;
}

export function listQueuedAgentActions(stateDir: string): Array<{ action: QueuedAgentAction; path: string }> {
  const paths = ensureAgentState(stateDir);
  const entries = listJsonFiles(paths.outboxDir);
  return entries
    .map((file) => {
      const action = readJsonFile<QueuedAgentAction>(file);
      return isQueuedAgentAction(action) ? { action, path: file } : null;
    })
    .filter((item): item is { action: QueuedAgentAction; path: string } => item !== null)
    .sort((a, b) => a.action.createdAt - b.action.createdAt);
}

export function removeQueuedAgentAction(filePath: string): void {
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

function isQueuedAgentAction(value: unknown): value is QueuedAgentAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  const text = (key: string): boolean => typeof action[key] === "string";
  const requiredText = (key: string): boolean => text(key) && (action[key] as string).length > 0;
  if (!requiredText("id") || typeof action.createdAt !== "number" || !Number.isFinite(action.createdAt)) return false;
  if (action.envelope != null) {
    if (!isValidEnvelope(action.envelope)) return false;
    const type = action.kind === "dm" ? "chat" : action.kind === "command" ? "command"
      : action.kind === "response" ? "command_response" : action.kind === "handoff" ? "handoff" : null;
    if (type && (action.envelope.to !== action.target || action.envelope.type !== type || action.envelope.id !== action.id)) {
      return false;
    }
    if (action.kind === "handoff" && (!isHandoff(action.envelope) || action.envelope.ts !== action.createdAt ||
      action.envelope.payload.request !== action.request)) return false;
  }
  switch (action.kind) {
    case "chat": return text("text");
    case "dm": return requiredText("target") && text("text");
    case "handoff": return requiredText("target") && isHandoffRequest(action.request);
    case "command": return requiredText("target") && requiredText("command");
    case "response": return requiredText("target") && requiredText("requestId") &&
      (action.error == null || text("error"));
    case "send_file": return requiredText("target") && requiredText("filePath") &&
      (action.transferKind === "file" || action.transferKind === "image");
    case "event": return requiredText("topic") && requiredText("eventKind");
    case "status": return text("status") && (action.detail == null || text("detail"));
    default: return false;
  }
}

/** Persist a direct action's wire identity before its first send attempt. */
export function prepareQueuedAgentEnvelope(
  filePath: string,
  action: QueuedAgentAction,
  identity: PeerIdentity,
): MessageEnvelope | null {
  if (action.kind !== "dm" && action.kind !== "command" && action.kind !== "response" && action.kind !== "handoff") return null;
  if (action.envelope) return action.envelope;
  const type = action.kind === "dm" ? "chat" : action.kind === "command" ? "command" : action.kind === "handoff" ? "handoff" : "command_response";
  const payload = action.kind === "dm" ? { text: action.text }
    : action.kind === "command" ? { command: action.command, args: action.args }
    : action.kind === "handoff" ? { request: action.request, expiresAt: action.createdAt + HANDOFF_TTL_MS }
    : action.error ? { requestId: action.requestId, ok: false, error: action.error }
    : { requestId: action.requestId, ok: true, result: action.result ?? null };
  const envelope = {
    ...createEnvelope(identity, type, payload, { to: action.target }),
    id: action.id,
    ts: action.createdAt,
  };
  writeJsonAtomic(filePath, { ...action, envelope });
  return envelope;
}

export function storeInboxMessage(stateDir: string, envelope: MessageEnvelope): InboxMessage {
  const paths = ensureAgentState(stateDir);
  // Wire IDs are opaque strings, not safe filesystem components. Include the
  // sender so two peers using the same ID cannot suppress each other's mail.
  const key = createHash("sha256")
    .update(JSON.stringify([envelope.from.streamId, envelope.from.instanceId, envelope.id]))
    .digest("hex");
  const filename = `${envelope.ts}_${key}.json`;
  const filePath = path.join(paths.inboxDir, filename);
  const record = {
    envelope,
    receivedAt: Date.now(),
  };
  if (!existsSync(filePath)) {
    writeJsonAtomic(filePath, record);
  }
  return {
    envelope,
    receivedAt: record.receivedAt,
    path: filePath,
  };
}

export function listInboxMessages(stateDir: string): InboxMessage[] {
  const paths = ensureAgentState(stateDir);
  return listJsonFiles(paths.inboxDir)
    .map((file) => {
      const item = readJsonFile<{ envelope: MessageEnvelope; receivedAt: number }>(file);
      return item && isValidEnvelope(item.envelope) ? { ...item, path: file } : null;
    })
    .filter((item): item is InboxMessage => item !== null)
    .concat(listHandoffInbox(stateDir))
    .sort((a, b) => a.envelope.ts - b.envelope.ts);
}

export function takeInboxMessages(stateDir: string, count = 20, peek = false): InboxMessage[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("inbox count must be a non-negative safe integer");
  }
  const paths = ensureAgentState(stateDir);
  const items = listInboxMessages(stateDir);
  const selected = items.slice(0, count);
  if (peek) return selected;
  const taken: InboxMessage[] = [];
  for (const item of items) {
    if (taken.length >= selected.length) break;
    if (item.envelope.type === "handoff" && path.dirname(item.path) === path.join(paths.stateDir, "handoffs")) {
      if (claimHandoff(stateDir, item)) taken.push(item);
      continue;
    }
    const target = path.join(paths.archiveDir, path.basename(item.path));
    try {
      renameSync(item.path, target);
    } catch (error) {
      // Listing is a snapshot. Another reader may already have claimed this
      // message; keep looking for unclaimed mail instead of failing the batch.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(item.path)) continue;
      throw error;
    }
    item.path = target;
    taken.push(item);
  }
  return taken;
}

/** Explicit archive maintenance. Age uses the local file's modification time. */
export function pruneAgentArchive(stateDir: string, options: { olderThanDays: number; keep: number; apply?: boolean }) {
  for (const [key, value] of [["olderThanDays", options.olderThanDays], ["keep", options.keep]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${key} must be a non-negative safe integer`);
  }
  const archiveDir = path.join(path.resolve(stateDir), "archive");
  const result = { dryRun: options.apply !== true, candidates: [] as string[], removed: [] as string[] };
  if (!existsSync(archiveDir)) return result;
  if (lstatSync(archiveDir).isSymbolicLink()) throw new Error("refusing to prune a linked archive directory");
  const cutoff = Date.now() - options.olderThanDays * 86_400_000;
  const records = listJsonFiles(archiveDir).flatMap(file => {
    try {
      const stats = lstatSync(file);
      if (!stats.isFile() || stats.isSymbolicLink()) return [];
      const item = readJsonFile<{ envelope: unknown }>(file);
      return item && isValidEnvelope(item.envelope) ? [{ file, stats }] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }).sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs || a.file.localeCompare(b.file));
  for (const { file, stats } of records.slice(options.keep)) {
    if (stats.mtimeMs >= cutoff) continue;
    result.candidates.push(file);
    if (options.apply !== true) continue;
    try {
      // A record replaced since the preview within this call belongs to a later pass.
      const current = lstatSync(file);
      if (!current.isFile() || current.ino !== stats.ino || current.mtimeMs !== stats.mtimeMs || current.size !== stats.size) continue;
      rmSync(file);
      result.removed.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}

/** Correlate existing peer reports without consuming mail or retrying work. */
export function getAgentReceipt(stateDir: string, requestId: string, peer: string) {
  if (!requestId || !peer) throw new Error("receipt requires a request ID and peer");
  const root = path.resolve(stateDir);
  const receipts: MessageEnvelope[] = [];
  const seen = new Set<string>();
  for (const dir of ["inbox", "archive"]) {
    for (const file of listJsonFiles(path.join(root, dir))) {
      const item = readJsonFile<{ envelope: unknown }>(file);
      if (!item || !isValidEnvelope(item.envelope)) continue;
      const envelope = item.envelope;
      if (envelope.from.streamId !== peer || !envelope.payload || typeof envelope.payload !== "object") continue;
      const payload = envelope.payload as Record<string, unknown>;
      const matches = envelope.type === "ack" ? payload.messageId === requestId
        : envelope.type === "command_response" && payload.requestId === requestId && typeof payload.ok === "boolean";
      const key = JSON.stringify([envelope.from.streamId, envelope.from.instanceId, envelope.id]);
      if (!matches || seen.has(key)) continue;
      seen.add(key);
      receipts.push(envelope);
    }
  }
  receipts.sort((a, b) => a.ts - b.ts);
  const queued = listQueuedAgentActions(stateDir).some(({ action }) =>
    action.id === requestId && "target" in action && action.target === peer);
  const handoff = readHandoffStatus(stateDir, requestId, peer);
  if (handoff) {
    if (handoff.receipt && !receipts.some(message => message.id === handoff.receipt!.id)) receipts.push(handoff.receipt);
    receipts.sort((a, b) => a.ts - b.ts);
    return { requestId, peer, status: receipts.some(message => message.type === "command_response") ? "responded" : handoff.status,
      queued, receipts, delivery: { status: handoff.status, attempts: handoff.attempts, expiresAt: handoff.expiresAt,
        ...(handoff.waitingFor ? { waitingFor: handoff.waitingFor } : {}) } };
  }
  // Return every response, including failures/conflicts; a peer report is not proof of execution.
  const status = receipts.some(message => message.type === "command_response") ? "responded"
    : receipts.length ? "acknowledged" : queued ? "queued" : "unknown";
  return { requestId, peer, status, queued, receipts };
}

export function getInboxSummary(stateDir: string): InboxSummary {
  const paths = ensureAgentState(stateDir);
  const session = readJsonFile<AgentSessionState>(paths.sessionFile);
  const messages = listInboxMessages(stateDir);
  const queued = listQueuedAgentActions(stateDir).length;
  const peers = normalizePeers(readJsonFile<unknown>(paths.peersFile));
  const senders = new Map<string, { streamId: string; name: string; count: number }>();
  const types = new Map<string, number>();
  const commands = new Map<string, number>();
  const events = new Map<string, number>();

  for (const item of messages) {
    const key = item.envelope.from.streamId;
    const sender = senders.get(key) ?? {
      streamId: item.envelope.from.streamId,
      name: item.envelope.from.name,
      count: 0,
    };
    sender.count += 1;
    senders.set(key, sender);

    types.set(item.envelope.type, (types.get(item.envelope.type) ?? 0) + 1);

    if (item.envelope.type === "command") {
      const commandName = getStringField(item.envelope.payload, "command");
      if (commandName) {
        commands.set(commandName, (commands.get(commandName) ?? 0) + 1);
      }
    }

    if (item.envelope.type === "event") {
      const eventKind = getStringField(item.envelope.payload, "kind");
      if (eventKind) {
        events.set(eventKind, (events.get(eventKind) ?? 0) + 1);
      }
    }
  }

  const updatedAt = session?.updatedAt ?? 0;
  const stale = updatedAt > 0 ? Date.now() - updatedAt > 20_000 : true;

  return {
    connected: session?.connected === true && !stale,
    pending: messages.length,
    queued,
    room: session?.room ?? null,
    streamId: session?.streamId ?? null,
    stale,
    peersKnown: peers.length,
    peersConnected: peers.filter((peer) => peer.connected).length,
    senders: [...senders.values()].sort((a, b) => b.count - a.count),
    types: sortTypeCounts(types),
    commands: sortCommandCounts(commands),
    events: sortEventCounts(events),
    peers,
  };
}

export function isInboxWorthy(type: MessageType): boolean {
  return ![
    "announce",
    "skill_update",
    "ping",
    "pong",
    "history_request",
    "file_offer",
    "file_chunk",
    "file_complete",
    "file_ack",
    // Swarm traffic is machine-to-machine and high volume. A single file would
    // otherwise write thousands of inbox entries and bury every real message.
    "swarm_offer",
    "swarm_manifest_request",
    "swarm_manifest_page",
    "swarm_announce",
    "swarm_request",
    "swarm_chunk",
    "swarm_have",
  ].includes(type);
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .sort();
}

function nextQueuedActionTimestamp(): number {
  lastQueuedActionAt = Math.max(Date.now(), lastQueuedActionAt + 1);
  return lastQueuedActionAt;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.${createMessageId()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, filePath);
        return;
      } catch (error) {
        // Windows readers/scanners can briefly deny replacement. Keep the old
        // file intact and retry for at most 100 ms; permanent errors still fail.
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || attempt >= 5 ||
            !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* preserve the original error */ }
  }
}

function getStringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function sortTypeCounts(map: Map<string, number>): Array<{ type: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => ({ type, count }));
}

function sortCommandCounts(map: Map<string, number>): Array<{ name: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

function sortEventCounts(map: Map<string, number>): Array<{ kind: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({ kind, count }));
}

function normalizePeers(peers: unknown): PeerInboxSummary[] {
  if (!Array.isArray(peers)) return [];
  return peers
    .map((peer) => normalizePeer(peer))
    .filter((peer): peer is PeerInboxSummary => peer !== null)
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.streamId.localeCompare(b.streamId));
}

function normalizePeer(peer: unknown): PeerInboxSummary | null {
  if (typeof peer !== "object" || peer === null) return null;
  const data = peer as Record<string, unknown>;
  const streamId = getStringLike(data.streamId);
  if (!streamId) return null;

  const agentProfile = (typeof data.agentProfile === "object" && data.agentProfile !== null)
    ? data.agentProfile as Record<string, unknown>
    : null;

  return {
    streamId,
    name: getStringLike(data.name) ?? streamId,
    role: getStringLike(data.role) ?? "unknown",
    connected: data.connected === true,
    status: getStringLike(data.status) ?? "unknown",
    statusDetail: getStringLike(data.statusDetail) ?? "",
    summary: getStringLike(agentProfile?.summary) ?? null,
    can: normalizeStringArray(agentProfile?.can),
    asks: normalizeAgentAsks(agentProfile?.asks),
    shares: normalizeSharedFolders(agentProfile?.shares),
  };
}

function normalizeAgentAsks(value: unknown): AgentAsk[] {
  if (!Array.isArray(value)) return [];
  const asks: AgentAsk[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const ask = item as Record<string, unknown>;
    const name = getStringLike(ask.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const normalized: AgentAsk = {
      name,
      description: getStringLike(ask.description) ?? `${name} command`,
    };
    const via = getStringLike(ask.via);
    if (via === "command" || via === "chat" || via === "event") {
      normalized.via = via;
    }
    const example = getStringLike(ask.example);
    if (example) normalized.example = example;
    asks.push(normalized);
  }

  return asks;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => getStringLike(item))
    .filter((item): item is string => Boolean(item)))];
}

function normalizeSharedFolders(value: unknown): SharedFolderSummary[] {
  if (!Array.isArray(value)) return [];
  const shares: SharedFolderSummary[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const share = item as Record<string, unknown>;
    const name = getStringLike(share.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const normalized: SharedFolderSummary = { name };
    const description = getStringLike(share.description);
    if (description) normalized.description = description;
    shares.push(normalized);
  }

  return shares;
}

function getStringLike(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
