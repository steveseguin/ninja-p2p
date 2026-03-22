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
    disconnect(): void;
    joinRoom(options?: { room?: string; password?: string | false }): Promise<void>;
    leaveRoom(): void;
    announce(options?: { streamID?: string; label?: string; meta?: string }): Promise<void>;
    view(streamID: string, options?: { audio?: boolean; video?: boolean; label?: string }): Promise<void>;
    sendData(data: unknown, target?: unknown): void;
    sendPing(uuid: string): void;
    publish(stream: unknown, options?: Record<string, unknown>): Promise<void>;
    stopPublishing(): void;
    stopViewing(streamID: string): void;
    getStats(uuid?: string): Promise<unknown>;

    addEventListener(event: string, handler: (event: { detail?: Record<string, unknown> }) => void): void;
    removeEventListener(event: string, handler: (event: { detail?: Record<string, unknown> }) => void): void;
    on(event: string, handler: (event: { detail?: Record<string, unknown> }) => void): void;
    off(event: string, handler: (event: { detail?: Record<string, unknown> }) => void): void;
    once(event: string, handler: (event: { detail?: Record<string, unknown> }) => void): void;

    debug: boolean;
  }

  export = VDONinjaSDK;
}
