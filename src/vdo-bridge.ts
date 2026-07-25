/**
 * VDO Bridge
 *
 * Wraps the @vdoninja/sdk to provide a high-level P2P communication layer.
 * Manages the SDK lifecycle, peers, message routing, auto-announce,
 * heartbeat pings, offline queue flushing, and graceful shutdown.
 *
 * Zero dependencies on stevesbot internals.
 */

import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { sendFileFromPath } from "./file-transfer.js";
import { MessageBus, type MessageBusOptions } from "./message-bus.js";
import { PeerRegistry } from "./peer-registry.js";
import {
  type AgentProfile,
  createEnvelope,
  createInstanceId,
  envelopeToWire,
  type FileOfferPayload,
  parseEnvelope,
  type AnnouncePayload,
  type MessageEnvelope,
  type MessageType,
  type PeerIdentity,
  type SkillUpdatePayload,
} from "./protocol.js";

/**
 * The version advertised to peers.
 *
 * Read from package.json rather than typed in. It was a literal, and had
 * already drifted from the released version — peers were told whatever someone
 * last remembered to edit, which is worse than no version at all because it
 * looks authoritative.
 */
function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Cap on how long a shutdown waits for the SDK, so it can never wedge an exit. */
const TEARDOWN_TIMEOUT_MS = 5000;
/** Quiet period after a reconnect, while the SDK replays its own view intent. */
const RESTORE_GRACE_MS = 8000;

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
  /** Optional agent profile advertised to peers. */
  agentProfile?: AgentProfile;
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
  private version = readPackageVersion();
  private agentProfile: AgentProfile | undefined;
  private readonly viewedStreamIds = new Set<string>();
  private disconnecting = false;
  /** Set while the SDK is re-establishing signalling and replaying its intent. */
  private restoring = false;
  private restoringUntil = 0;

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
    this.agentProfile = options.agentProfile;
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
      if (!this.sdk) return false;
      try {
        return this.sdk.sendData(data, target ?? undefined) !== false;
      } catch (err) {
        this.emitBridgeError(err);
        return false;
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

    const sdk = this.sdk;
    this.disconnecting = true;
    this.stopHeartbeat();

    // Send a leaving event to all peers
    try {
      const envelope = createEnvelope(this.identity, "event", { kind: "leaving" });
      this.sdk.sendData(envelopeToWire(envelope));
    } catch { /* best effort */ }

    // Every viewed peer holds an RTCPeerConnection. Under @roamhq/wrtc those
    // are native handles that keep Node's event loop alive, so a CLI that only
    // dropped the bookkeeping set would connect, do its work, and then hang
    // forever instead of exiting.
    for (const streamId of this.viewedStreamIds) {
      try {
        this.sdk.stopViewing(streamId);
      } catch { /* best effort */ }
    }

    try {
      this.sdk.leaveRoom();
    } catch { /* best effort */ }

    // Tearing the process down before the SDK has finished closing peer
    // connections kills the native WebRTC module mid-cleanup, so wait for real
    // completion. From v1.4.1 disconnect() resolves exactly then; older builds
    // return void and need the state polled instead.
    try {
      const result = sdk.disconnect() as unknown;
      if (result && typeof (result as Promise<void>).then === "function") {
        await Promise.race([result as Promise<void>, delay(TEARDOWN_TIMEOUT_MS)]);
      } else {
        await this.waitForSdkTeardown(sdk);
      }
    } catch {
      // A disconnect that throws has not cleaned up, so fall back to observing
      // the state rather than exiting into a half-torn-down native module.
      await this.waitForSdkTeardown(sdk);
    }

    this.connected = false;
    this.disconnecting = false;
    this.sdk = null;
    this.viewedStreamIds.clear();
    this.peers.clear();
    console.log("[P2P] Disconnected.");
    this.emit("disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Whether the SDK is mid-reconnect, or just finished and still settling. */
  isRestoring(): boolean {
    return this.restoring || Date.now() < this.restoringUntil;
  }

  /**
   * Resolve once the SDK has genuinely finished tearing down.
   *
   * Its "disconnected" event is not a reliable signal: the WebSocket close
   * handler fires it well before the real cleanup, which runs later in a
   * promise chain the SDK never hands back. Waiting on the event let callers
   * exit while peer connections were still closing, which crashed the native
   * WebRTC module. So observe the state the cleanup actually clears, and cap
   * the wait so a changed SDK can never wedge a shutdown.
   */
  private async waitForSdkTeardown(
    sdk: InstanceType<typeof import("@vdoninja/sdk")>,
    timeoutMs = TEARDOWN_TIMEOUT_MS,
  ): Promise<void> {
    const state = sdk as unknown as {
      connections?: { size?: number };
      signaling?: unknown;
    };
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const connectionsClosed = (state.connections?.size ?? 0) === 0;
      const signalingClosed = !state.signaling;
      if (connectionsClosed && signalingClosed) return;
      await delay(50);
    }
  }

  private emitBridgeError(err: unknown): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
      return;
    }
    console.error("[P2P] Bridge error:", err);
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

  /** Update the advertised agent profile and broadcast the change. */
  updateAgentProfile(profile: AgentProfile): void {
    this.agentProfile = profile;
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
      agent: this.agentProfile,
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

  /** Send a file to a connected peer. */
  sendFile(targetStreamId: string, filePath: string): FileOfferPayload {
    return sendFileFromPath(this, targetStreamId, filePath, "file");
  }

  /** Send an image to a connected peer. */
  sendImage(targetStreamId: string, filePath: string): FileOfferPayload {
    return sendFileFromPath(this, targetStreamId, filePath, "image");
  }

  /** Send raw data through the underlying SDK without envelope wrapping. */
  sendRaw(data: unknown, targetStreamId?: string): boolean {
    if (!this.sdk) return false;
    try {
      if (!targetStreamId) {
        return this.sdk.sendData(data, { allowFallback: true }) !== false;
      }
      const peer = this.peers.getPeer(targetStreamId);
      if (peer?.uuid) {
        return this.sdk.sendData(data, { uuid: peer.uuid, allowFallback: true }) !== false;
      } else {
        return this.sdk.sendData(data, { streamID: targetStreamId, allowFallback: true }) !== false;
      }
    } catch (err) {
      this.emitBridgeError(err);
      return false;
    }
  }

  // ── Binary lane ──────────────────────────────────────────────────────────

  /**
   * Whether this build can put raw bytes on the wire.
   *
   * False on SDK versions before 1.4.1, where everything was JSON-stringified
   * before it reached the data channel. Callers fall back to base64 rather than
   * failing: a swarm with a mix of old and new peers still works, just slower
   * with the old ones.
   */
  supportsBinary(): boolean {
    return typeof this.sdk?.sendBinary === "function";
  }

  /**
   * Send raw bytes to one peer, bypassing JSON entirely.
   *
   * Resolves false rather than throwing when the peer is unknown or the SDK is
   * too old, so a caller can treat it as "try binary, else base64" in one line.
   */
  async sendBinaryTo(targetStreamId: string, bytes: Uint8Array): Promise<boolean> {
    const sdk = this.sdk;
    if (!sdk || typeof sdk.sendBinary !== "function") return false;
    const uuid = this.peers.getPeer(targetStreamId)?.uuid;
    if (!uuid) return false;
    try {
      return await sdk.sendBinary(bytes, uuid);
    } catch (err) {
      this.emitBridgeError(err);
      return false;
    }
  }

  /**
   * Bytes still queued for a peer on the binary lane, or null if unknown.
   *
   * Note this is the binary lane specifically. Reading the control channel
   * while bulk traffic queues on `x-bin` reports a permanent zero, which is
   * exactly how the SDK's own docs concluded that the value never moves under
   * `@roamhq/wrtc` — see docs/sdk-wishlist.md.
   */
  bufferedBytesFor(targetStreamId: string): number | null {
    const sdk = this.sdk;
    if (!sdk || typeof sdk.getBufferedAmount !== "function") return null;
    const uuid = this.peers.getPeer(targetStreamId)?.uuid;
    if (!uuid) return null;
    try {
      return sdk.getBufferedAmount(uuid, "bin");
    } catch {
      return null;
    }
  }

  /** Negotiated SCTP message limit for a peer, or null if not reported. */
  maxMessageSizeFor(targetStreamId: string): number | null {
    const sdk = this.sdk;
    if (!sdk || typeof sdk.getMaxMessageSize !== "function") return null;
    const uuid = this.peers.getPeer(targetStreamId)?.uuid;
    if (!uuid) return null;
    try {
      return sdk.getMaxMessageSize(uuid);
    } catch {
      return null;
    }
  }

  /** Smallest limit any connected peer reports, or null if none report one. */
  smallestMaxMessageSize(): number | null {
    let smallest: number | null = null;
    for (const peer of this.peers.getConnectedPeers()) {
      const limit = this.maxMessageSizeFor(peer.streamId);
      if (limit === null) continue;
      if (smallest === null || limit < smallest) smallest = limit;
    }
    return smallest;
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
          this.bus.flushOfflineQueue(senderStreamId);
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
      this.viewedStreamIds.delete(streamId);
      this.peers.markDisconnected(streamId);
      console.log(`[P2P] Peer disconnected: ${streamId}`);
      this.emit("peer:disconnected", { streamId, uuid });
    });

    // Raw bytes from a peer's sendBinary(). No envelope, no routing beyond the
    // sender, so whatever framing the payload needs lives inside the bytes.
    this.sdk.addEventListener(
      "binaryReceived",
      (event: { detail?: { uuid?: string; streamID?: string; bytes?: unknown } }) => {
        const raw = event.detail?.bytes;
        if (!(raw instanceof Uint8Array)) return;
        const uuid = event.detail?.uuid ?? "unknown";
        const streamId = this.peers.streamIdForUuid(uuid) ?? event.detail?.streamID ?? uuid;
        this.emit("binary", { streamId, uuid, bytes: raw });
      },
    );

    // SDK-level connection events
    this.sdk.addEventListener(
      "disconnected",
      (event: { detail?: { intentional?: boolean; willReconnect?: boolean; phase?: string } }) => {
        // From SDK v1.4.1 the event says whether a reconnect is actually coming.
        // Older builds say nothing, so fall back to our own shutdown flag rather
        // than claiming a reconnect that will never happen.
        const detail = event?.detail;
        const willReconnect =
          typeof detail?.willReconnect === "boolean" ? detail.willReconnect : !this.disconnecting;
        if (willReconnect) {
          console.log("[P2P] WebSocket disconnected, SDK will attempt reconnect...");
        }
        this.emit("ws:disconnected", { willReconnect, phase: detail?.phase });
      },
    );

    this.sdk.addEventListener("reconnecting", () => {
      this.restoring = true;
    });

    this.sdk.addEventListener("reconnected", () => {
      console.log("[P2P] WebSocket reconnected.");
      // The SDK replays its own view intent right after this. Rebuilding a
      // connection on top of that replay races it — both sides manipulate the
      // same pending-view state — so hold off briefly and let it finish.
      this.restoring = false;
      this.restoringUntil = Date.now() + RESTORE_GRACE_MS;
      // Every peer connection was established under the old socket. The SDK
      // replays its own view intent, but our bookkeeping said "already viewing"
      // for all of them, so anything the replay missed could never be
      // re-established by us — the set was only ever cleared on shutdown.
      // Forget it, and let the fresh room listing decide what to view.
      this.viewedStreamIds.clear();
      this.emit("ws:reconnected");
    });

    // Room listing (existing peers when we join)
    this.sdk.addEventListener("listing", (event: { detail?: { list?: Array<{ streamID?: string }> } }) => {
      const list = event.detail?.list ?? [];
      for (const entry of list) {
        if (entry.streamID && entry.streamID !== this.options.streamId) {
          this.maybeViewPeer(entry.streamID);
        }
      }
    });

    this.sdk.addEventListener("videoaddedtoroom", (event: { detail?: { streamID?: string } }) => {
      this.maybeViewPeer(event.detail?.streamID);
    });

    this.sdk.addEventListener("streamAdded", (event: { detail?: { streamID?: string } }) => {
      this.maybeViewPeer(event.detail?.streamID);
    });

    // Error handling
    this.sdk.addEventListener("error", (event: { detail?: { error?: unknown } }) => {
      console.error("[P2P] SDK error:", event.detail?.error);
      this.emitBridgeError(event.detail?.error);
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
      agent: this.agentProfile,
    } satisfies SkillUpdatePayload);
  }

  /**
   * Tear down and rebuild the connection to one peer.
   *
   * A peer connection can report `open` on the sending side while nothing
   * actually crosses it — measured after a signalling blip, where chunk
   * requests arrived, the sender's `send()` returned success, and the bytes
   * never landed. Nothing below us notices, because every layer believes it is
   * fine. The only evidence is at the application layer: a peer that keeps
   * failing to deliver. This is how that evidence gets acted on.
   */
  revivePeer(streamId: string): boolean {
    if (!this.sdk || streamId === this.options.streamId) return false;
    // Never while the SDK is restoring: it is already rebuilding these very
    // connections, and doing it underneath was measured as slower than doing
    // nothing. With signalling healthy, a rebuild restores a path in ~260ms.
    if (this.isRestoring()) return false;
    try {
      this.sdk.stopViewing(streamId);
    } catch { /* it may already be gone; rebuilding is still worth trying */ }
    this.viewedStreamIds.delete(streamId);
    this.peers.markDisconnected(streamId);
    console.log(`[P2P] Rebuilding the connection to ${streamId}`);
    this.maybeViewPeer(streamId);
    return true;
  }

  private maybeViewPeer(streamId?: string): void {
    if (!this.sdk || !streamId || streamId === this.options.streamId || this.viewedStreamIds.has(streamId)) {
      return;
    }

    this.viewedStreamIds.add(streamId);
    try {
      this.sdk.view(streamId, { audio: false, video: false });
    } catch (err) {
      this.viewedStreamIds.delete(streamId);
      this.emitBridgeError(err);
    }
  }
}
