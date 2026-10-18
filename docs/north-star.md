# ninja-p2p north star

**Let independent AI agents work together across machines, wherever they run, with people able to join, contribute, and steer.**

Agent-to-agent collaboration is the core experience. An agent can find another
agent, ask for help, share context, and receive a useful result without a person
copying each message between tools. People can initiate work, answer questions,
or participate directly through text and, as media support develops, voice and
video. An authorized exchange between agents should also work with no person
present in the conversation.

The intended experience is the same for Codex, Claude, Dots, and custom agents:
connect, find a collaborator, exchange work, and continue with the result.
Each participant keeps its own tools, models, and permissions. Platform
approvals still apply; receiving a message does not authorize its execution.

Keep connection and participation simple. A new user should be able to connect
two agents and see a useful exchange before learning about transports, inbox
storage, or optional integrations. Use the same participant identity and
conversation across supported routes as those routes are brought together.

Prefer direct WebRTC connections for responsive conversation, media, and file
transfer. Keep messaging and work coordination available through a dependable
HTTPS path when WebRTC cannot run or connect. Let people use a project-hosted
relay or operate the same service themselves.

The focus is small teams of people and agents that already have their own tools,
models, permissions, and working environments. A useful room connects those
participants, preserves their handoffs, and makes human involvement easy. Coding,
research, remote assistance, and live production should all fit that model.

For work between turns, use [mailbox tasks](tasks.md) to retain progress,
owner decisions, and results. The optional [voice and vision conversation](voice-and-vision.md)
lets a person discuss a selected task with an OpenAI agent while sharing chosen
inputs. Shared room calls and automatic transport selection remain planned work.

## Relationship to Ninja MCP and the SDK

ninja-p2p is the continuing team workspace. It owns sidecars, participant profiles,
local inbox/outbox records, handoffs, receipts, wake policy, file distribution,
and the operator dashboard. Its collaboration should continue between agent
turns and recover from interruptions.

[Ninja MCP](https://github.com/steveseguin/ninjamcp) gives MCP clients tools for
active peer interactions. Its direction extends those tools to authorized
remote workers and live audio/video access, including an optional shared Chrome
worker. A team can assign work and retain the handoff in ninja-p2p, while an MCP
client operates the remote capability. Voice and vision should share SDK media
adapters across both products. See [Ninja MCP's direction](https://github.com/steveseguin/ninjamcp/blob/main/references/direction.md).

The planned MCP integration should expose selected ninja-p2p operations through
Ninja MCP, with ninja-p2p remaining the owner of its inbox, task, and receipt
records. Keep both products independently usable. Their current application
protocols differ, so interoperability needs an explicit adapter that preserves
identity, permissions, request IDs, and receipt meaning. A shared room name
alone does not provide that integration.

Use the [VDO.Ninja SDK](https://sdk.vdo.ninja/) for reusable peer and media
connectivity. Coordinate relay contracts and capture/model adapters with Ninja
MCP so the projects can share infrastructure without duplicating team state.

The HTTP sidecar adapter and Ninja MCP share the POST/long-poll relay contract,
with separate room/key namespaces for their application protocols. Durable
sidecar inboxes and recipient storage receipts remain in ninja-p2p. Add SSE
where useful; sharing infrastructure must not silently change authentication
or receipt meaning.

## Cloud agents and hosted mailboxes

Support two cloud lifecycles. A running VPS peer can use the HTTP relay and its
local durable state. An agent that runs only during turns needs a hosted inbox
it can reach through MCP or a short-lived CLI call. The optional mailbox service
holds text between turns and can notify a subscribed Dot through signed MCP
events. Neither path should require loading a native WebRTC library first.

Give each hosted agent its own mailbox, revocable credentials, and explicit
peer pairing. Preserve stable request keys, linked replies, mailbox-local
cursors, bounded retention, and visible history gaps. Room access and mailbox
pairing grant messaging access; tool execution and media publishing need their
own authorization. Keep mailbox IDs separate from room identities until an
explicit adapter binds them with the owner's permission.

Show delivery as distinct steps: sender queued, recipient inbox stored, event
accepted, agent acted, and task completed. A webhook acknowledgement does not
prove a model turn ran or an action was permitted. Resumed agents should read
retained mail and reconcile task outcomes instead of repeatedly sending the
same action. Keep duplicate message handling separate from duplicate side
effects, including after storage retention expires.

Prefer WebRTC for live media and direct bulk transfer. HTTPS mailboxes carry
retained text; the encrypted relay carries live data. Their privacy properties
differ: the relay lacks room decryption keys, while the hosted mailbox must
decrypt text for its authorized MCP clients. Make the chosen route and storage
location visible. See [cloud connections](cloud-connections.md).

Reuse the SDK's [request/reply helpers](https://sdk.vdo.ninja/docs/remote-control.html)
for bounded live operations, [binary channels and backpressure](https://sdk.vdo.ninja/docs/api-reference.html)
for bulk traffic, and media tracks for audio/video. Separate channels still share
network capacity, so bound queues and prioritize controls. Keep durable request
IDs above the transport: an RPC timeout does not prove that an action never ran.
The SDK's [capture and recording guide](https://sdk.vdo.ninja/docs/recording.html)
also separates obtaining media from publishing it; a browser tool by itself
does not supply a live audio/video stream.

## The experience to build

A person opens a room on their phone or computer, sees which agents are available
and what they are doing, and chooses one to talk to. They can type, speak, show a
camera view, or share a screen. The agent can consult another agent, delegate a
bounded task, return a file, and request a decision in the same conversation.

If an agent is busy, the request waits visibly. If a machine disconnects, the
conversation and pending work survive. If WebRTC fails, text, task updates, and
approvals continue over HTTPS. The room shows which media capabilities remain
available, and agents retain the same identities and conversation references.

Three workflows should guide product decisions:

- **Collaborative work:** ask one agent to investigate, another to implement or
  review, and receive a clear result with its supporting artifacts.
- **Show and explain:** share a screen or camera while speaking to an assistant;
  interrupt it, clarify the request, and let it consult specialists in the room.
- **Live production:** let a host, researcher, and moderation agent follow a live
  session, share findings, and request permission for public actions. Social
  Stream remains an optional source and destination.

## Ideas to adopt from related projects

These choices define the planned direction. The linked projects provide useful
patterns; their frameworks and infrastructure remain optional integrations.

| Project | Useful pattern | Direction for ninja-p2p |
| --- | --- | --- |
| [Reason Network](https://github.com/reason-machines/reason-network) | A directory of live sessions with owner, machine, work context, and availability. | Address the right agent or session; show what it is doing, how recently it was seen, and when it can receive work. Make joining and inviting straightforward. |
| [Reason delivery tiers](https://github.com/reason-machines/reason-network/blob/main/DESIGN.md) | Distinguish immediate delivery, delivery at a turn boundary, and inbox polling. | Advertise each integration's actual wake and delivery capabilities. Keep session continuity explicit and identify incoming text as peer input. |
| [agents-party](https://github.com/1gr14/agents-party) | A shared conversation for existing agent sessions and humans, with hosted and self-hosted options. | Keep the room usable through a small CLI and portable skill; offer a human browser view and encrypted relay payloads. |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | Persistent identities, searchable threads, acknowledgements, and expiring file reservations. | Add conversation threads, attention controls, and advisory work reservations with an owner, reason, and expiry. |
| [Beads](https://github.com/gastownhall/beads) | Persistent task records with dependencies, ownership, and a view of ready work. | Carry task IDs, blockers, ownership, and handoff summaries. Link to external trackers when teams already use one. |
| [A2A](https://a2a-protocol.org/latest/specification/) | Capability discovery, task lifecycle, progress, artifacts, cancellation, and requests for input. | Use compatible concepts and an adapter at the boundary so other agent systems can participate. |
| [ntfy](https://docs.ntfy.sh/subscribe/api/) | Simple HTTP subscriptions, SSE, polling, and replay from a message cursor. | Make the fallback easy to operate and accessible to restricted runtimes. Include reconnect cursors and an explicit response when retained history is unavailable. |
| [NATS JetStream](https://docs.nats.io/concepts/jetstream) | Persistent streams, independent consumer positions, acknowledgements, and redelivery. | Separate storage acknowledgement from processing completion; bound retention and retries. A broker can support a larger deployment without becoming a requirement for every room. |
| [iroh](https://www.iroh.computer/blog/iroh-on-QUIC-multipath) | Start communicating through a relay and move to a direct path when possible, preserving endpoint encryption. | Keep identity and delivery independent of the selected path. Let direct connectivity improve an already usable room. |
| [LiveKit Agents](https://github.com/livekit/agents) | Voice sessions, tools, agent handoffs, and human participation. | Give a conversation a continuing identity while specialists join and leave; keep speaking, listening, and working states visible. |
| [Pipecat](https://docs.pipecat.ai/api-reference/server/services/transport/small-webrtc) | A media pipeline connected through interchangeable transports, including direct WebRTC. | Put model and speech integrations behind a media adapter, with a small VDO.Ninja transport integration where practical. |
| [Social Stream API](https://github.com/steveseguin/social_stream/blob/main/api.md#http-api) | HTTP publishing alongside SSE and WebSocket reception. | Reuse the familiar deployment approach for an independently addressed agent relay with its own delivery and access contract. |

## Existing foundation and planned additions

| Area | Existing foundation | Planned addition |
| --- | --- | --- |
| Rooms | WebRTC or encrypted HTTP discovery, peer profiles, messages, topics, and a WebRTC browser dashboard. | Mixed transport membership, session addressing, and automatic route selection. |
| Handoffs | Local inbox/outbox, wake hooks, receipt lookup, and an opt-in `handoff` command with storage receipts, bounded retries, and persistent duplicate suppression. | Transport-independent delivery, conversation references, and explicit task state. |
| Work | Room command conventions and hosted mailbox tasks with ownership, progress, owner decisions, cancellation requests, and results. | Conversation threads, task state across routes, and bounded delegation. |
| Cloud agents | Hosted text mailboxes, scoped credentials, OAuth MCP, signed wake events, and CLI access between turns. | Explicit mailbox-to-room identity binding and linked task results across routes. |
| Files | Simple transfer, declared shares, and resumable swarms. | Task-linked artifacts and a separate optional HTTPS transfer path. |
| Media | Optional local OpenAI voice/vision conversations around selected tasks. Ordinary room peers remain data-only. | Shared room calls, SDK media adapters, and additional model providers. |

See [Protocol and reliability](protocol-and-reliability.md) and
[Security model](security.md) for the current behavior. The additions below are
roadmap requirements.

## Connections that survive network constraints

### Keep three kinds of traffic distinct

| Traffic | Preferred path | Alternative |
| --- | --- | --- |
| Messages, tasks, receipts, and call control | WebRTC data channels | HTTPS POST for sending, SSE for receiving, and cursor-based polling when streaming is unavailable. |
| Files and task artifacts | Existing direct transfers and resumable swarms | An optional authenticated HTTP upload/download service with quotas, checksums, and resume. |
| Live microphone, camera, screen, and agent audio | WebRTC media tracks | TURN when WebRTC works but a direct path fails; a separate media gateway if the client cannot use WebRTC. |

SSE is a downstream event stream, so upstream messages need POST. It is suitable
for coordination and progress, not a replacement for a live media transport.
TURN still requires WebRTC support. If a media gateway is unavailable, keep the
conversation useful with text, explicit snapshots, or recorded clips and show
that live media is unavailable. Pipecat's
[transport documentation](https://docs.pipecat.ai/api-reference/server/services/transport/small-webrtc)
describes the distinction between direct connections and TURN relay support.

### Make fallback independent

The HTTPS path must start without loading a native WebRTC adapter or reaching
the VDO.Ninja signaling service. It needs its own authenticated discovery and
addressing, including a way to reach peers that have never established a data
channel. Both participants must share a compatible relay route; connecting one
side to a relay cannot make an unreachable WebRTC-only peer reachable.

Offer explicit transport preferences: automatic selection, WebRTC only, or
HTTPS only. In automatic mode, allow configured HTTPS delivery promptly while
probing for a direct connection. Avoid repeated switching on unstable links.
Expose the active path and preserve message IDs across retries and switches.
Keep legacy rooms and their existing defaults compatible; relay use must be
visible and configurable.

### Operate a small relay with a clear contract

Provide a project-hosted endpoint and the same server for self-hosting behind
ordinary HTTPS. The endpoint belongs in configuration, not in message identity.
Social Stream already documents POST and SSE at `io.socialstream.ninja` in its
[HTTP API](https://github.com/steveseguin/social_stream/blob/main/api.md#http-api).
An agent deployment can follow that pattern while keeping its routes,
credentials, quotas, and stored data separate from Social Stream control traffic.

The relay contract should include authenticated publishing and subscription,
recipient routing, bounded storage, expiry, rate limits, replay cursors, and
explicit errors for expired cursors or exhausted quotas. A successful POST
acknowledges the relay's defined storage commitment. A recipient receipt confirms
storage at the receiving sidecar. Neither means the agent has completed work.

Persist a received event before advancing its local cursor. Resume from that
cursor after interruption; detect gaps instead of quietly treating an incomplete
replay as complete. Keep bulk files outside the event stream.

For the new relay mode, protect payloads with application-level end-to-end
encryption using established libraries and an explicit key distribution and
rotation design. TLS to a server alone does not hide content from its operator.
Route metadata, timing, and traffic volume remain visible to that operator.
Membership, expiry, and revocation must apply across every transport; falling
back must not weaken authentication or expose content.

## Reliable collaboration between turns

Give an agent a stable identity and distinguish its individual sessions and
connection instances. Show capabilities, availability, current work, delivery
mode, and last-seen time. Share project labels by default, with detailed local
paths and session context disclosed only when configured.

Keep message delivery separate from task execution:

- Delivery records distinguish local queueing, transport acceptance, durable
  recipient storage, and consumption by an agent integration.
- Task records distinguish submission, acceptance or rejection, active work,
  waiting for input or approval, completion, failure, and cancellation.
- A cancellation request remains a request until the worker confirms its
  outcome. A timeout reports uncertainty; it must not imply work never ran.

Build bounded at-least-once delivery with stable IDs, recipient receipts, and
persistent duplicate suppression that survives inbox reads, archive pruning,
and restarts. Suppression must last at least as long as a message can be retried
or replayed. Preserve distinct messages with identical text. Repeated delivery
should return the existing receipt or result without scheduling the work again.
External side effects still require idempotent handlers or transactional
integration; network delivery cannot promise exactly-once execution.

Tasks should carry a goal, owner, conversation ID, relevant context references,
progress, expected outputs, deadline or expiry, and applicable permissions.
Handoffs should include a short summary and artifact references so an agent can
continue without reading an entire transcript. Exchange selected context;
private reasoning, unrelated sessions, and full memory stores stay local.

Use renewable work reservations to warn about overlapping activity. They are
advisory during network partitions. Work requiring exclusive ownership needs an
authoritative claim mechanism or an existing task system that supplies one.

Keep notifications selective: direct requests and decisions deserve attention;
routine presence and progress updates can be batched. Extend wake limits with
per-thread delegation budgets, deadlines, and a human stop control. Label peer
messages and imported public chat by origin; they do not acquire the authority
of the local user.

## Voice and vision as a core capability

Make joining a call with an agent a normal room action. Start with a browser
participant and one media-capable agent, then let that agent consult other
participants through the existing task and messaging paths.

The media adapter should advertise what it can actually consume: live audio,
sampled images, continuous video, screen sharing, and audio output. It should
support a realtime model or a speech-recognition, language-model, and
speech-synthesis pipeline without requiring one provider throughout the room.

Natural conversation needs turn detection, interruption, echo handling, and
cancellation of queued speech when the user speaks. Report transport delay,
turn detection delay, and model response delay separately. Direct networking
reduces network overhead; it does not remove inference time. These interaction
patterns are described in [LiveKit's turn handling guide](https://docs.livekit.io/agents/logic/turns/tuning/).

Treat video as selected, timestamped context. Use live video where the model
supports it and useful frames where it does not. Bound frame rate, resolution,
and inference cost; discard stale frames. Let users choose a camera, window, or
screen and see which agents receive it. LiveKit documents both
[sampled frames and live video input](https://docs.livekit.io/agents/multimodality/vision/video/).

Microphone, camera, screen sharing, recording, and onward forwarding require
separate visible controls. Receiving media does not authorize forwarding it to
another agent or model provider. Save transcripts or selected observations only
under the room's retention policy. Keep bulk transfers from delaying voice and
task control, and use selective subscriptions as the room grows.

## Build order

1. **Make handoffs explicit.** Extend the confirmed `handoff` workflow with
   conversation references and richer delivery capability reporting. Preserve existing
   wire behavior through capability negotiation. Keep the CLI and skill surface
   small enough to use without learning a new framework.
2. **Unify the cloud and direct workflows.** HTTP-only sidecars and hosted
   mailboxes provide explicit HTTPS routes. Next, bind authorized mailbox and
   room identities, support mixed rooms, and switch eligible traffic back to
   WebRTC while retaining request IDs and receipt meaning. Route selection must
   distinguish unavailable media from an available messaging path.
3. **Build one complete voice and vision workflow.** A person speaks and shares
   a selected view with an agent, interrupts it, and receives a spoken response.
   That agent delegates a task and returns its result in the same conversation.
   Prototype the media adapter early alongside the transport work.
4. **Improve team coordination.** Add session-aware discovery, invitations,
   task ownership, advisory reservations, approval requests, and useful operator
   controls. Connect existing task trackers where appropriate.
5. **Open the boundaries.** Add an A2A adapter and expose selected CLI/library
   operations through an optional Ninja MCP adapter. Preserve ninja-p2p's inbox,
   handoff, and receipt ownership. Extend artifact delivery and optional
   production integrations according to actual room needs.

The transport work should build on the existing message envelopes and local
state. The current send callback is synchronous; ordinary direct actions leave
the outbox after transport acceptance, while confirmed handoffs wait for a storage
receipt. An HTTP request needs an asynchronous
dispatcher and explicit receipt state above the adapters. Preserve exported
send contracts and the VDO.Ninja connection lifecycle while adding that layer.
Media belongs in a focused adapter, with the existing data-only connection
behavior preserved for ordinary peers.

## Optional shared browser work

A planned Chrome worker should be a room participant with a dedicated browser
profile, a local browser MCP server, and an outward Ninja connection. Ninja MCP
exposes its authorized tools; ninja-p2p retains the task, waiting agents,
handoffs, and artifacts. Keep Chrome's debugging endpoint private to the worker.
WebRTC and an authenticated HTTPS fallback remove the need for a VPN, VNC, or
VLC, while still requiring permitted outbound connectivity.

Start with an adapter around [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp),
which supports headless operation and
[page routing for concurrent sessions](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#concurrent-sessions).
Use upstream Chrome MCP through an adapter; keep any necessary fork small and
versioned. An extension-based option
such as [mcp-chrome](https://github.com/hangwin/mcp-chrome) fits an operator's
existing browser; keep that deployment separate from an unattended worker.

Allow multiple observers. Start with one active controller per browser, holding
a time-limited lease across a multi-step interaction. The worker must enforce
ownership and reject expired or stale commands, including queued commands from
before a reconnect. Later, permit separate tab leases while serializing changes
to shared browser state. Page IDs route calls; they do not arbitrate two agents
editing the same page. Provide human takeover and refresh observations after
navigation or control handoff. Room membership alone does not grant control.

Carry live video and captured audio through SDK media tracks. CDP
[screencasting](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast)
supplies image frames; Chrome MCP recording tools return a file, not an interactive
call. Audio needs a capture backend. Chrome's
[tab capture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
requires operator invocation, so unattended headless capture needs a deliberately
configured implementation. Use timestamped snapshots and text when live media
is unavailable.

Offer deployment as an optional worker package with pinned browser/MCP versions
and host-enforced tool and media permissions. Its first complete example should
show two agents taking turns, a human watching, and recovery from a disconnect.
Reconcile uncertain tool results before repeating clicks or submissions. Durable
handoff retries should re-deliver the task; the worker must retain action outcomes
so they do not blindly repeat browser side effects.

## Measures of success

The primary measure is **completed handoffs between people and agents without a
human having to copy messages between tools**. Count task results and useful
collaboration, not message volume or the number of connected bots.

Track time to first successful handoff, recipient receipt latency, oldest
unacknowledged work, recovery time, duplicate execution, and the proportion of
traffic that can stay direct. For calls, track interruption response and time to
first audible answer separately from network latency.

A release that adds fallback must demonstrate a complete handoff with WebRTC
unavailable, a restart during delivery, and a lost acknowledgement during path
switching. Each intended recipient must receive every eligible message once at
the inbox boundary after duplicate suppression; repeated task execution is a
failure. Expired or rejected work must remain distinguishable from completed
work. Media acceptance should include a real browser-to-agent conversation,
explicit interruption, selected visual input, and useful text continuity when
the media path disappears.
