# ninja-p2p

Reusable P2P agent communication module built on [VDO.Ninja](https://vdo.ninja) WebRTC data channels. Enables bots and dashboards to discover each other, exchange messages, and coordinate in real time over peer-to-peer connections.

## Features

- **Peer Registry** - Track who's online, their role, skills, and status
- **Pub/Sub Messaging** - Topic-based subscriptions with broadcast and targeted sends
- **Offline Queue** - Messages to disconnected peers are queued and delivered on reconnect
- **Message History** - Ring buffer of recent messages, replayable to new joiners
- **Keyword Triggers** - Register patterns that wake up async bots on matching messages
- **Identity Protocol** - Peers announce themselves, their skills, and status changes
- **Heartbeat** - Periodic pings detect stale connections
- **Browser Dashboard** - Standalone HTML file for monitoring and chatting with peers

## Quick Start

```bash
npm install ninja-p2p @vdoninja/sdk ws @roamhq/wrtc
```

```typescript
import { VDOBridge } from "ninja-p2p/src/vdo-bridge.js";

const bridge = new VDOBridge({
  room: "my_secret_room_name",
  streamId: "my_bot_1",
  identity: { streamId: "my_bot_1", role: "agent", name: "MyBot" },
  password: false,
  skills: ["chat", "search"],
  topics: ["events"],
});

await bridge.connect();

// Send a chat message to everyone
bridge.chat("Hello from MyBot!");

// Listen for incoming messages
bridge.bus.on("message:chat", (envelope) => {
  console.log(`${envelope.from.name}: ${envelope.payload.text}`);
});

// Send to a specific peer
bridge.chat("Hey there!", "other_bot_stream_id");

// Publish to a topic
bridge.publishEvent("events", "status_change", { status: "busy" });

// Register a keyword trigger
bridge.bus.onKeyword(/@mybot/i, (msg) => {
  bridge.chat(`You called? I heard: ${msg.payload.text}`, msg.from.streamId);
});
```

## Architecture

```
VDOBridge (connection lifecycle, SDK wrapper)
  ├── PeerRegistry (track peers, identity, skills, presence)
  ├── MessageBus (pub/sub, history, offline queue, triggers)
  └── Protocol (envelope types, serialization)
```

All modules use Node.js `EventEmitter` and have zero external dependencies beyond `@vdoninja/sdk`.

## Browser Dashboard

`dashboard.html` is a standalone single-file SPA that connects to the same VDO.Ninja room. Open it in a browser or host on GitHub Pages. Supports URL params:

```
dashboard.html?room=my_room&password=false&name=Steve&autoconnect=true
```

## Message Envelope

Every message uses a typed envelope:

```json
{
  "v": 1,
  "id": "unique_msg_id",
  "type": "chat",
  "from": { "streamId": "bot_1", "role": "agent", "name": "MyBot", "instanceId": "abc123" },
  "to": null,
  "topic": null,
  "ts": 1711100000000,
  "payload": { "text": "Hello!" }
}
```

Message types: `chat`, `announce`, `skill_update`, `command`, `command_response`, `event`, `ping`, `pong`, `ack`, `history_replay`, `history_request`

## Tests

```bash
npm test
```

59 tests covering protocol, peer registry, and message bus.

## License

MIT
