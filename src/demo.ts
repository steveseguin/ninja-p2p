/**
 * Live Self-Test
 *
 * Getting two agents talking used to take six commands and a room-name
 * copy-paste, which is where most people gave up. `ninja-p2p demo` does the
 * whole round trip in one command: two peers connect, find each other over
 * WebRTC, exchange messages both ways, and complete a request/response.
 *
 * It doubles as a diagnostic. If this passes, the transport works on this
 * machine and network, and any remaining problem is configuration.
 */

import { VDOBridge } from "./vdo-bridge.js";
import { generateRoomName, type MessageEnvelope } from "./protocol.js";

export const DEMO_ALICE = "demo_alice";
export const DEMO_BOB = "demo_bob";

export type DemoStep = {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
};

export type DemoResult = {
  room: string;
  ok: boolean;
  steps: DemoStep[];
};

export type DemoOptions = {
  room?: string;
  password?: string | false;
  timeoutMs?: number;
  log?: (message: string) => void;
  /**
   * Called once the round trip succeeds, while both peers are still connected.
   * `--keep` uses it to hold the room open so it can be watched in the browser.
   */
  hold?: (room: string) => Promise<void>;
};

type DemoPlanItem = {
  name: string;
  run: () => Promise<string>;
};

export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const room = options.room || generateRoomName();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const password = options.password ?? false;
  const log = options.log ?? (() => {});
  const steps: DemoStep[] = [];

  const alice = new VDOBridge({
    room,
    streamId: DEMO_ALICE,
    identity: { streamId: DEMO_ALICE, role: "agent", name: "Alice" },
    password,
    skills: ["chat", "command"],
    topics: ["events"],
  });

  const bob = new VDOBridge({
    room,
    streamId: DEMO_BOB,
    identity: { streamId: DEMO_BOB, role: "agent", name: "Bob" },
    password,
    skills: ["chat", "command"],
    topics: ["events"],
  });

  // Bob answers the demo command himself so the request/response leg is a real
  // round trip rather than a message we quietly resolve locally.
  bob.bus.on("message:command", (envelope: MessageEnvelope) => {
    const payload = envelope.payload as { command?: string };
    if (payload.command === "ping") {
      bob.commandResponse(envelope, { pong: true, from: DEMO_BOB });
    }
  });

  const plan: DemoPlanItem[] = [
    {
      name: "connect",
      run: async () => {
        await Promise.all([alice.connect(), bob.connect()]);
        return `both peers joined room ${room}`;
      },
    },
    {
      name: "discover",
      run: async () => {
        await Promise.all([
          waitForPeer(alice, DEMO_BOB, timeoutMs),
          waitForPeer(bob, DEMO_ALICE, timeoutMs),
        ]);
        return "peers found each other over WebRTC";
      },
    },
    {
      name: "direct message",
      run: async () => {
        const received = waitForMessage(bob, "message:chat", DEMO_ALICE, timeoutMs);
        alice.chat("hello from Alice", DEMO_BOB);
        return `Bob received "${textOf(await received)}"`;
      },
    },
    {
      name: "reply",
      run: async () => {
        const received = waitForMessage(alice, "message:chat", DEMO_BOB, timeoutMs);
        bob.chat("hello back from Bob", DEMO_ALICE);
        return `Alice received "${textOf(await received)}"`;
      },
    },
    {
      name: "command",
      run: async () => {
        const received = waitForMessage(alice, "message:command_response", DEMO_BOB, timeoutMs);
        alice.command(DEMO_BOB, "ping");
        const envelope = await received;
        const payload = envelope.payload as { result?: unknown };
        return `Bob answered ${JSON.stringify(payload.result ?? envelope.payload)}`;
      },
    },
  ];

  try {
    for (const item of plan) {
      const startedAt = Date.now();
      try {
        const detail = await item.run();
        steps.push({ name: item.name, ok: true, detail, ms: Date.now() - startedAt });
        log(`  ok    ${item.name.padEnd(15)} ${detail}`);
      } catch (error) {
        steps.push({
          name: item.name,
          ok: false,
          detail: errorMessage(error),
          ms: Date.now() - startedAt,
        });
        log(`  FAIL  ${item.name.padEnd(15)} ${errorMessage(error)}`);
        // Later steps assume the earlier ones worked, so stop at the first break.
        break;
      }
    }

    if (options.hold && steps.length === plan.length && steps.every((step) => step.ok)) {
      await options.hold(room);
    }
  } finally {
    await Promise.allSettled([alice.disconnect(), bob.disconnect()]);
  }

  return {
    room,
    ok: steps.length === plan.length && steps.every((step) => step.ok),
    steps,
  };
}

export function formatDemoResult(result: DemoResult, dashboardUrl: string): string {
  const lines: string[] = ["", result.ok ? "Demo passed." : "Demo failed."];

  if (result.ok) {
    lines.push(
      "",
      "Two peers connected, found each other, and exchanged messages both ways",
      "with no server of your own. The same transport backs the agent sidecars.",
      "",
      "Watch a room like this in the browser:",
      `  ${dashboardUrl}`,
      "",
      "Start real agents in one room:",
      "  ninja-p2p start --id claude",
      "  ninja-p2p room --id claude",
      "  ninja-p2p start --room <that-room> --id codex",
      "",
      "Let them act on their own:",
      "  ninja-p2p start --id claude --on-message \"claude -p 'Check your ninja-p2p inbox'\"",
    );
  } else {
    const failed = result.steps.find((step) => !step.ok);
    lines.push(
      "",
      `First failure: ${failed?.name ?? "unknown"} — ${failed?.detail ?? "no detail"}`,
      "",
      "Run `ninja-p2p doctor` to check Node, WebRTC, and signaling reachability.",
    );
  }

  return lines.join("\n");
}

function waitForPeer(bridge: VDOBridge, streamId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (bridge.peers.getPeer(streamId)?.identity) {
      resolve();
      return;
    }

    const cleanup = (): void => {
      clearTimeout(timer);
      bridge.off("peer:announce", onAnnounce);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${streamId}`));
    }, timeoutMs);

    const onAnnounce = (payload: { streamId: string }): void => {
      if (payload.streamId !== streamId) return;
      cleanup();
      resolve();
    };

    bridge.on("peer:announce", onAnnounce);
  });
}

function waitForMessage(
  bridge: VDOBridge,
  event: string,
  fromStreamId: string,
  timeoutMs: number,
): Promise<MessageEnvelope> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      bridge.bus.off(event, onMessage);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${event} from ${fromStreamId}`));
    }, timeoutMs);

    const onMessage = (envelope: MessageEnvelope): void => {
      if (envelope.from.streamId !== fromStreamId) return;
      cleanup();
      resolve(envelope);
    };

    bridge.bus.on(event, onMessage);
  });
}

function textOf(envelope: MessageEnvelope): string {
  const payload = envelope.payload;
  if (typeof payload !== "object" || payload === null) return "";
  const text = (payload as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
