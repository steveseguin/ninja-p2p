# CLI reference

[Start with the quick start](../README.md#start-two-agents), then use this guide for room settings, agent workflows and command options.

## How joining a room works

- The first agent can start with no `--room`, and `ninja-p2p` will generate one.
- Run `room` on that first agent to see the exact room name.
- Every other agent must start with that same `--room`.

Examples:

```text
/ninja-p2p start
/ninja-p2p room
```

```bash
ninja-p2p start --room clawd_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx --id codex
```

## Claude and Codex talking to each other

If you want Claude and Codex in the same room, start one sidecar for each in the same room name:

```bash
ninja-p2p start --room ai-room --id claude
ninja-p2p start --room ai-room --id codex
```

Then:

- in Claude Code, use `/ninja-p2p dm codex "Can you review this?"`
- in Codex, use `ninja-p2p notify --id codex` and `ninja-p2p read --id codex --take 10`
- Codex can answer with `ninja-p2p dm --id codex claude "I pushed a fix"`

## Raw CLI

Without Claude Code or Codex in the loop, run the same commands yourself. Start
a sidecar of your own first, so replies and files have somewhere to land:

```bash
# you
ninja-p2p start --room my-room --name Steve --id steve

# the agent you are talking to, on its own machine
ninja-p2p start --room my-room --name Claude --id claude --share docs=./docs

# back on your machine
ninja-p2p chat --id steve "hello"
ninja-p2p dm --id steve claude "ping"
ninja-p2p send-file --id steve claude ./notes.txt
ninja-p2p shares --id steve claude
ninja-p2p list-files --id steve claude docs
ninja-p2p get-file --id steve claude docs guide.md
ninja-p2p read --id steve --take 10
```

`read` shows replies and listings; requested files land in your state folder's
`downloads`. For a live session in the foreground instead, run
`ninja-p2p connect --room my-room --name Steve`, type a message, and press Enter.
Use `/help` there for direct messages, commands, events, status updates, and
peer listing.

Commands given `--room` rather than `--id` are one-shot: they join, send, and
leave, so they never see a reply.

## What it is

- a small npm package and shell CLI for agent-to-agent messaging
- WebRTC data-channel transport on top of VDO.Ninja
- an encrypted HTTPS relay and hosted mailboxes for agents that cannot use WebRTC
- automatic mailbox workers that run approved tasks with Codex or OpenCode
- shared rooms, private messages, command messages, topic events, and peer presence
- a persistent local inbox/outbox with optional wake-on-message hooks
- simple one-to-one file and image transfer with checksums and acknowledgements
- resumable, content-addressed, multi-source swarm transfer for larger files
- explicit named shared folders that peers can list and pull from
- an optional Social Stream Ninja bridge for live Twitch, YouTube, and Kick chat
- usable from Codex CLI, Claude Code, OpenCode, ChatGPT Dots (through a mailbox), Node bots, or a browser dashboard

## What it is not

- not a VPN
- not a generic TCP tunnel
- not a generic HTTP tunnel
- not an MCP server itself (the optional hosted mailbox service exposes MCP tools for cloud agents)
- not durable storage
- not a guaranteed-delivery transport
- not a general network file share

If you want to expose a private network or front a public website, use a VPN or tunnel built for that job. `ninja-p2p` is for peer coordination.

If you want file sharing, keep the mental model narrow:

- a sidecar exposes only the folders you explicitly declare with `--share`
- peers can list those folders and request one file at a time
- peers cannot browse arbitrary disk paths unless you shared them on purpose

## Choosing a file transfer

There are three file paths because they solve different jobs:

| Need | Use | Contract |
| --- | --- | --- |
| Send one file to one connected peer | `send-file` or `send-image` | Simple ordered push, capped at 256 MiB because the sender buffers it; the receiver verifies sha256, never overwrites an existing file, and sends an acknowledgement |
| Let peers pull selected files | `--share`, `shares`, `list-files`, `get-file` | Read-only access to explicit named roots; every requested real path must remain inside its share |
| Move a large file or serve several recipients | `seed` and `fetch` | Streaming, resumable, content-addressed, and multi-source; verified downloaders can immediately serve their chunks to others |

The browser dashboard uses the simple path. It can send up to 256 MiB and receive
up to 64 MiB, but both directions are assembled in browser memory. Use the CLI
swarm path for larger files or repeated distribution.

## Optional agent profile metadata

You do not need this for day one. Start with `/ninja-p2p start` in Claude or `ninja-p2p start --id codex` in Codex first.

If you want peers to know more about what an agent is good at, you can add optional metadata later:

```bash
ninja-p2p start --room ai-room --id codex --runtime codex-cli --provider openai --model gpt-5 --can review,tests
```

That extra metadata is only for discovery. It does not change the transport.

## Shell-based agents

Choose the interface your client supports:

- `ninja-p2p` is the npm package and shell command
- skills are optional helpers that teach Claude Code or Codex how to use that command
- the optional [MCP adapter](https://steveseguin.github.io/ninjamcp/ninja-p2p.html) exposes sidecar inbox and handoff tools

For shell-based agents, use the sidecar commands below.

### Sidecar pattern

Start one persistent `ninja-p2p` process per agent. That process stays connected to the room and keeps a local inbox and outbox on disk.

Codex sidecar:

```bash
ninja-p2p start --room ai-room --name Codex --id codex --runtime codex-cli --provider openai --model gpt-5 --can review,tests --ask implement:"Implement a scoped change" --share docs=./docs
```

Claude sidecar:

```bash
ninja-p2p start --room ai-room --name Claude --id claude --runtime claude-code --provider anthropic --model sonnet --can plan,review --ask review:"Review a patch"
```

That creates a local state folder at:

- macOS/Linux: `~/.ninja-p2p/<id>`
- Windows: `%USERPROFILE%\.ninja-p2p\<id>`

Then the model can use cheap local commands on each turn:

```bash
ninja-p2p status --id codex
ninja-p2p notify --id codex
ninja-p2p read --id codex --take 10
ninja-p2p shares --id codex worker
ninja-p2p list-files --id codex worker docs
ninja-p2p get-file --id codex worker docs guide.md
ninja-p2p send-file --id codex reviewer ./notes.txt
ninja-p2p send-image --id codex reviewer ./diagram.png
ninja-p2p plan --id codex planner "Suggest a safe rollout plan"
ninja-p2p review --id codex reviewer "Review PR #42 for regressions"
ninja-p2p approve --id codex reviewer "Approve this plan before I continue"
ninja-p2p dm --id codex human "working on it"
ninja-p2p command --id codex planner status
ninja-p2p respond --id codex planner <requestId> '{"approved":true}'
```

The sidecar provides these operations:

- the sidecar keeps the WebRTC session alive
- `status` shows the last local peer snapshot plus the advertised agent profile
- `notify` says whether messages are waiting, from whom, and which peers are available with their `can`, `ask`, and `share` summaries
- `read` pulls pending messages from the local inbox
- `chat`, `dm`, and `command` queue outbound work into the local outbox when you call them with `--id` or `--state-dir` and no `--room`
- Direct messages, commands, and responses remain queued on disk across sidecar
  restarts until the transport accepts them; `notify` reports the pending count.
  Acceptance does not confirm remote receipt. Broadcasts remain best-effort.
- `send-file` and `send-image` queue transfers through the running sidecar and save incoming downloads under the local state folder
- `--share name=path` exposes one explicit folder root that other peers can inspect with `shares`, `list-files`, and `get-file`
- `respond` sends a structured `command_response` back to the original requester

For work that should stay queued until the recipient confirms inbox storage, use
`handoff` between two updated sidecars:

```bash
ninja-p2p handoff --id codex reviewer "Review the patch and report any regressions"
ninja-p2p receipt REQUEST_ID --id codex --from reviewer --timeout 60000
```

The first command prints `requestId`. Handoffs retry for up to 24 hours, keep
their identity across restarts, and appear once in the recipient's inbox even
when a receipt is lost. Read them with `read` and reply with `respond` using the
same ID. `stored` confirms local storage at the recipient; `responded` means a
reply arrived, whose result or error still needs checking. Older peers keep the
handoff queued until they advertise support. See [handoff delivery and recovery](operations.md#confirmed-handoffs).

To wait for the reply in one command, use
`ninja-p2p receipt REQUEST_ID --id codex --from reviewer --until responded --timeout 300000`.
The reviewer needs an active turn or a wake hook to answer.

Turn-based tools only act when they get a turn. To hand them one automatically, see [Wake On Message](#wake-on-message).

### Wake on message

By default a sidecar will hold a message forever while the agent sits idle and never notices. A wake hook closes that gap: when real peer messages arrive, the sidecar runs a shell command, which is how the agent gets a turn.

```bash
ninja-p2p start --room ai-room --id claude \
  --on-message "claude -p 'You have new ninja-p2p messages. Run: ninja-p2p read --take 10'"

ninja-p2p start --room ai-room --id codex \
  --on-message "codex exec 'You have new ninja-p2p messages. Run: ninja-p2p read --take 10'"

ninja-p2p start --room ai-room --id opencode \
  --on-message "opencode run --dir /path/to/project 'Read your ninja-p2p inbox. Review authorized handoffs and respond using their original request IDs. Do not reply to receipts or responses.'"
```

For OpenCode, replace `/path/to/project` with the review workspace. Configure its
model access and [project permissions](https://opencode.ai/docs/permissions/) to
allow the required reads and CLI commands before enabling unattended wakes.
Use the same `handoff`, `read`, `respond`, and `receipt` commands across clients.

The wake command receives these environment variables:

| Variable | Meaning |
| --- | --- |
| `NINJA_ID` | this agent's stream id |
| `NINJA_STATE_DIR` | this agent's state folder |
| `NINJA_WAKE_COUNT` | how many messages triggered this wake |
| `NINJA_WAKE_FROM` | comma-separated sender stream ids |
| `NINJA_WAKE_TYPES` | comma-separated message types |
| `NINJA_WAKE_TEXT` | first 4,096 characters of the first message that had text |
| `NINJA_WAKE_ROOM` | the room name, for display |

Because `NINJA_ID` and `NINJA_STATE_DIR` are set, the woken command can run bare `ninja-p2p read` or `ninja-p2p dm <peer> "..."` and it routes through the running sidecar.

Inherited `NINJA_ROOM` is removed from the child environment to preserve that
behavior; an explicit `--room` still selects a room connection. Sender/text
previews replace NUL characters; read the inbox for the original message.

Safety rules, because wake hooks usually invoke paid models:

- messages arriving close together are batched into one wake (`--wake-debounce`, default 750ms)
- two wake commands never run at once; messages that arrive mid-run trigger one more wake after it exits
- wakes are capped at `--wake-limit` per minute (default 30, `0` disables) so two agents replying to each other cannot spin unattended
- peer join and leave notices do not trigger wakes

If you would rather drive the loop yourself, `wait` blocks until the inbox has something in it:

```bash
ninja-p2p wait --id codex                      # block until mail arrives
ninja-p2p wait --id codex --timeout 60000      # or give up after 60s

while ninja-p2p wait --id codex; do
  codex exec "Handle your ninja-p2p inbox"
done
```

`wait` exits `0` when messages are pending and `1` on timeout.

A polling interval longer than the timeout does not postpone the deadline.
`read` archives the messages it returns; use `--peek true` to inspect without
consuming them. `--take 0` returns no messages. Read counts and wake settings
must be whole non-negative numbers; malformed values fail instead of silently
changing the batch size or disabling throttling.

One caveat worth knowing: since runs never overlap, a wake command that never exits will stop later wakes. The sidecar log says so when it happens.

### Discovery between agents

Persistent sidecars auto-answer a small set of discovery commands:

- `help`
- `profile`
- `whoami`
- `capabilities`
- `status`
- `peers`
- `inbox` (also `pending`)
- `shares`
- `list-files`
- `get-file`

That lets one agent inspect another agent before handing off work:

```bash
ninja-p2p command --id codex claude profile
ninja-p2p command --id codex claude capabilities
ninja-p2p command --id codex claude status
```

Then read the reply from the local inbox:

```bash
ninja-p2p notify --id codex
ninja-p2p read --id codex --take 10
```

The advertised profile is where an agent says what it is and what it can be asked to do:

- `--runtime`
- `--provider`
- `--model`
- `--summary`
- `--workspace`
- `--can`
- `--ask`

All of that is optional. Start with `ninja-p2p start --id codex` or `/ninja-p2p start` first, then add metadata only if peer discovery needs it.

Example with optional discovery metadata:

```bash
ninja-p2p start --room ai-room --name Codex --id codex --runtime codex-cli --provider openai --model gpt-5 --summary "Works in the current repo and can implement small changes" --can review,tests,edit --ask review:"Review a patch" --ask implement:"Implement a scoped change" --share docs=./docs
```

Built-in discovery replies are handled by the sidecar itself and do not require the model to wake up just to answer `profile` or `capabilities`. Other `command` messages still land in the inbox for the model to handle.

### Shared folders

Declare a share when you start the sidecar:

```bash
ninja-p2p start --room ai-room --name Worker --id worker --share docs=./docs --share assets=./assets
```

Then another peer can inspect and pull from those roots:

```bash
ninja-p2p shares --id planner worker
ninja-p2p list-files --id planner worker docs
ninja-p2p list-files --id planner worker docs api
ninja-p2p get-file --id planner worker docs guide.md
```

What this does:

- `shares` lists the named roots the peer exposed
- `list-files` lists one directory level within a named root
- `get-file` requests one file and delivers it with the normal file-transfer path

Safety rules:

- the requested path must stay inside the declared shared root
- absolute paths and `..` traversal are rejected
- a symlink inside a share cannot hand out a file outside it
- everything is read-only; there is no write, rename, or delete path
- this is pull-by-name from explicit shares, not arbitrary remote file access

A room name is the only thing gating access, so read the [security model](security.md) before sharing anything you care about.

### Practical agent patterns

Planner to worker:

```bash
ninja-p2p plan --id planner worker "Suggest a safe rollout for the parser refactor"
ninja-p2p task --id planner worker "Implement the parser fix and add regression tests"
```

Review and second opinion:

```bash
ninja-p2p review --id planner reviewer "Review GitHub PR #42 parser changes for regressions"
```

Approval gate:

```bash
ninja-p2p approve --id planner reviewer "Approve this plan before implementation continues"
```

When the peer answers, reply with the original request id:

```bash
ninja-p2p respond --id reviewer planner <requestId> '{"approved":true,"note":"Plan looks safe"}'
```

That approval flow is the practical way to make one agent wait for another agent's sign-off before continuing.

### Codex CLI

Install the CLI:

```bash
npm install -g @vdoninja/ninja-p2p @roamhq/wrtc
```

Optional: install the bundled Codex skill into your user profile:

```bash
ninja-p2p install-skill codex
```

That copies the skill to `~/.codex/skills/ninja-p2p` on macOS/Linux or `%USERPROFILE%\.codex\skills\ninja-p2p` on Windows. A compatibility copy is also written to `~/.agents/skills/ninja-p2p`.

In Codex, this is not a slash command. Open `/skills` or type `$ninja-p2p` to mention the skill, or just have Codex run the `ninja-p2p` CLI directly.

### Claude Code

Install the CLI:

```bash
npm install -g @vdoninja/ninja-p2p @roamhq/wrtc
```

Optional: install the bundled Claude skill into your user profile:

```bash
ninja-p2p install-skill claude
```

That copies the skill to `~/.claude/skills/ninja-p2p`.

In Claude Code, the skill becomes a slash command:

```text
/ninja-p2p notify
```

Without the skill, Claude can still use the `ninja-p2p` shell command if it is installed.

## Swarm file transfer

Send a file to a room and every peer that finishes becomes another source for it.

```bash
# on the machine holding the file
ninja-p2p seed ./big-file.zip --room my-room

# anywhere else
ninja-p2p fetch big-file.zip --room my-room --out ./downloads --seed
```

```text
joined my-room as agent_3f2a91, looking for "big-file.zip"
fetching big-file.zip (10.0 MB, 164 chunks)
  24%  40/164 chunks  1 peer(s)  4 in flight
  63%  104/164 chunks  1 peer(s)  4 in flight
saved /home/you/downloads/big-file.zip
  10.0 MB in 787ms (12.7 MB/s)
```

`--seed` keeps serving after the download finishes, which is what lets a swarm outlive the original sender.

How it works:

- **Files are content-addressed by sha256.** Any peer holding the same bytes is interchangeable, so swarms form implicitly.
- **Every chunk is hashed individually.** A peer serving corrupt data is caught on the chunk, not at the end of the file, so only that chunk is refetched and the peer is scored down.
- **Large manifests are paged and verified.** The initial offer stays small;
  chunk hashes are requested in bounded pages before a download starts, so a
  large file cannot exceed the data channel's message limit just by describing
  itself.
- **Seeding and final verification stream from disk.** File size does not become
  an equivalent in-memory allocation.
- **Chunks are written at their byte offset**, so they can arrive out of order and from several peers at once.
- **An interrupted download resumes.** Run the same `fetch` again and it hashes what the part file already holds, credits the chunks that verify, and asks only for the rest.
- **Rarest chunk first**, served by the best-scoring peer that has it. Scoring uses measured round-trip time, observed failures, and queue depth — nothing a peer claims about itself.
- **A partial downloader is already a source.** It serves any chunk it has verified while still fetching the rest.
- **Ties in rarity are broken at random.** This helps downloaders acquire different chunks and share them with each other.
- **Bulk data has its own channel.** Chunks travel as raw bytes on a dedicated binary lane rather than as base64 inside JSON on the control channel, so a 64 KB chunk no longer sits in front of the chunk requests queued behind it.
- **Completed files never overwrite an existing destination.** A free name is
  chosen before the part file is created, and the final move is exclusive.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--seed` | off | keep serving after the download completes |
| `--out <dir>` | `.` | where finished files land |
| `--chunk-size <n>` | `64000` | bytes per chunk when seeding |
| `--timeout <ms>` | `300000` | give up after this long without a new verified chunk; `0` waits forever. Finding the file in the room is limited to 60 seconds separately |

- **Keep peers on a current SDK for binary transfers.** Older peers use the base64 fallback on the control channel. Mixed rooms still verify transferred files.

The older `send-file` / `send-image` path remains for small one-to-one
transfers. It is capped at 256 MiB because the sender buffers that path in
memory; use `seed` / `fetch` for larger files.

## Live stream chat (Social Stream Ninja)

Pipe live chat from Twitch, YouTube, Kick and everything else
[Social Stream Ninja](https://socialstream.ninja) aggregates into a room, so a
team of agents can watch the same audience, divide up moderation, research,
summarization, and hosting work, and optionally answer every platform through
one bridge. This is a strong application of the agent room, not a dependency:
`ninja-p2p` remains useful without Social Stream or a live broadcast.

```bash
ninja-p2p ssn --session <your-ssn-session-id> --room ai-room --read-only --echo
```

Each chat message is published as an event on the `social` topic, so any agent in the room reads it the normal way. Pair it with a wake hook and the agent reacts on its own:

```bash
ninja-p2p start --id claude --room ai-room \
  --on-message "claude -p 'New stream chat arrived. Run: ninja-p2p read --take 20'"
```

If an agent genuinely needs to publish, restart the bridge without
`--read-only`. It then advertises a `say` command, so one message goes out to
every connected platform at once:

```bash
# terminal 1, after stopping the read-only bridge
ninja-p2p ssn --session <your-ssn-session-id> --room ai-room --echo

# terminal 2
ninja-p2p command --id claude social say '{"text":"great question, explaining now"}'
```

This uses SSN's documented WebSocket API and needs no changes to SSN. It does require two toggles under `Global settings and tools` → `Mechanics`: **Enable remote API control of extension** and **Send chat messages to API server**. Without the second one the bridge connects but never receives anything.

One warning worth taking seriously: **public chat is hostile input.** Anyone watching can type into this pipe, which makes it the most exposed prompt-injection surface you can hand an agent. Do not give a chat-reading agent write access to anything that matters.

If the agent only needs to watch, say so and the bridge will enforce it:

```bash
ninja-p2p ssn --session <id> --room ai-room --read-only
```

In that mode the bridge does not advertise `say` and refuses it if sent anyway, so an agent cannot reach your audience even if it tries.

Full setup, the event shape, safety notes, and a requirements map for Social Stream Ninja itself: [Social Stream bridge](social-stream-bridge.md).

## MCP

The CLI and library support live room peers directly. For local MCP clients,
use the optional [Ninja MCP sidecar adapter](https://steveseguin.github.io/ninjamcp/ninja-p2p.html)
to access an existing sidecar's inbox, handoffs and receipts.

The optional hosted mailbox service (`mailbox-service/`) does expose messaging
and task tools over MCP, so ChatGPT Dots and other cloud agents can reach your
workers. See [Cloud connections](cloud-connections.md) and
[Automatic workers](workers.md).

For live peer connections, files, and media through MCP, use the sibling package
[`@vdoninja/mcp`](https://github.com/steveseguin/ninjamcp).

## Troubleshooting

Start here:

```bash
ninja-p2p doctor
```

```text
[ok  ] node       Node v22.14.0
[ok  ] webrtc     @roamhq/wrtc is usable (data + media)
[ok  ] signaling  wss://wss.vdo.ninja reachable in 257ms
[ok  ] state      C:\Users\steve\.ninja-p2p is writable
[warn] sidecars   0 running, 6 stopped
```

It checks the Node version, whether the SDK can initialize either
`@roamhq/wrtc` or `node-datachannel`, whether the signaling server is reachable,
whether the state folder is writable, and which sidecars this machine believes
it started. It exits non-zero if a required check fails.

Common cases:

- **Peers never discover each other.** They must use the exact same `--room`. Run `ninja-p2p room --id <you>` on the first agent and copy that value.
- **`ninja-p2p demo` fails at `connect`.** Outbound `wss://` is blocked. Check a proxy or firewall.
- **Messages queue but never send.** The sidecar is not running. Check `ninja-p2p status --id <you>` and the log at `<state-dir>/agent.log`.
- **A wake hook stopped firing.** Wake runs never overlap, so a wake command that never exits blocks later ones. The log records `[wake] busy` when that happens.

## CLI

Prove the transport works, then diagnose if it does not:

```bash
ninja-p2p demo
ninja-p2p demo --keep
ninja-p2p doctor
```

Interactive room session:

```bash
ninja-p2p connect --room my-room --name Claude --id claude
```

One-shot room message:

```bash
ninja-p2p chat --room my-room --name Steve --id steve "hello"
```

One-shot direct message:

```bash
ninja-p2p dm --room my-room --name Steve --id steve claude "hello"
```

One-shot command:

```bash
ninja-p2p command --room my-room --name Steve --id steve claude status
```

Minimal persistent sidecar:

```bash
ninja-p2p start --id codex
```

Persistent sidecar with optional discovery metadata:

```bash
ninja-p2p start --room ai-room --name Codex --id codex --runtime codex-cli --provider openai --model gpt-5 --can review,tests
```

Sidecar status:

```bash
ninja-p2p status --id codex
```

Inbox summary:

```bash
ninja-p2p notify --id codex
```

Read pending messages:

```bash
ninja-p2p read --id codex --take 10
```

Block until messages arrive:

```bash
ninja-p2p wait --id codex
ninja-p2p wait --id codex --timeout 60000
```

Run a command automatically when messages arrive:

```bash
ninja-p2p start --id codex --on-message "codex exec 'Check your ninja-p2p inbox'"
```

Queue a direct message through the running sidecar:

```bash
ninja-p2p dm --id codex human "working on it"
```

Queue a file or image through the running sidecar:

```bash
ninja-p2p send-file --id codex reviewer ./notes.txt
ninja-p2p send-image --id codex reviewer ./diagram.png
```

List and pull from a shared folder:

```bash
ninja-p2p shares --id codex worker
ninja-p2p list-files --id codex worker docs
ninja-p2p get-file --id codex worker docs guide.md
```

Ask another sidecar what it can do:

```bash
ninja-p2p command --id codex claude capabilities
```

Ask for a plan, review, or approval:

```bash
ninja-p2p plan --id codex planner "Suggest a safe rollout"
ninja-p2p review --id codex reviewer "Review PR #42"
ninja-p2p approve --id codex reviewer "Approve this plan"
```

Reply to a request with a structured result:

```bash
ninja-p2p respond --id codex planner <requestId> '{"approved":true}'
```

Stop the sidecar:

```bash
ninja-p2p stop --id codex
```

Other commands and flags:

| Command or flag | What it does |
| --- | --- |
| `menu --id codex` | Shows the agent's room, status, and next steps |
| `--password <secret>` | Room password. Every peer must use the same one; it hashes the room name and encrypts connection setup |
| `--role <role>` | Role announced to peers (default `agent`) |
| `--wait-ms <ms>` | How long a one-shot `--room` command waits for peers before sending (default 1500) |
| `read --take <n>` | How many messages to take (default 20) |
| `wait --interval <ms>` | How often `wait` checks the inbox (default 500) |
| `respond <peer> <requestId> --error <text>` | Answers a request with a failure instead of a result |
| `demo --room <name> --password <secret> --timeout <ms>` | Runs the demo in a room you choose (default timeout 20000) |
| `doctor --state-root <dir>` | Checks a state folder other than `~/.ninja-p2p` |
| `seed --chunk-size <bytes>` | Chunk size from 1,024 bytes to 16 MiB (default 64000) |

The package also installs two helper programs: `ninja-p2p-relay` runs the
encrypted HTTP relay ([Cloud connections](cloud-connections.md)), and
`ninja-p2p-call` runs the local voice and vision page
([Voice and vision](voice-and-vision.md)).

Install the optional skills:

```bash
ninja-p2p install-skill codex
ninja-p2p install-skill claude
```

Useful env vars:

- `NINJA_ID`, `NINJA_NAME`, `NINJA_ROLE`, `NINJA_STATE_DIR`
- `NINJA_ROOM`, `NINJA_PASSWORD`
- `NINJA_ON_MESSAGE`, `NINJA_WAKE_DEBOUNCE`, `NINJA_WAKE_LIMIT` (same as the `start` flags)
- `NINJA_RUNTIME`, `NINJA_PROVIDER`, `NINJA_MODEL`, `NINJA_SUMMARY`, `NINJA_WORKSPACE`, `NINJA_CAN`, `NINJA_ASKS`, `NINJA_SHARE` (profile flags)
- `NINJA_TRANSPORT`, `NINJA_RELAY_CONFIG`, `NINJA_MAILBOX_CONFIG` (cloud connections)

`NINJA_ROOM` acts like `--room` on every command. With it set, `dm --id codex`
opens its own one-shot connection instead of queuing through the running
sidecar, so leave it unset in shells where agents talk through a sidecar.

