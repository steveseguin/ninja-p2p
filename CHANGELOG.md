# Changelog

## Unreleased

- Skip saved direct outbox records whose cached envelope disagrees with the
  action's recipient, type, or message ID, retaining them for inspection.

- Cap inbox wait sleeps at the remaining timeout, so a long polling interval
  cannot postpone a short requested deadline by an entire interval.

- Reject malformed CLI/environment wake limits and delays instead of truncating
  them; in particular, a fractional limit can no longer turn into unlimited mode.

- Validate and capture wake timing/rate settings at construction so timer overflow,
  invalid limits, or later caller mutations cannot undermine scheduling limits.

- Avoid accumulating unused run timestamps when wake rate limiting is disabled,
  keeping unlimited mode's bookkeeping from growing with every invocation.

- Replace NUL characters in wake sender/text previews so peer content cannot
  prevent process startup; original inbox messages remain unchanged.

- Remove inherited `NINJA_ROOM` from wake-hook environments so child CLI commands
  use the sidecar outbox; retain the room as `NINJA_WAKE_ROOM` for context.

- Honor `read --take 0` and reject malformed read counts instead of silently
  consuming the default batch or a truncated count.

- Validate inbox read counts before moving mail, preventing negative counts from
  archiving an unintended batch through array slicing.

- Count orphaned direct-transfer part files against quota even when their manifest
  is missing, using the existing conservative accounting for unreadable metadata.

- Keep stale direct transfers counted against quota when cleanup fails, so busy
  or inaccessible part files cannot silently bypass the incomplete-transfer limit.

- Look up transport UUIDs explicitly when adding peers, so a UUID matching an
  unrelated stream ID cannot merge or delete that peer's record.

- Preserve per-peer send order when a transport recovers: ordinary direct sends
  retry older queued messages first, without blocking transient swarm traffic.

- Remove already accepted offline messages even if a later transport send throws,
  preventing those messages from being resent on the next queue flush.

- Copy decoded swarm payloads even when frames arrive as Node Buffers, preventing
  receive-buffer reuse from changing retained chunk data.

- Ignore unsolicited swarm manifest pages until the file is requested, avoiding
  unrequested page downloads and retained hash lists during passive discovery.

- Give chunk maps ownership of their input bytes so external buffer mutations
  cannot make availability disagree with the cached completion count.

- Avoid regexp stack overflow when validating maximum-size base64 swarm chunks,
  retaining alphabet, padding, length, and hash checks.

- Validate and capture the heartbeat interval at bridge construction so invalid
  values or later options mutations cannot unexpectedly accelerate heartbeat traffic.

- Deliver history requests/replays without retaining their control envelopes,
  preventing replay nesting and eviction of conversation history.

- Keep inbox/outbox summaries available when a saved peer snapshot is not an
  array, without rewriting the malformed snapshot.

- Validate saved outbox action shapes before flushing. Malformed and unknown
  records remain on disk instead of crashing delivery or being silently deleted.

- Reject invalid swarm timer intervals and request timeouts before startup,
  avoiding accidental rapid loops, immediate expiry, or permanently pending requests.

- Validate swarm request limits before planning or creating managers/sessions;
  fractional and non-finite counts cannot bypass request budgets. Zero remains supported.

- Verify requested swarm chunks before serving so edited source bytes are not
  sent under an obsolete manifest. Unchanged chunks remain available.

- Apply the corrected shared filename sanitizer to swarm downloads as well as
  direct transfers, bounding Unicode names and stripping dots after truncation.

- Use one normalized shared-folder listing limit for entries and truncation;
  preserve the one-entry minimum and reject non-finite limits.

- Cancel a pending Social Stream retry when a new connection attempt starts,
  preventing an old timer from shortening a later disconnect's backoff.

- Preserve whitespace in shared-file paths so listings and get-file requests
  select the named file rather than a different whitespace-trimmed filename.

- Allow explicit local discard of direct transfers with unreadable manifests;
  sender-scoped cleanup still requires verifiable ownership.

- Handle damaged direct-transfer manifests during quota checks: records without
  parts do not block offers, while existing parts with unknown metadata count conservatively.

- Defer keyword triggers registered during dispatch until the next message,
  preventing self-rearming callbacks from looping on one message. Removals still apply immediately.

- Skip malformed saved inbox envelopes during reads and summaries without
  deleting or archiving them. Valid legacy filenames remain supported.

- Validate and copy Social Stream reconnect schedules so empty, overflowing,
  or mutated delay arrays cannot accidentally become 1 ms retry loops.

- Decode Social Stream HTML entities in one pass, preserving literal entity
  text instead of decoding it twice. Text-only messages retain their existing path.

- Refuse peer-registry rekeys onto occupied stream IDs, preventing unrelated
  UUID aliases from surviving removal and resolving to replacement peers.

- Clear pending chunk and manifest-page requests on swarm stop so restarting
  can retry immediately, preserving verified chunks and received manifest pages.

- Reject malformed presence field types before updating Node peer state or
  notifying discovery consumers. Partial updates and unknown extensions remain supported.

- Reject non-integer indices in chunk-map access and file reads so direct
  library calls cannot claim unrelated chunks or read unintended byte ranges.

- Promote temporary UUID peer records when later connection metadata supplies
  the stream ID, allowing channel opening to flush the correct offline queue.
  Already resolved peer identities remain unchanged.

- Finish short writes when creating swarm lock tokens and remove locks from
  failed setup attempts so an I/O error does not block an immediate retry.

- Allow swarm startup to be retried after a storage-directory failure instead
  of leaving the manager marked started without listeners or timers.

- Detach manager-owned swarm listeners on stop so stopped managers stay quiet
  and restart does not duplicate handlers. Preserve other bridge consumers.
- Include empty seeded files in the catalogue sent to peers joining later.

- Bound direct-transfer saved filenames by UTF-8 bytes and collision suffix
  length, preserving Unicode characters and removing trailing dots/spaces after
  truncation. Long accepted transfer IDs no longer break duplicate-name saves.

- Refuse swarm part-file writes and finalization after lock takeover. Hold the
  download lock through discard and preserve a replacement downloader's file.

- Ignore callbacks from retired SDK connections so they cannot overwrite current
  peer mappings, send through a replacement SDK, or restore disconnected state.
- Clear stale agent capabilities when a full peer announcement omits a profile;
  incremental skill updates continue to preserve an omitted profile.

- Open swarm seed sources read-only, never recreate missing sources, and keep
  seed originals intact when discarding a session. Download-owned parts retain
  their existing cleanup behavior.
- Release part-file handles and locks if resume scanning fails during construction.

- Share overlapping connection attempts and reject cancelled startup before it
  can announce a connected bridge after shutdown.
- Close replaced swarm seed sessions and reject reseeding with a chunk layout
  that conflicts with the file already advertised to peers.

- Recheck simple-transfer destinations at completion so overlapping offers with
  the same filename can both finish without overwriting each other.
- Let concurrent inbox readers skip already-claimed records and return only
  messages they successfully archived. Zero-count history reads now return no entries.

- Retry transient Windows sharing violations during atomic sidecar state writes
  for up to 100 ms. Preserve the previous record on failure and clean up temporary files.

- Clean up failed room startup, share teardown across overlapping disconnect
  calls, and cancel the shutdown timeout when SDK cleanup finishes early.
- Clear reconnect state after teardown and ignore callbacks from closed or
  superseded Social Stream sockets.

- Shared-folder listings skip broken, inaccessible, and escaping links, identify
  internal directory links correctly, and support explicitly shared filesystem roots.
- Keep keyword trigger handles stable across removals and clear/re-registration;
  ignore non-text chat fields during keyword matching.
- Reject invalid message history and offline queue limits before trimming; zero
  remains a supported way to disable retention.

- Keep sidecar direct messages, commands, and responses in the disk outbox until
  transport acceptance, preserving wire identity across restarts and avoiding
  eviction by the library's 50-message memory queue. Rejected sends preserve
  per-peer order while other peers continue. Add live restart-delivery validation.

- Derive inbox filenames from a hash of sender identity and message ID so opaque
  wire IDs cannot become filesystem paths or collide across different senders.
- Ignore delayed disconnect events from superseded peer connections.
- Apply stream routing before protocol replies and presence updates; initial
  announcements use transport targeting and still accept older UUID routes.
- Ignore null and non-object presence payloads before updating peer state.
- Review compatibility with published NinjaSDK 1.6.0 while retaining the 1.5.4
  minimum and existing browser SDK pin.

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
