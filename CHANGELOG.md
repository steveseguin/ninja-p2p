# Changelog

## 0.2.2

- Add the package's explicit MIT license with Steve Seguin as the copyright
  holder.
- Raise the installed SDK floor and browser dashboard pin to 1.5.4, the first
  SDK release under MPL-2.0.
- Update current licensing documentation and release checks for the SDK's new
  terms. Runtime behavior is unchanged.

## 0.2.1

- `doctor` now probes the adapter selected by the SDK and accepts either
  `@roamhq/wrtc` or the data-only `node-datachannel` path.
- Duplicate SDK disconnect notifications collapse into one logical peer-leave
  event.
- Pending binary sends no longer start a base64 fallback after swarm shutdown.
- The Node bridge and browser dashboard now wait for an open data channel before
  routine sends, avoiding expected startup warnings while preserving explicit
  fallback and retry behavior.
- The browser dashboard is pinned to the reviewed SDK 1.5.2 build instead of a
  stale, nondeterministic `@latest` URL.
- Release checks cover Node 20, 22, and 24 with both supported WebRTC adapters,
  plus the current npm install path used by Node 24.
- Licensing documentation now distinguishes ninja-p2p's MIT license from the
  SDK's separate per-file terms and unmodified linking exception. No license
  terms or license files changed.

## 0.2.0

The largest release so far. Agents can now be woken by incoming mail, files move
as a swarm rather than a single push, and live stream chat can be piped into a
room.

### Agents that act while you are away

- **`--on-message <command>` wake hooks.** A turn-based agent only acts when
  something hands it a turn, so a message could sit unread forever. A wake hook
  is that turn. Bursts are coalesced into one run, runs never overlap, and wakes
  are rate limited — verified live by pointing two agents at each other and
  confirming the runaway stayed at its configured rate.
- **`ninja-p2p wait`** blocks until mail arrives, for driving the loop yourself.

### Swarm file transfer

`ninja-p2p seed <file>` and `ninja-p2p fetch <name-or-id>` add a bulk,
multi-recipient path alongside the existing one-to-one `send-file` flow.

- Files are content-addressed by sha256 and every chunk is hashed individually,
  so a peer serving corrupt data is caught per chunk and routed around.
- A partial downloader is already a source, so downloaders serve each other and
  total throughput holds steady as they are added.
- Chunk bytes travel on a dedicated binary channel rather than base64 inside
  JSON, which keeps bulk traffic from blocking control messages. Needs
  `@vdoninja/sdk` 1.4.1+; older peers fall back automatically, per request, so
  mixed rooms work.
- Interrupted downloads resume, verifying what is already on disk by hashing it.
- Concurrent downloads of one file are kept apart by destination and locked, so
  they cannot overwrite each other.
- Large chunk-hash manifests are requested in verified, bounded pages instead
  of eventually exceeding the data-channel message limit.
- Seeding and final verification stream from disk, keeping memory bounded for
  large files.

Median 12.7 MB/s for one downloader on a local network; roughly 13 MB/s total
across three. The multi-downloader figure varies substantially run to run — see
the README for the spread.

### Live stream chat

- **`ninja-p2p ssn --session <id>`** bridges Social Stream Ninja — Twitch,
  YouTube, Kick and everything else it aggregates — into a room as events on the
  `social` topic, with a `say` command to reply to every platform at once.
  The guides start with `--read-only`; publishing is an explicit opt-in.

### Getting started and diagnosis

- **`ninja-p2p demo`** runs a full live round trip between two peers and prints
  a pass or fail per step.
- **`ninja-p2p doctor`** checks Node, the native WebRTC module, signalling
  reachability, and running sidecars.

### Fixes

- Exit codes were wrong on every successful run: `@roamhq/wrtc` crashes during
  native teardown at process exit, so a CLI that had done its job correctly
  returned 139. Shutdown now waits for real teardown and exits explicitly.
- Shared folder paths could be escaped with a symlink. Containment is now
  checked against the resolved real path.
- Peers were told a version that was typed in by hand and had drifted from the
  released one. It is read from `package.json` now.
- A disconnect no longer logs that a reconnect is coming when it is not.
- Swarm traffic is never retained or replayed: it was filling the message
  history ring, evicting the conversation that history replay exists to serve.
- Peer-controlled transfer IDs can no longer reach filesystem paths. Simple
  file offers and chunks now have strict shape, sender, and size validation,
  never overwrite an existing destination, and do not pollute message history.
- Wire envelopes have bounded identity and routing fields, and an established
  WebRTC connection cannot silently switch to another peer's stream ID.
- Empty swarm files finish correctly, fresh downloads claim their lock before
  the first chunk, and an invalid completed part is discarded instead of
  poisoning every retry.
- The Social Stream bridge now works on the documented Node 20 floor via its
  explicit `ws` fallback.
- The SDK dependency floor is now 1.4.1, enabling its binary, backpressure, and
  teardown surfaces. Its npm tarball advertises but omits the declaration file,
  so a narrow local type shim remains until a registry release includes it.
- Wake subprocess errors no longer crash or permanently wedge the runner, and
  peer text is bounded before entering the process environment.
- The dashboard observes rejected sends, applies real data-channel
  backpressure, validates inbound transfers, and reports delivery
  acknowledgements.
- History replay now returns only broadcasts and messages involving the
  requester; a peer can no longer disclose unrelated direct-message history.
- The mobile dashboard keeps chat controls reachable during long conversations,
  hides replayed control-message noise, and reports intentional disconnects
  accurately.
- The full suite now closes swarm fixtures deterministically on the Node 20
  support floor. A reusable live swarm validator covers both the 1.4.1 binary
  lane and the 1.4.0 base64 fallback.

### Documentation

- A landing page at the project site, with the operator dashboard moved
  alongside it. Existing `?room=` links still work.
- New: the security model, the Social Stream bridge guide, and a protocol and
  reliability document covering how transfer actually behaves, including what
  was measured and deliberately not built.
- The README and bundled Codex/Claude skills now distinguish simple sends,
  allowlisted shared folders, browser limits, and resumable swarm transfer.
- The library guide now documents the actual binary API (`sendBinaryTo` and the
  `binary` event) instead of implying that `sendRaw` bypasses JSON.
- Product messaging now leads with the user outcome — separate AI tools working
  as a team — and presents Social Stream Ninja as an important optional
  co-host, moderation, research, and live-production use case.

## 0.1.4 and earlier

See the git history.
