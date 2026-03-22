/**
 * Peer Registry
 *
 * Tracks all known peers in the VDO.Ninja room: their identity, skills,
 * status, and connection state. Emits events on changes so other layers
 * (MessageBus, dashboard) can react.
 *
 * Zero dependencies on stevesbot internals.
 */

import { EventEmitter } from "node:events";
import type { AnnouncePayload, PeerIdentity, SkillUpdatePayload } from "./protocol.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type PeerRecord = {
  streamId: string;
  uuid: string;
  identity: PeerIdentity | null;
  skills: string[];
  status: string;
  statusDetail: string;
  topics: string[];
  version: string;
  connectedAt: number;
  lastSeenAt: number;
  connected: boolean;
};

export interface PeerRegistryEvents {
  "peer:join": (peer: PeerRecord) => void;
  "peer:leave": (peer: PeerRecord) => void;
  "peer:update": (peer: PeerRecord, field: string) => void;
}

// ── Class ────────────────────────────────────────────────────────────────────

export class PeerRegistry extends EventEmitter {
  /** streamId -> PeerRecord */
  private readonly peers = new Map<string, PeerRecord>();
  /** uuid -> streamId (reverse lookup, filled after announce) */
  private readonly uuidToStream = new Map<string, string>();

  /** Add or re-activate a peer when a WebRTC connection opens. */
  addPeer(streamId: string, uuid: string): PeerRecord {
    const existing = this.peers.get(streamId);
    if (existing) {
      existing.uuid = uuid;
      existing.connected = true;
      existing.connectedAt = Date.now();
      existing.lastSeenAt = Date.now();
      this.uuidToStream.set(uuid, streamId);
      this.emit("peer:join", existing);
      return existing;
    }

    const peer: PeerRecord = {
      streamId,
      uuid,
      identity: null,
      skills: [],
      status: "online",
      statusDetail: "",
      topics: [],
      version: "",
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      connected: true,
    };
    this.peers.set(streamId, peer);
    this.uuidToStream.set(uuid, streamId);
    this.emit("peer:join", peer);
    return peer;
  }

  /** Mark a peer as disconnected but keep its record (for offline queueing). */
  markDisconnected(identifier: string): PeerRecord | undefined {
    const peer = this.resolve(identifier);
    if (!peer) return undefined;
    peer.connected = false;
    peer.lastSeenAt = Date.now();
    this.emit("peer:leave", peer);
    return peer;
  }

  /** Fully remove a peer record. */
  removePeer(identifier: string): boolean {
    const peer = this.resolve(identifier);
    if (!peer) return false;
    this.peers.delete(peer.streamId);
    this.uuidToStream.delete(peer.uuid);
    this.emit("peer:leave", peer);
    return true;
  }

  /** Update identity and skills from an announce message. */
  updateFromAnnounce(identifier: string, identity: PeerIdentity, announce: AnnouncePayload): PeerRecord | undefined {
    const peer = this.resolve(identifier);
    if (!peer) return undefined;
    peer.identity = identity;
    peer.skills = announce.skills ?? [];
    peer.status = announce.status ?? "online";
    peer.statusDetail = announce.statusDetail ?? "";
    peer.topics = announce.topics ?? [];
    peer.version = announce.version ?? "";
    peer.lastSeenAt = Date.now();
    // Also map the identity's streamId if different from our key
    if (identity.streamId && identity.streamId !== peer.streamId) {
      this.uuidToStream.set(identity.streamId, peer.streamId);
    }
    this.emit("peer:update", peer, "announce");
    return peer;
  }

  /** Update skills/status from a skill_update message. */
  updateFromSkillUpdate(identifier: string, update: SkillUpdatePayload): PeerRecord | undefined {
    const peer = this.resolve(identifier);
    if (!peer) return undefined;
    peer.skills = update.skills ?? peer.skills;
    peer.status = update.status ?? peer.status;
    peer.statusDetail = update.statusDetail ?? peer.statusDetail;
    peer.lastSeenAt = Date.now();
    this.emit("peer:update", peer, "skill_update");
    return peer;
  }

  /** Record a heartbeat (ping/pong/any message). */
  touch(identifier: string): void {
    const peer = this.resolve(identifier);
    if (peer) peer.lastSeenAt = Date.now();
  }

  /** Get a peer by streamId or uuid. */
  getPeer(identifier: string): PeerRecord | undefined {
    return this.resolve(identifier);
  }

  /** Resolve a streamId or uuid to a PeerRecord. */
  private resolve(identifier: string): PeerRecord | undefined {
    const direct = this.peers.get(identifier);
    if (direct) return direct;
    const streamId = this.uuidToStream.get(identifier);
    if (streamId) return this.peers.get(streamId);
    return undefined;
  }

  /** Check if a peer is connected. */
  isConnected(identifier: string): boolean {
    return this.resolve(identifier)?.connected ?? false;
  }

  /** Get all currently connected peers. */
  getConnectedPeers(): PeerRecord[] {
    return [...this.peers.values()].filter((p) => p.connected);
  }

  /** Get all known peers (including disconnected). */
  getAllPeers(): PeerRecord[] {
    return [...this.peers.values()];
  }

  /** Get the number of connected peers. */
  get connectedCount(): number {
    let count = 0;
    for (const p of this.peers.values()) {
      if (p.connected) count++;
    }
    return count;
  }

  /** Get streamId from a uuid. */
  streamIdForUuid(uuid: string): string | undefined {
    return this.uuidToStream.get(uuid);
  }

  /** Prune peers that haven't been seen for longer than staleness threshold. */
  pruneStale(maxAgeMs: number): PeerRecord[] {
    const now = Date.now();
    const pruned: PeerRecord[] = [];
    for (const peer of this.peers.values()) {
      if (!peer.connected && now - peer.lastSeenAt > maxAgeMs) {
        this.peers.delete(peer.streamId);
        this.uuidToStream.delete(peer.uuid);
        pruned.push(peer);
      }
    }
    return pruned;
  }

  /** Clear all records. */
  clear(): void {
    this.peers.clear();
    this.uuidToStream.clear();
  }

  /** Snapshot for serialization (dashboard, status tools). */
  toJSON(): object[] {
    return [...this.peers.values()].map((p) => ({
      streamId: p.streamId,
      name: p.identity?.name ?? p.streamId,
      role: p.identity?.role ?? "unknown",
      skills: p.skills,
      status: p.status,
      statusDetail: p.statusDetail,
      connected: p.connected,
      connectedAt: p.connectedAt,
      lastSeenAt: p.lastSeenAt,
    }));
  }
}
