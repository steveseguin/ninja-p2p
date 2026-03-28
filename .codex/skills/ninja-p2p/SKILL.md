---
name: ninja-p2p
description: Use the installed ninja-p2p CLI when the user wants Codex to send or receive room messages, private messages, or command messages over WebRTC. Prefer the sidecar inbox pattern when a long-lived agent session exists.
---

# ninja-p2p

Use this skill only when the user explicitly wants `ninja-p2p` or when the current task is clearly about agent-to-agent coordination through `ninja-p2p`.

## What this is

- `ninja-p2p` is an npm package and shell CLI.
- It is not an MCP server.
- In Codex, skills are typically discovered from `.codex/skills`. This package also ships a compatibility copy under `.agents/skills`.
- The skill does not install the CLI for you. Check that `ninja-p2p` exists before trying to use it.

## How to run it

If the current workspace contains `dist/cli.js`, prefer:

```bash
node ./dist/cli.js <args>
```

Otherwise, if `ninja-p2p` is installed on PATH, use:

```bash
ninja-p2p <args>
```

If the user mentions this skill with no concrete command yet, start with:

```bash
node ./dist/cli.js menu --id codex --name Codex --runtime codex-cli --provider openai
```

## If the CLI is missing

Tell the user to install one of these:

```bash
npm install -g @vdoninja/ninja-p2p @roamhq/wrtc
```

```bash
npm install @vdoninja/ninja-p2p @roamhq/wrtc
```

## Preferred workflow for Codex

If a long-lived agent session is meant to stay online, prefer the sidecar pattern:

```bash
ninja-p2p start --id codex
ninja-p2p status --id codex
ninja-p2p notify --id codex
ninja-p2p read --id codex --take 10
ninja-p2p shares --id codex worker
ninja-p2p list-files --id codex worker docs
ninja-p2p get-file --id codex worker docs guide.md
ninja-p2p send-file --id codex reviewer ./notes.txt
ninja-p2p send-image --id codex reviewer ./diagram.png
ninja-p2p plan --id codex planner "Suggest a safe rollout"
ninja-p2p review --id codex reviewer "Review PR #42 for regressions"
ninja-p2p approve --id codex reviewer "Approve this plan before I continue"
ninja-p2p respond --id codex planner <requestId> '{"approved":true}'
ninja-p2p command --id codex claude capabilities
ninja-p2p dm --id codex human "working on it"
ninja-p2p stop --id codex
```

This is the practical model for Codex:

- `ninja-p2p start ...` launches the persistent sidecar
- if you omit `--room`, `ninja-p2p` generates one automatically
- `ninja-p2p status ...` confirms it is still running and shows the last peer snapshot
- Codex uses `notify` and `read` to check the local inbox and peer capability summaries
- `chat`, `dm`, `command`, `plan`, `review`, `approve`, `respond`, `send-file`, `send-image`, `shares`, `list-files`, and `get-file` with `--id` queue outbound work through the running sidecar

Persistent sidecars auto-answer these remote discovery commands:

- `help`
- `profile`
- `whoami`
- `capabilities`
- `status`
- `peers`
- `inbox`

Use those before handing work to another agent:

```bash
ninja-p2p command --id codex claude profile
ninja-p2p command --id codex claude capabilities
ninja-p2p shares --id codex claude
ninja-p2p list-files --id codex claude docs
ninja-p2p get-file --id codex claude docs guide.md
```

Then use `notify` and `read` to inspect the reply in Codex's local inbox.

Useful collaboration patterns:

```bash
ninja-p2p plan --id codex planner "Suggest a safe rollout plan"
ninja-p2p review --id codex reviewer "Review this diff for regressions"
ninja-p2p approve --id codex reviewer "Approve this plan before I continue"
ninja-p2p respond --id codex planner <requestId> '{"approved":true,"note":"Looks safe"}'
```

Do not describe this as real-time interruption or as MCP. Codex still acts turn by turn.

## One-shot commands

Use these when the user just wants a quick send and does not need a long-lived local inbox:

```bash
ninja-p2p connect --room my-room --name Codex --id codex
ninja-p2p chat --room my-room --name Steve --id steve "hello"
ninja-p2p dm --room my-room --name Steve --id steve worker_bot "hello"
ninja-p2p shares --room my-room --name Steve --id steve worker_bot
ninja-p2p list-files --room my-room --name Steve --id steve worker_bot docs
ninja-p2p get-file --room my-room --name Steve --id steve worker_bot docs guide.md
ninja-p2p send-file --room my-room --name Steve --id steve worker_bot ./notes.txt
ninja-p2p command --room my-room --name Steve --id steve worker_bot status
```

## Guardrails

1. Prefer `notify` and `read` before sending if the user expects active collaboration.
2. Prefer `--id` values that are stable and human-readable.
3. When starting a sidecar, prefer explicit `--runtime`, `--provider`, `--model`, `--can`, and `--ask` fields so peers can discover what the agent is for.
4. Use `--share name=path` only for explicit allowlisted folders. Do not imply arbitrary remote filesystem access.
5. Do not describe this as an MCP server, a VPN, a generic TCP tunnel, or a guaranteed-delivery transport.
