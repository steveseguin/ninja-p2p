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

## Swarm transfer

Bulk file transfer runs its own protocol on top of the same envelope, with one
exception: chunk payloads travel as raw bytes on a dedicated binary channel
rather than inside an envelope, when both peers can.

### Two lanes, deliberately

Control messages — offers, bitfields, requests, progress — stay on the shared
control channel. Chunk bytes go on a separate reserved `x-bin` channel.

That split is the single largest thing separating this from the original
transfer path, and not for the reason that looks obvious. Base64 costs 33% in
bandwidth, which is real but modest. The larger cost was that a 64 KB chunk on
the control channel sat in front of every chunk request queued behind it. With
two downloaders sharing what they had, the control channel became the
bottleneck: measured at 627 KB/s each without the binary lane against 7.1 MB/s
with it.

Binary requires `@vdoninja/sdk` 1.4.1 or newer. Older peers are not excluded —
each request states whether its sender can receive bytes, so the answer is
chosen per request and a room can mix versions freely.

### Why ties are broken at random

Rarest-chunk-first is the standard rule, but at the start of a download every
chunk is equally rare. Breaking those ties by index meant every downloader
requested the same chunks in the same order, so no downloader ever held anything
another lacked, and the "a partial downloader is already a source" property was
true in code and worthless in practice. Three downloaders against one seeder
measured at exactly one third the speed of one, with no peer-to-peer traffic at
all.

Random tie-breaking makes downloaders diverge from the first request. Total
throughput across three downloaders went from 7.8 MB/s to 14.1 MB/s.

### Startup

A downloader that has just learned a file exists knows nothing about who holds
it. Waiting for the next periodic bitfield broadcast cost a fixed 2.6 s of a
4.0 s transfer. A peer now answers another peer's bitfield with its own,
unicast, but only when it holds something that peer lacks — which both makes the
reply useful and guarantees the exchange terminates after one round.

### What was measured and deliberately not built

- **Adaptive in-flight windows.** Throughput was identical at 4, 16 and 48
  outstanding requests per peer, so the window is not the constraint and an
  adaptive one would be complexity without a benefit. The SDK's own drain wait
  already bounds the send buffer, measured at 1.08 MB against a 1 MB
  high-water mark.
- **Larger chunks.** 64 KB, 128 KB and 192 KB were within 2% of each other. The
  negotiated SCTP limit is used as a safety check instead: at the 64 KB default
  a base64 chunk is 85 KB, which would be refused by a peer negotiating the
  65536 every implementation must support.
### Losing a chunk on a healthy link

Chunks are occasionally dropped with nothing wrong anywhere: measured on an idle
machine with three downloaders, one lost a chunk in roughly one run in three.
The only thing that notices is the request timeout, so its length is the whole
cost of a loss — a flat 15s turned a 2s transfer into 17s, which is where the
worst outliers in the table above come from.

The timeout is therefore scaled to the peer's measured round-trip time, with a
3s floor and the 15s ceiling kept for any peer we have not timed yet. The floor
is the important half: a peer serving several downloaders is slow rather than
broken, and expiring it early costs twice, because the chunk is re-requested
*and* the peer is charged a failure it did not earn.

This was built, reverted, and reinstated. The revert was based on a measured
2.5x throughput regression that turned out to be an artefact — over a hundred
stray test daemons from earlier runs were still sitting in rooms on the same
machine, because killing a shell job on Windows does not reach the node process
it spawned. Re-measured on a genuinely idle machine, the regression did not
exist. Any benchmark here is worth nothing without checking what else is
running first.

### Resume

Keeping a part file's bytes across a restart is only half of resuming. The
bitfield was rebuilt empty, so every chunk already on disk was fetched again —
"resumable" was true of the file and false of the transfer, and no test caught it
because none ever constructed a second session over an existing part file.

A download now hashes its part file on startup and credits the chunks that
verify. Verification is per chunk rather than inferred from the file's length:
chunks are written at byte offsets, so a gap reads back as zeros and an
interrupted write leaves a partial chunk, and neither is distinguishable from
real data by size. The cost is one pass over the file, paid only when a part
file already exists.

A part file that turns out to be complete — a run interrupted between the last
chunk and the rename — is finished immediately, since nothing else would ever
drive it to completion.

### Surviving a network drop

Closing a downloader's signalling socket mid-transfer produced the most
surprising result of any test here: chunk requests still arrived at the seeder,
the seeder's `send()` returned success, the data channel reported `open` at both
ends — and the bytes never landed. Measured directly: the seeder handed 331
chunks to the transport with zero failures and a worst case of 81 ms, and the
downloader received 327.

**No layer below the application notices a path like that.** Everything reports
health. The only evidence is a peer that stops delivering.

What the transfer does about it:

- Swarm messages are transient (above), so a request lost to the outage is not
  replayed later asking for a chunk we now hold.
- A request is only counted as outstanding if the transport accepted it.
  Assuming otherwise meant a chunk was held hostage for a full timeout by a
  request that never left.
- On reconnect, everything outstanding is abandoned and re-planned rather than
  timed out one chunk at a time, and no peer is charged a failure — the outage
  was ours.
- `viewedStreamIds` is cleared on reconnect. It was only ever cleared on
  shutdown, so after a blip every peer looked "already viewed" and nothing we
  did could re-establish one.
- A peer that misses several requests in a row **with nothing delivered in
  between** has its connection torn down and rebuilt. Measured with healthy
  signalling, a rebuild restores a working path in ~260 ms.

Rebuilding is deliberately held off while the SDK is itself reconnecting, plus a
short grace afterwards. It replays its own view intent then, and rebuilding
underneath that races it — ungated, three seeders sometimes never recovered at
all; gated, every configuration tested recovers.

**The honest limit:** a transfer always recovers, but not quickly. A 60 MB
transfer interrupted at 30% completed in about 55 s against roughly 5 s
uninterrupted, and more peers makes it slower rather than faster, since each one
has its own dead path to notice. The remaining cost is in re-establishing peer
connections after a signalling reconnect, which is below this layer.

### Concurrent downloads of the same file

In-progress files are keyed by content **and** destination. Keying by content
alone meant two `fetch` runs of the same file on one machine wrote into a single
part file and the first to finish renamed it out from under the others. A part
file is also locked while in use, so the one genuinely ambiguous case — two
downloads of the same file into the same folder — fails with a clear message
instead of interleaving writes. Locks left by a killed process go stale after
five minutes.

## Compatibility

- The wire envelope format is unchanged.
- Existing send callbacks that return `void` remain accepted; only an explicit `false` means the transport rejected a send.
- SDK targets use the SDK's documented `{ uuid }` or `{ streamID }` forms.
- Existing VDO.Ninja room and signaling behavior remains authoritative.

## Security boundary

WebRTC encrypts data in transit. Room names and optional VDO.Ninja passwords control discovery/connection behavior, but they are not an application authorization system. Validate commands at the receiving agent, expose only intentional shared folders, and do not treat peer-supplied names or capabilities as trusted identity claims.
