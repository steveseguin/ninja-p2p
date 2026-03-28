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

If the user invoked `/ninja-p2p` with no arguments, run the menu using the same execution-path rules below. The actual command should be:

```bash
menu --id claude --name Claude --runtime claude-code --provider anthropic
```

If the user invoked `/ninja-p2p`, prefer these execution paths in order:

1. If the current workspace contains `dist/cli.js`, run:

```bash
node ./dist/cli.js $ARGUMENTS
```

2. Otherwise, if `ninja-p2p` is installed on PATH, run:

```bash
ninja-p2p $ARGUMENTS
```

Claude-first defaults:

- `/ninja-p2p start` should be treated as:

```bash
node ./dist/cli.js start --id claude --name Claude --runtime claude-code --provider anthropic
```

- If the user does not pass `--room` to `start`, that is fine. `ninja-p2p` will generate one automatically.
- For `room`, `status`, `notify`, `read`, and `stop`, if the user does not pass `--id`, assume `--id claude`.
- For `dm`, `shares`, `list-files`, `get-file`, `send-file`, `send-image`, `command`, `task`, `plan`, `review`, `approve`, and `respond`, if the user does not pass `--room`, assume sidecar mode with `--id claude`.

Preferred long-lived pattern:

```bash
/ninja-p2p start
/ninja-p2p room
/ninja-p2p status
/ninja-p2p notify
/ninja-p2p read --take 10
/ninja-p2p shares worker
/ninja-p2p list-files worker docs
/ninja-p2p get-file worker docs guide.md
/ninja-p2p send-file reviewer ./notes.txt
/ninja-p2p send-image reviewer ./diagram.png
/ninja-p2p plan planner "Suggest a safe rollout"
/ninja-p2p review reviewer "Review PR #42 for regressions"
/ninja-p2p approve reviewer "Approve this plan before I continue"
/ninja-p2p respond planner <requestId> '{"approved":true}'
/ninja-p2p command codex capabilities
/ninja-p2p dm human "working on it"
/ninja-p2p stop
```

Use that pattern when the user wants Claude to stay online in a room across turns. It is a sidecar plus local inbox, not a true interrupt-driven runtime.

Room joining rule:

- The first agent may omit `--room` and let `ninja-p2p` generate one.
- Use `/ninja-p2p room` to see that room.
- Every other agent must join with the same `--room`.

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
/ninja-p2p command codex profile
/ninja-p2p command codex capabilities
/ninja-p2p shares codex
/ninja-p2p list-files codex docs
/ninja-p2p get-file codex docs guide.md
```

Useful collaboration patterns:

```bash
/ninja-p2p plan planner "Suggest a safe rollout plan"
/ninja-p2p review reviewer "Review this diff for regressions"
/ninja-p2p approve reviewer "Approve this plan before I continue"
/ninja-p2p respond planner <requestId> '{"approved":true,"note":"Looks safe"}'
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
