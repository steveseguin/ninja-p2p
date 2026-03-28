import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSidecarCommandResponse,
  composeSidecarAgentProfile,
  createFileTransferEventEnvelope,
  createPeerNoticeEnvelope,
  getAgentStatus,
  maybeHandleSidecarCommand,
  recordPeerNotice,
} from "../src/cli.js";
import { getInboxSummary, storeInboxMessage, writeAgentSession, writePeersSnapshot } from "../src/agent-state.js";
import { createEnvelope, type PeerIdentity } from "../src/protocol.js";
import { VDOBridge } from "../src/vdo-bridge.js";

const me: PeerIdentity = {
  streamId: "codex",
  role: "agent",
  name: "Codex",
  instanceId: "inst_me",
};

const other: PeerIdentity = {
  streamId: "claude",
  role: "agent",
  name: "Claude",
  instanceId: "inst_other",
};

function makeBridge() {
  const bridge = new VDOBridge({
    room: "ai-room",
    streamId: me.streamId,
    identity: {
      streamId: me.streamId,
      role: me.role,
      name: me.name,
    },
    password: false,
    skills: ["cli", "chat", "command", "sidecar", "discovery"],
    topics: ["events"],
    agentProfile: composeSidecarAgentProfile({
      runtime: "codex-cli",
      provider: "openai",
      model: "gpt-5",
      can: ["review", "tests"],
      asks: [{ name: "implement", description: "Implement a scoped change" }],
    }),
  });
  (bridge as unknown as { connected: boolean }).connected = true;
  return bridge;
}

function seedState(stateDir: string): void {
  writeAgentSession(stateDir, {
    room: "ai-room",
    streamId: me.streamId,
    name: me.name,
    role: me.role,
    stateDir,
    pid: process.pid,
    connected: true,
    skills: ["cli", "chat", "command", "sidecar", "discovery"],
    topics: ["events"],
    agentProfile: composeSidecarAgentProfile({
      runtime: "codex-cli",
      provider: "openai",
      model: "gpt-5",
      can: ["review", "tests"],
      asks: [{ name: "implement", description: "Implement a scoped change" }],
    }),
    sharedFolders: [],
    startedAt: Date.now() - 1_000,
    updatedAt: Date.now(),
  });
  writePeersSnapshot(stateDir, [
    { streamId: "claude", connected: true },
    { streamId: "human", connected: false },
  ]);
}

test("composeSidecarAgentProfile appends built-in discovery asks", () => {
  const profile = composeSidecarAgentProfile({
    runtime: "claude-code",
    can: ["review"],
    asks: [{ name: "review", description: "Review a patch" }],
    shares: [{ name: "docs" }],
  });

  assert.equal(profile.runtime, "claude-code");
  assert.deepEqual(profile.can, ["review"]);
  assert.deepEqual(profile.shares, [{ name: "docs" }]);
  assert.ok(profile.asks?.some((ask) => ask.name === "review"));
  assert.ok(profile.asks?.some((ask) => ask.name === "shares"));
  assert.ok(profile.asks?.some((ask) => ask.name === "list-files"));
  assert.ok(profile.asks?.some((ask) => ask.name === "get-file"));
  assert.ok(profile.asks?.some((ask) => ask.name === "capabilities"));
  assert.ok(profile.asks?.some((ask) => ask.name === "status"));
});

test("buildSidecarCommandResponse returns capability details for peers", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    seedState(dir);
    const bridge = makeBridge();
    const response = buildSidecarCommandResponse(bridge, dir, "capabilities");
    assert.equal(response.handled, true);
    assert.deepEqual(response.result, {
      room: "ai-room",
      identity: bridge.identity,
      skills: ["cli", "chat", "command", "sidecar", "discovery"],
      topics: ["events"],
      can: ["review", "tests"],
      shares: [],
      asks: composeSidecarAgentProfile({
        runtime: "codex-cli",
        provider: "openai",
        model: "gpt-5",
        can: ["review", "tests"],
        asks: [{ name: "implement", description: "Implement a scoped change" }],
      }).asks,
      profile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        provider: "openai",
        model: "gpt-5",
        can: ["review", "tests"],
        asks: [{ name: "implement", description: "Implement a scoped change" }],
      }),
      requestExamples: [
        {
          ask: "implement",
          via: "command",
          example: "ninja-p2p command --id <you> codex implement '{\"request\":\"...\"}'",
          command: "implement",
          args: { request: "Please help with implement" },
        },
        {
          ask: "review",
          via: "command",
          example: "ninja-p2p command --id <you> codex review '{\"request\":\"...\"}'",
          command: "review",
          args: { request: "Please help with review" },
        },
        {
          ask: "test",
          via: "command",
          example: "ninja-p2p command --id <you> codex test '{\"request\":\"...\"}'",
          command: "test",
          args: { request: "Please help with test" },
        },
        {
          ask: "help",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> help",
          command: "help",
          args: { request: "Please help with help" },
        },
        {
          ask: "profile",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> profile",
          command: "profile",
          args: { request: "Please help with profile" },
        },
        {
          ask: "whoami",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> whoami",
          command: "whoami",
          args: { request: "Please help with whoami" },
        },
        {
          ask: "capabilities",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> capabilities",
          command: "capabilities",
          args: { request: "Please help with capabilities" },
        },
        {
          ask: "status",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> status",
          command: "status",
          args: { request: "Please help with status" },
        },
        {
          ask: "peers",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> peers",
          command: "peers",
          args: { request: "Please help with peers" },
        },
        {
          ask: "inbox",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> inbox",
          command: "inbox",
          args: { request: "Please help with inbox" },
        },
        {
          ask: "pending",
          via: "command",
          example: "ninja-p2p command --id <you> <peer> pending",
          command: "pending",
          args: { request: "Please help with pending" },
        },
      ],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeHandleSidecarCommand auto-responds to built-in discovery commands", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    seedState(dir);
    const bridge = makeBridge();
    const responses: unknown[] = [];
    (bridge as unknown as {
      commandResponse: (message: unknown, result?: unknown) => unknown;
    }).commandResponse = (_message: unknown, result?: unknown) => {
      responses.push(result);
      return createEnvelope(me, "command_response", result ?? null, { to: other.streamId });
    };

    const handled = maybeHandleSidecarCommand(
      bridge,
      dir,
      createEnvelope(other, "command", { command: "status" }, { to: me.streamId }),
    );

    assert.equal(handled, true);
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0], {
      room: "ai-room",
      identity: bridge.identity,
      connected: true,
      status: "idle",
      statusDetail: "",
      pending: 0,
      queued: 0,
      stale: false,
      peersKnown: 2,
      peersConnected: 1,
      senders: [],
      types: [],
      commands: [],
      events: [],
      peers: [
        {
          streamId: "claude",
          name: "claude",
          role: "unknown",
          connected: true,
          status: "unknown",
          statusDetail: "",
          summary: null,
          can: [],
          asks: [],
          shares: [],
        },
        {
          streamId: "human",
          name: "human",
          role: "unknown",
          connected: false,
          status: "unknown",
          statusDetail: "",
          summary: null,
          can: [],
          asks: [],
          shares: [],
        },
      ],
      profile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        provider: "openai",
        model: "gpt-5",
        can: ["review", "tests"],
        asks: [{ name: "implement", description: "Implement a scoped change" }],
      }),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getAgentStatus includes peers and agent profile", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    seedState(dir);
    const status = getAgentStatus(dir) as Record<string, unknown>;
    assert.equal(status.room, "ai-room");
    assert.equal(status.streamId, "codex");
    assert.equal(status.peersKnown, 2);
    assert.equal(status.peersConnected, 1);
    assert.deepEqual(status.types, []);
    assert.deepEqual(status.commands, []);
    assert.deepEqual(status.events, []);
    assert.deepEqual(status.skills, ["cli", "chat", "command", "sidecar", "discovery"]);
    assert.deepEqual(status.topics, ["events"]);
    assert.deepEqual(status.peers, [
      { streamId: "claude", connected: true },
      { streamId: "human", connected: false },
    ]);
    assert.deepEqual(status.agentProfile, composeSidecarAgentProfile({
      runtime: "codex-cli",
      provider: "openai",
      model: "gpt-5",
      can: ["review", "tests"],
      asks: [{ name: "implement", description: "Implement a scoped change" }],
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordPeerNotice emits discovered once and updated on changes", () => {
  const fingerprints = new Map<string, string>();
  const first = recordPeerNotice(fingerprints, other, "peer_discovered", {
    streamId: other.streamId,
    status: "online",
    profile: { runtime: "claude-code" },
  });
  const second = recordPeerNotice(fingerprints, other, "peer_discovered", {
    streamId: other.streamId,
    status: "online",
    profile: { runtime: "claude-code" },
  });
  const third = recordPeerNotice(fingerprints, other, "peer_discovered", {
    streamId: other.streamId,
    status: "busy",
    profile: { runtime: "claude-code" },
  });

  assert.equal((first?.payload as Record<string, unknown>)?.kind, "peer_discovered");
  assert.equal(second, null);
  assert.equal((third?.payload as Record<string, unknown>)?.kind, "peer_updated");
});

test("createPeerNoticeEnvelope builds synthetic inbox events", () => {
  const notice = createPeerNoticeEnvelope(other, "peer_left", {
    streamId: other.streamId,
    status: "offline",
  });
  assert.equal(notice.type, "event");
  assert.deepEqual(notice.payload, {
    kind: "peer_left",
    streamId: other.streamId,
    status: "offline",
  });
});

test("createFileTransferEventEnvelope preserves event kind and transfer kind separately", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    const event = createFileTransferEventEnvelope(other, "file_received", {
      transferId: "transfer_123",
      name: "review.png",
      mimeType: "image/png",
      transferKind: "image",
      size: 68,
    });

    assert.equal(event.type, "event");
    assert.deepEqual(event.payload, {
      transferId: "transfer_123",
      name: "review.png",
      mimeType: "image/png",
      transferKind: "image",
      size: 68,
      kind: "file_received",
    });

    storeInboxMessage(dir, event);
    const summary = getInboxSummary(dir);
    assert.deepEqual(summary.events, [{ kind: "file_received", count: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildSidecarCommandResponse lists shared folders and files", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    const docsDir = path.join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(docsDir, "guide.md"), "# guide\n", "utf8");

    writeAgentSession(dir, {
      room: "ai-room",
      streamId: me.streamId,
      name: me.name,
      role: me.role,
      stateDir: dir,
      pid: process.pid,
      connected: true,
      skills: ["cli", "chat", "command", "sidecar", "discovery"],
      topics: ["events"],
      agentProfile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        shares: [{ name: "docs" }],
      }),
      sharedFolders: [{ name: "docs", path: docsDir }],
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    });
    writePeersSnapshot(dir, []);

    const bridge = new VDOBridge({
      room: "ai-room",
      streamId: me.streamId,
      identity: {
        streamId: me.streamId,
        role: me.role,
        name: me.name,
      },
      password: false,
      skills: ["cli", "chat", "command", "sidecar", "discovery"],
      topics: ["events"],
      agentProfile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        shares: [{ name: "docs" }],
      }),
    });
    (bridge as unknown as { connected: boolean }).connected = true;

    const shares = buildSidecarCommandResponse(bridge, dir, "shares", undefined, [{ name: "docs", path: docsDir }], other.streamId);
    assert.equal(shares.handled, true);
    assert.deepEqual(shares.result, {
      room: "ai-room",
      identity: bridge.identity,
      shares: [{ name: "docs" }],
    });

    const listing = buildSidecarCommandResponse(bridge, dir, "list-files", { share: "docs" }, [{ name: "docs", path: docsDir }], other.streamId);
    assert.equal(listing.handled, true);
    assert.deepEqual(listing.result, {
      share: "docs",
      path: "",
      entries: [
        { name: "guide.md", path: "guide.md", type: "file", size: 8 },
      ],
      truncated: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeHandleSidecarCommand get-file sends a file transfer and command response", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-cli-"));
  try {
    const docsDir = path.join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(docsDir, "guide.md"), "# guide\n", "utf8");

    writeAgentSession(dir, {
      room: "ai-room",
      streamId: me.streamId,
      name: me.name,
      role: me.role,
      stateDir: dir,
      pid: process.pid,
      connected: true,
      skills: ["cli", "chat", "command", "sidecar", "discovery"],
      topics: ["events"],
      agentProfile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        shares: [{ name: "docs" }],
      }),
      sharedFolders: [{ name: "docs", path: docsDir }],
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    });
    writePeersSnapshot(dir, []);

    const bridge = new VDOBridge({
      room: "ai-room",
      streamId: me.streamId,
      identity: {
        streamId: me.streamId,
        role: me.role,
        name: me.name,
      },
      password: false,
      skills: ["cli", "chat", "command", "sidecar", "discovery"],
      topics: ["events"],
      agentProfile: composeSidecarAgentProfile({
        runtime: "codex-cli",
        shares: [{ name: "docs" }],
      }),
    });
    (bridge as unknown as { connected: boolean }).connected = true;
    bridge.peers.addPeer(other.streamId, "uuid_other");

    const sent: Array<{ data: Record<string, unknown>; target?: unknown }> = [];
    bridge.bus.setSendDataFn((data, target) => {
      sent.push({ data: data as Record<string, unknown>, target });
    });

    const handled = maybeHandleSidecarCommand(
      bridge,
      dir,
      createEnvelope(other, "command", { command: "get-file", args: { share: "docs", path: "guide.md" } }, { to: me.streamId }),
    );

    assert.equal(handled, true);
    assert.deepEqual(sent.map((item) => item.data.type), [
      "file_offer",
      "file_chunk",
      "file_complete",
      "command_response",
    ]);
    const response = sent[3].data.payload as Record<string, unknown>;
    assert.equal(response.ok, true);
    assert.equal((response.result as Record<string, unknown>).name, "guide.md");
    assert.equal((response.result as Record<string, unknown>).transferKind, "file");
    assert.equal(typeof (response.result as Record<string, unknown>).transferId, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
