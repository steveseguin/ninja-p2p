/**
 * Local type shim for @vdoninja/sdk.
 *
 * The SDK ships its own `vdoninja-sdk.d.ts` from v1.4.1. Once that version is
 * the floor in package.json this file can go, along with the `?` on everything
 * below — see docs/sdk-wishlist.md item 9. Until then the declared floor is
 * ^1.4.0, which has none of the binary or backpressure surface, so those members
 * are typed optional. That is not defensive typing for its own sake: it is what
 * makes the compiler insist we feature-detect before calling them.
 */
declare module "@vdoninja/sdk" {
  class VDONinjaSDK {
    constructor(options?: {
      host?: string;
      room?: string;
      password?: string | false;
      salt?: string;
      debug?: boolean;
      turnServers?: unknown;
      forceTURN?: boolean;
      maxReconnectAttempts?: number;
    });

    connect(): Promise<void>;
    /** Returns a promise from v1.4.1; older builds return void. */
    disconnect(): void | Promise<void>;
    joinRoom(options?: { room?: string; password?: string | false }): Promise<void>;
    leaveRoom(): void;
    announce(options?: { streamID?: string; label?: string; meta?: string }): Promise<void>;
    view(streamID: string, options?: { audio?: boolean; video?: boolean; label?: string }): Promise<void>;
    sendData(data: unknown, target?: unknown): boolean;
    sendPing(uuid: string): void;
    publish(stream: unknown, options?: Record<string, unknown>): Promise<void>;
    stopPublishing(): void;
    stopViewing(streamID: string): void;
    getStats(uuid?: string): Promise<unknown>;

    // ── v1.4.1: binary lane, extra channels, backpressure ──────────────────
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
      options?: { ordered?: boolean; maxRetransmits?: number; maxPacketLifeTime?: number; timeout?: number },
    ): Promise<unknown>;
    getChannel?(uuid: string, label: string): unknown;
    /** Omit `label` for the control channel. Null if the peer or channel is unknown. */
    getBufferedAmount?(uuid: string, label?: string): number | null;
    /** Negotiated SCTP limit, or null if the transport has not reported one. */
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

    addEventListener(event: string, handler: (event: { detail?: Record<string, unknown> }) => void): void;
    removeEventListener(event: string, handler: (event: { detail?: Record<string, unknown> }) => void): void;
    on(event: string, handler: (event: { detail?: Record<string, unknown> }) => void): void;
    off(event: string, handler: (event: { detail?: Record<string, unknown> }) => void): void;
    once(event: string, handler: (event: { detail?: Record<string, unknown> }) => void): void;

    debug: boolean;
  }

  export = VDONinjaSDK;
}
