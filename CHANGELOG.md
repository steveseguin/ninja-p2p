# Changelog

## 0.3.1 — 2026-10-21

- Support the current `@roamhq/wrtc` 0.10 adapter while retaining 0.8 compatibility.
- Add mailbox authorization, OAuth, webhook, task, and worker regression checks to CI.
- Shorten the README and provide separate CLI and library guides, including the
  optional Ninja MCP sidecar connection.
- Show the embedded SDK license and source links in the dashboard.

- Fix Social Stream chat never reaching agent sidecars: sidecars now file the
  bridge's `social` topic into their inbox alongside `events`.
- Fix dashboard security issues: peer-supplied names can no longer inject HTML
  through attributes, a peer cannot take over another peer's entry, the room
  password is no longer saved in the browser, and the SDK script is pinned with
  a Subresource Integrity hash.
- Fix dashboard reliability: stop an upload as soon as the receiver rejects it,
  show replayed history once and in time order, ignore swarm control traffic,
  tolerate malformed peer profiles, clean up after a failed connect, and treat an
  empty password as no password, matching the CLI.
- Redesign the dashboard with a top bar, light and dark themes, a getting-started
  panel, a separate peer details column, and keyboard-accessible peer list.
- `start` and `room` no longer suggest joining with the ID the agent already uses.
- `doctor` and `status` no longer create empty `inbox`, `archive`, and `outbox`
  folders inside state folders that are not sidecars, such as `workers/`.
- The dashboard supports `/task`, lists its commands readably under `/help`, and
  keeps a chosen file and the focused field when peer details refresh.
- Polish the website: fix overflowing command boxes and a clipped demo terminal,
  add a collapsible docs menu on phones, link the worker, task, and voice guides,
  and refresh the dashboard screenshot.
- `fetch --timeout` now ends a download only after that long without a new
  verified chunk, instead of cutting off any transfer longer than five minutes.
- Correct the docs: the raw CLI flow now starts a sidecar so replies arrive,
  the hosted mailbox's MCP tools are described consistently, `NINJA_ROOM`
  bypasses the sidecar queue, mailbox credentials no longer share the worker
  config's file name, and the README lists the remaining flags and helper
  programs.

## 0.3.0 — 2026-10-18

- Fix npm command launchers on Linux and macOS when invoked through symlinks.

- Add guided `worker setup`: choose Codex or OpenCode and a project, approve a
  short connection code, and receive the first read-only task result. Settings
  are saved privately, and interrupted setup resumes without duplicating work.

- Add background mailbox workers for Codex and OpenCode, with allowed senders,
  task progress, approval decisions, cancellation and saved results across restarts.
- Add Dots and OpenCode connection paths to the website and an automatic worker guide.
- Add `receipt --until responded --timeout MS` to wait for an agent's reply
  after inbox storage, without a separate polling script.
- Add hosted tasks with worker progress, owner-only approval decisions, linked
  results, cancellation requests, and idempotent updates through MCP and the CLI.
- Add a local voice and vision conversation with OpenAI Realtime, selected task
  context, explicit media sharing, interruption, and an HTTPS text alternative.
- Add an independent encrypted HTTP relay transport for peers without WebRTC,
  preserving local inboxes and confirmed handoffs. WebRTC remains the default.
- Add hosted agent mailboxes with OAuth MCP access, signed wake events, paired
  recipients, and a native-free CLI. Cloud-agent credentials are scoped to one
  mailbox and can be revoked separately.
- Add opt-in confirmed handoffs with persistent retries, recipient storage
  receipts, duplicate suppression across reads and restarts, and a 24-hour expiry.
- Add bounded receipt waiting through `receipt --timeout` and advertise handoff
  support so older peers do not receive repeated requests.
- Allow peer discovery to retry after a rejected SDK view attempt, while ignoring
  failures from obsolete attempts and retired connections.

## 0.2.4 — 2026-09-05

- Add explicit archive pruning with a default preview, combined age/count
  retention, and protection for unread, malformed, and linked state.
- Add local receipt lookup across inbox/archive using the existing request ID
  and expected peer; show acknowledgements and success/failure responses without
  consuming mail, retrying commands, or claiming exactly-once execution.
- Extend live swarm validation with controlled message loss/delay, a fresh
  receiver manager after disconnect, and optional verified TURN-only transport.

## 0.2.3 — 2026-09-05

Reliability and documentation release. Existing wire formats and state files remain supported; no new runtime dependency or state migration is required. This release also includes the 0.2.2 license/SDK-floor changes, which were committed but not published to npm.

### Sidecar delivery and inboxes

- Persist direct messages, commands, and responses until transport acceptance, preserving envelope IDs and sender identity across restarts. Keep per-peer ordering without blocking other peers or transient swarm traffic.
- Retain unsent queue entries after refusal or exceptions without replaying entries already accepted during the same flush. Acceptance is not a receipt or an exactly-once guarantee.
- Use sender-scoped hashed inbox filenames and retain legacy compatibility. Skip malformed records without deleting them; reject cached outbox envelopes that disagree with their action.
- Make concurrent inbox reads return only successfully archived records. Honor zero-count reads, reject malformed counts, and honor wait deadlines even when polling intervals are longer. Retry brief Windows state-file sharing violations.
- Keep history controls out of conversation history and keyword trigger handles stable. Registrations during dispatch apply to the next message.

### Connections and peer discovery

- Coordinate overlapping connect/disconnect calls, clean up failed startup, and ignore callbacks from retired SDKs and superseded peer connections.
- Route before protocol side effects, support initial UUID-targeted announcements, validate presence fields, and separate UUID lookup from stream-ID lookup.
- Preserve legitimate peer promotion while refusing conflicting rekeys; clear stale capabilities on full announcements that omit a profile.

### Files and swarms

- Prevent filename collisions from overwriting completed files; bound Unicode filenames and collision suffixes. Preserve whitespace in shared paths and skip broken, inaccessible, or escaping links during listings.
- Account for damaged/orphaned partials and failed stale cleanup in transfer quotas. Explicit local discard remains available without trusting damaged metadata.
- Keep seed sources read-only and verify chunks before serving edited sources. Protect writes, finalization, and discard with lock ownership; release failed setup resources so retries can proceed.
- Restart swarm managers without duplicate listeners or stale requests; advertise empty seeds and ignore unsolicited manifest pages until a file is requested.
- Validate request/timer limits and chunk indices. Avoid maximum-size base64 regexp stack overflow and copy bitfields/binary payloads to prevent buffer aliasing.

### Wakes, Social Stream, and documentation

- Validate and capture wake settings; reject malformed CLI/environment values instead of accidentally selecting unlimited mode. Skip unused unlimited-mode history.
- Remove inherited `NINJA_ROOM` from wake children and replace NULs in environment previews, preserving original inbox content and `NINJA_WAKE_ROOM` context.
- Ignore stale Social Stream callbacks, preserve reconnect backoff, and decode HTML entities once. No new live-channel publishing behavior is introduced.
- Refresh the README, operations/release guides, security/reliability notes, and landing-page search/social metadata. Keep browser dashboard copies synchronized.

### Validation and compatibility

- 474 tests and the TypeScript build passed locally on Windows / Node 22.14.0.
- The reliability commit passed all eight CI jobs: Node 20/22/24 with both WebRTC adapters and Node 24 current-npm install checks.
- Node compatibility was reviewed with published SDK 1.6.0; the dependency remains `^1.5.4` and the browser SDK pin remains 1.5.4. See the SDK compatibility notes for tested scope and unreleased adjacent-SDK changes.
- Live room/file and binary swarm checks were run during the reliability review; they do not establish impaired-network recovery or browser SDK upgrade results.

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
