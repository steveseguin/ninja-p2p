# Let an agent receive work automatically

Keep Codex or OpenCode available for tasks from a Dot or another paired agent.
Start the worker once; it checks its hosted mailbox, runs one task at a time,
and returns the result to the same task. Follow progress and decisions on the
mailbox website or with `get_task` in your requesting agent.

## Connect and start

Install Node.js 20 or newer and your preferred agent CLI. Sign in to that CLI
and make sure it works in the project folder you want it to use. Install Ninja
P2P from GitHub:

```sh
npm install -g github:steveseguin/ninja-p2p
```

[Create and pair two mailboxes](cloud-connections.md#dots-and-agents-without-a-background-process):
one for the requester, one for this worker. Keep the worker's credential file
outside its project folder. No WebRTC adapter is required for mailbox tasks.

Next to that credential file, save `worker.json`:

```json
{
  "mailboxConfig": "mailbox.json",
  "agent": "codex",
  "workspace": "/path/to/project",
  "allowedPeers": ["REQUESTER_MAILBOX_ID"],
  "instructions": "Review files in this project and return concise findings. Do not edit files, install packages, publish, or contact other services."
}
```

Replace the workspace and requester ID. On Windows, use forward slashes in
JSON paths, such as `C:/Projects/my-app`. Paths are relative to `worker.json`.
Choose `"agent": "opencode"` to use OpenCode instead. Both use the CLI's saved
login and model selection; an optional `model` selects a different model for
this worker.

```sh
ninja-p2p worker start --config /private/worker.json
ninja-p2p worker status --config /private/worker.json
```

The worker runs in the background. Its state and logs are saved beside the
config in `worker.state`, unless you set `stateDir`. Keep that directory across
restarts, and use one worker state directory per mailbox.

## Ask for a result

In your paired Dot or other MCP agent, ask:

“Create a task for my paired worker to review the project README. Return the
three most useful improvements. Monitor this task and show me its result.”

The requester uses `create_task`, then reads updates with `get_task`. Dots can
monitor `message.created` for task notifications. Their own platform permissions
still apply. You can also [create and follow a task on the mailbox website](tasks.md).

Tasks show **waiting**, **working**, **needs your decision**, and the final
result. Only tasks assigned to this mailbox by a paired sender in `allowedPeers`
can launch the worker. Ordinary messages and replies do not launch jobs.

## Choose what the worker may do

Keep `instructions` specific to the work you authorize. The default is
`"sandbox": "read-only"`. Set `"sandbox": "workspace-write"` only for a worker
you want to edit its project. Codex uses its sandbox; OpenCode allows file
reading and, when selected, file editing, with shell commands, external
directories and other tools disabled for this invocation. This is an OpenCode
tool policy, not an operating-system sandbox. Global CLI settings are unchanged.

When an agent asks for approval, open the task on the mailbox website, read the
proposed action and approve or decline. Approval starts another turn with that
specific decision. It does not expand the configured workspace, tools or platform
permissions. Choose **Request cancellation** to stop an active task; wait for
its cancellation confirmation before handing the same work elsewhere.

Each turn has a ten-minute limit. `timeoutSeconds` can be 30–3600; `pollSeconds`
can be 2–60 and defaults to 5. Only one turn runs at a time. Model usage is billed
by your agent provider under your existing account.

## Stop and recover

```sh
ninja-p2p worker stop --config /private/worker.json
```

Stopping finishes the current turn and saves its result, then stops accepting
work. Start again with the same config and state directory. On a VPS, use
`worker run --config /private/worker.json` as the foreground command for your
service manager to restart after a reboot.

If the network disconnects, the worker retains task updates and retries them
with the same request keys. A saved result is delivered without running the
agent again. If execution was interrupted without a saved outcome, the task
asks for a decision before another attempt. Review the workspace and the logs
under `worker.state/runs/TASK_ID/` first: an interrupted turn may have completed
some actions. Decline to prevent another attempt.

Use `worker status` for connection errors and task IDs. Renew expired mailbox
credentials and restart with the same state directory. If the CLI is not on
your PATH, set `executable` to its native executable or Node `.js` entry point;
shell wrappers such as `.cmd`, `.bat` and `.ps1` are not accepted.
