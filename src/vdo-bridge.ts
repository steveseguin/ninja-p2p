/**
 * VDO Bridge
 *
 * Wraps the @vdoninja/sdk to provide a high-level P2P communication layer.
 * Manages the SDK lifecycle, peers, message routing, auto-announce,
 * heartbeat pings, offline queue flushing, and graceful shutdown.
 *
 * Zero dependencies on stevesbot internals.
 */

import { EventEmitter } from "node:events";
import { MessageBus, type MessageBusOptions } from "./message-bus.js";
import { PeerRegistry } from "./peer-registry.js";
import {
  createEnvelope,
  createInstanceId,
  envelopeToWire,
  parseEnvelope,
  type AnnouncePayload,
  type MessageEnvelope,
  type MessageType,
  type PeerIdentity,
  type SkillUpdatePayload,
} from "./protocol.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type VDOBridgeOptions = {
  room: string;
  streamId: string;
  identity: Omit<PeerIdentity, "instanceId">;
  password?: string | false;
  host?: string;
  forceTurn?: boolean;
  debug?: boolean;
  /** Skills to announce. */
  skills?: string[];
  /** Topics to subscribe to. */
  topics?: string[];
  /** Heartbeat interval in ms. Default: 30000. */
  heartbeatMs?: number;
  /** MessageBus options. */
  busOptions?: MessageBusOptions;
};

// ── Class ────────────────────────────────────────────────────────────────────

export class VDOBridge extends EventEmitter {
  readonly peers: PeerRegistry;
  readonly bus: MessageBus;
  readonly identity: PeerIdentity;

  private sdk: InstanceType<typeof import("@vdoninja/sdk")> | null = null;
  private readonly options: VDOBridgeOptions;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private skills: string[];
  private status = "idle";
  private statusDetail = "";
  private version = "0.1.1";

  constructor(options: VDOBridgeOptions) {
    super();
    this.options = options;
    this.identity = {
      streamId: options.streamId,
      role: options.identity.role,
      name: options.identity.name,
      instanceId: createInstanceId(),
    };
    this.skills = options.skills ?? [];
    this.peers = new PeerRegistry();
    this.bus = new MessageBus(this.identity, this.peers, options.busOptions);

    // Subscribe to requested topics
    for (const topic of options.topics ?? []) {
      this.bus.subscribe(topic);
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected) return;

    // Dynamic import for CJS SDK in ESM context
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const VDONinjaSDK = require("@vdoninja/sdk");
    this.sdk = new VDONinjaSDK({
      host: this.options.host ?? "wss://wss.vdo.ninja",
      debug: this.options.debug ?? false,
      forceTURN: this.options.forceTurn ?? false,
    }) as InstanceType<typeof VDONinjaSDK>;

    this.wireSDKEvents();

    // Set the send function on the bus
    this.bus.setSendDataFn((data, target) => {
      if (!this.sdk) return;
      try {
        this.sdk.sendData(data, target ?? undefined);
      } catch (err) {
        this.emit("error", err);
      }
    });

    await this.sdk!.connect();

    // Build joinRoom options
    const joinOpts: Record<string, unknown> = { room: this.options.room };
    if (this.options.password !== undefined) {
      joinOpts.password = this.options.password;
    }
    await this.sdk!.joinRoom(joinOpts);

    // Announce ourselves as a data-only publisher
    await this.sdk!.announce({ streamID: this.options.streamId });

    this.connected = true;
    this.startHeartbeat();

    console.log(`[P2P] Connected to room "${this.options.room}" as "${this.options.streamId}"`);
    this.emit("connected");
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.sdk) return;

    this.stopHeartbeat();

    // Send a leaving event to all peers
    try {
      const envelope = createEnvelope(this.identity, "event", { kind: "leaving" });
      this.sdk.sendData(envelopeToWire(envelope));
    } catch { /* best effort */ }

    try {
      this.sdk.leaveRoom();
    } catch { /* best effort */ }

    try {
      this.sdk.disconnect();
    } catch { /* best effort */ }

    this.connected = false;
    this.sdk = null;
    this.peers.clear();
    console.log("[P2P] Disconnected.");
    this.emit("disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── Identity Management ──────────────────────────────────────────────────

  /** Update skills and broadcast the change. */
  updateSkills(skills: string[]): void {
    this.skills = skills;
    this.broadcastSkillUpdate();
  }

  /** Update status and broadcast the change. */
  updateStatus(status: string, detail?: string): void {
    this.status = status;
    this.statusDetail = detail ?? "";
    this.broadcastSkillUpdate();
  }

  /** Get current announce payload. */
  getAnnouncePayload(): AnnouncePayload {
    return {
      skills: this.skills,
      status: this.status,
      statusDetail: this.statusDetail,
      version: this.version,
      topics: this.bus.getSubscriptions(),
    };
  }

  // ── Convenience Methods ──────────────────────────────────────────────────

  /** Send a chat message to everyone or a specific peer. */
  chat(text: string, to?: string): MessageEnvelope {
    if (to) {
      return this.bus.send(to, "chat", { text });
    }
    return this.bus.broadcast("chat", { text });
  }

  /** Send a chat message to a topic. */
  chatTopic(topic: string, text: string): MessageEnvelope {
    return this.bus.publish(topic, "chat", { text });
  }

  /** Send a command to a specific peer. */
  command(targetStreamId: string, command: string, args?: unknown): MessageEnvelope {
    return this.bus.send(targetStreamId, "command", { command, args });
  }

  /** Publish an event to a topic. */
  publishEvent(topic: string, kind: string, data?: unknown): MessageEnvelope {
    return this.bus.publish(topic, "event", { kind, ...((data && typeof data === "object") ? data : { data }) });
  }

  /** Send raw data through the underlying SDK without envelope wrapping. */
  sendRaw(data: unknown, targetStreamId?: string): boolean {
    if (!this.sdk) return false;
    try {
      if (!targetStreamId) {
        this.sdk.sendData(data);
        return true;
      }
      const peer = this.peers.getPeer(targetStreamId);
      if (peer?.uuid) {
        this.sdk.sendData(data, { UUID: peer.uuid });
      } else {
        this.sdk.sendData(data, { streamID: targetStreamId });
      }
      return true;
    } catch (err) {
      this.emit("error", err);
      return false;
    }
  }

  /** Reply to a received message using its sender as the target. */
  reply(message: MessageEnvelope, type: MessageType, payload: unknown): MessageEnvelope {
    return this.bus.send(message.from.streamId, type, payload);
  }

  /** Acknowledge receipt of a received message. */
  ack(message: MessageEnvelope, payload?: unknown): MessageEnvelope {
    const ackPayload: Record<string, unknown> = { messageId: message.id };
    if (payload !== undefined) {
      ackPayload.data = payload;
    }
    return this.bus.send(message.from.streamId, "ack", ackPayload);
  }

  /** Respond to a command or request-style message. */
  commandResponse(message: MessageEnvelope, result?: unknown, error?: string): MessageEnvelope {
    if (error) {
      return this.bus.send(message.from.streamId, "command_response", {
        requestId: message.id,
        ok: false,
        error,
      });
    }
    return this.bus.send(message.from.streamId, "command_response", {
      requestId: message.id,
      ok: true,
      result: result ?? null,
    });
  }

  /** Ask a peer to replay recent message history to this bridge. */
  requestHistory(targetStreamId: string, count = 50): MessageEnvelope {
    return this.bus.send(targetStreamId, "history_request", { count });
  }

  /** Access the underlying VDO.Ninja SDK instance for advanced media workflows. */
  getSDK(): InstanceType<typeof import("@vdoninja/sdk")> | null {
    return this.sdk;
  }

  // ── SDK Event Wiring ─────────────────────────────────────────────────────

  private wireSDKEvents(): void {
    if (!this.sdk) return;

    // Peer connected (WebRTC connection established)
    this.sdk.addEventListener("peerConnected", (event: { detail?: { uuid?: string; streamID?: string } }) => {
      const uuid = event.detail?.uuid ?? "unknown";
      const streamId = event.detail?.streamID ?? uuid;
      this.peers.addPeer(streamId, uuid);
      this.emit("peer:connected", { streamId, uuid });
    });

    // Data channel opened — send our announce
    this.sdk.addEventListener("dataChannelOpen", (event: { detail?: { uuid?: string; streamID?: string } }) => {
      const uuid = event.detail?.uuid ?? "unknown";
      const mappedStreamId = this.peers.streamIdForUuid(uuid);
      const eventStreamId = event.detail?.streamID;
      const streamId = mappedStreamId ?? (
        eventStreamId && eventStreamId !== this.options.streamId ? eventStreamId : uuid
      );

      // Send announce to this specific peer
      const announce = createEnvelope(this.identity, "announce", this.getAnnouncePayload(), { to: streamId });
      try {
        this.sdk!.sendData(envelopeToWire(announce), { UUID: uuid });
      } catch { /* peer may have disconnected */ }

      // Flush any queued offline messages for this peer
      const flushed = this.bus.flushOfflineQueue(streamId);
      if (flushed.length > 0) {
        console.log(`[P2P] Flushed ${flushed.length} queued messages to ${streamId}`);
      }

      this.emit("datachannel:open", { streamId, uuid });
    });

    // Data received — parse and route through MessageBus
    this.sdk.addEventListener("dataReceived", (event: { detail?: { data?: unknown; uuid?: string; streamID?: string } }) => {
      const raw = event.detail?.data;
      const uuid = event.detail?.uuid ?? "unknown";

      const envelope = parseEnvelope(raw);
      if (!envelope) {
        // Not our protocol — emit as raw data for consumers who want it
        this.emit("rawData", { data: raw, uuid });
        return;
      }

      // If we don't have a streamId mapping for this uuid, use the envelope's from
      const senderStreamId = envelope.from.streamId;
      if (!this.peers.getPeer(senderStreamId)) {
        const orphanPeer = this.peers.getPeer(uuid);
        if (orphanPeer && orphanPeer.streamId === uuid) {
          this.peers.rekeyPeer(uuid, senderStreamId);
        } else {
          this.peers.addPeer(senderStreamId, uuid);
        }
      }

      // Handle protocol-level messages
      switch (envelope.type) {
        case "announce":
          this.peers.updateFromAnnounce(senderStreamId, envelope.from, envelope.payload as AnnouncePayload);
          this.emit("peer:announce", { streamId: senderStreamId, identity: envelope.from, announce: envelope.payload });
          break;

        case "skill_update":
          this.peers.updateFromSkillUpdate(senderStreamId, envelope.payload as SkillUpdatePayload);
          break;

        case "ping":
          // Respond with pong
          this.respondPong(senderStreamId, envelope);
          break;

        case "pong":
          // Just update last-seen (already done in bus.handleIncoming)
          break;

        case "history_request": {
          // Send recent history to the requesting peer
          const count = typeof envelope.payload === "object" && envelope.payload !== null
            ? ((envelope.payload as Record<string, unknown>).count as number) ?? 50
            : 50;
          const history = this.bus.getHistory(count);
          for (const msg of history) {
            const replay = createEnvelope(this.identity, "history_replay", msg, { to: senderStreamId });
            try {
              this.sdk!.sendData(envelopeToWire(replay), { UUID: uuid });
            } catch { /* best effort */ }
          }
          break;
        }
      }

      // Route through MessageBus for application-level handling
      this.bus.handleIncoming(envelope);
    });

    // Peer disconnected
    this.sdk.addEventListener("peerDisconnected", (event: { detail?: { uuid?: string; streamID?: string } }) => {
      const uuid = event.detail?.uuid ?? "unknown";
      const streamId = event.detail?.streamID ?? this.peers.streamIdForUuid(uuid) ?? uuid;
      this.peers.markDisconnected(streamId);
      console.log(`[P2P] Peer disconnected: ${streamId}`);
      this.emit("peer:disconnected", { streamId, uuid });
    });

    // SDK-level connection events
    this.sdk.addEventListener("disconnected", () => {
      console.log("[P2P] WebSocket disconnected, SDK will attempt reconnect...");
      this.emit("ws:disconnected");
    });

    this.sdk.addEventListener("reconnected", () => {
      console.log("[P2P] WebSocket reconnected.");
      this.emit("ws:reconnected");
    });

    // Room listing (existing peers when we join)
    this.sdk.addEventListener("listing", (event: { detail?: { list?: Array<{ streamID?: string }> } }) => {
      const list = event.detail?.list ?? [];
      for (const entry of list) {
        if (entry.streamID && entry.streamID !== this.options.streamId) {
          // View each existing peer to establish data channels
          this.sdk!.view(entry.streamID, { audio: false, video: false });
        }
      }
    });

    // Error handling
    this.sdk.addEventListener("error", (event: { detail?: { error?: unknown } }) => {
      console.error("[P2P] SDK error:", event.detail?.error);
      this.emit("error", event.detail?.error);
    });
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    const interval = this.options.heartbeatMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.sdk) return;
      const ping = createEnvelope(this.identity, "ping", { ts: Date.now() });
      try {
        this.sdk.sendData(envelopeToWire(ping));
      } catch { /* connection may be lost */ }
    }, interval);
    // Don't block process exit
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private respondPong(targetStreamId: string, pingEnvelope: MessageEnvelope): void {
    if (!this.sdk) return;
    const pong = createEnvelope(this.identity, "pong", {
      pingId: pingEnvelope.id,
      pingTs: (pingEnvelope.payload as Record<string, unknown>)?.ts,
      pongTs: Date.now(),
    }, { to: targetStreamId });
    const peer = this.peers.getPeer(targetStreamId);
    if (peer) {
      try {
        this.sdk.sendData(envelopeToWire(pong), { UUID: peer.uuid });
      } catch { /* best effort */ }
    }
  }

  private broadcastSkillUpdate(): void {
    if (!this.connected) return;
    this.bus.broadcast("skill_update", {
      skills: this.skills,
      status: this.status,
      statusDetail: this.statusDetail,
    } satisfies SkillUpdatePayload);
  }
}
