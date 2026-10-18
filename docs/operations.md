# Operations and recovery

`prune-archive` and `receipt` are available starting with version 0.2.4.

Use this guide for an existing sidecar. For installation and a first room, start
with the [README](../README.md). For delivery guarantees, see
[Protocol and reliability](protocol-and-reliability.md).

## Upgrade without losing local work

```bash
ninja-p2p stop --id worker
npm install -g @vdoninja/ninja-p2p@latest @roamhq/wrtc
ninja-p2p start --id worker --room YOUR_EXISTING_ROOM
ninja-p2p status --id worker
```

Reuse the original ID, room, password, and state directory. Reapply your original
share/profile/wake flags; the example does not restore those flags for you.
Keep `inbox`, `archive`, `outbox`, `handoffs`, `handoff-status`, and transfer files in place. Version 0.2.4
reads existing state without migration. Data-only installations can continue
using `node-datachannel` instead of `@roamhq/wrtc`.

## Inspect mail before consuming it

```bash
ninja-p2p notify --id worker
ninja-p2p read --id worker --take 10 --peek true
ninja-p2p read --id worker --take 10
ninja-p2p wait --id worker --timeout 60000 --interval 500
```

`notify` reports valid pending inbox and queued outbox records. `read` moves
ordinary returned messages to `archive` and marks confirmed handoffs as read;
`--peek true` leaves them pending. `--take 0`
consumes nothing. Counts must be whole non-negative numbers. Concurrent readers
claim different messages, so one reader may receive fewer than requested.

`wait` does not consume mail. It exits 0 when mail is pending and 1 on timeout;
timeout 0 waits indefinitely. Its deadline takes precedence over a longer poll
interval. Archives have no automatic retention limit. Preview explicit pruning:

```bash
ninja-p2p prune-archive --id worker --older-than-days 30 --keep-newest 200
ninja-p2p prune-archive --id worker --older-than-days 30 --keep-newest 200 --apply true
```

Both retention controls are required. Only valid archived JSON records older
than the age threshold and outside the newest retained count qualify. Age uses
the local archive file modification time, not a peer's timestamp. The command
lists candidates and, when applied, removals. It never traverses subdirectories,
prunes a linked archive directory, or deletes unread inbox/outbox records.
Malformed records remain for manual inspection. Back up important receipts:
pruning them removes evidence from the receipt lookup below.

## When direct work stays queued

Direct messages, commands, and responses remain in the sidecar outbox until the
transport accepts them. Check that the destination stream ID is correct and
that both peers use the same room and password. Reconnects retry queued work;
one blocked destination does not block another destination's direct messages.

Transport acceptance is not remote receipt or execution. Look for an `ack` or
`command_response` when the task needs confirmation. A crash between acceptance
and removal of a disk record can resend its existing ID; handlers should tolerate
duplicates. Broadcasts and direct file sends do not gain this persistent-message
retry guarantee.

Use the action ID printed by a queued `command` or `dm` to inspect reports:

```bash
ninja-p2p receipt REQUEST_ID --id worker --from reviewer
```

This reads existing `ack` and `command_response` messages in the inbox and
archive without consuming them or opening a connection. Results distinguish
`queued`, `unknown`, `acknowledged`, and `responded`; `queued` is also a separate
boolean because a crash can leave a queued action alongside a response.
`responded` includes failed responses: inspect each receipt's `payload.ok`,
`error`, and `result`. Conflicting responses remain visible rather than being
silently overwritten. Only the specified peer and request ID are matched.
Peer identity remains self-asserted, and an acknowledgement is not execution.
`unknown` means no retained evidence, not proof of delivery or failure. This
command observes local state. Use `handoff` for automatic storage receipts and retries.

Malformed or inconsistent JSON records are skipped and left on disk. They do
not appear in valid-message counts. Stop the sidecar and back up its state before
repairing a record. Preserve a direct action's ID, recipient, type, and cached
envelope agreement; changing an ID can turn a retry into new work. Do not delete
the entire outbox merely because one record is damaged.

## Confirmed handoffs

Start both sidecars in the same room, then queue a request from one to the other:

```bash
ninja-p2p handoff --id planner worker "Review the patch and report the result"
ninja-p2p receipt REQUEST_ID --id planner --from worker --timeout 60000
ninja-p2p read --id worker --take 10
ninja-p2p respond --id worker planner REQUEST_ID '{"result":"Review complete"}'
```

Replace `REQUEST_ID` with the first command's `requestId`. The receiver sees a
`handoff` message with the request in `payload.request`. Wake hooks run for new
handoffs; duplicate deliveries and automatic storage receipts do not trigger
another wake. Receipt waiting reads local state without consuming messages or
opening a connection. A positive `--timeout` waits up to that many milliseconds;
omitting it or using zero returns immediately. Waiting exits 1 on timeout or
expiry. Timing out the CLI does not cancel the queued handoff.

Delivery status distinguishes `queued`, `awaiting_receipt`, `stored`, and
`expired`. `delivery.waitingFor` identifies a missing peer connection or missing
peer support. Both sidecars must advertise `handoff-v1`; update and restart an
older peer before using this workflow. The sender retries with increasing delays
up to 30 seconds and stops after 24 hours from queueing. An expired handoff is
unconfirmed: its receipt might have been lost. Check with the recipient before
creating a new request ID. A late valid receipt can still confirm storage.

`stored` confirms that the receiving sidecar saved the request. It does not mean
the agent read, accepted, or completed it. A `command_response` changes the
top-level receipt status to `responded`; inspect its result or error. Use request
IDs to make task handlers idempotent, especially for external side effects.

Each incoming handoff remains in `handoffs` with a separate read marker. These
records prevent redelivery after reads, restarts, and archive pruning. Keep that
directory and `handoff-status` when backing up or moving a sidecar. Archive pruning
does not remove them; deleting local state also deletes duplicate protection and
receipt evidence. Run one sidecar per state directory and keep the machines'
clocks synchronized. Use short requests and share files for large inputs.

## Recover file transfers

- **Direct send:** both peers must be connected. Receipts report verification
  success or failure; inspect the receiver inbox for file events. Existing files
  are never overwritten, and duplicate names receive a suffix. Retry a failed
  direct send as a new transfer; use swarms when resume matters.
- **Swarm:** rerun the same `fetch` into the same destination to reuse verified
  chunks. A live lock means another downloader owns that destination. Stop that
  downloader or let an abandoned lock age out; do not remove a live lock.
- **Seed changed:** chunks are checked before serving. Keep the source stable
  during distribution. To distribute edited content, seed it again and use its
  new content ID.
- **Quota reached:** the sidecar allows 16 incomplete direct transfers and
  512 MiB of promised incomplete data. Stale cleanup is attempted after 24 hours
  when another offer arrives. Failed cleanup still counts. Orphaned parts or
  unreadable manifests each reserve the conservative 256 MiB allowance.

For damaged direct-transfer metadata, the library's
`discardIncomingTransfer(stateDir, transferId)` is an explicit local cleanup
operation. It removes that transfer's part and manifest, not completed downloads.
The sender-scoped form refuses cleanup when ownership cannot be established.
There is no CLI discard command; inspect and back up local state before using
the library operation.

Shared-file paths retain their whitespace. Quote paths containing spaces.
Listings omit inaccessible, broken, and escaping links; an internal directory
link is still navigable. All files under a declared share are readable by room
peers, so keep shares narrow.

## Diagnose wake hooks

Wake commands are coalesced, run one at a time, and default to 30 runs per minute
with a 750 ms window. CLI wake limits/delays require whole non-negative values;
only an explicit rate limit of 0 disables throttling. A hung command blocks later
wakes until it exits. The sidecar logs spawn failures and busy/rate-limited runs.

Child commands inherit `NINJA_ID` and `NINJA_STATE_DIR` for local sidecar access.
Inherited `NINJA_ROOM` is removed; use `NINJA_WAKE_ROOM` for display. An explicit
`--room` still opts into a separate room connection. Sender/text previews are
bounded and replace NUL characters; read the inbox for complete original content.
Do not interpolate peer text into a shell command.

Peer join/leave notices and auto-handled discovery/file traffic do not trigger
these message wakes. Use [Social Stream troubleshooting](social-stream-bridge.md#troubleshooting)
for relay-specific issues. Start that bridge with `--read-only` when observing.
