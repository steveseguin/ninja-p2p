/**
 * Wake Hooks
 *
 * Turn-based agents (Claude Code, Codex CLI) only act when something hands them
 * a turn. The sidecar will happily hold a message forever while the agent sits
 * idle and never notices. A wake hook closes that gap: when real messages land
 * in the inbox, run a shell command so the agent gets a turn.
 *
 * Safety matters more than latency here. Two agents that both wake on message
 * and both reply will ping-pong forever, burning tokens with nobody watching.
 * So runs are coalesced into batches, never overlapped, and rate limited.
 */

import { spawn } from "node:child_process";
import type { MessageEnvelope } from "./protocol.js";

export const DEFAULT_WAKE_DEBOUNCE_MS = 750;
export const DEFAULT_WAKE_LIMIT_PER_MINUTE = 30;

export type WakeConfig = {
  command: string;
  debounceMs: number;
  limitPerMinute: number;
};

/** Minimal shape of a spawned process, so tests can inject a fake. */
export type WakeChild = {
  on(event: "exit", listener: () => void): unknown;
};

export type WakeSpawn = (command: string, env: NodeJS.ProcessEnv) => WakeChild;

export type WakeContext = {
  streamId: string;
  room: string;
  stateDir: string;
};

export type WakeRunnerOptions = {
  config: WakeConfig;
  context: WakeContext;
  spawnFn?: WakeSpawn;
  now?: () => number;
  log?: (message: string) => void;
};

/**
 * Environment handed to the wake command.
 *
 * NINJA_ID and NINJA_STATE_DIR are set on purpose: they let the woken command
 * run bare `ninja-p2p read` / `ninja-p2p dm <peer> <text>` and have those route
 * through this sidecar's local state.
 *
 * NINJA_ROOM is deliberately NOT set. The CLI treats a room as "one-shot mode"
 * and would open a second WebRTC connection under the same streamId instead of
 * queueing through the running sidecar. The room is exposed as NINJA_WAKE_ROOM
 * for display purposes only.
 */
export function buildWakeEnv(batch: MessageEnvelope[], context: WakeContext): Record<string, string> {
  return {
    NINJA_ID: context.streamId,
    NINJA_STATE_DIR: context.stateDir,
    NINJA_WAKE_ROOM: context.room,
    NINJA_WAKE_COUNT: String(batch.length),
    NINJA_WAKE_FROM: unique(batch.map((envelope) => envelope.from.streamId)).join(","),
    NINJA_WAKE_TYPES: unique(batch.map((envelope) => envelope.type)).join(","),
    NINJA_WAKE_TEXT: firstText(batch),
  };
}

export class WakeRunner {
  private readonly config: WakeConfig;
  private readonly context: WakeContext;
  private readonly spawnFn: WakeSpawn;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  private pending: MessageEnvelope[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerunRequested = false;
  private recentRuns: number[] = [];
  private disposed = false;

  constructor(options: WakeRunnerOptions) {
    this.config = options.config;
    this.context = options.context;
    this.spawnFn = options.spawnFn ?? defaultWakeSpawn;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  /** Record an inbox message and schedule a wake. */
  notify(envelope: MessageEnvelope): void {
    if (this.disposed) return;
    this.pending.push(envelope);
    this.schedule(this.config.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.pending = [];
  }

  /** Test seam: whether a wake command is currently executing. */
  isRunning(): boolean {
    return this.running;
  }

  /** Test seam: how many messages are waiting for the next wake. */
  pendingCount(): number {
    return this.pending.length;
  }

  private schedule(delayMs: number): void {
    if (this.disposed || this.timer) return;
    // Fixed window rather than a resetting debounce. A resetting timer can be
    // starved forever by a steady message stream; this bounds wake latency to
    // roughly debounceMs no matter how chatty the room gets.
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire();
    }, delayMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private fire(): void {
    if (this.disposed || this.pending.length === 0) return;

    if (this.running) {
      // Do not run two wake commands at once; an agent turn is not reentrant.
      this.rerunRequested = true;
      this.log(`[wake] busy, ${this.pending.length} message(s) will wait for the current run`);
      return;
    }

    const waitMs = this.throttleDelayMs();
    if (waitMs > 0) {
      this.log(`[wake] rate limit of ${this.config.limitPerMinute}/min reached, deferring ${waitMs}ms`);
      this.schedule(waitMs);
      return;
    }

    this.run();
  }

  /** Milliseconds to wait before another run is allowed, or 0 if one is. */
  private throttleDelayMs(): number {
    const limit = this.config.limitPerMinute;
    if (limit <= 0) return 0;
    const now = this.now();
    this.recentRuns = this.recentRuns.filter((at) => now - at < 60_000);
    if (this.recentRuns.length < limit) return 0;
    return 60_000 - (now - this.recentRuns[0]) + 1;
  }

  private run(): void {
    const batch = this.pending;
    this.pending = [];
    this.running = true;
    this.recentRuns.push(this.now());

    const env = { ...process.env, ...buildWakeEnv(batch, this.context) };
    this.log(`[wake] ${batch.length} message(s) from ${env.NINJA_WAKE_FROM || "unknown"} -> ${this.config.command}`);

    let child: WakeChild;
    try {
      child = this.spawnFn(this.config.command, env);
    } catch (error) {
      this.running = false;
      this.log(`[wake] failed to start: ${error instanceof Error ? error.message : String(error)}`);
      this.settle();
      return;
    }

    child.on("exit", () => {
      this.running = false;
      this.settle();
    });
  }

  /** After a run finishes, start another if messages arrived meanwhile. */
  private settle(): void {
    if (this.disposed) return;
    if (this.rerunRequested || this.pending.length > 0) {
      this.rerunRequested = false;
      this.schedule(this.config.debounceMs);
    }
  }
}

function defaultWakeSpawn(command: string, env: NodeJS.ProcessEnv): WakeChild {
  // Inherit stdio so the wake command's output lands in the sidecar log,
  // which is the only place a detached agent can report for itself.
  return spawn(command, {
    shell: true,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function firstText(batch: MessageEnvelope[]): string {
  for (const envelope of batch) {
    const payload = envelope.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const text = (payload as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim()) return text;
  }
  return "";
}
