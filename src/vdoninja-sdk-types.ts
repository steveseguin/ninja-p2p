/**
 * Narrow compatibility types for @vdoninja/sdk.
 *
 * SDK 1.4.1's package metadata points at `vdoninja-sdk.d.ts`, but the npm
 * tarball published on 2026-07-25 does not contain that file. Keep this local
 * interface until the declared SDK floor resolves to a registry package that
 * actually ships its declarations. It is compiled into ninja-p2p's own public
 * types, so consumers do not inherit the broken declaration reference.
 */

export type VDONinjaOptions = {
  host?: string;
  room?: string;
  password?: string | false;
  salt?: string;
  debug?: boolean;
  turnServers?: unknown;
  forceTURN?: boolean;
  maxReconnectAttempts?: number;
};

export interface VDONinja {
  connect(): Promise<void>;
  disconnect(): void | Promise<void>;
  joinRoom(options?: { room?: string; password?: string | false }): Promise<void>;
  leaveRoom(): void;
  announce(options?: { streamID?: string; label?: string; meta?: string }): Promise<void>;
  view(streamID: string, options?: { audio?: boolean; video?: boolean; label?: string }): Promise<unknown>;
  stopViewing(streamID: string): void;
  sendData(data: unknown, target?: unknown): boolean;
  sendPing(uuid: string): void;

  sendBinary?(
    data: ArrayBuffer | ArrayBufferView,
    uuid: string,
    options?: {
      ordered?: boolean;
      maxRetransmits?: number;
      maxPacketLifeTime?: number;
      waitForDrain?: boolean;
    },
  ): Promise<boolean>;
  openChannel?(
    uuid: string,
    label: string,
    options?: {
      ordered?: boolean;
      maxRetransmits?: number;
      maxPacketLifeTime?: number;
      timeout?: number;
    },
  ): Promise<unknown>;
  getChannel?(uuid: string, label: string): unknown;
  getBufferedAmount?(uuid: string, label?: string): number | null;
  getMaxMessageSize?(uuid: string): number | null;
  getPeerQuality?(uuid: string): Promise<{
    rttMs: number | null;
    lossRate: number | null;
    candidatePairType: string | null;
    relayed: boolean | null;
    availableOutgoingBitrate: number | null;
    bytesSent: number;
    bytesReceived: number;
  } | null>;

  publish(stream: unknown, options?: Record<string, unknown>): Promise<void>;
  stopPublishing(): void;
  getStats(uuid?: string): Promise<unknown>;
  addEventListener(event: string, handler: EventListenerOrEventListenerObject): void;
  removeEventListener(event: string, handler: EventListenerOrEventListenerObject): void;
  on(event: string, handler: EventListenerOrEventListenerObject): void;
  off(event: string, handler: EventListenerOrEventListenerObject): void;
  once(event: string, handler: EventListenerOrEventListenerObject): void;
  debug: boolean;
}

export type VDONinjaConstructor = new (options?: VDONinjaOptions) => VDONinja;
