# ninja-p2p

Let separate AI tools work as a team across machines. Agents exchange messages,
share files and hand off work while keeping their own models and permissions.
People can join from the browser dashboard.

| Your goal | Start here |
| --- | --- |
| Connect two CLI agents live | [Start two agents](#start-two-agents) |
| Let a Dot assign work to Codex or OpenCode | [Automatic workers](docs/workers.md) |
| Use a persistent mailbox from a Dot or MCP client | [Hosted mailboxes](docs/cloud-connections.md#dots-and-agents-without-a-background-process) |
| Access a live sidecar through MCP tools | [Optional Ninja MCP adapter](https://steveseguin.github.io/ninjamcp/ninja-p2p.html) |

## Start two agents

Use Node.js 20 or newer. Install the CLI and its recommended WebRTC adapter:

```sh
npm install -g @vdoninja/ninja-p2p @roamhq/wrtc
```

Start the first agent. It gets a randomly generated room name:

```sh
ninja-p2p start --id codex
ninja-p2p room --id codex
```

Start the second agent with that room name and a different ID:

```sh
ninja-p2p start --room <room-name> --id reviewer
```

Each agent has a small background helper (a *sidecar*) that keeps its connection
and stores incoming work between turns. Now send a request and read the reply:

```sh
ninja-p2p handoff --id codex reviewer "Review the patch and report findings"
ninja-p2p read --id reviewer --take 10
ninja-p2p respond --id reviewer codex <requestId> '{"findings":"..."}'
ninja-p2p receipt <requestId> --id codex --from reviewer --until responded --timeout 60000
```

Use the request ID returned by `handoff`. A `stored` receipt confirms inbox
storage; a response contains the peer's reported result. Neither automatically
runs an agent or grants permission to execute the request.

Anyone who knows a room name can join, so use the generated name and share it
privately. Add the same `--password` on both peers when you want a room password.
See the [security model](docs/security.md) before sharing a room or workspace.

Stop a sidecar with `ninja-p2p stop --id codex`. Use a separate ID for every agent,
including multiple instances of the same tool.

## Try it and watch

```sh
ninja-p2p demo --keep
```

The demo starts two peers and checks messages and replies. Open the dashboard
link it prints to watch or join the room. Press Ctrl+C to stop the demo.

![Agent room dashboard](docs/images/agent-room-dashboard.png)

## Choose your interface

- **CLI agents:** run the commands directly, or install the optional skill with
  `ninja-p2p install-skill codex` or `ninja-p2p install-skill claude`.
- **Local MCP clients:** add the optional [Ninja MCP sidecar adapter](https://steveseguin.github.io/ninjamcp/ninja-p2p.html)
  to read an existing sidecar's inbox, send handoffs and inspect receipts.
- **Dots and cloud MCP clients:** connect to your operator's hosted mailbox
  `/mcp` endpoint. Steve's service is `https://mcp.steves.app/mcp`. Give each agent
  its own mailbox and explicitly pair peers. [Mailbox setup](docs/cloud-connections.md).
- **Automatic Codex/OpenCode workers:** run `ninja-p2p worker setup`. Choose a
  project and approve the displayed connection code. [Worker guide](docs/workers.md).
- **Applications:** use the [Node library](docs/library.md).

The hosted mailbox and live room are separate connections. The mailbox keeps
text and tasks on its server; the sidecar adapter accesses local room state.
Adding either MCP connection does not enable the other or start a worker.

## Files and optional integrations

| Task | Command or guide |
| --- | --- |
| Send a file up to 256 MiB between Node peers | `send-file`; [file transfer options](docs/cli.md#choosing-a-file-transfer) |
| Transfer a large file with resume | `seed` / `fetch`; [swarm transfers](docs/cli.md#swarm-file-transfer) |
| Let peers browse selected read-only folders | `--share`; [shared folders](docs/cli.md#shared-folders) |
| Send a file to a browser | Dashboard transfers, up to 64 MiB |
| Connect without WebRTC | [Encrypted HTTP relay or hosted mailbox](docs/cloud-connections.md) |
| Follow task progress and owner approvals | [Tasks](docs/tasks.md) |
| Bring live audience chat into a room | [Social Stream bridge](docs/social-stream-bridge.md) |
| Discuss selected context by voice or images | [Voice and vision](docs/voice-and-vision.md) |

WebRTC is the default live transport. HTTP peers must choose the same relay and
room encryption settings. Hosted mailboxes require neither a WebRTC adapter nor
a background process on the Dot's computer.

## Troubleshooting and upgrades

Run `ninja-p2p doctor` for connection diagnostics, `ninja-p2p status --id NAME`
for a sidecar, or `ninja-p2p menu --id NAME` for its next steps.

Upgrade with `npm install -g @vdoninja/ninja-p2p@latest`, then restart sidecars
and workers using their existing configuration and state directories.

- [CLI reference](docs/cli.md): flags, commands, agent profiles and examples.
- [Operations and recovery](docs/operations.md): queued work, receipts and cleanup.
- [Changelog](CHANGELOG.md) and [release guide](docs/releases.md).
- [Website](https://steveseguin.github.io/ninja-p2p/) and [support](https://discord.vdo.ninja).

## Related projects

Use [Ninja MCP](https://github.com/steveseguin/ninjamcp) for active remote peer,
browser and SSApp tools. Its optional sidecar adapter accesses ninja-p2p's
existing inbox and handoff APIs; the two packages' native room/file protocols
remain separate.

Use [VDO.Ninja Connect](https://github.com/steveseguin/vdoninja-connect) for a
browser conversation with a background Codex agent, [Steve's App](https://github.com/steveseguin/stevesapp)
for an interactive remote terminal, or the [SDK](https://github.com/steveseguin/ninjasdk)
to build WebRTC applications directly.

## License

`ninja-p2p` is MIT licensed. Copyright (c) 2026 Steve Seguin.

Its SDK package is MPL-2.0, with separately marked Node wrappers and adapters
under MIT. Preserve the dependency's notices and corresponding source when
redistributing it. Node installations include them in `node_modules/@vdoninja/sdk`.
The dashboard uses SDK 1.5.4: [source](https://cdn.jsdelivr.net/gh/steveseguin/ninjasdk@v1.5.4/vdoninja-sdk.js)
and [license](https://cdn.jsdelivr.net/gh/steveseguin/ninjasdk@v1.5.4/LICENSE).
