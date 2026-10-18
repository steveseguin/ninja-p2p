# Let an agent receive work automatically

Keep Codex or OpenCode available for tasks from a Dot or another paired agent.
Start the worker once; it checks its hosted mailbox, runs one task at a time,
and returns the result to the same task. Follow progress and decisions on the
mailbox website or with `get_task` in your requesting agent.

## 1. Install and sign in

Install Node.js 20 or newer and Codex CLI or OpenCode. Sign in to that agent CLI
and make sure it works in your project folder. Install Ninja P2P:

```sh
npm install -g @vdoninja/ninja-p2p@latest
```

You also need a mailbox account and a requester mailbox connected to your Dot
or other MCP agent. Your service operator supplies the private account key;
[connect your requester](cloud-connections.md#dots-and-agents-without-a-background-process)
if it is not connected yet. Mailbox tasks use HTTPS and need no WebRTC adapter.

## 2. Connect your worker

On the computer where Codex or OpenCode will work, run:

```sh
ninja-p2p worker setup
```

Choose the agent and project folder. Setup opens the mailbox website with a
short connection code. Match it to your terminal, sign in, choose the requester
that may send work, and select **Connect worker**. Keep **Run a first read-only
task** checked to receive a short review of the project's README.

Setup saves private settings outside the project, starts the worker, checks its
connection, and shows the first task's result. It uses your CLI's existing login;
model usage is billed by your agent provider. Keep the worker's computer running
to receive tasks. Follow the task link to see progress on the website.

For a VPS or a terminal without prompts:

```sh
ninja-p2p worker setup --agent codex --workspace /path/to/project --no-open
```

Use `--agent opencode` for OpenCode. Open the printed link on another computer
to approve the connection. Use `--server https://your-mailbox.example` for your
own mailbox service. The default is `https://mcp.steves.app`.

Settings are saved under `~/.ninja-p2p/workers/`; setup prints their exact path
and the status and stop commands. `--config /private/worker.json` chooses another
location. Keep the config, credential, setup record and state directory together
and outside the project. Run the same command to resume an interrupted setup
or check the original first task without submitting it again.

Setup waits up to five minutes for the result. If the task is still pending,
the worker continues in the background; follow the task link or rerun setup.
`--wait SECONDS` changes this wait, and `--wait 0` checks once.

## 3. Ask for a result

In your paired Dot or other MCP agent, ask:

“Create a task for my paired worker to review the project README. Return the
three most useful improvements. Monitor this task and show me its result.”

The requester uses `create_task`, then reads updates with `get_task`. Dots can
monitor `message.created` for task notifications. Their own platform permissions
still apply. You can also [create and follow a task on the mailbox website](tasks.md).

Tasks show **waiting**, **working**, **needs your decision**, and the final
result. Only tasks assigned to this mailbox by a paired sender in `allowedPeers`
can launch the worker. Ordinary messages and replies do not launch jobs.

## Optional: configure a worker manually

If you already have a paired worker mailbox and credential file, save the
following configuration outside its project folder. Guided setup users can
edit the file whose path setup printed, then restart the worker.

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

Check for `running: true` and `state: "waiting"` before sending the first task.
`working` means the worker is handling a task. If it is still `connecting`,
run the status command again after a few seconds. For `connection_error`, read
`detail` in the status output; for a process that exits, check
`worker.state/worker.log`.

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
work. Start again with the same config and state directory. On a VPS, use this
foreground command with your service manager to restart after a reboot:

```sh
ninja-p2p worker run --config /private/worker.json
```

If the network disconnects, the worker retains task updates and retries them
with the same request keys. A saved result is delivered without running the
agent again. If execution was interrupted without a saved outcome, the task
asks for a decision before another attempt. Review the workspace and the logs
under the worker state directory’s `runs/TASK_ID/` first: an interrupted turn may have completed
some actions. Decline to prevent another attempt.

Check connection errors and task IDs with:

```sh
ninja-p2p worker status --config /private/worker.json
```

Renew expired mailbox credentials and restart with the same state directory.
If the CLI is not on your PATH, set `executable` to its native executable or
Node `.js` entry point;
shell wrappers such as `.cmd`, `.bat` and `.ps1` are not accepted.

If a Dot cannot see `create_task` or `get_task` after a plugin update, select
**Refresh tools** in that plugin's settings. If the plugin lists the tools but
the Dot still cannot use them, wait until its current work is idle, then select
**Pause** and **Resume** in the Dot's profile. Ask it to call `get_mailbox` and
`list_tasks` before retrying the same task request.
