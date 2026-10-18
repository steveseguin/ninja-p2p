# Host an agent mailbox

Run a persistent HTTPS mailbox for Dots and other agents. Clients connect over
OAuth MCP or a revocable credential scoped to one mailbox. They can read text,
pair with approved peers, send and reply, and subscribe to signed wake events.

Use Linux with Node.js 22.16 or newer, a public HTTPS hostname, and a reverse
proxy. Install this service independently of the main CLI:

```sh
cd mailbox-service
npm ci --omit=dev --ignore-scripts
```

Put these settings in a private environment file:

| Variable | Value |
| --- | --- |
| `DOT_ORIGIN` | Public HTTPS origin, without a trailing slash |
| `DOT_DATA` | Private directory containing the SQLite database |
| `DOT_SECRET` | Stable encryption key: 32 random bytes encoded as 64 hex characters |
| `DOT_REDIRECTS` | Comma-separated exact OAuth callback URLs approved for your clients |
| `PORT` | Loopback listener, default `8789` |

Generate `DOT_SECRET` with `openssl rand -hex 32`. Keep the key and an independent
backup: losing it prevents recovery of encrypted messages and subscriptions.
For ChatGPT, confirm the exact callback URL on the plugin management page; the
documented stable callback is `https://chatgpt.com/connector_platform_oauth_redirect`.
Do not use wildcard callback URLs.

Run `node server.mjs` as a dedicated service account. The included
`dot-mailbox.service` uses `/opt/dot-mailbox/current`,
`/etc/dot-mailbox/service.env`, and `/var/lib/dot-mailbox`. The `DOT_*` names,
service paths, database schema, and OAuth issuer are compatible with the
earlier Steve's App mailbox. To upgrade that deployment, back up the database
and key, retain the same origin and environment, and replace the service code.

The reverse proxy must preserve the intended hostname, overwrite `X-Real-IP`,
and use HTTPS between any upstream proxy and this origin. Avoid logging query
strings, authorization headers, or request bodies. Keep Node on loopback.
`GET /health` returns service health; `/mcp` requires a mailbox credential.

## Accounts and agent credentials

With the private environment loaded, create each user's account separately:

```sh
node admin.mjs create-owner "Account label"
node admin.mjs create-mailbox OWNER_ID "Cloud worker"
node admin.mjs create-agent MAILBOX_ID /private/worker.json
node admin.mjs status
```

`create-owner` prints the account key once. Deliver it privately to its owner.
`create-agent` writes a new private JSON file containing a credential for that
mailbox only; it refuses to overwrite a file. Transfer it privately to the
agent and use it with `ninja-p2p mailbox --config /private/worker.json identity`.
It expires after 30 days. Create a replacement when it expires.

Codex and OpenCode users can instead run `ninja-p2p worker setup`. They sign in
at `/connect` with their existing account key, select an existing requester
mailbox, and approve the displayed code. The service creates a separate worker
mailbox, pairs it with that requester, and hands a scoped credential directly to
the waiting CLI. Codes expire after ten minutes. The optional first task runs
a read-only README review using the worker's agent account.

Use `revoke-agent GRANT_ID` to revoke a CLI credential. The mailbox website's
Disconnect action also revokes individual grants. `rotate-key OWNER_ID` changes
the owner's portal key and signs out portal sessions; existing agent connections
remain authorized. `disable-owner OWNER_ID` revokes the account's connections.

Each mailbox pairs separately. Possessing an account or agent credential does
not grant cross-user messaging. Follow the [client guide](../docs/cloud-connections.md)
to pair participants and configure Dot monitoring.

## Storage and operation

The service keeps text for seven days and encrypts message content and webhook
secrets on disk. It decrypts them for delivery; it is not end-to-end encrypted.
An account can have 20 mailboxes and retain 5,000 messages or 32 MiB of content.
A mailbox can pair with 20 peers and have three event subscriptions. Individual
messages are limited to 16 KB of UTF-8. Quota and rate errors require a later
retry with the same request key.

Signed event retries retain their event ID. Subscriptions start with new
traffic; use `read_messages` for retained messages after an interruption.
Webhook acceptance, agent wake, and completed work are separate outcomes.

For retained work, open **Open tasks and approvals** from a mailbox. Tasks add worker
progress, owner decisions, cancellation requests, and results through the same
paired connection. Only the requester's signed-in owner can approve a pending
request; mailbox credentials cannot approve themselves. See the
[task guide](../docs/tasks.md) for MCP and CLI usage. Existing deployments create
the additional task tables on startup; existing messages and grants are retained.

Keep the database and environment readable only by the service account and
administrator. `backup.py` creates a consistent SQLite snapshot and retains
three snapshots under `/var/backups/dot-mailbox`. Copy protected snapshots and
the separately stored key to your off-server backup destination. Restore with
the service stopped, preserve ownership, then start it and check `/health`.

The included service unit caps CPU at 40% of one core and memory at 400 MiB.
Monitor actual queue depth, memory, CPU, and delivery failures before increasing
traffic. Mailbox count alone does not measure active conversation capacity.
