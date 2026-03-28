import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  createMessageId,
  type AgentAsk,
  type AgentProfile,
  type FileTransferKind,
  type MessageEnvelope,
  type MessageType,
  type SharedFolderSummary,
} from "./protocol.js";
import type { SharedFolderConfig } from "./shared-folders.js";

export type AgentSessionState = {
  room: string;
  streamId: string;
  name: string;
  role: string;
  stateDir: string;
  pid: number;
  connected: boolean;
  skills: string[];
  topics: string[];
  agentProfile: AgentProfile | null;
  sharedFolders: SharedFolderConfig[];
  startedAt: number;
  updatedAt: number;
};

export type QueuedAgentAction =
  | { id: string; createdAt: number; kind: "chat"; text: string }
  | { id: string; createdAt: number; kind: "dm"; target: string; text: string }
  | { id: string; createdAt: number; kind: "send_file"; target: string; filePath: string; transferKind: FileTransferKind }
  | { id: string; createdAt: number; kind: "command"; target: string; command: string; args?: unknown }
  | { id: string; createdAt: number; kind: "response"; target: string; requestId: string; result?: unknown; error?: string }
  | { id: string; createdAt: number; kind: "event"; topic: string; eventKind: string; data?: unknown }
  | { id: string; createdAt: number; kind: "status"; status: string; detail?: string };

export type QueuedAgentActionInput =
  | { kind: "chat"; text: string }
  | { kind: "dm"; target: string; text: string }
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
  const paths = ensureAgentState(stateDir);
  const queued = {
    ...action,
    id: createMessageId(),
    createdAt: Date.now(),
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
      return action ? { action, path: file } : null;
    })
    .filter((item): item is { action: QueuedAgentAction; path: string } => item !== null)
    .sort((a, b) => a.action.createdAt - b.action.createdAt);
}

export function removeQueuedAgentAction(filePath: string): void {
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

export function storeInboxMessage(stateDir: string, envelope: MessageEnvelope): InboxMessage {
  const paths = ensureAgentState(stateDir);
  const filename = `${envelope.ts}_${envelope.id}.json`;
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
      return item ? { ...item, path: file } : null;
    })
    .filter((item): item is InboxMessage => item !== null)
    .sort((a, b) => a.envelope.ts - b.envelope.ts);
}

export function takeInboxMessages(stateDir: string, count = 20, peek = false): InboxMessage[] {
  const paths = ensureAgentState(stateDir);
  const items = listInboxMessages(stateDir).slice(0, count);
  if (!peek) {
    for (const item of items) {
      const target = path.join(paths.archiveDir, path.basename(item.path));
      renameSync(item.path, target);
      item.path = target;
    }
  }
  return items;
}

export function getInboxSummary(stateDir: string): InboxSummary {
  const paths = ensureAgentState(stateDir);
  const session = readJsonFile<AgentSessionState>(paths.sessionFile);
  const messages = listInboxMessages(stateDir);
  const queued = listQueuedAgentActions(stateDir).length;
  const peers = normalizePeers(readJsonFile<unknown[]>(paths.peersFile) ?? []);
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
  ].includes(type);
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .sort();
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
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
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

function normalizePeers(peers: unknown[]): PeerInboxSummary[] {
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
