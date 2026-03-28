# ninja-p2p

`ninja-p2p` is a small TypeScript library for peer-to-peer agent messaging on top of the [VDO.Ninja](https://vdo.ninja) SDK.

It gives you a shared room, peer discovery, direct messages, group chat, topics, in-memory history, and a simple browser dashboard. The transport is WebRTC data channels. You do not need to open inbound ports just to let agents talk to each other.

Package: [`@vdoninja/ninja-p2p`](https://www.npmjs.com/package/@vdoninja/ninja-p2p)  
Support: https://discord.vdo.ninja

## What It Does

- peers join the same room and discover each other
- direct messages between named peers
- room-wide chat
- topic-based pub/sub
- peer status, skills, and presence tracking
- in-memory history replay
- in-memory offline queue for peers that drop and reconnect
- a standalone `dashboard.html` room monitor/chat client

## What It Does Not Do

- it is not a VPN
- it is not a generic TCP tunnel
- it is not a generic HTTP tunnel
- it does not provide durable storage
- it does not guarantee message delivery
- it does not turn the dashboard into a remote shell

This package is for agent coordination. If you want to expose a whole private network or front a public website, use a VPN or a tunnel made for that job.

## Install

```bash
npm install @vdoninja/ninja-p2p @roamhq/wrtc
```

Notes:

- `@vdoninja/sdk` is installed automatically.
- `ws` comes from `@vdoninja/sdk` in Node.
- `@roamhq/wrtc` is recommended for Node bots that need WebRTC support.

## Add The Codex Skill

Install the skill from this repo's `skills/ninja-p2p` folder, then restart Codex.

### PowerShell

```powershell
python $HOME\.codex\skills\.system\skill-installer\scripts\install-skill-from-github.py --repo steveseguin/ninja-p2p --path skills/ninja-p2p
```

### Bash

```bash
python ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py --repo steveseguin/ninja-p2p --path skills/ninja-p2p
```

## Quick Start

```ts
import { VDOBridge } from "@vdoninja/ninja-p2p";

const bridge = new VDOBridge({
  room: "agents_room",
  streamId: "planner_bot",
  identity: {
    streamId: "planner_bot",
    role: "agent",
    name: "Planner",
  },
  password: false,
  skills: ["chat", "search"],
  topics: ["events"],
});

await bridge.connect();

bridge.chat("Planner online");
bridge.chat("sync now", "worker_bot");
bridge.publishEvent("events", "status_change", { status: "busy" });

bridge.bus.on("message:chat", (envelope) => {
  console.log(`${envelope.from.name}: ${envelope.payload.text}`);
});
```

## Human Operator Example

One simple pattern is to put a human-operated process in the same room as the bots.

Agent:

```ts
import { VDOBridge } from "@vdoninja/ninja-p2p";

const worker = new VDOBridge({
  room: "agents_room",
  streamId: "worker_bot",
  identity: {
    streamId: "worker_bot",
    role: "agent",
    name: "Worker",
  },
  password: false,
  skills: ["status", "say"],
});

await worker.connect();

worker.bus.on("message:command", (envelope) => {
  const payload = envelope.payload as { command?: string; args?: { text?: string } };

  if (payload.command === "status") {
    worker.commandResponse(envelope, {
      status: "idle",
      peers: worker.peers.toJSON(),
    });
    return;
  }

  if (payload.command === "say") {
    console.log(payload.args?.text ?? "");
    worker.commandResponse(envelope, { ok: true });
    return;
  }

  worker.commandResponse(envelope, undefined, `unknown command: ${payload.command ?? "?"}`);
});
```

Operator:

```ts
import { VDOBridge } from "@vdoninja/ninja-p2p";

const operator = new VDOBridge({
  room: "agents_room",
  streamId: "steve_operator",
  identity: {
    streamId: "steve_operator",
    role: "operator",
    name: "Steve",
  },
  password: false,
});

await operator.connect();

operator.command("worker_bot", "status");
operator.command("worker_bot", "say", { text: "hello from the operator" });

operator.bus.on("message:command_response", (envelope) => {
  console.log(envelope.payload);
});
```

The browser dashboard can also join the same room:

```text
dashboard.html?room=agents_room&password=false&name=Steve&autoconnect=true
```

The dashboard can chat, DM a peer, and send simple slash-command messages like `/status`, `/health`, `/history`, and `/peers`.

## Coordination Helpers

- `bridge.chat(text, to?)`
- `bridge.chatTopic(topic, text)`
- `bridge.command(targetStreamId, command, args?)`
- `bridge.commandResponse(message, result?, error?)`
- `bridge.publishEvent(topic, kind, data?)`
- `bridge.reply(message, type, payload)`
- `bridge.ack(message, payload?)`
- `bridge.requestHistory(targetStreamId, count?)`

These are lightweight coordination messages. They are useful, but they are not hard delivery guarantees.

## Raw Data, Media, and Advanced SDK Access

This package focuses on data-channel messaging.

The underlying VDO.Ninja SDK goes further than that. It can also:

- publish and view audio/video tracks
- emit `track` events
- send binary payloads over the data channel

This wrapper exposes two escape hatches for that:

- `bridge.sendRaw(data, targetStreamId?)` sends arbitrary data without wrapping it in the message envelope
- `bridge.getSDK()` returns the underlying VDO.Ninja SDK instance after `connect()`

Example:

```ts
const sdk = bridge.getSDK();

sdk?.addEventListener("track", (event) => {
  const track = event.detail?.track;
  console.log("track", track?.kind);
});

const chunk = new Uint8Array([1, 2, 3]).buffer;
bridge.sendRaw(chunk, "worker_bot");
```

If you want to turn video into frames for ingestion, or build a file-transfer layer, do it on top of the SDK or on top of `sendRaw`. That is possible with the current stack, but it is not wrapped into a higher-level API in this package yet.

## Public API

Main entrypoint:

```ts
import { VDOBridge, MessageBus, PeerRegistry } from "@vdoninja/ninja-p2p";
```

Subpath entrypoints:

```ts
import { VDOBridge } from "@vdoninja/ninja-p2p/vdo-bridge";
import { createEnvelope } from "@vdoninja/ninja-p2p/protocol";
```

## Files

- `src/vdo-bridge.ts`: connection lifecycle and SDK integration
- `src/message-bus.ts`: chat, direct messages, topics, history, offline queue
- `src/peer-registry.ts`: peer state and presence
- `src/protocol.ts`: message envelope format
- `dashboard.html`: browser monitor/chat client
- `skills/ninja-p2p`: Codex skill

## Tests

```bash
npm test
npm run build
```

## Support

- Discord: https://discord.vdo.ninja
- VDO.Ninja: https://vdo.ninja
- Social Stream Ninja: https://socialstream.ninja

## License

MIT
