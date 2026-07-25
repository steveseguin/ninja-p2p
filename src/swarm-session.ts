/**
 * Swarm Session
 *
 * Holds the live state of one file transfer: what we have, what each peer has,
 * what is in flight, and who has been reliable. It is transport-agnostic — it
 * emits requests and chunks through a `SwarmSend` interface — so the whole
 * state machine is testable without a network.
 *
 * The property that matters: a session serves any chunk it has verified, even
 * while it is still downloading the rest. A peer that is 10% done is already a
 * source for that 10%, which is what turns a one-to-one transfer into a swarm.
 */

import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import {
  ChunkFile,
  ChunkMap,
  chunkLength,
  createPeerStats,
  planChunkRequests,
  recordPeerRtt,
  sha256Hex,
  type SwarmManifest,
  type SwarmPeerState,
  type SwarmPeerStats,
} from "./swarm.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Floor on the wait before a request is written off.
 *
 * Chosen to be far longer than any healthy delivery — chunks normally land in
 * well under 200ms even with several downloaders sharing a seeder — so a peer
 * that is merely busy is never mistaken for one that has dropped the request.
 */
export const MIN_REQUEST_TIMEOUT_MS = 3_000;
/** Round trips of grace before a request is assumed lost. */
export const REQUEST_TIMEOUT_RTT_MULTIPLIER = 12;

/** How the session reaches the network. */
export type SwarmSend = {
  /**
   * @returns false when the transport did not take the request, so the chunk
   * can be planned again straight away rather than occupying a slot until it
   * times out.
   */
  request(peerId: string, index: number): boolean;
  /**
   * @param binary Whether the requester said it can take raw bytes. The session
   * passes the requester's preference straight through rather than deciding —
   * only the transport knows whether it can honour it.
   */
  chunk(peerId: string, index: number, bytes: Uint8Array, binary: boolean): void;
  /**
   * Tell the listed peers which chunks we now hold. Either list being empty
   * means there is nothing to say, and the transport should send nothing.
   */
  have(indexes: number[], toPeerIds: string[]): void;
  /** Broadcast our full bitfield. */
  announce(chunksBase64: string): void;
  /** Send our bitfield to one peer only. */
  announceTo(peerId: string, chunksBase64: string): void;
};

export type SwarmSessionOptions = {
  manifest: SwarmManifest;
  partPath: string;
  savedPath: string;
  send: SwarmSend;
  /** Pre-seeded bitfield. A sender passes a full map; a receiver passes nothing. */
  have?: ChunkMap;
  now?: () => number;
  requestTimeoutMs?: number;
  maxInFlightPerPeer?: number;
  maxInFlightTotal?: number;
  /** Tie-break source for piece selection. Injectable for deterministic tests. */
  random?: () => number;
  log?: (message: string) => void;
};

export type SwarmProgress = {
  fileId: string;
  name: string;
  size: number;
  totalChunks: number;
  haveChunks: number;
  inFlight: number;
  peers: number;
  complete: boolean;
  percent: number;
};

type InFlightRequest = {
  peerId: string;
  index: number;
  sentAt: number;
};

export class SwarmSession {
  readonly manifest: SwarmManifest;
  readonly savedPath: string;

  private readonly file: ChunkFile;
  private readonly send: SwarmSend;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly maxInFlightPerPeer?: number;
  private readonly maxInFlightTotal?: number;
  private readonly random?: () => number;
  private readonly log: (message: string) => void;

  private readonly have: ChunkMap;
  private readonly peerChunks = new Map<string, ChunkMap>();
  private readonly peerStats = new Map<string, SwarmPeerStats>();
  private readonly inFlight = new Map<number, InFlightRequest>();
  /** Chunks acquired since the last flush, batched to keep the room quiet. */
  private pendingHave: number[] = [];
  /** Requests to a peer that have timed out with nothing arriving in between. */
  private readonly consecutiveTimeouts = new Map<string, number>();

  private completed = false;

  constructor(options: SwarmSessionOptions) {
    this.manifest = options.manifest;
    this.savedPath = options.savedPath;
    this.send = options.send;
    this.now = options.now ?? (() => Date.now());
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxInFlightPerPeer = options.maxInFlightPerPeer;
    this.maxInFlightTotal = options.maxInFlightTotal;
    this.random = options.random;
    this.log = options.log ?? (() => {});
    // A seed session is handed a pre-filled bitfield and points at the user's
    // own file; a download owns its part file and must not share it.
    this.file = new ChunkFile(options.partPath, options.manifest, options.have === undefined);
    // A download credits whatever a previous, interrupted run already verified.
    this.have = options.have ?? this.file.scanVerified();
  }

  // ── Peer tracking ──────────────────────────────────────────────────────────

  setPeerChunks(peerId: string, chunks: ChunkMap): void {
    this.peerChunks.set(peerId, chunks);
    if (!this.peerStats.has(peerId)) this.peerStats.set(peerId, createPeerStats());
  }

  onPeerAnnounce(peerId: string, chunksBase64: string): void {
    this.setPeerChunks(peerId, ChunkMap.fromBase64(chunksBase64, this.manifest.totalChunks));
  }

  onPeerHave(peerId: string, index: number): void {
    const existing = this.peerChunks.get(peerId) ?? new ChunkMap(this.manifest.totalChunks);
    existing.set(index);
    this.setPeerChunks(peerId, existing);
  }

  removePeer(peerId: string): void {
    this.peerChunks.delete(peerId);
    this.peerStats.delete(peerId);
    this.consecutiveTimeouts.delete(peerId);
    // Anything outstanding with that peer is never arriving; free it to re-plan.
    for (const [index, request] of [...this.inFlight]) {
      if (request.peerId === peerId) this.inFlight.delete(index);
    }
  }

  peerCount(): number {
    return this.peerChunks.size;
  }

  statsFor(peerId: string): SwarmPeerStats | undefined {
    return this.peerStats.get(peerId);
  }

  // ── Serving ────────────────────────────────────────────────────────────────

  /**
   * Answer a peer's request. Works mid-download: if we hold and verified the
   * chunk, we can serve it, whether or not the rest has arrived.
   */
  onChunkRequest(peerId: string, index: number, binary = false): boolean {
    if (!this.have.has(index)) return false;
    const bytes = this.file.readChunk(index);
    if (!bytes) return false;
    this.send.chunk(peerId, index, bytes, binary);
    return true;
  }

  // ── Receiving ──────────────────────────────────────────────────────────────

  /**
   * Accept a delivered chunk. Returns false when it fails verification, in
   * which case the sending peer is charged a failure and the chunk stays
   * outstanding for someone else to serve.
   */
  onChunkData(peerId: string, index: number, data: Uint8Array): boolean {
    const request = this.inFlight.get(index);
    if (request) this.inFlight.delete(index);

    if (this.have.has(index)) {
      // A duplicate from a slower peer. Harmless, and not a failure.
      return true;
    }

    const stats = this.peerStats.get(peerId) ?? createPeerStats();
    this.peerStats.set(peerId, stats);

    if (!this.file.writeChunk(index, data)) {
      stats.failures += 1;
      this.log(`[swarm] bad chunk ${index} from ${peerId} (${stats.failures} failure(s))`);
      return false;
    }

    // Anything arriving proves the path works, whatever came before.
    this.consecutiveTimeouts.delete(peerId);

    // Only time requests we actually issued to this peer.
    if (request && request.peerId === peerId) {
      recordPeerRtt(stats, this.now() - request.sentAt);
    }
    stats.delivered += 1;

    this.have.set(index);
    // Queued rather than sent: one message per chunk per interested peer costs
    // chunks x peers messages, all on the same control channel the chunk
    // requests use. Measured with five downloaders of a 164-chunk file, that
    // flood cost an order of magnitude of throughput. The pump flushes this as
    // a batch, so a burst of arrivals becomes one message.
    this.pendingHave.push(index);
    return true;
  }

  // ── Driving ────────────────────────────────────────────────────────────────

  /**
   * Give up on everything outstanding without blaming anyone.
   *
   * Used when our own connection was replaced: every request was addressed to a
   * path that no longer exists, so waiting out their timeouts wastes the length
   * of a timeout per chunk. The peers did nothing wrong, so no failure is
   * charged — scoring them down for our outage would send the next requests to
   * the wrong places.
   */
  abandonInFlight(): number {
    const abandoned = this.inFlight.size;
    this.inFlight.clear();
    return abandoned;
  }

  /** Expire outstanding requests that never came back, charging the peer. */
  expireTimeouts(): number {
    const now = this.now();
    let expired = 0;

    for (const [index, request] of [...this.inFlight]) {
      if (now - request.sentAt < this.timeoutFor(request.peerId)) continue;
      this.inFlight.delete(index);
      const stats = this.peerStats.get(request.peerId) ?? createPeerStats();
      stats.failures += 1;
      this.peerStats.set(request.peerId, stats);
      this.consecutiveTimeouts.set(request.peerId, (this.consecutiveTimeouts.get(request.peerId) ?? 0) + 1);
      expired += 1;
      this.log(`[swarm] request for chunk ${index} to ${request.peerId} timed out`);
    }

    return expired;
  }

  /**
   * How long to wait on this peer before assuming the request is lost.
   *
   * Chunks are occasionally dropped even on a healthy local link — measured on
   * an idle machine, one downloader in three lost a chunk and the flat 15s
   * timeout turned a 2s transfer into 17s. A peer answering in 80ms does not
   * need fifteen seconds of grace to prove it has failed.
   *
   * Scaling by measured round-trip time, with a floor far above any healthy
   * delivery, shortens that without risking the opposite mistake: a peer
   * serving several downloaders is slow rather than broken, and expiring it
   * early costs twice — the chunk is re-requested, and the peer is charged a
   * failure it did not earn. A peer we have never timed keeps the full ceiling.
   */
  private timeoutFor(peerId: string): number {
    const rtt = this.peerStats.get(peerId)?.rttMs;
    if (rtt === null || rtt === undefined) return this.requestTimeoutMs;
    return Math.min(
      this.requestTimeoutMs,
      Math.max(MIN_REQUEST_TIMEOUT_MS, rtt * REQUEST_TIMEOUT_RTT_MULTIPLIER),
    );
  }

  /**
   * Peers that have gone quiet: several requests timed out with nothing
   * arriving in between. One timeout is ordinary; a run of them with no
   * deliveries is the signature of a path that is open but not carrying.
   */
  unresponsivePeers(threshold: number): string[] {
    const out: string[] = [];
    for (const [peerId, count] of this.consecutiveTimeouts) {
      if (count >= threshold) out.push(peerId);
    }
    return out;
  }

  /** Forget the quiet streak for a peer whose connection is being rebuilt. */
  clearUnresponsive(peerId: string): void {
    this.consecutiveTimeouts.delete(peerId);
  }

  /** Plan and issue the next batch of chunk requests. Returns how many went out. */
  pump(): number {
    // Before the completion check: the batch containing the final chunk still
    // has to reach the peers still downloading.
    this.flushHave();
    if (this.isComplete()) return 0;
    this.expireTimeouts();
    // Keep the part-file lock warm, so a slow but healthy transfer is never
    // mistaken for one abandoned by a killed process.
    this.file.touchLock();

    const peers: SwarmPeerState[] = [];
    for (const [peerId, chunks] of this.peerChunks) {
      peers.push({
        peerId,
        chunks,
        inFlight: this.inFlightForPeer(peerId),
        stats: this.peerStats.get(peerId),
      });
    }

    const plans = planChunkRequests(this.have, peers, new Set(this.inFlight.keys()), {
      maxInFlightPerPeer: this.maxInFlightPerPeer,
      maxInFlightTotal: this.maxInFlightTotal,
      random: this.random,
    });

    let issued = 0;
    for (const plan of plans) {
      // Only occupy a slot if the request actually left. Assuming it did meant
      // a request lost to a momentary transport hiccup held its chunk hostage
      // for the full request timeout — measured as a 60s stall after a
      // signalling blip that the data channel itself sailed through.
      if (!this.send.request(plan.peerId, plan.index)) continue;
      this.inFlight.set(plan.index, {
        peerId: plan.peerId,
        index: plan.index,
        sentAt: this.now(),
      });
      issued += 1;
    }

    return issued;
  }

  announce(): void {
    this.send.announce(this.have.toBase64());
  }

  /**
   * Send any queued "I now hold these" news.
   *
   * A peer that already holds the whole file gains nothing from it, so only
   * peers still missing something are told at all.
   */
  flushHave(): void {
    if (this.pendingHave.length === 0) return;
    const indexes = this.pendingHave;
    this.pendingHave = [];
    const interested = this.peersMissingAnything();
    if (interested.length === 0) return;
    this.send.have(indexes, interested);
  }

  /** Peers that still want something, so progress is only told to them. */
  private peersMissingAnything(): string[] {
    const interested: string[] = [];
    for (const [peerId, chunks] of this.peerChunks) {
      if (!chunks.isComplete()) interested.push(peerId);
    }
    return interested;
  }

  /** Send our bitfield to one peer, without telling the whole room. */
  announceTo(peerId: string): void {
    this.send.announceTo(peerId, this.have.toBase64());
  }

  /**
   * Whether we hold a chunk this peer does not.
   *
   * Used to answer a peer's announce with our own, which is what lets a fresh
   * downloader start immediately instead of waiting out the announce interval.
   * Gating on "can I actually help" is what stops that reply turning into a
   * broadcast storm: a peer we cannot help gets nothing back, so the exchange
   * terminates after one round.
   */
  canHelp(peerId: string): boolean {
    const theirs = this.peerChunks.get(peerId);
    if (!theirs) return false;
    for (let index = 0; index < this.manifest.totalChunks; index += 1) {
      if (this.have.has(index) && !theirs.has(index)) return true;
    }
    return false;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  isComplete(): boolean {
    return this.have.isComplete();
  }

  chunkMap(): ChunkMap {
    return this.have;
  }

  progress(): SwarmProgress {
    const haveChunks = this.have.count();
    return {
      fileId: this.manifest.fileId,
      name: this.manifest.name,
      size: this.manifest.size,
      totalChunks: this.manifest.totalChunks,
      haveChunks,
      inFlight: this.inFlight.size,
      peers: this.peerChunks.size,
      complete: this.have.isComplete(),
      percent: this.manifest.totalChunks === 0
        ? 100
        : Math.floor((haveChunks / this.manifest.totalChunks) * 100),
    };
  }

  /**
   * Verify the assembled file and move it into place.
   *
   * Every chunk was already hash-checked on arrival, so this is belt and
   * braces — but it is cheap next to the download and it is the only thing that
   * catches a wrong manifest or a damaged part file.
   */
  finish(): { ok: boolean; savedPath?: string; error?: string } {
    if (!this.isComplete()) {
      return { ok: false, error: `incomplete: ${this.have.count()}/${this.manifest.totalChunks} chunks` };
    }
    if (this.completed) {
      return { ok: true, savedPath: this.savedPath };
    }

    this.file.close();

    if (this.manifest.totalChunks === 0) {
      // An empty file still needs to exist at the destination.
      renameSync(this.file.filePath, this.savedPath);
      this.completed = true;
      return { ok: true, savedPath: this.savedPath };
    }

    const assembled = new Uint8Array(readFileSync(this.file.filePath));
    if (assembled.byteLength !== this.manifest.size) {
      return { ok: false, error: `size mismatch: ${assembled.byteLength} != ${this.manifest.size}` };
    }
    if (sha256Hex(assembled) !== this.manifest.fileId) {
      return { ok: false, error: "sha256 mismatch on the assembled file" };
    }

    renameSync(this.file.filePath, this.savedPath);
    this.completed = true;
    return { ok: true, savedPath: this.savedPath };
  }

  close(): void {
    this.file.close();
  }

  /** Drop the partial file. Used when a transfer is abandoned. */
  discard(): void {
    this.file.close();
    if (existsSync(this.file.filePath)) rmSync(this.file.filePath, { force: true });
  }

  private inFlightForPeer(peerId: string): number {
    let count = 0;
    for (const request of this.inFlight.values()) {
      if (request.peerId === peerId) count += 1;
    }
    return count;
  }
}

/** Open a session over a file we already hold in full, ready to seed. */
export function createSeedSession(
  manifest: SwarmManifest,
  filePath: string,
  send: SwarmSend,
  options: Partial<SwarmSessionOptions> = {},
): SwarmSession {
  return new SwarmSession({
    ...options,
    manifest,
    partPath: filePath,
    savedPath: filePath,
    have: ChunkMap.full(manifest.totalChunks),
    send,
  });
}

export { chunkLength };
