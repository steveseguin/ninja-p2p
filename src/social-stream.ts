/**
 * Social Stream Ninja Bridge
 *
 * Pipes live chat from Twitch, YouTube, Kick and everything else Social Stream
 * Ninja aggregates into a ninja-p2p room as topic events, and lets agents in
 * that room talk back out to every connected platform at once.
 *
 * This uses SSN's documented WebSocket API and requires no changes to SSN
 * itself. Channel 4 carries chat from the extension; channel 1 is where the
 * extension listens for commands, so the bridge joins as `in=4, out=1`.
 *
 * See docs/social-stream-bridge.md for setup and for the direct WebRTC path
 * that would remove the relay entirely.
 */

import { createRequire } from "node:module";

export const DEFAULT_SSN_HOST = "wss://io.socialstream.ninja";
export const DEFAULT_SSN_IN_CHANNEL = 4;
export const DEFAULT_SSN_OUT_CHANNEL = 1;
export const DEFAULT_SSN_TOPIC = "social";

export type SocialMessage = {
  id: string | null;
  platform: string;
  author: string;
  text: string;
  avatar: string | null;
  donation: string | null;
  membership: string | null;
  event: string | null;
  sourceName: string | null;
  moderator: boolean;
  bot: boolean;
};

/** Minimal WebSocket surface, so tests can inject a fake. */
export type SocialSocket = {
  send(data: string): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
};

export type SocialSocketFactory = (url: string) => SocialSocket;
type SocialSocketConstructor = new (url: string) => SocialSocket;
type SocketModule = {
  WebSocket?: SocialSocketConstructor;
  default?: SocialSocketConstructor;
};

const requireFromHere = createRequire(import.meta.url);

export type SocialStreamBridgeOptions = {
  session: string;
  host?: string;
  inChannel?: number;
  outChannel?: number;
  onMessage: (message: SocialMessage) => void;
  log?: (message: string) => void;
  socketFactory?: SocialSocketFactory;
  /** Reconnect backoff steps in ms; the last value repeats. */
  backoffMs?: number[];
};

export function buildSocialStreamUrl(
  session: string,
  host = DEFAULT_SSN_HOST,
  inChannel = DEFAULT_SSN_IN_CHANNEL,
  outChannel = DEFAULT_SSN_OUT_CHANNEL,
): string {
  const trimmedHost = host.replace(/\/+$/, "");
  return `${trimmedHost}/join/${encodeURIComponent(session)}/${inChannel}/${outChannel}`;
}

/**
 * Convert one raw SSN payload into a flat message, or null if it is not chat.
 *
 * The channel carries far more than chat — callbacks, waitlist state, poll
 * updates, queue sizes. Everything SSN considers a message has `chatname`, so
 * that is the gate. Anything without it is control traffic an agent should not
 * be woken for.
 */
export function normalizeSocialMessage(raw: unknown): SocialMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;

  const author = asText(data.chatname);
  if (!author) return null;

  const message = asText(data.chatmessage);
  // chatmessage may carry sanitized emote markup unless textonly is set.
  // Agents want words, so strip tags but keep the original shape intact.
  const text = data.textonly === true ? message : stripHtml(message);

  return {
    id: asText(data.id) || null,
    platform: asText(data.type).toLowerCase() || "unknown",
    author,
    text,
    avatar: asText(data.chatimg) || null,
    donation: asText(data.hasDonation) || null,
    membership: asText(data.membership) || null,
    event: typeof data.event === "string" && data.event.trim() ? data.event.trim() : null,
    sourceName: asText(data.sourceName) || null,
    moderator: data.moderator === true,
    bot: data.bot === true,
  };
}

/** A one-line human summary, useful for logs and chat relays. */
export function describeSocialMessage(message: SocialMessage): string {
  const parts = [`[${message.platform}] ${message.author}`];
  if (message.donation) parts.push(`(${message.donation})`);
  if (message.event) parts.push(`<${message.event}>`);
  return `${parts.join(" ")}: ${message.text}`;
}

export class SocialStreamBridge {
  private readonly options: Required<Pick<SocialStreamBridgeOptions, "session">> & SocialStreamBridgeOptions;
  private readonly socketFactory: SocialSocketFactory;
  private readonly log: (message: string) => void;
  private readonly backoffMs: number[];

  private socket: SocialSocket | null = null;
  private attempt = 0;
  private connected = false;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SocialStreamBridgeOptions) {
    if (!options.session.trim()) {
      throw new Error("social stream bridge requires a session id");
    }
    this.options = options;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.log = options.log ?? (() => {});
    this.backoffMs = options.backoffMs ?? [1000, 2000, 5000, 10_000, 30_000];
  }

  get url(): string {
    return buildSocialStreamUrl(
      this.options.session,
      this.options.host,
      this.options.inChannel,
      this.options.outChannel,
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  connect(): void {
    if (this.closed || this.socket) return;

    let socket: SocialSocket;
    try {
      socket = this.socketFactory(this.url);
    } catch (error) {
      this.log(`[ssn] connect failed: ${errorMessage(error)}`);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.connected = true;
      this.attempt = 0;
      this.log(`[ssn] connected to session ${this.options.session}`);
    };

    socket.onmessage = (event) => {
      const payload = parseJson(event?.data);
      if (payload === undefined) return;
      const message = normalizeSocialMessage(payload);
      if (!message) return;
      try {
        this.options.onMessage(message);
      } catch (error) {
        this.log(`[ssn] handler error: ${errorMessage(error)}`);
      }
    };

    socket.onerror = () => {
      this.log("[ssn] socket error");
    };

    socket.onclose = () => {
      this.connected = false;
      this.socket = null;
      if (this.closed) return;
      this.log("[ssn] disconnected");
      this.scheduleReconnect();
    };
  }

  /**
   * Send a chat message out to every platform SSN is connected to.
   * Returns false when the socket is not ready, so callers can report honestly
   * rather than silently dropping an agent's reply.
   */
  sendChat(text: string): boolean {
    return this.sendAction("sendChat", text);
  }

  sendAction(action: string, value?: unknown): boolean {
    if (!this.socket || !this.connected) return false;
    try {
      const payload: Record<string, unknown> = { action };
      if (value !== undefined) payload.value = value;
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      this.log(`[ssn] send failed: ${errorMessage(error)}`);
      return false;
    }
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch { /* best effort */ }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
    this.attempt += 1;
    this.log(`[ssn] reconnecting in ${delay}ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    if (typeof this.retryTimer.unref === "function") this.retryTimer.unref();
  }
}

/**
 * Pick the platform WebSocket when present, with `ws` as the Node 20 fallback.
 *
 * Node 20 is the package's supported floor but does not expose WebSocket by
 * default. The bridge used to advertise Node 20 support and then fail at
 * runtime on exactly that version.
 */
export function resolveSocialSocketConstructor(
  platform: SocialSocketConstructor | null | undefined =
    globalThis.WebSocket as unknown as SocialSocketConstructor | undefined,
  load: () => unknown = () => requireFromHere("ws"),
): SocialSocketConstructor {
  if (platform) return platform;

  let loaded: unknown;
  try {
    loaded = load();
  } catch (error) {
    throw new Error(`no WebSocket implementation available: ${errorMessage(error)}`);
  }
  const module = loaded as SocketModule | SocialSocketConstructor;
  const implementation = typeof module === "function"
    ? module
    : module.WebSocket ?? module.default;
  if (typeof implementation !== "function") {
    throw new Error("the ws package did not export a WebSocket constructor");
  }
  return implementation;
}

function defaultSocketFactory(url: string): SocialSocket {
  const Impl = resolveSocialSocketConstructor();
  return new Impl(url);
}

function parseJson(data: unknown): unknown {
  const text = typeof data === "string"
    ? data
    : (data && typeof (data as { toString?: () => string }).toString === "function")
      ? String(data)
      : null;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
