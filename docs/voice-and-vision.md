# Talk about your work

Open a local conversation with an OpenAI agent to discuss a task, speak through
your microphone, or show a selected camera or screen view. Keep task decisions
and worker progress in the [mailbox task page](tasks.md).

Set `OPENAI_API_KEY` in your local terminal, then run:

```sh
ninja-p2p-call
```

To include a task you can access:

```sh
ninja-p2p-call --config /private/mailbox.json --task TASK_ID
```

From a checkout, build the CLI and use `node runtime/call-server.mjs` with the
same options. Open the private loopback URL printed by the command on that
computer. The key stays in the local server process. Keep the terminal running
while using the page; after a reload, reopen the original URL in a new tab.

## Start a conversation

1. Select **Start voice session**. You can type immediately and hear the reply.
2. Choose **Share microphone** to speak. Select **Stop microphone** to stop capture.
3. Choose **Share camera** or **Share screen** to send selected frames. The
   browser lets you choose the screen or window. Use **Stop visual sharing**
   when finished, or select one image file instead.
4. Select **Interrupt** to stop the current response, or **End session** to
   close the connection and stop microphone and visual capture.

Microphone and visual sharing start off. The page shows which inputs are being
sent to OpenAI. Camera and screen sharing send one frame every three seconds;
they are selected snapshots, not a continuous video track to the model.
Image uploads accept PNG, JPEG, or WebP files under 5 MB and resize them before
sharing. Audio replies are AI generated. Use the audio player's controls if
your browser blocks playback.

## Bring in a task

When launched with a task ID, the page loads a preview using that mailbox's
credential. Select **Include this task when I send a message** to share its
current goal, state, approval, and result with OpenAI. Refresh or preview it
before sending. Unchecking the option stops adding task context to subsequent
messages; it does not erase content already shared in that model session.

The conversation discusses your task. It does not update tasks, approve
requests, send mailbox messages, or control a browser. Use the mailbox page for
task decisions. For an agent that operates a shared remote browser, use
[Ninja MCP's browser companion](https://steveseguin.github.io/ninjamcp/browser-agent.html).

## Continue without WebRTC

Choose **Use HTTPS text instead of voice**, or type after ending the voice
session. This uses an ordinary HTTPS request and works when a WebRTC connection
cannot be established. Each text request contains your current message and any
explicitly selected task context; earlier voice transcripts and images are not
automatically copied into it. Include the context you need in the message.

The voice connection uses WebRTC between your browser and OpenAI. It is
separate from a VDO.Ninja peer room, so other room members do not automatically
join or hear it. Hosted mailbox tasks remain available independently of the call.

## Models and limits

The defaults are `gpt-realtime-2.1` for voice and vision and `gpt-4.1-mini` for
HTTPS text. Set `NINJA_CALL_MODEL` or `NINJA_TEXT_MODEL` in the server process to
choose a compatible model available to your OpenAI project.

Each call ends after five minutes. A server process permits one active call,
up to six call attempts, and 30 HTTPS text requests. Restart it to begin another
bounded session. Model usage is billed to your OpenAI account. The application
does not record locally; OpenAI processes the inputs and generated responses.

The local server requires its private access URL and checks request origin.
Keep it bound to loopback. For a hosted deployment, add user authentication,
account-specific usage limits, and HTTPS before exposing session creation.

The adapter follows OpenAI's [Realtime WebRTC interface](https://developers.openai.com/api/docs/guides/realtime-webrtc)
and [Responses API](https://developers.openai.com/api/docs/guides/text).
