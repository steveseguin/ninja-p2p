/**
 * Swarm Manager
 *
 * Binds swarm sessions to a live room. It routes swarm messages to the right
 * file, drives the request pump, and keeps peers informed about what it holds.
 *
 * One behaviour worth calling out: when a download completes, the manager
 * immediately reopens the finished file as a seed session. A peer that just
 * finished is the swarm's newest full source, and dropping out at that moment
 * is exactly what starves a swarm.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { VDOBridge } from "./vdo-bridge.js";
import {
  buildManifest,
  ChunkMap,
  DEFAULT_SWARM_CHUNK_SIZE,
  manifestsAgree,
  maxSafeChunkSize,
  partPathFor,
  type SwarmManifest,
} from "./swarm.js";
import {
  createSeedSession,
  SwarmSession,
  type SwarmProgress,
  type SwarmSend,
} from "./swarm-session.js";
import { decodeChunkFrame, encodeChunkFrame, isBinaryFileId } from "./swarm-wire.js";
import type {
  MessageEnvelope,
  SwarmAnnouncePayload,
  SwarmChunkPayload,
  SwarmHavePayload,
  SwarmOfferPayload,
  SwarmRequestPayload,
} from "./protocol.js";

export const DEFAULT_PUMP_INTERVAL_MS = 250;
export const DEFAULT_ANNOUNCE_INTERVAL_MS = 5_000;
/** Floor on how often one peer can be answered about one file. */
export const ANNOUNCE_REPLY_MIN_INTERVAL_MS = 1_000;
/** Consecutive timeouts, with nothing delivered between, before rebuilding a path. */
export const UNRESPONSIVE_TIMEOUT_THRESHOLD = 3;
/** Floor between rebuild attempts for one peer, so a dead peer is not hammered. */
export const REVIVE_MIN_INTERVAL_MS = 20_000;

export type SwarmCompletion = {
  fileId: string;
  manifest: SwarmManifest;
  savedPath: string;
};

export type SwarmManagerOptions = {
  bridge: VDOBridge;
  /** Where finished files land. */
  downloadDir: string;
  /** Where in-progress `.part` files live. */
  workDir: string;
  pumpIntervalMs?: number;
  announceIntervalMs?: number;
  /** Outstanding chunk requests allowed per peer. */
  maxInFlightPerPeer?: number;
  /** Outstanding chunk requests allowed across all peers, as a memory bound. */
  maxInFlightTotal?: number;
  log?: (message: string) => void;
  onComplete?: (completion: SwarmCompletion) => void;
  onProgress?: (progress: SwarmProgress) => void;
};

export class SwarmManager {
  private readonly bridge: VDOBridge;
  private readonly downloadDir: string;
  private readonly workDir: string;
  private readonly pumpIntervalMs: number;
  private readonly announceIntervalMs: number;
  private readonly maxInFlightPerPeer?: number;
  private readonly maxInFlightTotal?: number;
  private readonly log: (message: string) => void;
  private readonly onComplete?: (completion: SwarmCompletion) => void;
  private readonly onProgress?: (progress: SwarmProgress) => void;

  private readonly sessions = new Map<string, SwarmSession>();
  private readonly offers = new Map<string, SwarmManifest>();
  /** Files asked for before their offer arrived. */
  private readonly wanted = new Set<string>();
  private readonly seeding = new Set<string>();
  /** `fileId:peerId` -> when we last answered that peer's announce. */
  private readonly lastAnnounceReply = new Map<string, number>();
  /** peerId -> when its connection was last rebuilt. */
  private readonly lastRevive = new Map<string, number>();

  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(options: SwarmManagerOptions) {
    this.bridge = options.bridge;
    this.downloadDir = options.downloadDir;
    this.workDir = options.workDir;
    this.pumpIntervalMs = options.pumpIntervalMs ?? DEFAULT_PUMP_INTERVAL_MS;
    this.announceIntervalMs = options.announceIntervalMs ?? DEFAULT_ANNOUNCE_INTERVAL_MS;
    this.maxInFlightPerPeer = options.maxInFlightPerPeer;
    this.maxInFlightTotal = options.maxInFlightTotal;
    this.log = options.log ?? (() => {});
    this.onComplete = options.onComplete;
    this.onProgress = options.onProgress;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;

    mkdirSync(this.downloadDir, { recursive: true });
    mkdirSync(this.workDir, { recursive: true });

    this.bridge.bus.on("message:swarm_offer", (envelope: MessageEnvelope) => {
      this.handleOffer(envelope);
    });
    this.bridge.bus.on("message:swarm_announce", (envelope: MessageEnvelope) => {
      const payload = envelope.payload as SwarmAnnouncePayload;
      const session = this.sessions.get(payload.fileId);
      if (!session) return;
      session.onPeerAnnounce(envelope.from.streamId, payload.chunks);
      this.answerAnnounce(session, envelope.from.streamId);
      // New availability may unblock chunks we could not ask anyone for.
      this.schedulePump();
    });
    this.bridge.bus.on("message:swarm_have", (envelope: MessageEnvelope) => {
      const payload = envelope.payload as SwarmHavePayload;
      const session = this.sessions.get(payload.fileId);
      if (!session) return;
      // `indexes` is what we send; `index` is what an older peer sends.
      const indexes = payload.indexes ?? (typeof payload.index === "number" ? [payload.index] : []);
      for (const index of indexes) session.onPeerHave(envelope.from.streamId, index);
      this.schedulePump();
    });
    this.bridge.bus.on("message:swarm_request", (envelope: MessageEnvelope) => {
      const payload = envelope.payload as SwarmRequestPayload;
      this.sessions
        .get(payload.fileId)
        ?.onChunkRequest(envelope.from.streamId, payload.index, payload.bin === 1);
    });
    this.bridge.bus.on("message:swarm_chunk", (envelope: MessageEnvelope) => {
      this.handleChunk(envelope);
    });
    this.bridge.on("binary", ({ streamId, bytes }: { streamId: string; bytes: Uint8Array }) => {
      this.handleBinary(streamId, bytes);
    });

    this.bridge.on("peer:disconnected", ({ streamId }: { streamId: string }) => {
      for (const session of this.sessions.values()) session.removePeer(streamId);
      for (const key of [...this.lastAnnounceReply.keys()]) {
        if (key.endsWith(`:${streamId}`)) this.lastAnnounceReply.delete(key);
      }
      this.lastRevive.delete(streamId);
    });
    // A peer that just appeared missed every offer we already broadcast, so it
    // has no way to learn a file exists. Send it our catalogue directly rather
    // than re-broadcasting: a manifest carries one hash per chunk, which is
    // megabytes for a large file and would hit every peer on every join.
    this.bridge.on("peer:announce", ({ streamId }: { streamId: string }) => {
      this.greetPeer(streamId);
    });
    // Our socket came back on new peer connections. Anything outstanding was
    // addressed to the old ones, so re-plan now rather than waiting out a
    // timeout per chunk, and re-state what we hold so peers can place us again.
    this.bridge.on("ws:reconnected", () => {
      let abandoned = 0;
      for (const session of this.sessions.values()) abandoned += session.abandonInFlight();
      if (abandoned > 0) this.log(`[swarm] reconnected; re-planning ${abandoned} outstanding request(s)`);
      this.announceAll();
      this.schedulePump();
    });

    this.pumpTimer = setInterval(() => this.pump(), this.pumpIntervalMs);
    if (this.pumpTimer.unref) this.pumpTimer.unref();
    this.announceTimer = setInterval(() => this.announceAll(), this.announceIntervalMs);
    if (this.announceTimer.unref) this.announceTimer.unref();
  }

  stop(): void {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.pumpTimer = null;
    this.announceTimer = null;
    this.coalesceTimer = null;
    for (const session of this.sessions.values()) session.close();
    this.started = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Publish a local file to the room and start serving it. */
  seed(filePath: string, chunkSize = DEFAULT_SWARM_CHUNK_SIZE): SwarmManifest {
    const resolved = path.resolve(filePath);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new Error(`not a file: ${resolved}`);
    }

    // A chunk is fixed for the life of the swarm, so this is the only chance to
    // check it against what the transport will actually carry. Peers that join
    // later may negotiate a smaller limit than anyone present now — nothing can
    // be done about that here, but binary chunks stay under the 65536 floor
    // regardless, so only the base64 fallback is exposed.
    const limit = this.bridge.smallestMaxMessageSize();
    if (limit !== null) {
      const safe = maxSafeChunkSize(limit);
      if (chunkSize > safe) {
        this.log(
          `[swarm] chunk size ${chunkSize} exceeds what a ${limit}-byte message limit can carry ` +
            `once base64-encoded; using ${safe}`,
        );
        chunkSize = safe;
      }
    }

    const bytes = new Uint8Array(readFileSync(resolved));
    const manifest = buildManifest(bytes, path.basename(resolved), guessMimeType(resolved), chunkSize);

    this.offers.set(manifest.fileId, manifest);
    this.seeding.add(manifest.fileId);

    const session = createSeedSession(manifest, resolved, this.sendFor(manifest), {
      log: this.log,
    });
    this.sessions.set(manifest.fileId, session);

    this.broadcastOffer(manifest);
    session.announce();
    this.log(`[swarm] seeding ${manifest.name} (${manifest.totalChunks} chunks, ${manifest.fileId.slice(0, 12)})`);
    return manifest;
  }

  /**
   * Ask for a file by content id. If its offer has not arrived yet the request
   * is remembered, so `fetch` before the seeder announces still works.
   */
  fetch(fileId: string): boolean {
    if (this.sessions.has(fileId)) return true;
    const manifest = this.offers.get(fileId);
    if (!manifest) {
      this.wanted.add(fileId);
      this.log(`[swarm] waiting for an offer of ${fileId.slice(0, 12)}`);
      return false;
    }
    return this.startDownload(manifest);
  }

  knownOffers(): SwarmManifest[] {
    return [...this.offers.values()];
  }

  /**
   * Find an offer by full content id, an unambiguous id prefix, or exact file
   * name. A 64-character hex id is not something anyone types by hand.
   */
  resolveOffer(query: string): SwarmManifest | null {
    const trimmed = query.trim();
    if (!trimmed) return null;

    const exact = this.offers.get(trimmed);
    if (exact) return exact;

    const byName = [...this.offers.values()].filter((m) => m.name === trimmed);
    if (byName.length === 1) return byName[0];

    const lowered = trimmed.toLowerCase();
    const byPrefix = [...this.offers.values()].filter((m) => m.fileId.startsWith(lowered));
    if (byPrefix.length === 1) return byPrefix[0];

    // Ambiguous matches resolve to nothing rather than guessing wrong.
    return null;
  }

  progress(): SwarmProgress[] {
    return [...this.sessions.values()].map((session) => session.progress());
  }

  sessionFor(fileId: string): SwarmSession | undefined {
    return this.sessions.get(fileId);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private pump(): void {
    for (const session of this.sessions.values()) {
      if (session.isComplete()) continue;
      session.pump();
      this.reviveUnresponsive(session);
    }
  }

  /**
   * Rebuild the connection to a peer that keeps timing out without delivering.
   *
   * The case this exists for is a path that every layer believes is healthy: a
   * signalling blip leaves the peer connection reporting `open`, the sender's
   * `send()` succeeds, and the bytes are simply dropped. Waiting it out took
   * around a minute; the swarm has the evidence to act much sooner, because a
   * run of timeouts with nothing delivered in between says so.
   *
   * Deliberately conservative: a peer must miss several requests in a row, and
   * rebuilding is rate-limited, because a genuinely slow peer must not be
   * disconnected for being slow.
   */
  private reviveUnresponsive(session: SwarmSession): void {
    const now = Date.now();
    for (const peerId of session.unresponsivePeers(UNRESPONSIVE_TIMEOUT_THRESHOLD)) {
      if (now - (this.lastRevive.get(peerId) ?? 0) < REVIVE_MIN_INTERVAL_MS) continue;
      this.lastRevive.set(peerId, now);
      session.clearUnresponsive(peerId);
      this.log(`[swarm] ${peerId} stopped delivering; rebuilding the connection`);
      this.bridge.revivePeer(peerId);
    }
  }

  /**
   * Re-plan as soon as a request slot frees, instead of waiting for the timer.
   *
   * The interval alone caps throughput hard: with four requests in flight and a
   * 250ms tick, a slot that frees 10ms after a pump sits idle for the other
   * 240ms. Measured against a real 5 MB transfer that ceiling was 16 chunks/s
   * and we were getting 9.6. Pumping on arrival removes the ceiling and leaves
   * round-trip time as the governor.
   *
   * The short coalescing delay matters too: chunks arrive in bursts, and
   * planning is O(chunks x peers), so replanning once per burst beats
   * replanning once per chunk.
   */
  private schedulePump(): void {
    if (!this.started || this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this.pump();
    }, 5);
    if (this.coalesceTimer.unref) this.coalesceTimer.unref();
  }

  private announceAll(): void {
    for (const session of this.sessions.values()) session.announce();
  }

  /**
   * Answer a peer's announce with our own bitfield when we can serve it.
   *
   * Without this a fresh downloader knows a file exists but not who holds any
   * of it, so it sits idle until the next periodic announce comes round.
   * Measured on a 5 MB transfer that stall was 2.6 s of a 4.0 s total — the
   * transfer itself was never the slow part. Replying on demand takes the same
   * transfer to 1.0 s without making the room any chattier at rest.
   *
   * Three things keep this from becoming an announce storm: we only reply if we
   * actually hold something the peer lacks, the reply is unicast rather than
   * broadcast, and each peer gets at most one reply per file per second.
   */
  private answerAnnounce(session: SwarmSession, peerId: string): void {
    if (!session.canHelp(peerId)) return;

    const key = `${session.manifest.fileId}:${peerId}`;
    const last = this.lastAnnounceReply.get(key) ?? 0;
    const now = Date.now();
    if (now - last < ANNOUNCE_REPLY_MIN_INTERVAL_MS) return;

    this.lastAnnounceReply.set(key, now);
    session.announceTo(peerId);
  }

  /** Tell one peer everything we can offer, then what we currently hold. */
  private greetPeer(streamId: string): void {
    for (const session of this.sessions.values()) {
      // Only advertise files we can actually serve some of.
      if (session.chunkMap().count() === 0) continue;
      this.bridge.bus.trySend(streamId, "swarm_offer", session.manifest satisfies SwarmOfferPayload);
    }
    this.announceAll();
  }

  private broadcastOffer(manifest: SwarmManifest): void {
    this.bridge.bus.tryBroadcast("swarm_offer", manifest satisfies SwarmOfferPayload);
  }

  private handleOffer(envelope: MessageEnvelope): void {
    const offered = envelope.payload as SwarmOfferPayload;
    if (!offered?.fileId || !Array.isArray(offered.chunkHashes)) return;

    const known = this.offers.get(offered.fileId);
    if (known) {
      // Same content id must mean the same bytes. Disagreement means the peer
      // is broken or lying, and trading chunks with it would corrupt the file.
      if (!manifestsAgree(known, offered)) {
        this.log(`[swarm] rejecting conflicting offer for ${offered.fileId.slice(0, 12)} from ${envelope.from.streamId}`);
      }
      return;
    }

    this.offers.set(offered.fileId, offered);
    this.log(`[swarm] offer: ${offered.name} (${offered.fileId.slice(0, 12)}) from ${envelope.from.streamId}`);

    if (this.wanted.delete(offered.fileId)) {
      this.startDownload(offered);
    }
  }

  private handleChunk(envelope: MessageEnvelope): void {
    const payload = envelope.payload as SwarmChunkPayload;
    const session = this.sessions.get(payload.fileId);
    if (!session) return;

    const bytes = new Uint8Array(Buffer.from(payload.data, "base64"));
    session.onChunkData(envelope.from.streamId, payload.index, bytes);

    if (!session.isComplete()) {
      // That request slot is free now; refill it rather than waiting a tick.
      this.schedulePump();
      this.onProgress?.(session.progress());
      return;
    }
    this.completeSession(payload.fileId, session);
  }

  private startDownload(manifest: SwarmManifest): boolean {
    if (this.sessions.has(manifest.fileId)) return true;

    const savedPath = chooseSavedPath(this.downloadDir, manifest.name, manifest.fileId);
    const partPath = partPathFor(this.workDir, manifest.fileId, savedPath);

    let session: SwarmSession;
    try {
      session = new SwarmSession({
        manifest,
        partPath,
        savedPath,
        send: this.sendFor(manifest),
        maxInFlightPerPeer: this.maxInFlightPerPeer,
        maxInFlightTotal: this.maxInFlightTotal,
        log: this.log,
      });
    } catch (err) {
      // Constructing a download claims the part file, so this is where a
      // conflicting download surfaces. It reaches us from inside a bus event
      // handler, where an unhandled throw would be swallowed or take the
      // process down — say what happened and decline the file instead.
      this.log(`[swarm] cannot start ${manifest.name}: ${(err as Error).message}`);
      return false;
    }
    this.sessions.set(manifest.fileId, session);

    const resumed = session.chunkMap().count();
    if (resumed > 0) {
      this.log(`[swarm] resuming ${manifest.name}: ${resumed}/${manifest.totalChunks} chunks already verified`);
    }

    // A part file left by a run that was interrupted after the last chunk but
    // before the rename is already whole. Nothing would ever drive it to
    // completion — the pump exits early on a complete session — so finish it
    // here rather than waiting for a chunk that is never coming.
    if (session.isComplete()) {
      this.completeSession(manifest.fileId, session);
      return true;
    }

    // Tell the room what we hold, which for a fresh download is nothing —
    // that is still useful, because it identifies us as a participant.
    session.announce();
    this.log(`[swarm] fetching ${manifest.name} (${manifest.totalChunks} chunks)`);
    return true;
  }

  private completeSession(fileId: string, session: SwarmSession): void {
    const result = session.finish();
    if (!result.ok) {
      this.log(`[swarm] finish failed for ${fileId.slice(0, 12)}: ${result.error}`);
      return;
    }

    const manifest = session.manifest;
    this.log(`[swarm] complete: ${manifest.name} -> ${result.savedPath}`);

    // Reopen the finished file as a seed. The part file was renamed away, so
    // without this the session can no longer serve and the swarm loses its
    // newest full source at the worst possible moment.
    const seed = createSeedSession(manifest, result.savedPath!, this.sendFor(manifest), { log: this.log });
    this.sessions.set(fileId, seed);
    this.seeding.add(fileId);
    seed.announce();

    this.onComplete?.({ fileId, manifest, savedPath: result.savedPath! });
  }

  private sendFor(manifest: SwarmManifest): SwarmSend {
    const fileId = manifest.fileId;
    // Only ask for binary replies if we could actually decode one. A hex content
    // id is required by the frame header; ids we generate always qualify, but an
    // offer from somewhere else might not, and that peer should still work.
    const canReceiveBinary = this.bridge.supportsBinary() && isBinaryFileId(fileId);

    return {
      request: (peerId, index) => {
        const payload: SwarmRequestPayload = { fileId, index };
        if (canReceiveBinary) payload.bin = 1;
        return this.bridge.bus.trySend(peerId, "swarm_request", payload);
      },
      chunk: (peerId, index, bytes, binary) => {
        if (binary && this.bridge.supportsBinary() && isBinaryFileId(fileId)) {
          const frame = encodeChunkFrame(fileId, index, bytes);
          // Fire and forget, but fall back if the lane refuses the bytes —
          // a peer that asked for binary and then got nothing would stall
          // until its request timed out, once per chunk.
          void this.bridge
            .sendBinaryTo(peerId, frame)
            .then((sent) => {
              if (!sent) this.sendChunkAsBase64(peerId, fileId, index, bytes);
            })
            .catch(() => this.sendChunkAsBase64(peerId, fileId, index, bytes));
          return;
        }
        this.sendChunkAsBase64(peerId, fileId, index, bytes);
      },
      have: (indexes, toPeerIds) => {
        // Nobody in the room is still downloading this, so stay quiet.
        if (toPeerIds.length === 0 || indexes.length === 0) return;
        const payload = { fileId, indexes } satisfies SwarmHavePayload;
        for (const peerId of toPeerIds) this.bridge.bus.trySend(peerId, "swarm_have", payload);
      },
      announce: (chunks) => {
        this.bridge.bus.tryBroadcast("swarm_announce", {
          fileId,
          totalChunks: manifest.totalChunks,
          chunks,
        } satisfies SwarmAnnouncePayload);
      },
      announceTo: (peerId, chunks) => {
        this.bridge.bus.trySend(peerId, "swarm_announce", {
          fileId,
          totalChunks: manifest.totalChunks,
          chunks,
        } satisfies SwarmAnnouncePayload);
      },
    };
  }

  private sendChunkAsBase64(peerId: string, fileId: string, index: number, bytes: Uint8Array): void {
    this.bridge.bus.trySend(peerId, "swarm_chunk", {
      fileId,
      index,
      data: Buffer.from(bytes).toString("base64"),
    } satisfies SwarmChunkPayload);
  }

  /**
   * Route a frame off the shared binary lane.
   *
   * Anything that is not one of our chunk frames is left alone: the lane is the
   * application's, and another feature may well be using it too.
   */
  private handleBinary(streamId: string, bytes: Uint8Array): void {
    const frame = decodeChunkFrame(bytes);
    if (!frame) return;
    const session = this.sessions.get(frame.fileId);
    if (!session) return;

    session.onChunkData(streamId, frame.index, frame.data);

    if (!session.isComplete()) {
      this.schedulePump();
      this.onProgress?.(session.progress());
      return;
    }
    this.completeSession(frame.fileId, session);
  }
}

function chooseSavedPath(downloadDir: string, name: string, fileId: string): string {
  const safe = path.basename(name || "download").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_") || "download";
  const direct = path.join(downloadDir, safe);
  if (!existsSync(direct)) return direct;
  const parsed = path.parse(safe);
  return path.join(downloadDir, `${parsed.name}_${fileId.slice(0, 8)}${parsed.ext}`);
}

function guessMimeType(filePath: string): string {
  const known: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
  };
  return known[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export { ChunkMap };
