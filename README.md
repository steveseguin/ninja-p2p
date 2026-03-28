# ninja-p2p

Reusable bot-to-bot P2P communication layer built on [VDO.Ninja](https://vdo.ninja) WebRTC data channels. It lets agents discover each other inside a room, announce skills and status, send room-wide or private messages, and keep lightweight message history without a central relay.

## What This Repo Is

- A TypeScript/Node library for room-based peer discovery and messaging
- A standalone `dashboard.html` monitor/chat client
- A Codex skill at `skills/ninja-p2p`

## Install The Library

Install it directly from GitHub:

```bash
npm install github:steveseguin/ninja-p2p @roamhq/wrtc
```

Notes:

- `@vdoninja/sdk` is pulled in automatically as a dependency.
- `ws` comes from `@vdoninja/sdk` in Node environments.
- `@roamhq/wrtc` is recommended for Node-based bots that need WebRTC support.

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
import { VDOBridge } from "ninja-p2p";

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

// Send to everyone in the room
bridge.chat("Planner online");

// Send a private message to a specific peer
bridge.chat("sync now", "worker_bot");

// Publish a topic event
bridge.publishEvent("events", "status_change", { status: "busy" });

// Listen for incoming chat
bridge.bus.on("message:chat", (envelope) => {
  console.log(`${envelope.from.name}: ${envelope.payload.text}`);
});
```

## Core Features

- **Peer Registry**: Track peers, identity, skills, topics, and status
- **Pub/Sub Messaging**: Broadcast, direct send, and topic fanout
- **Offline Queue**: Queue messages for peers that are temporarily disconnected
- **Message History**: Replay recent messages to late joiners
- **Keyword Triggers**: Wake async bots from chat patterns
- **Identity Protocol**: Peers announce skills and status changes
- **Heartbeat**: Detect stale peers
- **Browser Dashboard**: Monitor peers and chat from a single HTML file

## Core Patterns

- Room-wide chat: `bridge.chat("hello")`
- Private message: `bridge.chat("hello", "target_stream_id")`
- Targeted command: `bridge.command("target_stream_id", "do_work", { jobId: 123 })`
- Topic event: `bridge.publishEvent("events", "status_change", { status: "busy" })`

## Browser Dashboard

`dashboard.html` is a standalone single-file SPA that connects to the same VDO.Ninja room. Open it locally in a browser or host it anywhere static files are supported.

Example:

```text
dashboard.html?room=agents_room&password=false&name=Steve&autoconnect=true
```

## Public API

Main entrypoint:

```ts
import { VDOBridge, MessageBus, PeerRegistry } from "ninja-p2p";
```

Subpath entrypoints:

```ts
import { VDOBridge } from "ninja-p2p/vdo-bridge";
import { createEnvelope } from "ninja-p2p/protocol";
```

## Architecture

```text
VDOBridge
  |- PeerRegistry
  |- MessageBus
  `- Protocol helpers
```

## Tests

```bash
npm test
```

## License

MIT
