/**
 * Swarm Transfer
 *
 * The original file transfer was one sender pushing base64 chunks in strict
 * order to one receiver. That caps throughput at a single peer's upload, breaks
 * if a chunk arrives out of order, and cannot resume from anyone else.
 *
 * This is the torrent-shaped replacement. Files are content-addressed by their
 * sha256, so every peer holding the same bytes is interchangeable. Peers publish
 * a bitfield of the chunks they hold, chunks are pulled rather than pushed, and
 * a peer can start serving a chunk the moment it has verified it — while still
 * downloading the rest.
 *
 * The SDK gives one data channel per peer, so parallelism comes from two places:
 * requesting from several peers at once, and keeping several requests in flight
 * on each channel rather than waiting for each to land.
 *
 * This module is deliberately pure and I/O-light so the hard parts — bitfields,
 * piece selection, verification — are testable without a network.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const DEFAULT_SWARM_CHUNK_SIZE = 64_000;
export const DEFAULT_MAX_IN_FLIGHT_PER_PEER = 4;
export const DEFAULT_MAX_IN_FLIGHT_TOTAL = 24;

/** Room left for the JSON envelope wrapped around a base64 chunk. */
export const SWARM_ENVELOPE_HEADROOM = 4_096;

/** After this long with no progress, a lock is treated as abandoned. */
export const SWARM_LOCK_STALE_MS = 5 * 60_000;

/**
 * Where an in-progress download is written.
 *
 * Keyed by content **and destination**, not content alone. Two `fetch` runs of
 * the same file into different folders are a perfectly ordinary thing to do,
 * and sharing one `.part` between them meant they wrote over each other and the
 * first to finish renamed the file out from under the rest — which surfaced as
 * an ENOENT crash, having already corrupted whatever the others had written.
 *
 * Keeping the destination in the key also preserves resume: the same fetch, run
 * again, lands on the same part file and picks up where it left off.
 */
export function partPathFor(workDir: string, fileId: string, savedPath: string): string {
  const destination = sha256Hex(new TextEncoder().encode(path.resolve(savedPath))).slice(0, 12);
  return path.join(workDir, `${fileId}-${destination}.part`);
}

/**
 * Largest chunk that still fits one SCTP message once base64-encoded.
 *
 * Only the fallback path needs this. Binary chunks add a 40-byte header, so a
 * 64 KB chunk fits inside even the 65536 every WebRTC implementation must
 * support. Base64 inflates by 4/3, so the same chunk becomes 85 KB and would be
 * refused by a peer that negotiated only that minimum — a failure that would
 * only ever show up against an implementation we had not tested with.
 *
 * Every implementation measured here negotiates 262144, which is why this has
 * never bitten. It is a guard, not a tuning knob: chunk size was measured
 * against throughput at 64 KB, 128 KB and 192 KB and moved it by under 2%.
 */
export function maxSafeChunkSize(messageLimit: number): number {
  const budget = messageLimit - SWARM_ENVELOPE_HEADROOM;
  if (budget <= 0) return 1_024;
  return Math.max(1_024, Math.floor((budget * 3) / 4));
}

/** Immutable description of a file, shared by every peer in its swarm. */
export type SwarmManifest = {
  /** sha256 of the whole file. Also the swarm identity. */
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  /** sha256 per chunk, so a bad chunk can be blamed on the peer that sent it. */
  chunkHashes: string[];
};

// ── Chunk bitfield ───────────────────────────────────────────────────────────

/**
 * Which chunks a peer holds.
 *
 * A bitfield rather than a list: a 4 GB file at 64 KB chunks is ~65k chunks,
 * which is 8 KB as bits and would be megabytes as JSON indices. Peers exchange
 * these constantly, so the compact form matters.
 */
export class ChunkMap {
  readonly totalChunks: number;
  private readonly bits: Uint8Array;
  private present = 0;

  constructor(totalChunks: number, bits?: Uint8Array) {
    if (!Number.isInteger(totalChunks) || totalChunks < 0) {
      throw new Error(`invalid totalChunks: ${totalChunks}`);
    }
    this.totalChunks = totalChunks;
    this.bits = bits ?? new Uint8Array(byteLengthFor(totalChunks));
    if (this.bits.length < byteLengthFor(totalChunks)) {
      throw new Error("bitfield too short for totalChunks");
    }
    this.present = this.recount();
  }

  static full(totalChunks: number): ChunkMap {
    const map = new ChunkMap(totalChunks);
    for (let i = 0; i < totalChunks; i += 1) map.set(i);
    return map;
  }

  static fromBase64(value: string, totalChunks: number): ChunkMap {
    const bits = new Uint8Array(Buffer.from(value, "base64"));
    const needed = byteLengthFor(totalChunks);
    if (bits.length < needed) {
      const padded = new Uint8Array(needed);
      padded.set(bits);
      return new ChunkMap(totalChunks, padded);
    }
    return new ChunkMap(totalChunks, bits.subarray(0, needed));
  }

  toBase64(): string {
    return Buffer.from(this.bits).toString("base64");
  }

  has(index: number): boolean {
    if (index < 0 || index >= this.totalChunks) return false;
    return (this.bits[index >> 3] & (1 << (index & 7))) !== 0;
  }

  set(index: number): boolean {
    if (index < 0 || index >= this.totalChunks) return false;
    if (this.has(index)) return false;
    this.bits[index >> 3] |= 1 << (index & 7);
    this.present += 1;
    return true;
  }

  count(): number {
    return this.present;
  }

  isComplete(): boolean {
    return this.present === this.totalChunks;
  }

  missing(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.totalChunks; i += 1) {
      if (!this.has(i)) out.push(i);
    }
    return out;
  }

  clone(): ChunkMap {
    return new ChunkMap(this.totalChunks, Uint8Array.from(this.bits));
  }

  private recount(): number {
    let total = 0;
    for (let i = 0; i < this.totalChunks; i += 1) {
      if ((this.bits[i >> 3] & (1 << (i & 7))) !== 0) total += 1;
    }
    return total;
  }
}

function byteLengthFor(totalChunks: number): number {
  return Math.ceil(totalChunks / 8);
}

// ── Piece selection ──────────────────────────────────────────────────────────

/**
 * What we have actually observed about a peer.
 *
 * Every field here is measured from real traffic — no declared capacity, no
 * trust tiers, nothing a peer can assert about itself. A peer that claims to be
 * fast and then is not will simply score worse after a few chunks.
 */
export type SwarmPeerStats = {
  /** Exponentially weighted round-trip time for chunk requests, or null until measured. */
  rttMs: number | null;
  /** Requests that timed out or returned a chunk failing its hash. */
  failures: number;
  /** Chunks delivered and verified. */
  delivered: number;
};

export type SwarmPeerState = {
  peerId: string;
  chunks: ChunkMap;
  /** How many requests are already outstanding with this peer. */
  inFlight: number;
  stats?: SwarmPeerStats;
};

/** RTT assumed for a peer we have not measured yet, so new peers still get tried. */
export const UNKNOWN_PEER_RTT_MS = 250;
const FAILURE_PENALTY_MS = 2_000;
const QUEUE_PENALTY_MS = 250;
const PROVEN_PEER_BONUS_MS = 10;
const PROVEN_PEER_BONUS_CAP = 20;

export function createPeerStats(): SwarmPeerStats {
  return { rttMs: null, failures: 0, delivered: 0 };
}

/** Fold a new RTT sample in. Weighted toward history so one spike cannot swing it. */
export function recordPeerRtt(stats: SwarmPeerStats, sampleMs: number): SwarmPeerStats {
  if (!Number.isFinite(sampleMs) || sampleMs < 0) return stats;
  stats.rttMs = stats.rttMs === null ? sampleMs : stats.rttMs * 0.7 + sampleMs * 0.3;
  return stats;
}

/**
 * Rank a peer for serving the next chunk. Lower is better, and the units are
 * milliseconds throughout so the number stays explainable: it is roughly
 * "expected delay if we ask this peer".
 */
export function scorePeer(peer: SwarmPeerState): number {
  const stats = peer.stats;
  let score = stats?.rttMs ?? UNKNOWN_PEER_RTT_MS;
  score += (stats?.failures ?? 0) * FAILURE_PENALTY_MS;
  score += peer.inFlight * QUEUE_PENALTY_MS;
  score -= Math.min(stats?.delivered ?? 0, PROVEN_PEER_BONUS_CAP) * PROVEN_PEER_BONUS_MS;
  return score;
}

export type ChunkRequestPlan = {
  peerId: string;
  index: number;
};

export type PlanOptions = {
  maxInFlightPerPeer?: number;
  maxInFlightTotal?: number;
  /**
   * Tie-break among equally rare chunks. Injectable so tests stay deterministic;
   * everything else about planning already is.
   */
  random?: () => number;
};

/**
 * Decide what to ask for next.
 *
 * Rarest-first: chunks held by the fewest peers are fetched first, so a swarm
 * does not lose the only copy of a chunk when the peer holding it leaves. Among
 * peers that can serve a chunk, the best-scoring one wins — measured latency,
 * observed failures, and current queue depth — which spreads load and routes
 * around bad peers without any central coordination.
 *
 * Ties are broken randomly, and that is load-bearing rather than a detail. Ties
 * are the normal case at the start of a download, when every chunk has exactly
 * the same rarity. Breaking them by index meant every downloader asked for the
 * same chunks in the same order, so downloaders never held anything the others
 * lacked and could never serve each other — three leechers against one seeder
 * measured at exactly one third the speed of one, with no peer-to-peer traffic
 * at all. Random selection makes them diverge immediately.
 */
export function planChunkRequests(
  have: ChunkMap,
  peers: SwarmPeerState[],
  inFlightIndices: ReadonlySet<number>,
  options: PlanOptions = {},
): ChunkRequestPlan[] {
  const maxPerPeer = options.maxInFlightPerPeer ?? DEFAULT_MAX_IN_FLIGHT_PER_PEER;
  const maxTotal = options.maxInFlightTotal ?? DEFAULT_MAX_IN_FLIGHT_TOTAL;

  const budget = new Map<string, number>();
  let totalInFlight = 0;
  for (const peer of peers) {
    budget.set(peer.peerId, Math.max(0, maxPerPeer - peer.inFlight));
    totalInFlight += peer.inFlight;
  }

  let remainingTotal = Math.max(0, maxTotal - totalInFlight);
  if (remainingTotal === 0) return [];

  // Rarity across the peers we can actually reach right now.
  const random = options.random ?? Math.random;
  const candidates: Array<{ index: number; rarity: number; tiebreak: number }> = [];
  for (let index = 0; index < have.totalChunks; index += 1) {
    if (have.has(index) || inFlightIndices.has(index)) continue;
    let rarity = 0;
    for (const peer of peers) {
      if (peer.chunks.has(index)) rarity += 1;
    }
    if (rarity > 0) candidates.push({ index, rarity, tiebreak: random() });
  }

  // Rarest first, then random among equals — see the note above.
  candidates.sort((a, b) => a.rarity - b.rarity || a.tiebreak - b.tiebreak);

  const plans: ChunkRequestPlan[] = [];
  const assigned = new Map<string, number>();

  for (const candidate of candidates) {
    if (remainingTotal === 0) break;

    let chosen: string | null = null;
    let chosenScore = Number.POSITIVE_INFINITY;

    for (const peer of peers) {
      if (!peer.chunks.has(candidate.index)) continue;
      if ((budget.get(peer.peerId) ?? 0) <= 0) continue;
      // Count work already assigned in this same pass, so one fast peer does
      // not get handed the entire batch.
      const score = scorePeer({
        ...peer,
        inFlight: peer.inFlight + (assigned.get(peer.peerId) ?? 0),
      });
      if (score < chosenScore) {
        chosen = peer.peerId;
        chosenScore = score;
      }
    }

    if (!chosen) continue;

    plans.push({ peerId: chosen, index: candidate.index });
    budget.set(chosen, (budget.get(chosen) ?? 0) - 1);
    assigned.set(chosen, (assigned.get(chosen) ?? 0) + 1);
    remainingTotal -= 1;
  }

  return plans;
}

// ── Chunk storage ────────────────────────────────────────────────────────────

export function chunkOffset(index: number, chunkSize: number): number {
  return index * chunkSize;
}

export function chunkLength(index: number, manifest: Pick<SwarmManifest, "size" | "chunkSize">): number {
  const start = index * manifest.chunkSize;
  return Math.max(0, Math.min(manifest.chunkSize, manifest.size - start));
}

/**
 * A partially downloaded file backed by a sparse `.part` on disk.
 *
 * Chunks are written at their byte offset rather than appended, which is what
 * makes out-of-order and multi-source delivery possible at all.
 */
export class ChunkFile {
  readonly filePath: string;
  readonly manifest: SwarmManifest;
  private fd: number | null = null;
  private lockPath: string | null = null;

  /**
   * @param exclusive Refuse to open if another live process holds this file.
   * Only a download needs it — a seed session opens the user's own file
   * read-mostly and several of those coexisting is fine.
   */
  constructor(filePath: string, manifest: SwarmManifest, exclusive = false) {
    this.filePath = filePath;
    this.manifest = manifest;
    if (exclusive) this.lockPath = `${filePath}.lock`;
  }

  open(): void {
    if (this.fd !== null) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.acquireLock();
    // r+ keeps whatever is already there so an interrupted transfer resumes;
    // w+ creates it the first time.
    this.fd = openSync(this.filePath, existsSync(this.filePath) ? "r+" : "w+");
  }

  /**
   * Work out which chunks this file already holds, by hashing them.
   *
   * Keeping the bytes across a restart is only half of resuming; without this
   * the bitfield starts empty and every chunk on disk is fetched again. That is
   * what the code did, so "resume after an interruption" was true of the file
   * and false of the transfer.
   *
   * Every chunk is verified rather than inferred from the file's length. A part
   * file is written at byte offsets, so a gap reads back as zeros and a
   * truncated write leaves a partial chunk — neither is distinguishable from
   * real data by size alone, and trusting either would silently corrupt the
   * result. Hashing costs one pass over the file, which is only paid when a
   * part file already exists.
   */
  scanVerified(): ChunkMap {
    const map = new ChunkMap(this.manifest.totalChunks);
    if (!existsSync(this.filePath)) return map;

    const size = statSync(this.filePath).size;
    if (size === 0) return map;

    this.open();
    for (let index = 0; index < this.manifest.totalChunks; index += 1) {
      const length = chunkLength(index, this.manifest);
      const offset = chunkOffset(index, this.manifest.chunkSize);
      if (offset + length > size) continue;

      const buffer = new Uint8Array(length);
      if (length > 0) {
        try {
          if (readSync(this.fd!, buffer, 0, length, offset) !== length) continue;
        } catch {
          continue;
        }
      }
      if (sha256Hex(buffer) === this.manifest.chunkHashes[index]) map.set(index);
    }
    return map;
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    this.releaseLock();
  }

  /**
   * Claim the part file, or explain who has it.
   *
   * Two downloads of the same file to the same folder is the one case the
   * destination-keyed path cannot separate, and it is a genuine conflict rather
   * than something to paper over — so fail loudly instead of interleaving
   * writes. A lock left behind by a killed process goes stale rather than
   * blocking that destination forever.
   */
  private acquireLock(): void {
    if (!this.lockPath) return;

    try {
      closeSync(openSync(this.lockPath, "wx"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      const age = Date.now() - statSync(this.lockPath).mtimeMs;
      if (age < SWARM_LOCK_STALE_MS) {
        throw new Error(
          `another download of this file to this location is already running ` +
            `(lock held for ${Math.round(age / 1000)}s at ${this.lockPath})`,
        );
      }
      rmSync(this.lockPath, { force: true });
      closeSync(openSync(this.lockPath, "wx"));
    }
    writeFileSync(this.lockPath, `${process.pid}\n`);
  }

  private releaseLock(): void {
    if (!this.lockPath) return;
    rmSync(this.lockPath, { force: true });
  }

  /** Refresh the lock so a long, healthy transfer is never mistaken for stale. */
  touchLock(): void {
    if (!this.lockPath || this.fd === null) return;
    try {
      const now = new Date();
      utimesSync(this.lockPath, now, now);
    } catch { /* the lock going missing is not worth failing a transfer over */ }
  }

  /**
   * Verify and store one chunk. Returns false when the bytes do not match the
   * manifest hash, which means the peer that sent them is wrong or hostile —
   * the chunk is dropped and can be re-fetched from someone else.
   */
  writeChunk(index: number, bytes: Uint8Array): boolean {
    if (index < 0 || index >= this.manifest.totalChunks) return false;
    if (bytes.byteLength !== chunkLength(index, this.manifest)) return false;
    if (sha256Hex(bytes) !== this.manifest.chunkHashes[index]) return false;

    this.open();
    writeSync(this.fd!, bytes, 0, bytes.byteLength, chunkOffset(index, this.manifest.chunkSize));
    return true;
  }

  readChunk(index: number): Uint8Array | null {
    if (index < 0 || index >= this.manifest.totalChunks) return null;
    const length = chunkLength(index, this.manifest);
    const buffer = new Uint8Array(length);
    if (length === 0) return buffer;

    this.open();
    const read = readSync(this.fd!, buffer, 0, length, chunkOffset(index, this.manifest.chunkSize));
    if (read !== length) return null;
    return buffer;
  }
}

// ── Manifest construction ────────────────────────────────────────────────────

/** Build a manifest by hashing a file's bytes chunk by chunk. */
export function buildManifest(
  bytes: Uint8Array,
  name: string,
  mimeType: string,
  chunkSize = DEFAULT_SWARM_CHUNK_SIZE,
): SwarmManifest {
  const normalizedChunkSize = Math.max(1_024, chunkSize);
  const size = bytes.byteLength;
  const totalChunks = size === 0 ? 0 : Math.ceil(size / normalizedChunkSize);
  const chunkHashes: string[] = [];

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * normalizedChunkSize;
    chunkHashes.push(sha256Hex(bytes.subarray(start, Math.min(start + normalizedChunkSize, size))));
  }

  return {
    fileId: sha256Hex(bytes),
    name,
    mimeType,
    size,
    chunkSize: normalizedChunkSize,
    totalChunks,
    chunkHashes,
  };
}

/**
 * Confirm two peers are describing the same bytes before trading chunks.
 * Without this a peer could advertise a familiar fileId while serving a
 * different file's chunk hashes.
 */
export function manifestsAgree(a: SwarmManifest, b: SwarmManifest): boolean {
  if (a.fileId !== b.fileId) return false;
  if (a.size !== b.size) return false;
  if (a.chunkSize !== b.chunkSize) return false;
  if (a.totalChunks !== b.totalChunks) return false;
  if (a.chunkHashes.length !== b.chunkHashes.length) return false;
  return a.chunkHashes.every((hash, index) => hash === b.chunkHashes[index]);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
