# Changelog

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

`ninja-p2p seed <file>` and `ninja-p2p fetch <name-or-id>` replace the old
one-sender-pushes-to-one-receiver path.

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

Median 12.7 MB/s for one downloader on a local network; roughly 13 MB/s total
across three. The multi-downloader figure varies substantially run to run — see
the README for the spread.

### Live stream chat

- **`ninja-p2p ssn --session <id>`** bridges Social Stream Ninja — Twitch,
  YouTube, Kick and everything else it aggregates — into a room as events on the
  `social` topic, with a `say` command to reply to every platform at once.
  `--read-only` is available for trying it safely.

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

### Documentation

- A landing page at the project site, with the operator dashboard moved
  alongside it. Existing `?room=` links still work.
- New: the security model, the Social Stream bridge guide, and a protocol and
  reliability document covering how transfer actually behaves, including what
  was measured and deliberately not built.

## 0.1.4 and earlier

See the git history.
