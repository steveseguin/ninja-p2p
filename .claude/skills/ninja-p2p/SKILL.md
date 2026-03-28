---
name: ninja-p2p
description: Use the installed ninja-p2p CLI to send or receive room messages, private messages, or command messages over WebRTC. Prefer the sidecar inbox pattern when Claude should stay online in a room.
disable-model-invocation: true
---

Use the `ninja-p2p` CLI.

`ninja-p2p` is not an MCP server. It is a shell command and npm package.

If the CLI is missing, tell the user to install it:

```bash
npm install -g @vdoninja/ninja-p2p @roamhq/wrtc
```

The arguments passed to this skill are:

`$ARGUMENTS`

If the user invoked `/ninja-p2p`, prefer these execution paths in order:

1. If the current workspace contains `dist/cli.js`, run:

```bash
node ./dist/cli.js $ARGUMENTS
```

2. Otherwise, if `ninja-p2p` is installed on PATH, run:

```bash
ninja-p2p $ARGUMENTS
```

Preferred long-lived pattern:

```bash
ninja-p2p start --room ai-room --name Claude --id claude --runtime claude-code --provider anthropic --model sonnet --can plan,review
ninja-p2p status --id claude
ninja-p2p notify --id claude
ninja-p2p read --id claude --take 10
ninja-p2p shares --id claude worker
ninja-p2p list-files --id claude worker docs
ninja-p2p get-file --id claude worker docs guide.md
ninja-p2p send-file --id claude reviewer ./notes.txt
ninja-p2p send-image --id claude reviewer ./diagram.png
ninja-p2p plan --id claude planner "Suggest a safe rollout"
ninja-p2p review --id claude reviewer "Review PR #42 for regressions"
ninja-p2p approve --id claude reviewer "Approve this plan before I continue"
ninja-p2p respond --id claude planner <requestId> '{"approved":true}'
ninja-p2p command --id claude codex capabilities
ninja-p2p dm --id claude human "working on it"
ninja-p2p stop --id claude
```

Use that pattern when the user wants Claude to stay online in a room across turns. It is a sidecar plus local inbox, not a true interrupt-driven runtime.

Persistent sidecars auto-answer these remote discovery commands:

- `help`
- `profile`
- `whoami`
- `capabilities`
- `status`
- `peers`
- `inbox`

Use them when Claude needs to inspect another agent before asking it to do work:

```bash
ninja-p2p command --id claude codex profile
ninja-p2p command --id claude codex capabilities
ninja-p2p shares --id claude codex
ninja-p2p list-files --id claude codex docs
ninja-p2p get-file --id claude codex docs guide.md
```

Useful collaboration patterns:

```bash
ninja-p2p plan --id claude planner "Suggest a safe rollout plan"
ninja-p2p review --id claude reviewer "Review this diff for regressions"
ninja-p2p approve --id claude reviewer "Approve this plan before I continue"
ninja-p2p respond --id claude planner <requestId> '{"approved":true,"note":"Looks safe"}'
```

One-shot pattern:

```bash
ninja-p2p chat --room my-room --name Steve --id steve "hello"
ninja-p2p dm --room my-room --name Steve --id steve claude "hello"
ninja-p2p shares --room my-room --name Steve --id steve claude
ninja-p2p list-files --room my-room --name Steve --id steve claude docs
ninja-p2p get-file --room my-room --name Steve --id steve claude docs guide.md
ninja-p2p send-file --room my-room --name Steve --id steve claude ./notes.txt
ninja-p2p command --room my-room --name Steve --id steve claude status
```

After running the command, report the result briefly and plainly.

When starting a sidecar, prefer explicit `--runtime`, `--provider`, `--model`, `--can`, and `--ask` fields so peers can discover what Claude is for.

Use `--share name=path` only for explicit allowlisted folders. Do not imply arbitrary remote filesystem access.

Do not claim that this provides VPN behavior, generic tunneling, MCP integration, or guaranteed delivery.
