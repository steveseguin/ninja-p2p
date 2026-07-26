# SDK Wishlist

Things `@vdoninja/sdk` could add that would directly remove workarounds in
`ninja-p2p`. Every item came from friction actually hit while building, with the
evidence and the workaround in place at the time.

**Status: eight are usable from SDK v1.4.1 on npm, with one packaging fix and
one VDO.Ninja decision still open.** Item 9 exists in the SDK source and package
metadata, but its declaration file is absent from the published npm tarball.

Verified against a local v1.4.1 build on 2026-07-25 with two live Node peers over
real signalling — not by reading the source. Results and two corrections to the
SDK's own Node caveats are in [Verification](#verification) at the end.

`ninja-p2p` now declares `@vdoninja/sdk` `^1.4.1` and uses its runtime APIs
directly. A narrow local type shim remains because the 1.4.1 npm tarball
advertises `vdoninja-sdk.d.ts` but does not include it. Runtime feature detection
also remains so a room containing an older already-installed peer automatically
uses the verified base64 swarm fallback for that peer.

| # | Item | Status | API |
|---|------|--------|-----|
| 1 | Binary send path | **landed** | `sendBinary()` / `binaryReceived` |
| 2 | Teardown completion signal | **landed** | `await disconnect()` / `teardownComplete` |
| 3 | Backpressure signal | **landed** | `getBufferedAmount()` / `bufferedAmountLow` |
| 4 | Multiple channels per peer | **landed** | `openChannel()` / `getChannel()` / `channelOpen` |
| 5 | Unordered / partial reliability | **landed** | `ordered` / `maxRetransmits` / `maxPacketLifeTime` |
| 6 | Max message size | **landed** | `getMaxMessageSize()` |
| 7 | Per-peer connection quality | **landed** | `getPeerQuality()` |
| 8 | Unambiguous lifecycle events | **landed** | `disconnected` detail: `intentional`, `reason`, `phase` |
| 9 | TypeScript definitions | **packaging fix needed** | metadata points to an omitted `vdoninja-sdk.d.ts` |
| 10 | Room/salt derivation contract | **open** | — |

---

## 1. A real binary send path — landed

**Was.** Everything sent was JSON-stringified before it reached the data channel
(`vdoninja-sdk.js:5983`), and `sendData` wrapped the payload as `{ pipe: data }`
first. An `ArrayBuffer` serialised to `{}`. Swarm transfer therefore base64-encoded
every chunk: ~33% of all bandwidth, permanently.

**Now.** `sendBinary(bytes, uuid, options)` puts bytes on the wire untouched and
the receiver gets `binaryReceived` with a real `Uint8Array`.

The design detail that matters: binary travels on a dedicated `x-bin` channel, not
the control channel. VDO.Ninja renders any binary payload arriving on the control
channel as a WebP image frame, so the obvious implementation would have visibly
corrupted every VDO.Ninja viewer instead of being harmlessly ignored. The `x-`
prefix is reserved on both sides, so a VDO.Ninja peer ignores the lane entirely.

**Measured:** 11.4 MB of 60 KB frames delivered byte-identical at **6.4 MB/s** in
Node. Our base64 swarm path measured 1.1 MB/s.

## 2. Teardown that tells you when it is finished — landed

**Was.** `disconnect()` returned `void` and did its real work inside a promise
chain it never handed back (`vdoninja-sdk.js:924`). The `disconnected` event was
not usable as a completion signal because the socket-close handler fired the same
event much earlier. Exiting on it tore the process down mid-cleanup, which crashed
the native WebRTC module and corrupted CLI exit codes.

**Now.** `disconnect()` returns a promise that resolves when cleanup genuinely
completes, and `teardownComplete` is emitted exactly once from that one place.

**Measured:** resolved in 53 ms with `teardownComplete` observed. Our workaround —
polling `sdk.connections.size` and `sdk.signaling` with a 5 s cap — can go.

## 3. A backpressure signal — landed

**Was.** `bufferedAmount` was read internally for the bye-flush but never exposed,
so flow control was guesswork and our in-flight caps were hand-tuned against one
link.

**Now.** `getBufferedAmount(uuid, label)` plus a `bufferedAmountLow` event, and
`sendBinary` applies backpressure itself unless `waitForDrain: false`.

**Measured, and it works in Node** — see [Correction 2](#correction-2-bufferedamount-does-work-in-node-just-not-the-event).

## 4. More than one data channel per peer — landed

**Was.** Exactly one channel, `createDataChannel('sendChannel', { ordered: true })`
at `vdoninja-sdk.js:1881`. A 64 KB chunk head-of-line-blocked any control message
queued behind it.

**Now.** `openChannel(uuid, label, options)`, with the label forced into the
reserved `x-` namespace so it is safe toward a browser peer. Incoming reserved
channels surface as `channelOpen` with the raw `RTCDataChannel` handed over —
the application owns the protocol on it.

## 5. Unordered / partially-reliable delivery — landed

`ordered`, `maxRetransmits` and `maxPacketLifeTime` pass through to
`createDataChannel`, with the mutually-exclusive pair rejected up front rather
than left to throw inside WebRTC.

Worth noting we have not adopted this yet. Chunked transfer indexes and hashes
every chunk, so ordering is redundant — but unordered delivery interacts with
backpressure and retransmission in ways worth measuring on a lossy link before
turning it on, and every link we have measured so far is local.

## 6. Tell callers the maximum message size — landed

`getMaxMessageSize(uuid)` returns the negotiated SCTP limit, or null if the
transport has not reported one. See
[Correction 1](#correction-1-roamhqwrtc-does-expose-pcsctp) — it is not null under
`@roamhq/wrtc`, which the SDK docs assume.

## 7. Per-peer connection quality — landed

`getPeerQuality(uuid)` returns `{ rttMs, lossRate, candidatePairType, relayed,
availableOutgoingBitrate, bytesSent, bytesReceived }`. This lets a new peer be
ranked on its first request instead of its tenth, which is exactly the gap in our
swarm scoring.

`lossRate` is null on a data-only peer, which is correct and documented — loss is
derived from inbound RTP and a data-only peer carries none.

## 8. Unambiguous lifecycle events — landed

`disconnected` now carries `{ intentional, reason, willReconnect, phase }`, with
`phase: 'socket'` for the close and `phase: 'teardown'` for completion. We were
logging "SDK will attempt reconnect" during deliberate shutdowns; `willReconnect`
answers that directly and our local suppression flag can go.

## 9. TypeScript definitions — packaging fix needed

`vdoninja-sdk.d.ts` exists in the SDK source and the package metadata points to
it, with internals deliberately omitted. The npm 1.4.1 tarball does not contain
the file, so TypeScript consumers resolve the Node entry to untyped JavaScript.
`ninja-p2p` therefore keeps its narrow shim until a registry release actually
ships the advertised declaration.

## 10. A documented room and hash derivation contract — still open

Room hashing uses `password + salt` with a default salt of `"vdo.ninja"`
(`vdoninja-sdk.js:677`). It is what makes a Social Stream Ninja listener possible
from a third-party client — but only because we read the source to confirm the
salts matched.

`docs/compatibility.md` now says salt behaviour "remains unchanged", which is a
commitment not to break it. What is still missing is the derivation itself stated
plainly, so a third-party client can implement against a document rather than
against a source file.

This one is genuinely a VDO.Ninja decision, not an SDK one: publishing it as
stable constrains VDO.Ninja. Recording it here as open rather than pressing.

---

## Verification

Two Node peers, real signalling, `@roamhq/wrtc`, local build of v1.4.1.

```
sendBinary            60,000 bytes  ->  sha256 identical, instanceof Uint8Array true
bulk                  200 x 60 KB   ->  11.44 MB in 1.79 s = 6.38 MB/s, 200/200 frames
getMaxMessageSize()   262144
await disconnect()    resolved 53 ms, teardownComplete fired
getPeerQuality()      { rttMs: 0, lossRate: null, candidatePairType: 'host/host',
                        relayed: false, bytesSent: 11500347 }
```

Two caveats in the SDK's Node docs did not survive measurement.

### Correction 1: `@roamhq/wrtc` does expose `pc.sctp`

`vdoninja-sdk.js:2847` and `README-NODE.md` both state that `@roamhq/wrtc` does
not expose `pc.sctp` at all, so `getMaxMessageSize` returns null there.

Measured: `pc.sctp` is present and `pc.sctp.maxMessageSize` is **262144**.

This matters beyond a doc fix. The advice that follows from "returns null" is to
assume 65536; the real negotiated limit is 4× that. We were sending 64 KB chunks
on a guess, and can now ask.

### Correction 2: `bufferedAmount` does work in Node, just not the event

`README-NODE.md` states `bufferedAmount` "stays 0 on `@roamhq/wrtc` no matter how
much is queued — measured at 0 after handing it 2.4MB", and concludes that
`getBufferedAmount()` always returns 0, `waitForDrain` is a no-op, and Node
callers must keep an application-level cap.

Measured on the binary lane:

```
peak bufferedAmount, waitForDrain: false  ->  4,380,000
peak bufferedAmount, waitForDrain: true   ->  1,080,000   (high-water mark 1,048,576)
```

It tracks accurately, and `waitForDrain` is doing real work — the cap holds within
3% of the configured high-water mark.

**Root cause of the original measurement.** `getBufferedAmount(uuid)` with no label
reads `connection.dataChannel`, the *control* channel. `sendBinary` queues on
`x-bin`. So the reading was of an idle lane while a different one filled. Run
side by side during the same burst:

```
peak getBufferedAmount(uuid)        [control lane]  ->  0
peak getBufferedAmount(uuid, 'bin') [binary lane]   ->  4,380,000
```

**What is genuinely missing under wrtc** is the `bufferedamountlow` *event*: it
never fires, so `bufferedAmountLow` never emits there. It does not matter, because
`_waitForChannelDrain` polls at 50 ms as a fallback and that is what carries the
backpressure. Worth narrowing the caveat to the event rather than the value —
"keep an application-level cap in Node" is advice Node callers do not need.

---

## Deliberately not asking for

To be clear about scope, none of these are wanted:

- server-assisted routing, coordination, or relay logic — the whole point here
  is that no server is involved beyond signalling and TURN
- chunking, resume, or file-transfer semantics inside the SDK; that belongs in
  the layer above and we already have it
- retry, queueing, or delivery guarantees — coordination transport is the right
  contract
- anything requiring accounts, identity, or persistence

## Adjacent, still true

**`@roamhq/wrtc` segfaults on normal process exit** once a data channel has
existed, after everything has been closed correctly:

```bash
node -e "const w=require('@roamhq/wrtc');const pc=new w.RTCPeerConnection();
         const dc=pc.createDataChannel('x');dc.close();pc.close();"
# Segmentation fault, exit 139
```

Not the SDK's bug, and now documented in `README-NODE.md`. We exit explicitly
after awaiting teardown, which avoids it.
