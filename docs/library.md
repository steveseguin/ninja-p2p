# Node library

## Install as a library

```bash
npm install @vdoninja/ninja-p2p @roamhq/wrtc
```

Notes:

- `@vdoninja/sdk` 1.5.4 or newer is installed automatically
- `ws` is installed directly for Node 20 and Social Stream compatibility
- `@roamhq/wrtc` is recommended and supports data plus media
- `node-datachannel` is a supported alternative for data-only peers

## Library quick start

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

## Human operator example

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

The same UI is hosted, so you do not have to open a local file:

```text
https://steveseguin.github.io/ninja-p2p/dashboard.html?room=agents_room&password=false&name=Steve&autoconnect=true
```

The project landing page lives at the root of that site, and `docs/dashboard.html` is the copy it serves. Run `npm run sync:docs` after editing `dashboard.html` to update it.

That browser UI can:

- enter a room and optional password
- see connected bots and operators
- select a peer and DM it directly
- broadcast to the whole room
- inspect the selected peer's announced profile, capabilities, asks, and shared folders
- browse a selected peer's declared shared folders and request one file at a time
- send a local file to the selected peer, which lands in that peer's downloads folder
- download files that arrive over the room connection
- send slash-style commands like `/profile`, `/capabilities`, `/inbox`, `/status`, `/history`, `/peers`, `/shares`, `/ls <peer> <share> [path]`, `/get <peer> <share> <path>`, and `/cmd <peer> <command> [json]`
- send operator-friendly shortcuts like `/plan`, `/review`, `/approve`, and `/respond`

One honest caveat: GitHub Pages is just a static host. It can join a known room, but it will not list all rooms for you or store durable history on its own. Also, if the room password matters, entering it into the page is better than putting it in the URL. The dashboard can browse shares and use the simple transfer protocol, but it does not implement swarm or a full sync UI. Browser uploads are capped at 256 MiB and browser downloads at 64 MiB because the page holds them in memory.

## Coordination helpers

- `bridge.chat(text, to?)`
- `bridge.chatTopic(topic, text)`
- `bridge.command(targetStreamId, command, args?)`
- `bridge.commandResponse(message, result?, error?)`
- `bridge.publishEvent(topic, kind, data?)`
- `bridge.reply(message, type, payload)`
- `bridge.ack(message, payload?)`
- `bridge.requestHistory(targetStreamId, count?)`

These are lightweight coordination messages. They are useful, but they are not hard delivery guarantees.

## Raw data, media, and advanced SDK access

This package focuses on data-channel messaging.

The underlying VDO.Ninja SDK can also:

- publish and view audio or video tracks
- emit `track` events
- send binary payloads over the data channel

This wrapper exposes the control lane plus the optional binary lane:

- `bridge.sendRaw(data, targetStreamId?)` sends JSON-compatible SDK data on the
  control lane
- `bridge.supportsBinary()` reports whether the installed SDK has the 1.4.1
  binary API
- `await bridge.sendBinaryTo(targetStreamId, bytes)` sends a `Uint8Array`
  without JSON or base64
- `bridge.on("binary", ({ streamId, bytes }) => ...)` receives those bytes
- `bridge.bufferedBytesFor(targetStreamId)` and
  `bridge.maxMessageSizeFor(targetStreamId)` expose binary-lane backpressure and
  the negotiated SCTP limit
- `bridge.getSDK()`

Example:

```ts
bridge.on("binary", ({ streamId, bytes }) => {
  console.log("binary frame", streamId, bytes.byteLength);
});

const bytes = new Uint8Array([1, 2, 3]);
if (bridge.supportsBinary()) {
  await bridge.sendBinaryTo("worker_bot", bytes);
}
```

`sendRaw()` is not the binary API: SDK 1.4.0 JSON-stringifies non-string values,
and SDK 1.4.1 reserves `sendBinary()` for raw bytes. The built-in swarm handles
that compatibility choice per peer automatically. A custom protocol must
negotiate receiver support itself; a successful local send does not prove that
an older remote peer understands the bytes.

The CLI already provides simple file/image transfer and the resumable swarm.
Use the lower-level SDK or binary methods only when you need a different framing
protocol or media behavior.

