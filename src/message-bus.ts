/**
 * Message Bus
 *
 * Pub/sub messaging layer with:
 * - Topic-based subscriptions
 * - Ring buffer message history
 * - Offline queue for disconnected peers
 * - Keyword triggers for async bot wakeup
 *
 * Zero dependencies on stevesbot internals.
 */

import { EventEmitter } from "node:events";
import type { PeerRegistry } from "./peer-registry.js";
import {
  createEnvelope,
  envelopeToWire,
  isTransientType,
  type MessageEnvelope,
  type MessageType,
  type PeerIdentity,
} from "./protocol.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type KeywordTrigger = {
  pattern: RegExp;
  handler: (msg: MessageEnvelope) => void;
};

/** Return false when the transport could not accept the message yet. */
export type SendDataFn = (data: object, target?: unknown) => boolean | void;

export type MessageBusOptions = {
  /** Max messages kept in history. Non-negative safe integer; zero disables it. Default: 200. */
  historySize?: number;
  /** Max messages queued per offline peer. Non-negative safe integer; zero disables it. Default: 50. */
  offlineQueueSize?: number;
};

// ── Class ────────────────────────────────────────────────────────────────────

export class MessageBus extends EventEmitter {
  private readonly identity: PeerIdentity;
  private readonly peers: PeerRegistry;
  private sendDataFn: SendDataFn | null = null;

  /** Our own topic subscriptions. */
  private readonly subscriptions = new Set<string>();

  /** Ring buffer of recent messages. */
  private readonly history: MessageEnvelope[] = [];
  private readonly historySize: number;

  /** Per-peer offline message queues. Map<streamId, MessageEnvelope[]>. */
  private readonly offlineQueues = new Map<string, MessageEnvelope[]>();
  private readonly offlineQueueSize: number;

  /** Registered keyword triggers. */
  private readonly triggers = new Map<number, KeywordTrigger>();
  private nextTriggerId = 0;

  constructor(identity: PeerIdentity, peers: PeerRegistry, options?: MessageBusOptions) {
    super();
    this.identity = identity;
    this.peers = peers;
    this.historySize = options?.historySize ?? 200;
    this.offlineQueueSize = options?.offlineQueueSize ?? 50;
    for (const [name, value] of [["historySize", this.historySize], ["offlineQueueSize", this.offlineQueueSize]] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
      }
    }
  }

  /** Set the low-level send function (provided by VDOBridge after SDK connects). */
  setSendDataFn(fn: SendDataFn): void {
    this.sendDataFn = fn;
  }

  private emitBusError(err: unknown): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
      return;
    }
    console.error("[P2P] Message bus error:", err);
  }

  // ── Subscriptions ────────────────────────────────────────────────────────

  subscribe(topic: string): void {
    this.subscriptions.add(topic);
  }

  unsubscribe(topic: string): void {
    this.subscriptions.delete(topic);
  }

  isSubscribed(topic: string): boolean {
    return this.subscriptions.has(topic);
  }

  getSubscriptions(): string[] {
    return [...this.subscriptions];
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /** Broadcast a message to all connected peers. */
  broadcast(type: MessageType, payload: unknown, topic?: string): MessageEnvelope {
    const envelope = createEnvelope(this.identity, type, payload, { topic: topic ?? null });
    this.addToHistory(envelope);
    this.rawSend(envelope, null);
    return envelope;
  }

  /**
   * Send something that is only worth delivering right now, reporting whether
   * the transport took it.
   *
   * Unlike `send`, a failure is not queued for replay and nothing enters the
   * history ring. Both matter for swarm traffic: a chunk request replayed from
   * a queue asks for something the requester already has, and a few seconds of
   * transfer is enough to evict every real message from history.
   *
   * The returned boolean is the point. A caller that assumes a send succeeded
   * will sit waiting out a request timeout for a message that never left.
   */
  trySend(targetStreamId: string, type: MessageType, payload: unknown): boolean {
    if (!this.peers.isConnected(targetStreamId)) return false;
    const envelope = createEnvelope(this.identity, type, payload, { to: targetStreamId });
    return this.rawSend(envelope, targetStreamId);
  }

  /** Broadcast counterpart of `trySend`: not retained, not replayed. */
  tryBroadcast(type: MessageType, payload: unknown): boolean {
    const envelope = createEnvelope(this.identity, type, payload);
    return this.rawSend(envelope, null);
  }

  /** Send a caller-persisted direct envelope, without a second in-memory queue. */
  trySendEnvelope(envelope: MessageEnvelope): boolean {
    if (!envelope.to || !this.peers.isConnected(envelope.to)) return false;
    if (!this.rawSend(envelope, envelope.to)) return false;
    this.addToHistory(envelope);
    return true;
  }

  /** Send a message to a specific peer (by streamId). */
  send(targetStreamId: string, type: MessageType, payload: unknown): MessageEnvelope {
    const envelope = createEnvelope(this.identity, type, payload, { to: targetStreamId });
    const transient = isTransientType(type);
    // Transient types are still deliverable this way, but never retained or
    // queued, so a caller reaching for the wrong method cannot flood history.
    if (!transient) this.addToHistory(envelope);

    // A recovered transport must send older commands before newer ones.
    // Immediate-only traffic deliberately does not wait behind this queue.
    if (!transient && this.peers.isConnected(targetStreamId) && this.getOfflineQueueSize(targetStreamId) > 0) {
      this.flushOfflineQueue(targetStreamId);
    }
    if (
      !this.peers.isConnected(targetStreamId) ||
      (!transient && this.getOfflineQueueSize(targetStreamId) > 0) ||
      !this.rawSend(envelope, targetStreamId)
    ) {
      if (!transient) this.enqueueOffline(targetStreamId, envelope);
    }
    return envelope;
  }

  /** Publish a message to a topic (only peers subscribed to that topic receive it).
   *  Since we can't know remote subscriptions at this layer, we broadcast and let
   *  receivers filter. The envelope carries the topic for filtering. */
  publish(topic: string, type: MessageType, payload: unknown): MessageEnvelope {
    const envelope = createEnvelope(this.identity, type, payload, { topic });
    this.addToHistory(envelope);
    this.rawSend(envelope, null);
    return envelope;
  }

  // ── Receiving ────────────────────────────────────────────────────────────

  /** Called by VDOBridge when a message arrives. Routes and emits events. */
  handleIncoming(envelope: MessageEnvelope): void {
    // Skip messages from ourselves
    if (envelope.from.streamId === this.identity.streamId &&
        envelope.from.instanceId === this.identity.instanceId) {
      return;
    }

    // Topic filtering: if a topic is set and we're not subscribed, skip
    // (except announce/ping/pong/history which are always delivered)
    const alwaysDeliver = new Set(["announce", "skill_update", "ping", "pong", "history_replay", "history_request"]);
    if (envelope.topic && !alwaysDeliver.has(envelope.type) && !this.subscriptions.has(envelope.topic)) {
      return;
    }

    // Targeted message: only process if addressed to us (or broadcast)
    if (envelope.to && envelope.to !== this.identity.streamId) {
      return;
    }

    // Update peer last-seen
    this.peers.touch(envelope.from.streamId);

    // Store in history
    this.addToHistory(envelope);

    // Fire keyword triggers for chat messages
    if (envelope.type === "chat") {
      this.checkTriggers(envelope);
    }

    // Emit typed event
    this.emit("message", envelope);
    this.emit(`message:${envelope.type}`, envelope);
    if (envelope.topic) {
      this.emit(`topic:${envelope.topic}`, envelope);
    }
  }

  // ── History ──────────────────────────────────────────────────────────────

  /** Get the most recent N messages from history. */
  getHistory(count?: number): MessageEnvelope[] {
    const n = count ?? this.historySize;
    if (n === 0) return [];
    return this.history.slice(-n);
  }

  /** Get messages from/to a specific peer. */
  getHistoryForPeer(streamId: string, count?: number): MessageEnvelope[] {
    const n = count ?? 50;
    if (n === 0) return [];
    return this.history
      .filter((m) => m.from.streamId === streamId || m.to === streamId)
      .slice(-n);
  }

  /** Get message count. */
  get historyCount(): number {
    return this.history.length;
  }

  // ── Offline Queue ────────────────────────────────────────────────────────

  /** Flush queued messages to a peer that just reconnected. */
  flushOfflineQueue(streamId: string): MessageEnvelope[] {
    const queue = this.offlineQueues.get(streamId);
    if (!queue || queue.length === 0) return [];

    const flushed: MessageEnvelope[] = [];
    try {
      for (const msg of queue) {
        // Preserve the original type and ID. Wrapping queued commands as
        // history_replay prevented normal command/file handlers from seeing them.
        if (!this.rawSend(msg, streamId)) break;
        flushed.push(msg);
      }
    } finally {
      // A later transport exception must not replay already accepted commands.
      if (flushed.length === queue.length) {
        this.offlineQueues.delete(streamId);
      } else if (flushed.length > 0) {
        this.offlineQueues.set(streamId, queue.slice(flushed.length));
      }
    }

    return flushed;
  }

  /** Get the number of queued messages for a peer. */
  getOfflineQueueSize(streamId: string): number {
    return this.offlineQueues.get(streamId)?.length ?? 0;
  }

  /** Get all peers that have queued messages. */
  getOfflineQueuePeers(): string[] {
    return [...this.offlineQueues.keys()].filter((k) => (this.offlineQueues.get(k)?.length ?? 0) > 0);
  }

  // ── Keyword Triggers ─────────────────────────────────────────────────────

  /** Register a keyword trigger. Returns an ID for removal. */
  onKeyword(pattern: string | RegExp, handler: (msg: MessageEnvelope) => void): number {
    const re = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
    const id = this.nextTriggerId++;
    this.triggers.set(id, { pattern: re, handler });
    return id;
  }

  /** Remove a trigger by the stable ID returned from onKeyword. */
  removeTrigger(id: number): void {
    this.triggers.delete(id);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private rawSend(envelope: MessageEnvelope, target: string | null): boolean {
    if (!this.sendDataFn) return false;
    const wire = envelopeToWire(envelope);
    let accepted: boolean | void;
    if (target) {
      // Prefer uuid targeting once we know it; streamID targeting can be ambiguous
      // before announce/rekey completes on some SDK connection paths.
      const peer = this.peers.getPeer(target);
      if (peer?.uuid) {
        accepted = this.sendDataFn(wire, { uuid: peer.uuid });
      } else {
        accepted = this.sendDataFn(wire, { streamID: target });
      }
    } else {
      // Broadcast to all
      accepted = this.sendDataFn(wire);
    }
    // Void preserves compatibility with existing transports written before
    // acceptance results were supported. Only an explicit false is a failure.
    return accepted !== false;
  }

  private addToHistory(envelope: MessageEnvelope): void {
    if (isTransientType(envelope.type)) return;
    // Replaying control traffic nests replays and crowds out the conversation.
    // Consumers still receive these events; do not unwrap/re-execute their payloads.
    if (envelope.type === "history_request" || envelope.type === "history_replay") return;
    // Don't store heartbeat or file chunk traffic in history.
    if (envelope.type === "ping" || envelope.type === "pong" || envelope.type === "file_chunk") return;
    this.history.push(envelope);
    while (this.history.length > this.historySize) {
      this.history.shift();
    }
  }

  private enqueueOffline(streamId: string, envelope: MessageEnvelope): void {
    let queue = this.offlineQueues.get(streamId);
    if (!queue) {
      queue = [];
      this.offlineQueues.set(streamId, queue);
    }
    queue.push(envelope);
    while (queue.length > this.offlineQueueSize) {
      queue.shift();
    }
  }

  private checkTriggers(envelope: MessageEnvelope): void {
    const text = typeof envelope.payload === "string"
      ? envelope.payload
      : typeof envelope.payload === "object" && envelope.payload !== null
        ? (envelope.payload as Record<string, unknown>).text as string ?? (envelope.payload as Record<string, unknown>).message as string ?? ""
        : "";

    if (typeof text !== "string" || !text) return;
    // New registrations belong to the next message; removals still take effect
    // immediately. A live Map iterator can revisit a self-rearming handler forever.
    for (const id of [...this.triggers.keys()]) {
      const trigger = this.triggers.get(id);
      if (!trigger) continue;
      trigger.pattern.lastIndex = 0;
      if (trigger.pattern.test(text)) {
        try {
          trigger.handler(envelope);
        } catch (err) {
          this.emitBusError(err);
        }
      }
    }
  }

  /** Clear all state. */
  clear(): void {
    this.history.length = 0;
    this.offlineQueues.clear();
    this.triggers.clear();
    this.subscriptions.clear();
  }
}
