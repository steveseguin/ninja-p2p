# Connect cloud agents

Use WebRTC for direct room connections, file transfers, and SDK audio/video.
When an agent's environment cannot run or connect WebRTC, choose an HTTPS path:

| Agent environment | Connection | What stays online |
| --- | --- | --- |
| A VPS or agent that can run a background sidecar | Encrypted HTTP relay | Relay and sidecars; queued handoffs wait on the sender |
| A Dot or agent that runs only during turns | Hosted mailbox over MCP or the CLI | Mailbox service; messages wait on the server |

Neither HTTPS path needs a native WebRTC library, UDP, an inbound port on the
agent, or a VPN. The agent must be allowed outbound HTTPS to the service. Both
services can use the same server and hostname.

## Running peers: HTTP relay

Install the CLI without optional native modules:

```sh
npm install -g @vdoninja/ninja-p2p --omit=optional
```

Get a relay URL, access token, and room encryption key from your operator. Save
them in a private JSON file readable only by your agent account:

```json
{
  "url": "https://relay.example.com",
  "token": "<relay access token>",
  "key": "<64 hexadecimal characters encoding 32 random bytes>"
}
```

Start each sidecar with a different ID and matching room settings:

```sh
ninja-p2p start --room project --id planner --transport http --relay-config /private/relay.json
ninja-p2p start --room project --id worker --transport http --relay-config /private/relay.json
ninja-p2p handoff --id planner worker "Review the patch and report findings"
ninja-p2p receipt REQUEST_ID --id planner --from worker --timeout 60000
ninja-p2p read --id worker --take 10
```

`NINJA_TRANSPORT=http` and `NINJA_RELAY_CONFIG` can supply the same settings.
Alternatively set `NINJA_RELAY_URL`, `NINJA_RELAY_TOKEN`, and `NINJA_RELAY_KEY`
in the process environment. Secrets are not written to sidecar status files.

HTTP peers use the existing room envelopes, inboxes, and handoff receipts.
`stored` means the receiving sidecar wrote the handoff to its inbox. Ordinary
messages have best-effort delivery; use `handoff` when storage confirmation and
retries matter. See [handoff recovery](operations.md#confirmed-handoffs).

Both peers must choose HTTP to talk over this route. WebRTC and HTTP sessions
do not automatically bridge or switch transports. The browser dashboard uses
WebRTC, as do the Social Stream bridge and the `demo` connectivity check.
To return to WebRTC, restart the participating sidecars with
`--transport webrtc` and retain their state directories.

The relay accepts encrypted POSTs and delivers events through 25-second long
polls. It retains up to five minutes of live replay, bounded to 512 events or
8 MiB per room and 16 rooms per server. It has no disk archive. Relay restarts
or overflow report lost history; confirmed handoffs retry from the sender's
durable outbox. Reconcile ordinary messages and unfinished transfers after a
history gap. Sidecar process restarts begin with current relay traffic.

Room content uses AES-256-GCM. Keep the room key on clients, separate from the
relay access token. Room-key holders can read all room traffic and claim room
identities; use separate rooms and keys for separate trust groups. The relay
sees addresses, opaque room IDs, timing, and sizes. Shared room keys have no
forward secrecy. This is distinct from the per-mailbox access below.

## Dots and agents without a background process

Open your operator's mailbox website; Steve's hosted service is
[mcp.steves.app](https://mcp.steves.app/). Sign in with the private account key
the operator supplies, and give each agent its own mailbox.

For a ChatGPT Dot, add the service's `/mcp` endpoint as a custom OAuth MCP
plugin with dynamic client registration. Authorize one mailbox, select the
plugin in the Dot conversation, and ask it to get its mailbox identity and
monitor `message.created`. Specify which senders and requests it may act on.
Incoming message text does not grant permission to act.

For a CLI agent, ask the operator for a credential file scoped to its mailbox:

```sh
ninja-p2p mailbox --config /private/mailbox.json identity
ninja-p2p mailbox --config /private/mailbox.json read --after 0
```

Set `NINJA_MAILBOX_CONFIG` to avoid repeating `--config`. The CLI uses HTTPS MCP
directly and exits after each call. No local sidecar or WebRTC dependency is
required.

To have Codex or OpenCode receive and complete tasks in the background,
[start a mailbox worker](workers.md) after pairing.

Pair two agents explicitly. The first calls `create_peer_invitation` through
MCP or `mailbox invite`; the recipient calls `accept_peer_invitation` or
`mailbox pair INVITATION`. Share invitations privately: they are single-use
and expire after ten minutes. Pairing permits messages, not remote execution.
Use `mailbox unpair PEER_ID` to stop future messages.

```sh
ninja-p2p mailbox send PEER_MAILBOX_ID "Review the patch" --request-key review_patch_001
ninja-p2p mailbox read --after 0
ninja-p2p mailbox reply MESSAGE_ID "Review complete; see the attached reference"
```

The text command does not attach files; include a reference the recipient is
authorized to access. Save `next_sequence` from each read and use it as
`--after` on the next call. Reads do not delete messages. If `history_lost` is
true, reconcile missing work with the sender. Messages expire after seven days;
keep task outcomes in your own workspace.

Reuse `--request-key` only when retrying the same send. Distinct requests need
distinct keys even when their text is identical. A reply is linked to one
incoming message and retries return the same reply. Do not automatically reply
to replies. The service limits message text to 16 KB of UTF-8.

A `stored` result confirms server storage. A successful webhook confirms event
acceptance by the destination. Neither proves the agent ran, replied, or
completed work. Track the linked reply or explicit task result. Dot monitoring
and actions remain subject to the connected platform's permissions.

Mailbox text and webhook secrets are encrypted on disk, but the service
decrypts text to deliver it to authorized clients. This is not end-to-end
encryption. Give every agent a separate mailbox credential. Credentials expire
after 30 days and the operator or mailbox owner can revoke them sooner.

Mailbox IDs and WebRTC room IDs are separate addresses. Mailbox messages are
not automatically forwarded into rooms or to every peer. Use the mailbox when
the recipient is a Dot or an offline agent; use a room for live collaboration.

For work that needs progress, owner decisions, and a returned result, use
[tasks and approvals](tasks.md) after pairing your mailboxes.

## Host the services

For the live relay, run `ninja-p2p-relay` with `VDON_RELAY_TOKEN` set to at least
32 random printable characters. It listens on `127.0.0.1:8790` by default;
`VDON_RELAY_HOST` and `VDON_RELAY_PORT` override the listener. Generate a relay
token and a separate room key with `openssl rand -hex 32`.

Put the listener behind an HTTPS reverse proxy. Forward `/v1/rooms/` unchanged,
preserve `Authorization`, disable caching and response buffering, allow 768 KiB
request bodies, and allow at least 30 seconds for long-poll responses. Keep
the listener private. The relay contract is compatible with Ninja MCP's relay
server; application protocols use separate room/key namespaces.

Install the optional [mailbox service](../mailbox-service/README.md) separately.
It needs Node.js 22.16 or newer and SQLite storage. It can share a hostname with
the relay: route `/v1/rooms/` to the relay and other requests to the mailbox.
Keep the two access credentials separate.

These services carry data and retained text. Live audio/video still needs a
WebRTC-capable endpoint and, where necessary, TURN. A mailbox wake does not
create a microphone, camera, or media track inside a cloud agent.
