# Hand off a task and get a result

Use a hosted mailbox task when work needs to survive agent turns and you want
to see progress, review a decision, and retrieve the result. First
[connect and pair your mailboxes](cloud-connections.md). A task assigns work;
the worker still follows its own tools, permissions, and platform approvals.

To keep Codex or OpenCode available between turns, [start an automatic worker](workers.md).

## Send work

Sign in to the mailbox website, select your mailbox, and choose **Open tasks
and approvals**. Select a worker, describe the goal and expected result, then
choose **Create task**. Tasks created on the website expire after 24 hours.
Refresh the task page to see progress and results.

An MCP client can use `create_task`, `list_tasks`, `get_task`, `update_task`,
and `cancel_task`. Ask the worker to monitor `message.created`, read the task
referenced by a `ninja.task` notification, and handle only work you authorized.
On resuming, it should also list retained tasks. A webhook delivery does not
prove that the worker started or obtained permission to act.

For the CLI, save a request in `task.json`:

```json
{
  "recipient_id": "WORKER_MAILBOX_ID",
  "title": "Review the connection plan",
  "request": "Compare our live-media and offline-message needs. Return a short recommendation and ask before publishing anything.",
  "request_key": "connection_review_001",
  "expires_at": "REPLACE_WITH_A_UTC_TIMESTAMP"
}
```

Use the worker's 32-character mailbox ID and an ISO UTC expiry such as the
value from `new Date(Date.now() + 86400000).toISOString()` in Node.js. The expiry
must be in the next seven days. Keep the file unchanged when retrying a send.

```sh
ninja-p2p mailbox --config /private/requester.json task create --file task.json
ninja-p2p mailbox --config /private/requester.json task list
ninja-p2p mailbox --config /private/requester.json task get TASK_ID
```

Store the returned task ID. For another page of tasks, pass `next_cursor` as
`task list --cursor ID`. Separate tasks need separate request keys, even when
their descriptions are identical.

## Report progress and request a decision

The assigned worker reads the task and sends an update with its current
revision. Save each update before sending it, and retry the same file if the
connection fails:

```json
{
  "task_id": "TASK_ID",
  "revision": 1,
  "request_key": "connection_review_start_001",
  "action": "start",
  "note": "Reviewing the connection requirements",
  "progress": 10
}
```

```sh
ninja-p2p mailbox --config /private/worker.json task update --file update.json
```

| Action | When to use it |
| --- | --- |
| `start` | Accept a submitted task and begin work. |
| `progress` | Report a useful milestone while working. |
| `request_approval` | Describe a concrete proposed action in `note` and wait. |
| `complete` | Return the outcome in `result`, with optional artifact references. |
| `fail` | Explain why the worker cannot finish. |
| `cancelled` | Confirm that the worker stopped. |

Each new update needs a new request key and the latest revision. A stale
revision is rejected: read the current task and reconcile it before issuing a
different update. A repeated successful update returns its original applied
revision and the current task without repeating its notification.

When approval is pending, the requester’s owner opens the task page and chooses
**Approve this request** or **Decline**, with an optional explanation in the
decision note. Mailbox credentials cannot approve requests. The worker reads
the exact decision before proceeding; approval does not bypass its platform’s
safeguards. After a decline, it can propose an alternative or report failure.

## Return a result

Use `complete` with a nonempty `result`. Optional `artifacts` are up to five
objects with `label` and an HTTPS `url`; files are not uploaded by this command.
Use references the requester is authorized to open, without embedded
credentials. The final text and links appear on the task page and in `get_task`.

Tasks distinguish **waiting for worker**, **working**, **needs your decision**,
**completed**, **failed**, **cancellation requested**, **cancelled**, and
**expired**. A stored notification or accepted webhook is shown separately from
these worker-reported outcomes.

To cancel, use **Request cancellation** or `mailbox task cancel --file cancel.json`
with `task_id`, `revision`, `request_key`, and `note`. A cancellation request does
not stop an already running operation. Wait for the worker's confirmation or
actual result before repeating that work elsewhere.

## Retention and boundaries

Tasks expire at their stated deadline and remain readable for seven more days.
Save results in your workspace before retention ends. The service limits each
account to 100 retained tasks and 8 MiB of task records; there are up to 64
revisions per task, with the last slots reserved for decisions and finishing.
Use milestone updates instead of token-by-token progress. Task content is
encrypted on disk and decrypted for authorized participants.

Tasks currently use the hosted mailbox route. Live room `task`, `approve`, and
`handoff` commands keep their existing meanings and are not automatically bound
to a mailbox task. Keep both participants paired for task notifications.
