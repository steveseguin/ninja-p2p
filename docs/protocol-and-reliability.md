# Protocol and reliability

`ninja-p2p` is an agent coordination layer over VDO.Ninja WebRTC data channels. It does not replace or extend VDO.Ninja signaling.

## Layers

1. The VDO.Ninja SDK joins a room, discovers published stream IDs, and establishes WebRTC peer connections and data channels.
2. `VDOBridge` asks the SDK to view discovered peers as data-only connections.
3. `MessageBus` sends a versioned JSON envelope through those channels.
4. The optional sidecar stores inbox and outbox records on the local machine so a turn-based agent can read them later.

The application envelope contains an ID, timestamp, sender identity, message type, optional target/topic, and payload. It is data carried through VDO.Ninja, not a new WebSocket command.

## Delivery semantics

- Direct messages are sent when the SDK accepts them for an open data channel.
- If a known peer is offline, or the channel exists but is not ready yet, the message is queued in memory.
- A queue flush retries the original envelope, including its message ID and type, and removes only messages the SDK accepted. A failed flush leaves the remaining messages in order for the next channel-open or announce event.
- The persistent CLI sidecar additionally stores actions on disk before its live process sends them.
- There is no durable remote broker and no exactly-once guarantee. Applications that require confirmation should use message IDs with `ack` or `command_response` and make handlers idempotent.
- Room broadcasts are best-effort. They are not retained independently for every absent peer.

## Connection race this prevents

WebRTC emits several milestones. `peerConnected` can occur before `dataChannelOpen`. Older code treated the first event as send-ready, so an agent replying in that interval could receive a normal-looking local envelope even though the SDK rejected the send. The bridge now observes the SDK's boolean send result and queues an explicitly rejected direct message.

A second race occurred during reconnect: the queue was deleted before replay attempts. If the data channel closed between the open event and the first replay, every queued message was lost locally. Queue entries now remain until each replay is accepted.

## Compatibility

- The wire envelope format is unchanged.
- Existing send callbacks that return `void` remain accepted; only an explicit `false` means the transport rejected a send.
- SDK targets use the SDK's documented `{ uuid }` or `{ streamID }` forms.
- Existing VDO.Ninja room and signaling behavior remains authoritative.

## Security boundary

WebRTC encrypts data in transit. Room names and optional VDO.Ninja passwords control discovery/connection behavior, but they are not an application authorization system. Validate commands at the receiving agent, expose only intentional shared folders, and do not treat peer-supplied names or capabilities as trusted identity claims.
