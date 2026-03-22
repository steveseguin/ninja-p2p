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
  type MessageEnvelope,
  type MessageType,
  type PeerIdentity,
} from "./protocol.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type KeywordTrigger = {
  pattern: RegExp;
  handler: (msg: MessageEnvelope) => void;
};

export type SendDataFn = (data: object, target?: unknown) => void;

export type MessageBusOptions = {
  /** Max messages kept in history ring buffer. Default: 200. */
  historySize?: number;
  /** Max messages queued per offline peer. Default: 50. */
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
  private readonly triggers: KeywordTrigger[] = [];

  constructor(identity: PeerIdentity, peers: PeerRegistry, options?: MessageBusOptions) {
    super();
    this.identity = identity;
    this.peers = peers;
    this.historySize = options?.historySize ?? 200;
    this.offlineQueueSize = options?.offlineQueueSize ?? 50;
  }

  /** Set the low-level send function (provided by VDOBridge after SDK connects). */
  setSendDataFn(fn: SendDataFn): void {
    this.sendDataFn = fn;
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

  /** Send a message to a specific peer (by streamId). */
  send(targetStreamId: string, type: MessageType, payload: unknown): MessageEnvelope {
    const envelope = createEnvelope(this.identity, type, payload, { to: targetStreamId });
    this.addToHistory(envelope);

    if (this.peers.isConnected(targetStreamId)) {
      this.rawSend(envelope, targetStreamId);
    } else {
      this.enqueueOffline(targetStreamId, envelope);
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
    return this.history.slice(-n);
  }

  /** Get messages from/to a specific peer. */
  getHistoryForPeer(streamId: string, count?: number): MessageEnvelope[] {
    const n = count ?? 50;
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

    this.offlineQueues.delete(streamId);

    // Send each queued message wrapped as history_replay
    for (const msg of queue) {
      const replay = createEnvelope(this.identity, "history_replay", msg, { to: streamId });
      this.rawSend(replay, streamId);
    }

    return queue;
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
    this.triggers.push({ pattern: re, handler });
    return this.triggers.length - 1;
  }

  /** Remove a trigger by index. */
  removeTrigger(index: number): void {
    if (index >= 0 && index < this.triggers.length) {
      this.triggers.splice(index, 1);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private rawSend(envelope: MessageEnvelope, target: string | null): void {
    if (!this.sendDataFn) return;
    const wire = envelopeToWire(envelope);
    if (target) {
      // Send to specific peer — use streamId as target for sendData
      this.sendDataFn(wire, { streamID: target });
    } else {
      // Broadcast to all
      this.sendDataFn(wire);
    }
  }

  private addToHistory(envelope: MessageEnvelope): void {
    // Don't store pings/pongs in history
    if (envelope.type === "ping" || envelope.type === "pong") return;
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

    if (!text) return;
    for (const trigger of this.triggers) {
      if (trigger.pattern.test(text)) {
        try {
          trigger.handler(envelope);
        } catch (err) {
          this.emit("error", err);
        }
      }
    }
  }

  /** Clear all state. */
  clear(): void {
    this.history.length = 0;
    this.offlineQueues.clear();
    this.triggers.length = 0;
    this.subscriptions.clear();
  }
}
