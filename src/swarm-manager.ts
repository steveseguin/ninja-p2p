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

import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { VDOBridge } from "./vdo-bridge.js";
import {
  buildManifestFromFile,
  ChunkMap,
  chunkLength,
  DEFAULT_SWARM_CHUNK_SIZE,
  hashChunkHashes,
  isSha256Hex,
  MAX_SWARM_TOTAL_CHUNKS,
  manifestsAgree,
  maxSafeChunkSize,
  partPathFor,
  SWARM_INLINE_MANIFEST_HASHES,
  SWARM_MANIFEST_PAGE_HASHES,
  toManifestSummary,
  validateManifestSummary,
  validateSwarmManifest,
  type SwarmManifest,
  type SwarmManifestSummary,
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
  SwarmManifestPagePayload,
  SwarmManifestRequestPayload,
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
/** Retry a lost manifest page request without flooding the control channel. */
export const MANIFEST_REQUEST_RETRY_MS = 2_000;
/** Bound both request messages and the burst of page responses they trigger. */
export const MANIFEST_PAGES_PER_REQUEST = 8;

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
  onError?: (message: string, manifest?: SwarmManifestSummary) => void;
};

export type SwarmOfferInfo = SwarmManifestSummary & {
  manifestReady: boolean;
};

type OfferRecord = {
  summary: SwarmManifestSummary;
  manifest: SwarmManifest | null;
  pageSize: number;
  totalPages: number;
  sources: Set<string>;
  pages: Map<number, string[]>;
  requestedAt: Map<number, number>;
  sourceCursor: number;
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
  private readonly onError?: (message: string, manifest?: SwarmManifestSummary) => void;

  private readonly sessions = new Map<string, SwarmSession>();
  private readonly offers = new Map<string, OfferRecord>();
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
  /** Invalidates asynchronous sends when stop() begins. */
  private lifecycleGeneration = 0;

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
    this.onError = options.onError;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lifecycleGeneration += 1;

    mkdirSync(this.downloadDir, { recursive: true });
    mkdirSync(this.workDir, { recursive: true });

    this.bridge.bus.on("message:swarm_offer", (envelope: MessageEnvelope) => {
      this.guard("offer", envelope, () => this.handleOffer(envelope));
    });
    this.bridge.bus.on("message:swarm_manifest_request", (envelope: MessageEnvelope) => {
      this.guard("manifest request", envelope, () => this.handleManifestRequest(envelope));
    });
    this.bridge.bus.on("message:swarm_manifest_page", (envelope: MessageEnvelope) => {
      this.guard("manifest page", envelope, () => this.handleManifestPage(envelope));
    });
    this.bridge.bus.on("message:swarm_announce", (envelope: MessageEnvelope) => {
      this.guard("announce", envelope, () => this.handleAnnounce(envelope));
    });
    this.bridge.bus.on("message:swarm_have", (envelope: MessageEnvelope) => {
      this.guard("have", envelope, () => this.handleHave(envelope));
    });
    this.bridge.bus.on("message:swarm_request", (envelope: MessageEnvelope) => {
      this.guard("chunk request", envelope, () => this.handleRequest(envelope));
    });
    this.bridge.bus.on("message:swarm_chunk", (envelope: MessageEnvelope) => {
      this.guard("chunk", envelope, () => this.handleChunk(envelope));
    });
    this.bridge.on("binary", ({ streamId, bytes }: { streamId: string; bytes: Uint8Array }) => {
      try {
        this.handleBinary(streamId, bytes);
      } catch (error) {
        this.log(`[swarm] rejected binary frame from ${streamId}: ${errorMessage(error)}`);
      }
    });

    this.bridge.on("peer:disconnected", ({ streamId }: { streamId: string }) => {
      for (const session of this.sessions.values()) session.removePeer(streamId);
      for (const offer of this.offers.values()) {
        offer.sources.delete(streamId);
        offer.requestedAt.clear();
      }
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
    // A refused binary send normally falls back to base64. Invalidate pending
    // sends first so that fallback never starts on a channel being torn down.
    this.started = false;
    this.lifecycleGeneration += 1;
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.pumpTimer = null;
    this.announceTimer = null;
    this.coalesceTimer = null;
    for (const session of this.sessions.values()) session.close();
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

    const manifest = buildManifestFromFile(
      resolved,
      path.basename(resolved),
      guessMimeType(resolved),
      chunkSize,
    );

    this.offers.set(manifest.fileId, createOfferRecord(manifest));
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
    if (!isSha256Hex(fileId)) {
      this.reportError("refusing an invalid swarm file id");
      return false;
    }
    const offer = this.offers.get(fileId);
    if (!offer) {
      this.wanted.add(fileId);
      this.log(`[swarm] waiting for an offer of ${fileId.slice(0, 12)}`);
      return false;
    }
    this.wanted.add(fileId);
    if (offer.manifest) return this.startDownload(offer.manifest);
    this.requestManifestPages(offer);
    this.log(`[swarm] requesting manifest for ${offer.summary.name}`);
    return true;
  }

  knownOffers(): SwarmOfferInfo[] {
    return [...this.offers.values()].map(toOfferInfo);
  }

  /**
   * Find an offer by full content id, an unambiguous id prefix, or exact file
   * name. A 64-character hex id is not something anyone types by hand.
   */
  resolveOffer(query: string): SwarmOfferInfo | null {
    const trimmed = query.trim();
    if (!trimmed) return null;

    const exact = this.offers.get(trimmed);
    if (exact) return toOfferInfo(exact);

    const byName = [...this.offers.values()].filter((record) => record.summary.name === trimmed);
    if (byName.length === 1) return toOfferInfo(byName[0]);

    const lowered = trimmed.toLowerCase();
    const byPrefix = [...this.offers.values()].filter((record) => record.summary.fileId.startsWith(lowered));
    if (byPrefix.length === 1) return toOfferInfo(byPrefix[0]);

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
    for (const fileId of this.wanted) {
      const offer = this.offers.get(fileId);
      if (offer && !offer.manifest) this.requestManifestPages(offer);
    }
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
      this.bridge.bus.trySend(streamId, "swarm_offer", toOfferPayload(session.manifest));
      session.announceTo(streamId);
    }
  }

  private broadcastOffer(manifest: SwarmManifest): void {
    if (!this.bridge.bus.tryBroadcast("swarm_offer", toOfferPayload(manifest))) {
      this.log(`[swarm] transport refused offer for ${manifest.name}; it will be retried when peers join`);
    }
  }

  private handleOffer(envelope: MessageEnvelope): void {
    const parsed = parseOfferPayload(envelope.payload);
    if (!parsed.ok) {
      this.log(`[swarm] rejecting invalid offer from ${envelope.from.streamId}: ${parsed.error}`);
      return;
    }

    const { summary, manifest, pageSize, totalPages } = parsed;
    const known = this.offers.get(summary.fileId);
    if (known) {
      // Same content id must mean the same bytes. Disagreement means the peer
      // is broken or lying, and trading chunks with it would corrupt the file.
      if (!summariesAgree(known.summary, summary)) {
        this.log(`[swarm] rejecting conflicting offer for ${summary.fileId.slice(0, 12)} from ${envelope.from.streamId}`);
        return;
      }
      if (manifest && known.manifest && !manifestsAgree(known.manifest, manifest)) {
        this.log(`[swarm] rejecting conflicting inline manifest for ${summary.fileId.slice(0, 12)} from ${envelope.from.streamId}`);
        return;
      }
      known.sources.add(envelope.from.streamId);
      if (!known.manifest && manifest) known.manifest = manifest;
      if (this.wanted.has(summary.fileId)) {
        if (known.manifest) {
          this.startDownload(known.manifest);
        } else {
          this.requestManifestPages(known);
        }
      }
      return;
    }

    const record: OfferRecord = {
      summary,
      manifest,
      pageSize,
      totalPages,
      sources: new Set([envelope.from.streamId]),
      pages: new Map(),
      requestedAt: new Map(),
      sourceCursor: 0,
    };
    this.offers.set(summary.fileId, record);
    this.log(`[swarm] offer: ${summary.name} (${summary.fileId.slice(0, 12)}) from ${envelope.from.streamId}`);

    if (this.wanted.has(summary.fileId)) {
      if (manifest) {
        this.startDownload(manifest);
      } else {
        this.requestManifestPages(record);
      }
    }
  }

  private handleManifestRequest(envelope: MessageEnvelope): void {
    const payload = asRecord(envelope.payload);
    if (!payload || !isSha256Hex(payload.fileId)) return;
    const pageSize = payload.pageSize;
    const pages = payload.pages;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SWARM_MANIFEST_PAGE_HASHES) return;
    if (!Array.isArray(pages) || pages.length < 1 || pages.length > MANIFEST_PAGES_PER_REQUEST) return;

    const manifest = this.sessions.get(payload.fileId)?.manifest ?? this.offers.get(payload.fileId)?.manifest;
    if (!manifest) return;
    const totalPages = Math.ceil(manifest.totalChunks / pageSize);
    const uniquePages = [...new Set(pages)];
    for (const page of uniquePages) {
      if (!Number.isInteger(page) || page < 0 || page >= totalPages) continue;
      const start = page * pageSize;
      this.bridge.bus.trySend(envelope.from.streamId, "swarm_manifest_page", {
        fileId: manifest.fileId,
        page,
        totalPages,
        pageSize,
        chunkHashesHash: manifest.chunkHashesHash,
        hashes: manifest.chunkHashes.slice(start, start + pageSize),
      } satisfies SwarmManifestPagePayload);
    }
  }

  private handleManifestPage(envelope: MessageEnvelope): void {
    const payload = parseManifestPage(envelope.payload);
    if (!payload) return;
    const offer = this.offers.get(payload.fileId);
    if (!offer || offer.manifest) return;
    if (!offer.sources.has(envelope.from.streamId)) return;
    if (
      payload.pageSize !== offer.pageSize ||
      payload.totalPages !== offer.totalPages ||
      payload.chunkHashesHash !== offer.summary.chunkHashesHash
    ) {
      this.log(`[swarm] rejecting conflicting manifest page from ${envelope.from.streamId}`);
      return;
    }

    const expected = expectedHashesOnPage(offer.summary.totalChunks, offer.pageSize, payload.page);
    if (payload.hashes.length !== expected) return;
    offer.pages.set(payload.page, payload.hashes);
    offer.requestedAt.delete(payload.page);

    if (offer.pages.size !== offer.totalPages) {
      this.requestManifestPages(offer);
      return;
    }

    const chunkHashes: string[] = [];
    for (let page = 0; page < offer.totalPages; page += 1) {
      const hashes = offer.pages.get(page);
      if (!hashes) return;
      chunkHashes.push(...hashes);
    }
    if (
      chunkHashes.length !== offer.summary.totalChunks ||
      hashChunkHashes(chunkHashes) !== offer.summary.chunkHashesHash
    ) {
      this.log(`[swarm] rejecting assembled manifest for ${offer.summary.fileId.slice(0, 12)}`);
      offer.pages.clear();
      offer.requestedAt.clear();
      return;
    }

    const manifest: SwarmManifest = { ...offer.summary, chunkHashes };
    const validationError = validateSwarmManifest(manifest);
    if (validationError) {
      this.log(`[swarm] rejecting assembled manifest: ${validationError}`);
      return;
    }
    offer.manifest = manifest;
    offer.pages.clear();
    offer.requestedAt.clear();
    this.log(`[swarm] manifest ready for ${manifest.name} (${manifest.totalChunks} chunk hashes)`);
    if (this.wanted.has(manifest.fileId)) this.startDownload(manifest);
  }

  private handleAnnounce(envelope: MessageEnvelope): void {
    const payload = asRecord(envelope.payload);
    if (!payload || !isSha256Hex(payload.fileId) || typeof payload.chunks !== "string") return;
    const session = this.sessions.get(payload.fileId);
    if (!session || payload.totalChunks !== session.manifest.totalChunks) return;
    if (!isValidChunkMapBase64(payload.chunks, session.manifest.totalChunks)) return;
    session.onPeerAnnounce(envelope.from.streamId, payload.chunks);
    this.answerAnnounce(session, envelope.from.streamId);
    this.schedulePump();
  }

  private handleHave(envelope: MessageEnvelope): void {
    const payload = asRecord(envelope.payload);
    if (!payload || !isSha256Hex(payload.fileId)) return;
    const session = this.sessions.get(payload.fileId);
    if (!session) return;

    const rawIndexes = Array.isArray(payload.indexes)
      ? payload.indexes
      : (typeof payload.index === "number" ? [payload.index] : []);
    if (rawIndexes.length > 4_096) return;
    const indexes = rawIndexes.filter(
      (index): index is number => Number.isInteger(index) && index >= 0 && index < session.manifest.totalChunks,
    );
    for (const index of indexes) session.onPeerHave(envelope.from.streamId, index);
    if (indexes.length > 0) this.schedulePump();
  }

  private handleRequest(envelope: MessageEnvelope): void {
    const payload = asRecord(envelope.payload);
    if (!payload || !isSha256Hex(payload.fileId) || !Number.isInteger(payload.index)) return;
    const session = this.sessions.get(payload.fileId);
    if (!session || payload.index < 0 || payload.index >= session.manifest.totalChunks) return;
    session.onChunkRequest(envelope.from.streamId, payload.index, payload.bin === 1);
  }

  private requestManifestPages(offer: OfferRecord): void {
    if (offer.manifest || offer.totalPages === 0) return;
    const now = Date.now();
    const pages: number[] = [];
    for (let page = 0; page < offer.totalPages && pages.length < MANIFEST_PAGES_PER_REQUEST; page += 1) {
      if (offer.pages.has(page)) continue;
      const requestedAt = offer.requestedAt.get(page) ?? 0;
      if (now - requestedAt < MANIFEST_REQUEST_RETRY_MS) continue;
      pages.push(page);
    }
    if (pages.length === 0) return;

    const sources = [...offer.sources];
    if (sources.length === 0) return;
    for (let attempt = 0; attempt < sources.length; attempt += 1) {
      const index = (offer.sourceCursor + attempt) % sources.length;
      const source = sources[index];
      const sent = this.bridge.bus.trySend(source, "swarm_manifest_request", {
        fileId: offer.summary.fileId,
        pageSize: offer.pageSize,
        pages,
      } satisfies SwarmManifestRequestPayload);
      if (!sent) continue;
      offer.sourceCursor = (index + 1) % sources.length;
      for (const page of pages) offer.requestedAt.set(page, now);
      return;
    }
  }

  private guard(label: string, envelope: MessageEnvelope, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.log(`[swarm] rejected ${label} from ${envelope.from.streamId}: ${errorMessage(error)}`);
    }
  }

  private reportError(message: string, manifest?: SwarmManifestSummary): void {
    this.log(`[swarm] ${message}`);
    this.onError?.(message, manifest);
  }

  private handleChunk(envelope: MessageEnvelope): void {
    const payload = asRecord(envelope.payload);
    if (
      !payload ||
      !isSha256Hex(payload.fileId) ||
      !Number.isInteger(payload.index) ||
      typeof payload.data !== "string"
    ) return;
    const session = this.sessions.get(payload.fileId);
    if (!session || session.isComplete()) return;
    if (payload.index < 0 || payload.index >= session.manifest.totalChunks) return;

    const expectedLength = chunkLength(payload.index, session.manifest);
    const maxBase64Length = Math.ceil(expectedLength / 3) * 4;
    if (payload.data.length > maxBase64Length + 4 || !BASE64_PATTERN.test(payload.data)) return;

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
    const validationError = validateSwarmManifest(manifest);
    if (validationError) {
      this.reportError(`cannot start ${manifest.name}: ${validationError}`, toManifestSummary(manifest));
      return false;
    }

    let session: SwarmSession;
    try {
      const savedPath = chooseSavedPath(this.downloadDir, manifest.name, manifest.fileId);
      const partPath = partPathFor(this.workDir, manifest.fileId, savedPath);
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
      this.reportError(`cannot start ${manifest.name}: ${errorMessage(err)}`, toManifestSummary(manifest));
      return false;
    }
    this.sessions.set(manifest.fileId, session);
    this.wanted.delete(manifest.fileId);

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
    let result: ReturnType<SwarmSession["finish"]>;
    try {
      result = session.finish();
    } catch (error) {
      result = { ok: false, error: errorMessage(error) };
    }
    if (!result.ok) {
      if (result.integrityFailure) {
        // Keeping a complete-but-invalid part file makes every retry scan it as
        // complete against the same bad chunk manifest and fail forever.
        session.discard();
        this.offers.delete(fileId);
        this.seeding.delete(fileId);
        this.wanted.add(fileId);
      } else {
        session.close();
      }
      this.sessions.delete(fileId);
      this.reportError(
        `finish failed for ${fileId.slice(0, 12)}: ${result.error ?? "unknown error"}` +
          (result.integrityFailure ? " (invalid part discarded)" : ""),
        toManifestSummary(session.manifest),
      );
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
    this.offers.set(fileId, createOfferRecord(manifest));
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
          const generation = this.lifecycleGeneration;
          // Fire and forget, but fall back if the lane refuses the bytes —
          // a peer that asked for binary and then got nothing would stall
          // until its request timed out, once per chunk.
          void this.bridge
            .sendBinaryTo(peerId, frame)
            .then((sent) => {
              if (
                !sent &&
                this.started &&
                this.lifecycleGeneration === generation
              ) {
                this.sendChunkAsBase64(peerId, fileId, index, bytes);
              }
            })
            .catch(() => {
              if (this.started && this.lifecycleGeneration === generation) {
                this.sendChunkAsBase64(peerId, fileId, index, bytes);
              }
            });
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
    if (!session || session.isComplete()) return;

    session.onChunkData(streamId, frame.index, frame.data);

    if (!session.isComplete()) {
      this.schedulePump();
      this.onProgress?.(session.progress());
      return;
    }
    this.completeSession(frame.fileId, session);
  }
}

type ParsedOffer =
  | {
    ok: true;
    summary: SwarmManifestSummary;
    manifest: SwarmManifest | null;
    pageSize: number;
    totalPages: number;
  }
  | { ok: false; error: string };

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseOfferPayload(value: unknown): ParsedOffer {
  const data = asRecord(value);
  if (!data) return { ok: false, error: "payload is not an object" };
  if (
    !isSha256Hex(data.fileId) ||
    typeof data.name !== "string" ||
    typeof data.mimeType !== "string" ||
    !Number.isSafeInteger(data.size) ||
    !Number.isInteger(data.chunkSize) ||
    !Number.isInteger(data.totalChunks)
  ) {
    return { ok: false, error: "missing or invalid summary fields" };
  }

  let inlineHashes: string[] | null = null;
  if (data.chunkHashes !== undefined) {
    if (!Array.isArray(data.chunkHashes) || data.chunkHashes.length > MAX_SWARM_TOTAL_CHUNKS) {
      return { ok: false, error: "chunkHashes is invalid" };
    }
    if (!data.chunkHashes.every(isSha256Hex)) {
      return { ok: false, error: "chunkHashes contains an invalid digest" };
    }
    inlineHashes = [...data.chunkHashes];
  }

  let chunkHashesHash = isSha256Hex(data.chunkHashesHash) ? data.chunkHashesHash : null;
  if (!chunkHashesHash && inlineHashes) {
    // Compatibility with pre-paging builds that sent the full list inline.
    chunkHashesHash = hashChunkHashes(inlineHashes);
  }
  if (!chunkHashesHash) return { ok: false, error: "chunkHashesHash is missing or invalid" };

  const summary: SwarmManifestSummary = {
    fileId: data.fileId,
    name: data.name,
    mimeType: data.mimeType,
    size: data.size,
    chunkSize: data.chunkSize,
    totalChunks: data.totalChunks,
    chunkHashesHash,
  };
  const summaryError = validateManifestSummary(summary);
  if (summaryError) return { ok: false, error: summaryError };

  if (inlineHashes) {
    const manifest: SwarmManifest = { ...summary, chunkHashes: inlineHashes };
    const manifestError = validateSwarmManifest(manifest);
    if (manifestError) return { ok: false, error: manifestError };
    return {
      ok: true,
      summary,
      manifest,
      pageSize: SWARM_MANIFEST_PAGE_HASHES,
      totalPages: Math.ceil(summary.totalChunks / SWARM_MANIFEST_PAGE_HASHES),
    };
  }

  if (
    !Number.isInteger(data.manifestPageSize) ||
    data.manifestPageSize < 1 ||
    data.manifestPageSize > SWARM_MANIFEST_PAGE_HASHES ||
    !Number.isInteger(data.manifestPages)
  ) {
    return { ok: false, error: "paged manifest metadata is invalid" };
  }
  const expectedPages = Math.ceil(summary.totalChunks / data.manifestPageSize);
  if (summary.totalChunks === 0 || data.manifestPages !== expectedPages) {
    return { ok: false, error: "manifest page count does not match totalChunks" };
  }

  return {
    ok: true,
    summary,
    manifest: null,
    pageSize: data.manifestPageSize,
    totalPages: data.manifestPages,
  };
}

function parseManifestPage(value: unknown): SwarmManifestPagePayload | null {
  const data = asRecord(value);
  if (
    !data ||
    !isSha256Hex(data.fileId) ||
    !isSha256Hex(data.chunkHashesHash) ||
    !Number.isInteger(data.page) ||
    !Number.isInteger(data.totalPages) ||
    !Number.isInteger(data.pageSize) ||
    data.pageSize < 1 ||
    data.pageSize > SWARM_MANIFEST_PAGE_HASHES ||
    data.totalPages < 1 ||
    data.totalPages > MAX_SWARM_TOTAL_CHUNKS ||
    data.page < 0 ||
    data.page >= data.totalPages ||
    !Array.isArray(data.hashes) ||
    data.hashes.length > data.pageSize ||
    !data.hashes.every(isSha256Hex)
  ) {
    return null;
  }
  return {
    fileId: data.fileId,
    page: data.page,
    totalPages: data.totalPages,
    pageSize: data.pageSize,
    chunkHashesHash: data.chunkHashesHash,
    hashes: [...data.hashes],
  };
}

function toOfferPayload(manifest: SwarmManifest): SwarmOfferPayload {
  const summary = toManifestSummary(manifest);
  if (manifest.totalChunks <= SWARM_INLINE_MANIFEST_HASHES) {
    return { ...summary, chunkHashes: [...manifest.chunkHashes] };
  }
  return {
    ...summary,
    manifestPageSize: SWARM_MANIFEST_PAGE_HASHES,
    manifestPages: Math.ceil(manifest.totalChunks / SWARM_MANIFEST_PAGE_HASHES),
  };
}

function createOfferRecord(manifest: SwarmManifest): OfferRecord {
  return {
    summary: toManifestSummary(manifest),
    manifest,
    pageSize: SWARM_MANIFEST_PAGE_HASHES,
    totalPages: Math.ceil(manifest.totalChunks / SWARM_MANIFEST_PAGE_HASHES),
    sources: new Set(),
    pages: new Map(),
    requestedAt: new Map(),
    sourceCursor: 0,
  };
}

function toOfferInfo(record: OfferRecord): SwarmOfferInfo {
  return { ...record.summary, manifestReady: record.manifest !== null };
}

function summariesAgree(a: SwarmManifestSummary, b: SwarmManifestSummary): boolean {
  return (
    a.fileId === b.fileId &&
    a.size === b.size &&
    a.chunkSize === b.chunkSize &&
    a.totalChunks === b.totalChunks &&
    a.chunkHashesHash === b.chunkHashesHash
  );
}

function expectedHashesOnPage(totalChunks: number, pageSize: number, page: number): number {
  return Math.max(0, Math.min(pageSize, totalChunks - page * pageSize));
}

function isValidChunkMapBase64(value: string, totalChunks: number): boolean {
  const expectedBytes = Math.ceil(totalChunks / 8);
  const expectedEncoded = Math.ceil(expectedBytes / 3) * 4;
  if (value.length !== expectedEncoded || !BASE64_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, "base64").byteLength === expectedBytes;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null ? value as Record<string, any> : null;
}

function chooseSavedPath(downloadDir: string, name: string, fileId: string): string {
  let safe = path.basename(name || "download")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180) || "download";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  const direct = path.join(downloadDir, safe);
  if (!existsSync(direct)) return direct;

  const parsed = path.parse(safe);
  const tagged = path.join(downloadDir, `${parsed.name}_${fileId.slice(0, 8)}${parsed.ext}`);
  if (!existsSync(tagged)) return tagged;
  for (let suffix = 2; suffix < 100_000; suffix += 1) {
    const candidate = path.join(downloadDir, `${parsed.name}_${fileId.slice(0, 8)}_${suffix}${parsed.ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`could not choose an unused destination for ${safe}`);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { ChunkMap };
