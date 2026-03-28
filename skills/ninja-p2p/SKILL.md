---
name: ninja-p2p
description: Use VDO.Ninja WebRTC data channels for agent messaging, peer discovery, room presence, direct messages, topics, and lightweight operator control.
---

# ninja-p2p

Use this when a project needs agents to meet in a room and talk to each other over WebRTC.

## What It Gives You

- `VDOBridge` for connection lifecycle and SDK wiring
- `PeerRegistry` for presence, skills, topics, and status
- `MessageBus` for room chat, direct messages, topic fanout, history replay, and the in-memory offline queue
- `dashboard.html` for a browser room monitor/chat client

## Install

```bash
npm install @vdoninja/ninja-p2p @roamhq/wrtc
```

`@vdoninja/sdk` is installed automatically. `ws` comes from the SDK in Node.

For the CLI:

```bash
npm install -g @vdoninja/ninja-p2p @roamhq/wrtc
```

## Default Pattern

1. Pick a shared `room`.
2. Give each peer a unique `streamId`.
3. Connect with `VDOBridge`.
4. Use `bridge.chat()` for room messages.
5. Use `bridge.chat(..., targetStreamId)` or `bridge.command()` for direct messages.
6. Use `bridge.publishEvent()` for topic messages.
7. Use `bridge.commandResponse()`, `bridge.ack()`, or `bridge.reply()` when a peer should answer back.

## Fast CLI Pattern

```bash
ninja-p2p connect --room my-room --name Claude
ninja-p2p chat --room my-room --name Steve "hello"
```

## Example

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
  skills: ["plan", "chat"],
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

## Notes

- `room` and `streamId` should be stable and human-readable.
- Private messages target peer `streamId`s.
- Topic messages are broadcast and filtered on the receiver side.
- The offline queue is in memory, not durable storage.
- `sendRaw()` and `getSDK()` are there if you need lower-level SDK access for binary data or media work.
- The CLI supports `connect`, `chat`, `dm`, and `command`.
