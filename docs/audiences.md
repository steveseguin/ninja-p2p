# Audiences, Use Cases, and Ideas

A working notebook, not a spec. `ninja-p2p` has not found its audience yet, so this
file exists to keep the candidate audiences honest and side by side while we
experiment. Nothing here is committed to. When one audience clearly wins, we
collapse this file into a positioning doc and delete the rest.

Update this as things are learned. Record what was tried and what it taught us,
not just what sounded good.

---

## The one-sentence claim

> Cross-machine, cross-vendor agent messaging with no server you have to run.

That is the only thing `ninja-p2p` does that nothing else does. Every audience
pitch below is a different way of cashing in that same sentence. Alternatives
each fail at least one leg:

| Alternative | Fails on |
| --- | --- |
| Claude Code subagents | Same machine, same vendor, ephemeral |
| MCP | Client to server, not agent to agent |
| Google A2A | Needs HTTP endpoints you host and expose |
| Redis / NATS / a queue | You run the server |
| Shared files / git | Same filesystem, or a remote you manage |
| SSH / tmux | No NAT traversal, manual per-box setup |

The WebRTC choice does real work here. NAT traversal is free, so an agent behind
CGNAT can reach one across town with no port forwarding, tunnel, or VPS. That is
a capability, not a repackaging. Second asset: the signaling layer is
VDO.Ninja's, already carrying live video at scale. "I did not build a new chat
server, I reused the one already moving video for thousands of people" is a
strong and true line.

---

## Status log

**2026-07-25 — release audit turned the feature set into a bounded contract.**
The v0.2 work was reviewed as hostile network input rather than only as a happy
demo. The product intent stayed the same; the edges became explicit:

- simple transfers are one-to-one, checksum verified, non-overwriting, and
  capped at 256 MiB; swarm is the streaming path for larger or multi-recipient
  work
- large swarm manifests are fetched in authenticated pages, part files are
  destination-locked, and corrupt completed parts are discarded before retry
- history replay cannot disclose direct messages between other peers, and bulk
  transfer traffic no longer evicts conversation history
- wake environment text is bounded, subprocess failures cannot wedge the
  runner, and Social Stream uses an explicit Node 20-compatible `ws` dependency
- the dashboard now keeps chat reachable on mobile, ignores stale disconnect
  events, validates incoming files, applies backpressure, and caps its DOM

Evidence: the full suite passed on Node 22 and the Node 20 support floor; a
packed install pinned to SDK 1.4.0 passed the base64 compatibility fallback; a
2 MiB, 2,048-chunk transfer exercised eight manifest pages on both fallback and
1.4.1 binary lanes. The v0.2 dependency floor moved to the now-public 1.4.1
after that compatibility check. Real Chrome covered chat, commands, privacy filtering, XSS text,
mobile layout, reconnect, a checksum-verified 512 KiB receive, and a 505-message
history flood. Chrome automation could not drive the outbound file chooser
without extension file-URL permission, so that interaction remains covered by
the live sidecar protocol tests rather than the browser driver.

**2026-07-25 — wake hooks landed.** The biggest gap for every agent-facing
audience was that turn-based agents never notice inbound mail. The sidecar held
messages forever while the agent sat idle, so "agents collaborating" required a
human to poke each one. Two additions close it:

- `--on-message <cmd>` — the sidecar runs a shell command when real peer
  messages land. Batches are coalesced, runs never overlap, and a default limit
  of 30 wakes/min stops two chatty agents from ping-ponging unattended.
- `ninja-p2p wait --id X [--timeout ms]` — blocks until the inbox is non-empty.
  Exit 0 means mail, exit 1 means timeout, so `while ninja-p2p wait --id x; do
  ...; done` behaves the way a shell author expects.

Verified live over real WebRTC between two sidecars: three rapid DMs coalesced
into a single wake carrying `NINJA_WAKE_COUNT=3`, and peer join/leave notices
correctly did *not* trigger wakes.

This is the difference between "a message bus for agents" and "your agents work
together while you sleep." It should be the centre of the next demo.

**2026-07-25 — `demo` and `doctor` landed.** The notes below called the
six-command onboarding the biggest drop-off, so:

- `ninja-p2p demo` runs a real round trip between two peers (connect, discover,
  DM, reply, request/response) and prints pass or fail per step in about a
  second. It is both the thirty-second pitch and a self-test. `--keep` holds the
  room open so it can be watched in the browser dashboard.
- `ninja-p2p doctor` checks Node version, the native WebRTC module, signaling
  reachability, state-folder writability, and which sidecars are alive.

The README now opens with `demo` rather than a six-step setup.

**2026-07-25 — exit codes were silently broken.** Found while testing `demo`:
`@roamhq/wrtc` **segfaults during normal Node process teardown** whenever a data
channel has existed, corrupting the exit code (139 or 127) even on a completely
successful run. Every CLI command that actually reached a peer was affected. It
was invisible because nobody had been checking `$?` — and it would have silently
broken the `while ninja-p2p wait --id x; do ...; done` loop shipped hours
earlier.

Three fixes, in order of how much they matter:

1. The CLI now exits explicitly after stdout drains, rather than by letting the
   event loop empty. Explicit exit skips the native teardown path and the crash
   with it. Verified 5/5 clean exits.
2. `VDOBridge.disconnect()` now calls `stopViewing` for every viewed peer.
   Viewer peer connections were never closed, only forgotten.
3. `disconnect()` now waits for the SDK's teardown to actually finish. Its
   "disconnected" event fires from the socket-close handler well before the real
   cleanup, which runs later in a promise chain the SDK never returns. Waiting on
   that event meant callers resumed while two sockets and ten timers were still
   live.

Lesson worth keeping: **test exit codes, not just output.** Everything printed
"Demo passed" while returning 127.

**2026-07-25 — security model written, and a real hole closed while writing
it.** `docs/security.md` now states plainly what a room is (a bearer
capability), what a password does, what a peer can and cannot reach, and what is
not protected at all (self-asserted identity, no signing, no delivery
guarantees). Writing it surfaced an actual gap: shared-folder path containment
was **lexical only**, so a symlink placed inside a share could hand out any file
it pointed at. Now both the resolved path and the real path must sit inside the
share root. Covered by a test.

That is the argument for writing the security doc before the feature, not after.

**2026-07-25 — Social Stream Ninja bridge shipped.** `ninja-p2p ssn --session
<id> --room <room>` pipes live chat from every platform SSN aggregates into a
room as `social_chat` events, and advertises a `say` command so one agent
message fans back out to every connected platform. Built entirely against SSN's
documented WebSocket API; no changes to SSN. Verified end to end against a
throwaway session: an agent discovered the bridge's `say` ask through peer
discovery, sent it, and got `{ok: true, sent: true}` back.

Two findings worth carrying forward:

- **SSN already publishes over VDO.Ninja WebRTC**, and the room, stream id, and
  salt line up exactly with what `@vdoninja/sdk` defaults to. A relay-free bridge
  is possible today; the only blocker is that the contract is an internal detail
  and could change. Requirement G in the bridge doc asks SSN to freeze it.
- **The SSN session id is an all-or-nothing credential.** It grants reading chat,
  sending chat everywhere, blocking users, and injecting fake donations. Until
  scoped tokens exist, the honest advice to a cautious streamer is "do not point
  an autonomous agent at this." That is requirement A, and it is the single
  biggest unlock for this audience.

  Two follow-ups on that. First, the fix is smaller than it looks: SSN's channel
  system already expresses read-only (the extension publishes chat on channel 4
  and listens for commands on channel 1), so a `read` token is a relay-side
  join-handshake change needing **nothing** from the extension or the standalone
  app. Second, `--read-only` now enforces the same posture from our side — the
  bridge hides the `say` ask and refuses it if sent anyway. That guards against
  an over-eager agent, not against anyone holding the session id, so it is a
  mitigation and not a substitute.

`docs/social-stream-bridge.md` holds the setup guide plus a prioritised
requirements map for SSN itself, aimed mostly at the standalone desktop app,
which is a far better host for a persistent bridge than a browser extension.

Also worth flagging as a first-class hazard rather than a footnote: **live
public chat is the most exposed prompt-injection surface a project like this can
have.** Anyone watching can type into it. That warning is now in the README, the
bridge doc, the landing page, and both agent skills.

**2026-07-25 — swarm file transfer core built and tested.** The old transfer was
one sender pushing base64 chunks in strict order to one receiver: capped at a
single peer's upload, broken by any out-of-order arrival, and unresumable from
anyone else. `src/swarm.ts` and `src/swarm-session.ts` replace that model.

Proven in tests, including a deterministic in-memory multi-peer swarm:

- **A peer re-serves a file it downloaded after the original seeder leaves.**
  This is the property that makes it a swarm rather than a mirror.
- **A partially complete peer serves the chunks it already holds** while still
  downloading the rest.
- **A peer answering with well-formed garbage is caught and routed around**
  without leaving the swarm — per-chunk hashes locate the liar, and peer scoring
  demotes it.

Design notes worth keeping:

- Files are content-addressed by sha256, so every peer holding the same bytes is
  interchangeable and swarms form implicitly.
- **Per-chunk hashes are non-negotiable.** Without them a bad chunk only shows
  up as a whole-file hash failure at the end, with no way to know who sent it.
- Chunks are written at their byte offset, not appended. That single change is
  what enables out-of-order, multi-source, and resume.
- Rarest-first piece selection, then best-scoring peer among those that hold it.
  Scoring is measured only — EWMA RTT, observed failures, queue depth. Nothing a
  peer asserts about itself counts, taking the lesson from chunkcast's
  `sourceDecisionScore` without importing its server-assisted coordination.

**On "multiple data channels": verified not available per peer.** The VDO.Ninja
SDK creates exactly one `sendChannel` per peer connection
(`vdoninja-sdk.js:1881`). So the speedup does not come from stacking channels on
one peer. It comes from two places that the swarm design already exploits:
requesting from several peers at once (one channel each), and keeping several
requests in flight per channel instead of waiting for each to land. Worth
stating plainly rather than implying parallel channels.

**2026-07-25 — swarm wired end to end and proven live.** `swarm_offer`,
`swarm_announce`, `swarm_request`, `swarm_chunk` and `swarm_have` message types,
a `SwarmManager` binding sessions to a room, and two CLI commands:

```bash
ninja-p2p seed ./big-file.zip --room my-room
ninja-p2p fetch big-file.zip --room my-room --out ./downloads --seed
```

Live result over real WebRTC with a 5 MB file in 82 chunks:

1. seeder → peer A: 8.5s (599 KB/s)
2. **original seeder killed**
3. peer A → peer B: 9.8s (521 KB/s), byte-identical sha256

Step 3 is the whole point: B pulled the entire file from a peer that never had
the original, with the source gone. The swarm outlived its seeder.

Two bugs the live test caught that unit tests could not:

- **Late joiners never learned the manifest.** Offers were broadcast once at
  seed time, and the periodic re-announce only carried the bitfield. A peer
  joining afterwards saw a swarm it had no manifest for. Fixed by greeting each
  arriving peer with our catalogue — unicast, not broadcast, because a manifest
  carries one hash per chunk and is megabytes for a large file.
- **A finished download stopped serving.** `finish()` renames the `.part` away,
  so the session could no longer read chunks — the swarm lost its newest full
  source at the exact moment it gained one. The manager now reopens the finished
  file as a seed session.

**2026-07-25 — throughput nearly doubled, and binary framing ruled out.**

Set out to add binary chunk framing for the ~33% base64 win and found it is
**not possible through this SDK**: `_sendDataInternal` does
`typeof data === 'string' ? data : JSON.stringify(data)`
(`vdoninja-sdk.js:5983`). Every non-string is JSON-stringified before it reaches
the data channel, so `bridge.sendRaw()` sends raw *values*, not raw *bytes* — an
ArrayBuffer would serialise to `{}` and lose the payload silently. Base64 is
structural until the SDK grows a real binary path. Worth knowing before anyone
tries again.

Measuring instead of assuming found the actual bottleneck:

```
measured:         9.6 chunks/s
pump-limited max: 16.0 chunks/s   <- ceiling with 1 peer
```

The 250ms pump interval, not base64, was dominating. With four requests in
flight, a slot freed 10ms after a tick sat idle for the other 240ms. Pumping on
chunk arrival (with a 5ms coalescing window, since planning is O(chunks x peers)
and chunks arrive in bursts) removed the ceiling:

**5 MB: 8.5s → 4.4s. 599 KB/s → 1.1 MB/s. Same checksum.**

Lesson: the obvious optimisation was both impossible and not the bottleneck.
Measure first.

**2026-07-25 — browser can send files now.** The dashboard could browse shares
and download, but not send — the last gap in the file-transfer story. It now has
a "Send a File" panel on the peer details pane that speaks the same
offer/chunk/complete protocol the CLI does. Verified browser to CLI with a
300 KB file, byte-identical sha256. Yields every 16 chunks so the tab stays
responsive and the data channel can drain.

`isInboxWorthy` excludes all five swarm types; without that a single file would
write thousands of inbox entries and bury every real agent message.

**SSN thread status: parked, not abandoned.** The bridge is built, documented,
and tested. It is blocked from being a traction bet only by requirement A
(scoped tokens), which is a relay-side change on SSN's side. Resume here when
that lands — nothing in `ninja-p2p` needs to change first, and `--read-only`
already gives streamers a safe way to try it today.

**2026-07-25 — the SDK granted the wishlist, and the real bottlenecks turned out
to be ours.** `@vdoninja/sdk` 1.4.1 landed nine of the ten items in
`docs/sdk-wishlist.md`, including a genuine binary send path. Adopting it went
nothing like expected and the story is worth keeping.

Binary chunks alone were worth **18%** — real, but nowhere near the headline
33% that base64 supposedly cost. Measuring the swarm properly turned up three
bugs that had been invisible because every previous live test had exactly one
downloader and one seeder.

1. **A fixed multi-second startup stall.** A downloader that learned a file
   existed had to wait for the seeder's next periodic bitfield broadcast before
   it could ask for anything — 2.6s of a 4.0s transfer, doing nothing. Peers now
   answer a bitfield with their own, unicast, and only when they hold something
   the asker lacks (which also makes the exchange terminate after one round).

2. **Rarest-first ties broke by index, which silently disabled the swarm.** At
   the start of a download every chunk is equally rare, so every downloader
   asked for the same chunks in the same order. They never held anything each
   other lacked, so the "a partial downloader is already a source" property —
   the whole premise — never once fired. Three downloaders ran at exactly one
   third the speed of one. Random tie-breaking fixed it, and this is the single
   most valuable thing found all day.

3. **Concurrent downloads of one file destroyed each other.** Part files were
   keyed by content id alone, so three `fetch` processes on one machine wrote
   into the same file and the first to finish renamed it away; the rest died on
   ENOENT having already corrupted each other's data. Now keyed by content *and*
   destination, with a lock for the genuinely ambiguous case.

Measured after, 10 MB from one seeder, separate processes:

```
downloaders   each        total       (before today)
1             12.7 MB/s   12.7 MB/s   1.1 MB/s
2             7.1 MB/s    14.2 MB/s
3             4.7 MB/s    14.1 MB/s   7.8 MB/s total
5             2.4 MB/s    12.0 MB/s   ~3 MB/s total
```

Total throughput now holds flat as downloaders are added instead of collapsing.

**Two things measured and deliberately not built.** In-flight window size (4 vs
16 vs 48) changed throughput by nothing, and chunk size (64 KB vs 128 KB vs
192 KB) by under 2%. Both were on the to-do list as "obvious" optimisations.
Neither was real. The negotiated SCTP limit got used as a safety guard instead —
at the 64 KB default a base64 chunk is 85 KB, which a peer negotiating the
spec-minimum 65536 would refuse.

**Two of the SDK's own Node caveats did not survive measurement**, and both were
in our favour: `pc.sctp` *is* exposed under `@roamhq/wrtc` (262144, not null),
and `bufferedAmount` *does* track — the original reading was of the control
channel while the bytes queued on the binary one. Reported back with the root
cause rather than just the contradiction.

**Lesson, again:** the thing worth optimising was not the thing that looked
expensive. Base64 was visible and cost 18%. A tie-break rule nobody would think
to question cost 3x, and cost it in exactly the scenario the product is *for*.
Every live test until today had one downloader, which is the one shape where the
bug is invisible.

**2026-07-25 — "resumable" was not.** Went looking for more bugs of the same
shape as the tie-break one — a property true in the code's structure that never
actually fires — and found the third in a day.

The part file always kept its bytes across a restart (`r+`, with a comment
saying exactly that). But the bitfield was rebuilt empty, so a resumed download
credited zero chunks and re-fetched the entire file. Proven in eight lines: run
one takes 5 of 10 chunks and drops the session, run two over the same part file
reports 0. The bytes were on disk the whole time — 20,480 of them — just never
counted.

No test caught it because none had ever constructed a second session over an
existing part file. Every test, and every live run, started from nothing.

A download now hashes its part file on startup and credits what verifies.
Hashing rather than inferring from length is load-bearing: chunks are written at
byte offsets, so a gap reads back as zeros and an interrupted write leaves a
partial chunk, and neither is distinguishable from real data by size.

Verified live on 200 MB: 1311/3277 chunks credited from an interrupted run, only
the remaining 1966 fetched, byte-identical, 16.8 MB/s — the largest and fastest
transfer tested so far.

Two things fell out of it. Reading the part file at construction means a
conflicting download is now detected when the session is created rather than
when the first chunk lands, which is strictly better; and a part file that turns
out to be *complete* — interrupted between the last chunk and the rename — would
have hung forever, since the pump exits early on a complete session. Both
handled, both tested.

**Pattern worth naming.** Three bugs today, all the same shape: a documented
property that was structurally true and never once executed in practice.
Rarest-first ties, peer-to-peer sharing, resume. Each was invisible because the
tests and the live runs all exercised the one configuration where the bug does
not show — a single downloader, starting from nothing. The lesson is not "write
more tests", it is **test the shape the feature exists for**, not the shape
that is easiest to set up.

**2026-07-25 — auditing the claims, and the strangest bug yet.** Picked the
untested shapes deliberately this time rather than waiting to trip over them.
Closing a downloader's signalling socket mid-transfer found something I would
not have believed without the numbers:

```
seeder handed to transport:  331 chunks, 0 failures, worst case 81ms
downloader received:         327
```

Requests arrived. Sends succeeded. Both ends reported the channel `open`. Four
chunks simply evaporated. **No layer below the application can detect this** —
everything reports health — so the only possible detector is "a peer stopped
delivering", which is application-level knowledge.

Two ordinary bugs fell out of the same investigation, both from treating swarm
traffic as durable:

- A chunk request that failed to send was queued and replayed later, asking for
  a chunk we already had by then.
- Every swarm message entered the 200-entry history ring. A few seconds of
  transfer evicted the entire conversation that `history_request` exists to
  replay. Swarm traffic is now transient: not retained, not replayed.

And one that mattered more: a request was counted as outstanding whether or not
the transport took it, so a request that never left held its chunk hostage for
the full 15s timeout. And `viewedStreamIds` was only ever cleared on shutdown,
so after a reconnect every peer looked "already viewed" and nothing we did could
re-establish one.

**Two things built and one reverted.** Rebuilding a peer's connection after a
run of undelivered requests works — measured at 260ms to restore a working path
— but only if it does not race the SDK's own reconnect, which it must be held
off during. An adaptive request timeout scaled to measured RTT was built to
notice losses faster, showed no measurable benefit in the case it was built for,
and cost **2.5x throughput with three downloaders** — a peer serving several
others is slow, not broken. Reverted, with the reasoning left in the code so
nobody rebuilds it.

That revert is worth dwelling on: it was caught only because I re-ran the
*normal* benchmark after changing the *fault* path. The fault-path numbers
looked fine.

**The honest limit, now documented:** a transfer always recovers from a
signalling drop, but slowly — about 55s against 5s uninterrupted — and more
peers makes it worse rather than better. The remaining cost is re-establishing
peer connections after a reconnect, which is below our layer. Recording it as a
known limitation rather than claiming reliability we have not got.

**2026-07-25 — the audit finished, and the worst bug was in my measurements.**
Two remaining claims tested, both of which held, plus one finding that
retroactively undermined a day of numbers.

**Wake safety holds.** Two agents each set to reply to whatever messages them —
the runaway the rate limiter exists to prevent, never once run live. With a
2/min limit it produced 4 and 5 turns over 135s against a ceiling of ~4.5, and
logged its deferrals. Separately, ten messages sent at once produced exactly
**one** turn with `count=10`, and no turn ever overlapped another. All three
documented guarantees are real. This is the feature that decides whether an
unattended pair of agents can burn tokens all night, so it is the one most worth
having proven rather than assumed.

**The measurement bug.** Killing a shell job on Windows does not reach the node
process it spawned, so every live test left its daemons running. By the time I
noticed there were **104 stray processes**, all still sitting in rooms, all
still holding WebRTC connections. Every benchmark after the first few was taken
on a machine quietly competing with itself.

That invalidated a decision. I had reverted an adaptive request timeout on the
strength of a measured 2.5x throughput regression. Re-measured on a genuinely
idle machine, the regression did not exist. Worse, the thing the timeout was
built for turned out to be real and common: chunks are occasionally dropped on a
perfectly healthy local link, roughly one run in three, and the flat 15s timeout
turned a 2s transfer into 17s. Correlating the outliers with the logs made it
unambiguous — the slow downloader was always exactly the one with logged
timeouts, and the clean runs had none. Reinstated with a 3s floor, which is the
half that matters: a peer serving several downloaders is slow, not broken.

**The published numbers were single lucky runs.** Repeated on an idle machine, a
single downloader is steady (12.2–13.0 MB/s) but three at once vary by a factor
of four (1.1–5.5 MB/s each). The README claimed 4.7 MB/s each — the top of the
range presented as typical. Now a median with the spread stated, because a
number someone can fail to reproduce is worse than no number.

Also fixed a test of my own that was flaky for the same reason as the tie-break
test earlier: it delivered chunk 0 assuming chunk 0 had been requested, and
piece selection is deliberately random now.

**Standing lesson from the whole day, in one line:** every wrong conclusion came
from trusting a measurement I had not checked the conditions of — the SDK's
`bufferedAmount` reading was of the wrong channel, mine was on a poisoned
machine. Check what else is running before believing a benchmark.

`swarm-manager.ts` now has 22 tests. It was the only substantive module without
any, and four of the day's bugs lived in it.

**2026-07-25 — landing page.** GitHub Pages served only the operator dashboard,
so the project had no front door. `docs/index.html` is now a real landing page
(what it is, the demo output, wake hooks, the comparison table, honest limits)
and the dashboard moved to `docs/dashboard.html`. Existing `?room=` deep links
to the old root redirect to the dashboard with their query string intact, so
nothing that was shared before breaks. Verified in a browser.

---

## Audience 1 — the AI-agent crowd

**Who:** people building with Claude Code, Codex CLI, LangGraph, CrewAI. Biggest
group, most saturated, most skeptical.

**Why they'd care:** they cannot currently make two *different* vendors' agents
work together, on two different machines, without building infrastructure. That
is the wedge. Do **not** pitch "orchestrate your agents" — that phrase is dead on
arrival in this crowd. Pitch the specific impossible thing: *my Claude and my
Codex, on two machines, reviewing each other's work, unattended.*

**Use cases**
- Adversarial pairing: Claude implements, Codex reviews, disagreements surface to
  a human. Two vendors is a genuine quality argument, not just a stunt.
- Approval gates: a planner blocks on a reviewer's `approve` before continuing.
- Long-running handoff: an agent that finishes a build hands results to an agent
  on a machine that has the deploy credentials.
- Overnight loops: with wake hooks, a pair can grind on a task queue unattended.

**Still missing**
- **No MCP server.** They will ask every single time. Either build a thin
  `ninja-p2p mcp` bridge or get a one-line answer so crisp it ends the thread.
  Current answer — "MCP gives an agent tools, this gives agents each other" — is
  good but unproven in the wild.
- **No one-command demo.** Getting two agents talking is still ~6 commands plus
  a room name copy-paste. `ninja-p2p demo` should spawn two wired sidecars and
  print what to watch. This is the single highest-leverage remaining item.
- No notion of a task thread. Every message is independent; agents cannot follow
  "the conversation about PR #42" without inventing their own convention.
- No spend guard. Wake hooks invoke paid models. A per-hour token or invocation
  budget would make people much more willing to leave it running overnight.

**Ideas**
- `ninja-p2p demo` — two sidecars, wake hooks pre-wired, prints the dashboard URL.
- Presets: `--preset planner|worker|reviewer` bundling sensible `--can`/`--ask`.
- Thread IDs on envelopes so a task's messages group naturally.
- `--wake-budget <n>` capping wake invocations per hour, separate from rate limit.
- A `handoff` message type with explicit accept/reject/done states.

**How to test traction:** post the Claude-and-Codex video. If it does not move,
this audience is probably not it, because that is the strongest asset we have.

---

## Audience 2 — devs with more than one machine

**Who:** anyone with a desktop, a laptop, a homelab box, a cloud VM. Nobody is
selling to them directly, which makes this the least crowded lane.

**Why they'd care:** they already feel the pain — "the agent with the good
context is on the wrong machine." No-infra P2P across NAT is a real unlock, and
the pitch needs no AI framing at all to land.

**Use cases**
- Drive from the laptop, run the heavy build on the desktop.
- Agent on the GPU box, agent on the laptop, they coordinate.
- Reach a work machine you cannot VPN into, without opening ports.
- Pull one file off another machine without standing up a share.

**Still missing**
- **No remote execution.** The obvious ask is "run this command over there," and
  we do not do it. This is deliberate — it is a remote shell and needs real auth
  before it ships. Room passwords exist but the security model is undocumented,
  which is worse than either having or not having the feature.
- **No connectivity diagnostics.** When WebRTC fails, the user has no idea
  whether it is the wrtc install, the network, or the room name.
- Flags must be retyped on every box. A `.ninja-p2p.json` per project would fix it.

**Ideas**
- `ninja-p2p doctor` — check wrtc install, signaling reachability, NAT type,
  clock skew. Cheap to build, high trust payoff, great screenshot.
- Config file so `ninja-p2p start` needs no flags in a known project.
- `--allow-exec` with an explicit command allowlist and required room password.
  Ship the security doc *first*, the feature second.
- Document the threat model plainly: who can join a room, what a password
  protects, what a peer can and cannot reach on your disk.

**How to test traction:** a "no VPN, no ports, no server" post aimed at infra
people rather than AI people. Different crowd, different hook, same binary.

---

## Audience 3 — the VDO.Ninja and Social Stream crowd

**Who:** the existing audience. Streamers, creators, AV people. Warm, already
trusting of the WebRTC work.

**Why they'd care:** they are not looking for an agent mesh, so the pitch has to
start from something they already want. The bridge is Social Stream Ninja, which
already ingests live chat from X, YouTube, Twitch and more.

**Use cases**
- An agent that watches live stream chat and reacts, summarizes, or moderates.
- A co-host agent that answers repeated questions in chat.
- Post-stream: an agent that gets the chat log as a room event stream.
- Machine-to-machine coordination for multi-PC streaming rigs.

**Shipped 2026-07-25:** `ninja-p2p ssn` bridges SSN chat into a room and lets
agents reply to every platform with one message. See the status log above.

**Still missing**
- **Scoped SSN tokens.** This is the blocker, and it is on SSN's side, not ours.
  The session id grants full control, so recommending an autonomous agent to a
  streamer today means recommending they hand over their stream. Requirement A
  in the bridge doc.
- No OBS-friendly view. The dashboard is an operator tool, not an overlay.
- The standalone SSN app should host the bridge itself; a checkbox there beats a
  second process. Requirement D.

**Ideas**
- An overlay page showing agent activity, styled for capture.
- A moderation agent that flags rather than acts — fits the read-only posture
  the injection risk demands, and is genuinely useful.
- Lean on the existing Discord for early testers rather than cold-posting.

**How to test traction:** show a co-host or moderation agent to the existing
community. Cheapest audience to reach, because we already have the channel — but
lead with the safety posture, because the failure mode here is public and lands
on someone's channel.

---

## Wildcards

Not currently targeted. Recorded because any of them could outrun the three
above, and two of them are nearly free given what already ships.

### Serverless anonymous chat rooms
`dashboard.html` already is one: open a link, pick a room, talk over WebRTC with
no account and no server. Ephemeral, no history, no signup.
- **For:** near zero build cost, broad appeal, easy to demo.
- **Against:** crowded space, and no moderation story. Anonymous rooms invite
  abuse we have no answer for. Think hard before leaning in.

### Cross-machine file transfer
`send-file`, `--share`, and `get-file` already work, browser included.
Framing: "airdrop between your own machines, over a link, across any network."
- **For:** possibly the sleeper hit. Broadest appeal, lowest conceptual overhead,
  no AI framing needed. Real pain, especially browser-to-CLI.
- **Against:** croc, magic-wormhole, and PairDrop exist. Differentiator has to be
  browser-to-CLI plus NAT traversal that just works.
- **Worth testing:** this may be a better first post than the agent story,
  because it needs zero explanation.

### Distributed community inference
`--can` / `--ask` plus `command` / `respond` is already the skeleton of a
capability marketplace. An agent advertises `--can inference --model ...`, peers
route requests to it.
- **For:** the most interesting story by far. People with idle GPUs is a real,
  motivated group.
- **Against:** the biggest lift. Needs request routing, queueing, result
  streaming, and a trust model. Guaranteed delivery matters here and we
  explicitly do not offer it.
- **Verdict:** not now, but the protocol is accidentally well shaped for it.
  Avoid decisions that would foreclose it.

### Others worth a line
- Distributing CI or test runs across machines you already own.
- Human-plus-agent pair programming with the dashboard as the shared surface.
- Fleet coordination for people running many agents in parallel.

---

## Cross-cutting backlog

Ranked by leverage across audiences, not by effort.

1. ~~`ninja-p2p demo`~~ — done 2026-07-25.
2. ~~`ninja-p2p doctor`~~ — done 2026-07-25.
3. ~~Documented security model~~ — done 2026-07-25, `docs/security.md`.
4. ~~Landing page~~ — done 2026-07-25.
5. ~~Social Stream bridge~~ — done 2026-07-25, `docs/social-stream-bridge.md`.
6. Project config file to kill flag repetition. Now the top item: every
   multi-machine user retypes the same flags on every box.
7. Browser-side uploader for the dashboard. The file-transfer wildcard is the
   cheapest broad-appeal story we have and it is one gap away from complete —
   the dashboard can download from a peer but cannot send.
8. Thread IDs on envelopes.
8. Remote exec behind `--allow-exec` plus an allowlist. Only now that the
   security model is written is this even discussable.
9. MCP bridge, if the agent crowd keeps demanding it.

---

## Known limitations

Honest list. Some are deliberate.

- **A hung wake command stops future wakes.** Runs never overlap, so if the
  command never exits, no further wakes fire. It is visible in the sidecar log
  ("busy, N message(s) will wait") but there is no kill timeout. Deliberate for
  now — killing a possibly-productive agent run mid-flight is worse.
- **Wake hooks do not fire on peer join/leave.** Deliberate: reconnects would
  wake the agent constantly. A `--wake-on-peer` opt-in could be added.
- **Wake hooks do not fire on completed file receipt.** Probably should; not yet
  wired.
- **No delivery guarantees.** Stated plainly in the README. Fine for
  coordination, disqualifying for the inference-marketplace idea.
- **No MCP server.** Deliberate, and the most common question.
- `@roamhq/wrtc` is a native dependency and a real install-friction point for
  Node users.
- Signaling still depends on VDO.Ninja's servers. "No server to host" means no
  server *you* host — worth saying precisely, because someone will check.

---

## Open questions

- Is the strongest first post the agent demo, or the file-transfer demo? The
  agent one is more differentiated; the file one needs no explanation.
- Does the multi-machine framing pull a genuinely different crowd, or the same
  people wearing a different hat?
- Is "no server" legible to normal users, or does it need to be shown rather
  than said?
- Would an MCP bridge win the agent crowd, or just invite comparison to tools
  that do MCP better?
