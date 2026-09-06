# Recovery validation

Run from a built checkout with a supported Node WebRTC adapter:

```bash
npm run build
node scripts/validate-swarm-live.mjs --impaired
node scripts/validate-swarm-live.mjs --relay
node scripts/validate-swarm-live.mjs --impaired --relay
```

Each run creates an isolated random room and temporary files, then disconnects
both peers and removes its own fixture. It does not use a streaming channel.
Do not rebuild `dist` while a validator is running.

`--impaired` drops the first manifest page once and the first attempt for every
17th chunk, and delays other binary replies by 20 or 80 ms. It transfers 512 KiB
in 512 chunks, interrupts after at least 128 verified chunks, disconnects the
receiver, constructs a fresh manager, and reconnects. Assertions require resume
from disk, request timeout recovery, and an exact final SHA-256 match. Production
timeouts are retained. Loss is injected at the application-message boundary over
real WebRTC; it is not an OS packet-loss emulator or a claim about SCTP loss rates.

`--relay` uses the bridge's existing TURN-only option and requires SDK statistics
to confirm the selected candidate pair is relayed. A missing relay or unavailable
quality report fails the check rather than being reported as a relay success.
The normal fixture is 2 MiB in 2,048 chunks. SDK `getPeerQuality` supplies the
candidate type; these runs used installed SDK 1.6.0 and `@roamhq/wrtc` 0.8.0 on
Windows with Node 22.14.0.

## Results from this follow-up

- Direct impaired/restart run passed on `host/host`: 31 chunks and one manifest
  page deliberately dropped; 137 verified chunks resumed from disk; all 512
  chunks verified in the completed file.
- TURN-only run passed on `relay/relay`: 2,048 binary chunks, eight manifest pages,
  and matching final file SHA-256.
- Combined impaired/restart + TURN run passed on `relay/relay`: 31 chunks and one
  manifest page dropped, 128 chunks resumed, and all 512 chunks verified. Elapsed
  transfer time, including manifest retrieval and restart, was 39,685 ms.
- An earlier 2 MiB impaired run exceeded its 90-second deadline after reconnect.
  The smaller impairment fixture keeps real request-timeout coverage practical.
  The earlier failure remains a limit of these results, not proof that larger
  interrupted transfers meet a latency target.

These are bounded recovery checks, not throughput benchmarks. They do not model
bandwidth saturation, long outages, TURN service failure, or arbitrary packet
loss. Keep command handlers idempotent; these tests do not introduce message
acknowledgement retries or automatic command re-execution.
