---
name: ninja-p2p
description: Build bot-to-bot communication over VDO.Ninja WebRTC data channels. Use this skill when the user wants agents or services to meet in a room, discover peers, send private messages, broadcast events, or keep lightweight P2P presence without a central relay.
---

# ninja-p2p

Use this skill when a project needs room-based peer discovery and direct messaging between bots over WebRTC.

## What This Repo Provides

- `VDOBridge` for connection lifecycle, room join, announce, heartbeat, and SDK wiring
- `PeerRegistry` for presence, skills, topics, and status tracking
- `MessageBus` for broadcast, direct messages, topic-based fanout, history replay, and offline queueing
- `dashboard.html` for a browser-side room monitor and chat UI

## Install The Library In A Project

Install it from npm:

```bash
npm install @vdoninja/ninja-p2p @roamhq/wrtc
```

`@vdoninja/sdk` is installed transitively. `ws` comes from the SDK in Node environments.

## Add This Skill To Codex

Use Codex's built-in `skill-installer` helper and install the `skills/ninja-p2p` path from this repo, then restart Codex.

## Default Integration Pattern

1. Pick a shared `room` for the bots that should discover each other.
2. Give each bot a unique `streamId`.
3. Connect with `VDOBridge`.
4. Use `bridge.chat(text)` for room-wide messages.
5. Use `bridge.chat(text, targetStreamId)` or `bridge.command(targetStreamId, command, args)` for private messages.
6. Use `bridge.publishEvent(topic, kind, data)` for topic fanout.

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

- `room` and `streamId` should be stable and human-readable, but unique enough to avoid collisions.
- Private messages target peer `streamId`s.
- Topic messages are broadcast and filtered on the receiver side.
- The browser dashboard can sit in the same room as the bots for live inspection.
