#!/usr/bin/env node

import { closeSync, cpSync, existsSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  appendIncomingTransferChunk,
  beginIncomingTransfer,
  completeIncomingTransfer,
  createFailedFileAckPayload,
  createFileAckPayload,
  discardIncomingTransfer,
  sendFileFromPath,
  type CompletedTransferResult,
} from "./file-transfer.js";
import { VDOBridge } from "./vdo-bridge.js";
import {
  createEnvelope,
  envelopeToWire,
  type AgentAsk,
  type AgentProfile,
  type AnnouncePayload,
  type FileAckPayload,
  type FileChunkPayload,
  type FileCompletePayload,
  type FileOfferPayload,
  type MessageEnvelope,
  type PeerIdentity,
  type SkillUpdatePayload,
} from "./protocol.js";
import {
  ensureAgentState,
  getInboxSummary,
  isInboxWorthy,
  listQueuedAgentActions,
  queueAgentAction,
  readAgentSession,
  readPeersSnapshot,
  removeQueuedAgentAction,
  storeInboxMessage,
  takeInboxMessages,
  writeAgentSession,
  writePeersSnapshot,
} from "./agent-state.js";
import {
  getDefaultStateDir,
  getSkillInstallTarget,
  getSkillInstallTargets,
  helpText,
  parseCliArgs,
  parseJsonMaybe,
  type CliCommonOptions,
  type SkillRuntime,
} from "./cli-lib.js";
import {
  listSharedFolderEntries,
  resolveSharedFile,
  toSharedFolderSummaries,
  type SharedFolderConfig,
} from "./shared-folders.js";
import {
  DEFAULT_WAKE_DEBOUNCE_MS,
  DEFAULT_WAKE_LIMIT_PER_MINUTE,
  WakeRunner,
} from "./wake.js";
import { formatDemoResult, runDemo } from "./demo.js";
import { describeSocialMessage, SocialStreamBridge } from "./social-stream.js";
import { SwarmManager, type SwarmCompletion } from "./swarm-manager.js";
import {
  checkNodeVersion,
  checkSidecars,
  checkSignaling,
  checkStateRoot,
  checkWebRtc,
  formatReport,
  summarizeChecks,
  type DiagnosticCheck,
} from "./doctor.js";

const SIDECAR_SKILLS = ["cli", "chat", "command", "sidecar", "discovery"];

export const SIDECAR_DISCOVERY_ASKS: AgentAsk[] = [
  { name: "help", description: "Summarize this agent sidecar and its built-in commands.", via: "command", example: "ninja-p2p command --id <you> <peer> help" },
  { name: "profile", description: "Return identity and the advertised agent profile.", via: "command", example: "ninja-p2p command --id <you> <peer> profile" },
  { name: "whoami", description: "Alias for profile.", via: "command", example: "ninja-p2p command --id <you> <peer> whoami" },
  { name: "capabilities", description: "Return skills, capabilities, and asks.", via: "command", example: "ninja-p2p command --id <you> <peer> capabilities" },
  { name: "status", description: "Return connection state, inbox counts, and peer counts.", via: "command", example: "ninja-p2p command --id <you> <peer> status" },
  { name: "peers", description: "Return the last known peers in the room.", via: "command", example: "ninja-p2p command --id <you> <peer> peers" },
  { name: "inbox", description: "Return pending inbox summary without consuming messages.", via: "command", example: "ninja-p2p command --id <you> <peer> inbox" },
  { name: "pending", description: "Alias for inbox.", via: "command", example: "ninja-p2p command --id <you> <peer> pending" },
];

export const SIDECAR_SHARE_ASKS: AgentAsk[] = [
  { name: "shares", description: "List the shared folders this agent exposes.", via: "command", example: "ninja-p2p command --id <you> <peer> shares" },
  { name: "list-files", description: "List the files and directories in a shared folder.", via: "command", example: "ninja-p2p command --id <you> <peer> list-files '{\"share\":\"docs\"}'" },
  { name: "get-file", description: "Request one file from a shared folder.", via: "command", example: "ninja-p2p command --id <you> <peer> get-file '{\"share\":\"docs\",\"path\":\"guide.md\"}'" },
];

const DERIVED_CAPABILITY_ASKS: Record<string, AgentAsk[]> = {
  plan: [{ name: "plan", description: "Ask for a plan, breakdown, or next-step proposal.", via: "command" }],
  approve: [{ name: "approve", description: "Ask for approval or a go/no-go decision before proceeding.", via: "command" }],
  review: [{ name: "review", description: "Ask for a review, critique, or second opinion.", via: "command" }],
  tests: [{ name: "test", description: "Ask for test ideas, coverage gaps, or validation steps.", via: "command" }],
  edit: [{ name: "implement", description: "Ask for a scoped implementation or code edit.", via: "command" }],
  code: [{ name: "implement", description: "Ask for a scoped implementation or code edit.", via: "command" }],
  debug: [{ name: "debug", description: "Ask for debugging help or root-cause analysis.", via: "command" }],
  docs: [{ name: "docs", description: "Ask for documentation or rewrite help.", via: "command" }],
  research: [{ name: "research", description: "Ask for investigation or background research.", via: "command" }],
};

async function main(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);

  switch (parsed.kind) {
    case "help":
      console.log(helpText());
      return;
    case "menu":
      console.log(buildMenuText(parsed.options));
      return;
    case "install-skill":
      installSkill(parsed.runtime);
      return;
    case "start":
      startAgent(parsed.options);
      return;
    case "stop":
      stopAgent(parsed.stateDir);
      return;
    case "status":
      console.log(JSON.stringify(getAgentStatus(parsed.stateDir), null, 2));
      return;
    case "room":
      console.log(buildRoomText(parsed.stateDir));
      return;
    case "agent":
      await runAgent(parsed.options);
      return;
    case "notify":
      console.log(JSON.stringify(getInboxSummary(parsed.stateDir), null, 2));
      return;
    case "read":
      console.log(JSON.stringify({
        stateDir: parsed.stateDir,
        messages: takeInboxMessages(parsed.stateDir, parsed.take, parsed.peek).map((item) => item.envelope),
      }, null, 2));
      return;
    case "wait":
      await waitForInbox(parsed.stateDir, parsed.timeoutMs, parsed.intervalMs);
      return;
    case "doctor":
      await runDoctor(parsed.stateRoot);
      return;
    case "demo":
      await runDemoCommand(parsed.room, parsed.password, parsed.timeoutMs, parsed.keep);
      return;
    case "seed":
      await runSeed(parsed.options, parsed.filePath, parsed.chunkSize);
      return;
    case "fetch":
      await runFetch(parsed.options, parsed.query, parsed.outDir, parsed.keepSeeding, parsed.timeoutMs);
      return;
    case "ssn":
      await runSocialStreamBridge(parsed);
      return;
    case "connect":
      await runConnect(parsed.options);
      return;
    case "chat":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, { kind: "chat", text: parsed.text });
        console.log(`queued chat ${queued.id} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        bridge.chat(parsed.text);
        console.log(`sent chat to room ${parsed.options.room}`);
      });
      return;
    case "dm":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "dm",
          target: parsed.target,
          text: parsed.text,
        });
        console.log(`queued direct message ${queued.id} to ${parsed.target} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        const envelope = createEnvelope(bridge.identity, "chat", { text: parsed.text }, { to: parsed.target });
        bridge.sendRaw(envelopeToWire(envelope), parsed.target);
        console.log(`sent direct chat to ${parsed.target}`);
      });
      return;
    case "send-file":
    case "send-image": {
      const filePath = path.resolve(parsed.filePath);
      const transferKind = parsed.kind === "send-image" ? "image" : "file";
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "send_file",
          target: parsed.target,
          filePath,
          transferKind,
        });
        console.log(`queued ${transferKind} transfer ${queued.id} to ${parsed.target} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        const offer = sendFileFromPath(bridge, parsed.target, filePath, transferKind);
        console.log(`sent ${transferKind} ${offer.name} to ${parsed.target}`);
      });
      return;
    }
    case "shares":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "command",
          target: parsed.target,
          command: "shares",
        });
        console.log(`queued shares request ${queued.id} to ${parsed.target} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        bridge.command(parsed.target, "shares");
        console.log(`requested shares from ${parsed.target}`);
      });
      return;
    case "list-files":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "command",
          target: parsed.target,
          command: "list-files",
          args: {
            share: parsed.share,
            path: parsed.folderPath || "",
          },
        });
        console.log(`queued list-files request ${queued.id} to ${parsed.target} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        bridge.command(parsed.target, "list-files", {
          share: parsed.share,
          path: parsed.folderPath || "",
        });
        console.log(`requested ${parsed.share}${parsed.folderPath ? `/${parsed.folderPath}` : ""} from ${parsed.target}`);
      });
      return;
    case "get-file":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "command",
          target: parsed.target,
          command: "get-file",
          args: {
            share: parsed.share,
            path: parsed.filePath,
          },
        });
        console.log(`queued get-file request ${queued.id} to ${parsed.target} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        bridge.command(parsed.target, "get-file", {
          share: parsed.share,
          path: parsed.filePath,
        });
        console.log(`requested file ${parsed.share}/${parsed.filePath} from ${parsed.target}`);
      });
      return;
    case "command":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "command",
          target: parsed.target,
          command: parsed.command,
          args: parsed.args,
        });
        console.log(`queued command ${queued.id} to ${parsed.target} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        const envelope = createEnvelope(bridge.identity, "command", {
          command: parsed.command,
          args: parsed.args,
        }, { to: parsed.target });
        bridge.sendRaw(envelopeToWire(envelope), parsed.target);
        console.log(`sent command ${parsed.command} to ${parsed.target}`);
      });
      return;
    case "respond":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "response",
          target: parsed.target,
          requestId: parsed.requestId,
          result: parsed.result,
          error: parsed.error,
        });
        console.log(`queued response ${queued.id} to ${parsed.target} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        sendCommandResponse(bridge, parsed.target, parsed.requestId, parsed.result, parsed.error);
        console.log(`sent response to ${parsed.target} for ${parsed.requestId}`);
      });
      return;
    case "event":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "event",
          topic: parsed.topic,
          eventKind: parsed.eventKind,
          data: parsed.data,
        });
        console.log(`queued event ${queued.id} ${parsed.topic}/${parsed.eventKind} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        bridge.publishEvent(parsed.topic, parsed.eventKind, parsed.data);
        console.log(`published event ${parsed.topic}/${parsed.eventKind}`);
      });
      return;
    case "task":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "command",
          target: parsed.target,
          command: "task",
          args: { request: parsed.request },
        });
        console.log(`queued task ${queued.id} to ${parsed.target} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        bridge.command(parsed.target, "task", { request: parsed.request });
        console.log(`sent task request to ${parsed.target}`);
      });
      return;
    case "review":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "command",
          target: parsed.target,
          command: "review",
          args: { request: parsed.request },
        });
        console.log(`queued review ${queued.id} to ${parsed.target} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        bridge.command(parsed.target, "review", { request: parsed.request });
        console.log(`sent review request to ${parsed.target}`);
      });
      return;
    case "plan":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "command",
          target: parsed.target,
          command: "plan",
          args: { request: parsed.request },
        });
        console.log(`queued plan ${queued.id} to ${parsed.target} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        bridge.command(parsed.target, "plan", { request: parsed.request });
        console.log(`sent plan request to ${parsed.target}`);
      });
      return;
    case "approve":
      if (parsed.options.stateDir) {
        const queued = queueAgentAction(parsed.options.stateDir, {
          kind: "command",
          target: parsed.target,
          command: "approve",
          args: { request: parsed.request },
        });
        console.log(`queued approval request ${queued.id} to ${parsed.target} in ${parsed.options.stateDir}`);
        return;
      }
      await runOneShot(parsed.options, (bridge) => {
        bridge.command(parsed.target, "approve", { request: parsed.request });
        console.log(`sent approval request to ${parsed.target}`);
      });
      return;
  }
}

export function buildMenuText(options: CliCommonOptions): string {
  const prefix = getCommandPrefix(options);
  const stateDir = options.stateDir ?? getDefaultStateDir(options.streamId);
  const status = existsSync(path.join(stateDir, "session.json")) ? getAgentStatus(stateDir) : null;
  const room = typeof status?.room === "string" && status.room ? status.room : options.room;
  const running = Boolean(status?.running);

  const lines = [
    "ninja-p2p",
    "",
    `id: ${options.streamId}`,
    `room: ${room || "(generated on start)"}`,
    running ? "status: running" : "status: not started",
    "",
  ];

  if (!running) {
    lines.push("Start from Claude or Codex:");
    lines.push(`  ${prefix} start`);
    lines.push(`  ${prefix} start --room my-room`);
    lines.push("");
    lines.push("If you do not pass --room, ninja-p2p generates one for you.");
  } else {
    lines.push("Useful commands:");
    lines.push(`  ${prefix} room`);
    lines.push(`  ${prefix} status`);
    lines.push(`  ${prefix} notify`);
    lines.push(`  ${prefix} read`);
    lines.push(`  ${prefix} dm <peer> "hello"`);
    lines.push(`  ${prefix} shares <peer>`);
    lines.push(`  ${prefix} stop`);
    lines.push("");
    lines.push(`Another agent joins with: --room ${room}`);
  }

  return lines.join("\n");
}

export function buildRoomText(stateDir: string): string {
  const status = getAgentStatus(stateDir);
  const room = typeof status.room === "string" ? status.room : "";
  const streamId = typeof status.streamId === "string" ? status.streamId : "";

  if (!room) {
    return [
      "room: not set",
      "start the sidecar first, or start it with --room my-room",
    ].join("\n");
  }

  return [
    `room: ${room}`,
    `id: ${streamId || "unknown"}`,
    "",
    "Join this room from another agent:",
    `  Claude: /ninja-p2p start --room ${room}`,
    `  Codex: ninja-p2p start --room ${room} --id codex`,
    `  Generic CLI: ninja-p2p start --room ${room} --id worker`,
  ].join("\n");
}

function installSkill(runtime: SkillRuntime): void {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceCandidates = runtime === "codex"
    ? [
      path.join(packageRoot, ".codex", "skills", "ninja-p2p"),
      path.join(packageRoot, ".agents", "skills", "ninja-p2p"),
    ]
    : [path.join(packageRoot, ".claude", "skills", "ninja-p2p")];
  const source = sourceCandidates.find((candidate) => existsSync(candidate));
  const targets = getSkillInstallTargets(runtime);
  const primaryTarget = getSkillInstallTarget(runtime);

  if (!source) {
    throw new Error(`bundled ${runtime} skill not found`);
  }

  for (const target of targets) {
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, force: true });
  }

  console.log(`installed ${runtime} skill at ${primaryTarget}`);
  if (runtime === "codex" && targets.length > 1) {
    console.log(`installed Codex compatibility copy at ${targets[1]}`);
  }
  console.log(`restart ${runtime === "codex" ? "Codex" : "Claude Code"} if it does not appear immediately`);
}

function createBridge(options: CliCommonOptions, mode: "sidecar" | "interactive" | "oneshot" = "oneshot"): VDOBridge {
  const agentProfile = mode === "sidecar"
    ? composeSidecarAgentProfile(options.agentProfile)
    : options.agentProfile;
  return new VDOBridge({
    room: options.room,
    streamId: options.streamId,
    identity: {
      streamId: options.streamId,
      role: options.role,
      name: options.name,
    },
    password: options.password,
    skills: mode === "sidecar" ? SIDECAR_SKILLS : ["cli", "chat", "command"],
    topics: ["events"],
    agentProfile,
  });
}

function startAgent(options: CliCommonOptions): void {
  if (!options.stateDir) {
    throw new Error("missing state dir; use --state-dir or --id");
  }

  const current = getAgentStatus(options.stateDir);
  if (current.running) {
    console.log(`agent already running: pid=${current.pid} state=${options.stateDir}`);
    return;
  }

  const paths = ensureAgentState(options.stateDir);
  const logFile = path.join(paths.stateDir, "agent.log");
  const stdout = openSync(logFile, "a");
  const stderr = openSync(logFile, "a");
  const child = spawn(process.execPath, [resolveCliEntryPath(), "agent", ...buildAgentArgs(options)], {
    detached: true,
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
  });
  closeSync(stdout);
  closeSync(stderr);
  child.unref();

  console.log(`started agent pid=${child.pid} state=${options.stateDir}`);
  console.log(`room: ${options.room}`);
  console.log(`id: ${options.streamId}`);
  console.log(`log: ${logFile}`);
  console.log(`join from Claude: /ninja-p2p start --room ${options.room}`);
  console.log(`join from Codex: ninja-p2p start --room ${options.room} --id codex`);
  const prefix = getCommandPrefix(options);
  if (prefix === "/ninja-p2p") {
    console.log(`next: ${prefix} room`);
    console.log(`next: ${prefix} notify`);
    console.log(`next: ${prefix} read --take 10`);
  } else {
    console.log(`next: ${prefix} room --id ${options.streamId}`);
    console.log(`next: ${prefix} notify --id ${options.streamId}`);
    console.log(`next: ${prefix} read --id ${options.streamId} --take 10`);
  }
}

function stopAgent(stateDir: string): void {
  const session = readAgentSession(stateDir);
  if (!session?.pid) {
    console.log(`agent not running: ${stateDir}`);
    return;
  }

  if (isPidRunning(session.pid)) {
    process.kill(session.pid);
    writeAgentSession(stateDir, {
      ...session,
      connected: false,
      updatedAt: Date.now(),
    });
    console.log(`stopped agent pid=${session.pid} state=${stateDir}`);
    return;
  }

  writeAgentSession(stateDir, {
    ...session,
    connected: false,
    updatedAt: Date.now(),
  });
  console.log(`agent already stopped: ${stateDir}`);
}

export function getAgentStatus(stateDir: string): Record<string, unknown> {
  const session = readAgentSession(stateDir);
  const inbox = getInboxSummary(stateDir);
  const peers = readPeersSnapshot(stateDir);
  const pid = session?.pid ?? null;
  const running = pid !== null && isPidRunning(pid);
  return {
    stateDir,
    pid,
    running,
    room: session?.room ?? inbox.room,
    streamId: session?.streamId ?? inbox.streamId,
    connected: running && inbox.connected,
    stale: inbox.stale,
    pending: inbox.pending,
    queued: inbox.queued,
    peersKnown: inbox.peersKnown,
    peersConnected: inbox.peersConnected,
    senders: inbox.senders,
    types: inbox.types,
    commands: inbox.commands,
    events: inbox.events,
    skills: session?.skills ?? [],
    topics: session?.topics ?? [],
    agentProfile: session?.agentProfile ?? null,
    sharedFolders: session?.sharedFolders ?? [],
    peers,
    logFile: path.join(stateDir, "agent.log"),
  };
}

async function runAgent(options: CliCommonOptions): Promise<void> {
  if (!options.stateDir) {
    throw new Error("missing state dir; use --state-dir or --id");
  }

  const bridge = createBridge(options, "sidecar");
  const advertisedProfile = composeSidecarAgentProfile(options.agentProfile);
  const peerFingerprints = new Map<string, string>();
  let shuttingDown = false;

  // Wake hooks fire on real peer traffic only. Peer join/leave notices are
  // generated locally and would otherwise wake the agent every reconnect.
  const wake = options.wake
    ? new WakeRunner({
      config: options.wake,
      context: {
        streamId: options.streamId,
        room: options.room,
        stateDir: options.stateDir,
      },
      log: (message) => console.log(message),
    })
    : null;

  const syncSession = (connected = bridge.isConnected()): void => {
    writeAgentSession(options.stateDir!, {
      room: options.room,
      streamId: options.streamId,
      name: options.name,
      role: options.role,
      stateDir: options.stateDir!,
      pid: process.pid,
      connected,
      skills: SIDECAR_SKILLS,
      topics: ["events"],
      agentProfile: advertisedProfile,
      sharedFolders: options.sharedFolders,
      startedAt: readAgentSession(options.stateDir!)?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    writePeersSnapshot(options.stateDir!, bridge.peers.toJSON());
  };

  const flushOutbox = (): void => {
    for (const item of listQueuedAgentActions(options.stateDir!)) {
      try {
        switch (item.action.kind) {
          case "chat":
            bridge.chat(item.action.text);
            break;
          case "dm":
            bridge.chat(item.action.text, item.action.target);
            break;
          case "send_file":
            sendFileFromPath(bridge, item.action.target, item.action.filePath, item.action.transferKind);
            break;
          case "command":
            bridge.command(item.action.target, item.action.command, item.action.args);
            break;
          case "response":
            sendCommandResponse(bridge, item.action.target, item.action.requestId, item.action.result, item.action.error);
            break;
          case "event":
            bridge.publishEvent(item.action.topic, item.action.eventKind, item.action.data);
            break;
          case "status":
            bridge.updateStatus(item.action.status, item.action.detail);
            break;
        }
      } catch (error) {
        if (item.action.kind === "send_file" && error instanceof Error && /peer is not connected/i.test(error.message)) {
          continue;
        }
        storeInboxMessage(options.stateDir!, createFileTransferEventEnvelope(bridge.identity, "file_send_failed", {
          target: "target" in item.action ? item.action.target : null,
          filePath: "filePath" in item.action ? item.action.filePath : null,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      removeQueuedAgentAction(item.path);
    }
  };

  writeAgentSession(options.stateDir, {
    room: options.room,
    streamId: options.streamId,
    name: options.name,
    role: options.role,
    stateDir: options.stateDir,
    pid: process.pid,
    connected: false,
    skills: SIDECAR_SKILLS,
    topics: ["events"],
    agentProfile: advertisedProfile,
    sharedFolders: options.sharedFolders,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });

  await bridge.connect();
  syncSession(true);
  console.log(`agent ready: ${options.streamId} -> ${options.stateDir}`);
  if (options.wake) {
    console.log(`wake on message: ${options.wake.command}`);
    console.log(`wake debounce=${options.wake.debounceMs}ms limit=${options.wake.limitPerMinute || "unlimited"}/min`);
  }

  bridge.on("peer:connected", () => {
    syncSession(true);
  });
  bridge.on("peer:announce", ({ streamId, identity, announce }) => {
    const notice = recordPeerNotice(peerFingerprints, identity, "peer_discovered", {
      streamId,
      skills: announce.skills,
      status: announce.status,
      statusDetail: announce.statusDetail,
      topics: announce.topics,
      version: announce.version,
      profile: announce.agent ?? null,
      requestExamples: buildRequestExamples(streamId, announce.agent?.asks ?? SIDECAR_DISCOVERY_ASKS),
    });
    if (notice) {
      storeInboxMessage(options.stateDir!, notice);
      console.log(`[peer] discovered ${streamId}`);
    }
    syncSession(true);
  });
  bridge.on("peer:disconnected", () => {
    syncSession(true);
  });
  bridge.on("peer:disconnected", ({ streamId }) => {
    const peer = bridge.peers.getPeer(streamId);
    const identity = peer?.identity ?? {
      streamId,
      role: "agent",
      name: streamId,
      instanceId: "unknown",
    };
    if (peerFingerprints.delete(streamId)) {
      storeInboxMessage(options.stateDir!, createPeerNoticeEnvelope(identity, "peer_left", {
        streamId,
        status: "offline",
        profile: peer?.agentProfile ?? null,
      }));
      console.log(`[peer] left ${streamId}`);
    }
    syncSession(true);
  });

  bridge.bus.on("message:skill_update", (envelope: MessageEnvelope) => {
    const payload = envelope.payload as SkillUpdatePayload;
    const notice = recordPeerNotice(peerFingerprints, envelope.from, "peer_updated", {
      streamId: envelope.from.streamId,
      skills: payload.skills ?? [],
      status: payload.status ?? "online",
      statusDetail: payload.statusDetail ?? "",
      profile: payload.agent ?? null,
      requestExamples: buildRequestExamples(envelope.from.streamId, payload.agent?.asks ?? SIDECAR_DISCOVERY_ASKS),
    });
    if (notice) {
      storeInboxMessage(options.stateDir!, notice);
      console.log(`[peer] updated ${envelope.from.streamId}`);
    }
    syncSession(true);
  });

  bridge.bus.on("message", (envelope: MessageEnvelope) => {
    const transferHandled = maybeHandleSidecarFileTransfer(bridge, options.stateDir!, envelope);
    const autoHandled = transferHandled || maybeHandleSidecarCommand(bridge, options.stateDir!, envelope);
    if (!autoHandled && isInboxWorthy(envelope.type)) {
      storeInboxMessage(options.stateDir!, envelope);
      wake?.notify(envelope);
      console.log(`[inbox] ${envelope.type} from ${envelope.from.streamId}`);
    } else if (transferHandled) {
      console.log(`[transfer] ${envelope.type} from ${envelope.from.streamId}`);
    } else if (autoHandled) {
      console.log(`[auto] ${envelope.type} from ${envelope.from.streamId}`);
    }
    syncSession(true);
  });

  const heartbeatTimer = setInterval(() => {
    flushOutbox();
    syncSession(true);
  }, 500);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    wake?.dispose();
    syncSession(false);
    await bridge.disconnect();
    syncSession(false);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await new Promise<void>((resolve) => {
    bridge.once("disconnected", () => resolve());
  });
}

async function runOneShot(options: CliCommonOptions, send: (bridge: VDOBridge) => void): Promise<void> {
  const bridge = createBridge(options, "oneshot");
  await bridge.connect();
  await delay(options.waitMs);
  send(bridge);
  await delay(500);
  await bridge.disconnect();
}

async function runConnect(options: CliCommonOptions): Promise<void> {
  const bridge = createBridge(options, "interactive");
  await bridge.connect();

  console.log(`connected: room=${options.room} id=${options.streamId}`);
  console.log("type text to chat, or /help for commands");

  bridge.on("peer:connected", ({ streamId }) => {
    console.log(`[peer] connected ${streamId}`);
  });
  bridge.on("peer:disconnected", ({ streamId }) => {
    console.log(`[peer] disconnected ${streamId}`);
  });

  bridge.bus.on("message:chat", (envelope: MessageEnvelope) => {
    const text = payloadText(envelope);
    console.log(`[chat] ${envelope.from.name}: ${text}`);
  });
  bridge.bus.on("message:command", (envelope: MessageEnvelope) => {
    console.log(`[command] ${envelope.from.name}: ${JSON.stringify(envelope.payload)}`);
  });
  bridge.bus.on("message:command_response", (envelope: MessageEnvelope) => {
    console.log(`[response] ${envelope.from.name}: ${JSON.stringify(envelope.payload)}`);
  });
  bridge.bus.on("message:event", (envelope: MessageEnvelope) => {
    console.log(`[event] ${envelope.from.name}: ${JSON.stringify(envelope.payload)}`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    await bridge.disconnect();
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  rl.on("line", (line) => {
    void handleInteractiveLine(bridge, line, shutdown);
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve());
  });
}

async function handleInteractiveLine(bridge: VDOBridge, line: string, shutdown: () => Promise<void>): Promise<void> {
  const input = line.trim();
  if (!input) return;

  if (!input.startsWith("/")) {
    bridge.chat(input);
    return;
  }

  const [command, ...rest] = input.slice(1).split(" ");
  switch (command) {
    case "help":
      console.log(helpText());
      return;
    case "quit":
    case "exit":
      await shutdown();
      return;
    case "peers":
      console.log(JSON.stringify(bridge.peers.toJSON(), null, 2));
      return;
    case "status":
      bridge.updateStatus(rest[0] || "online", rest.slice(1).join(" "));
      console.log("status updated");
      return;
    case "dm":
      if (rest.length < 2) {
        console.log("usage: /dm <peer> <message>");
        return;
      }
      bridge.chat(rest.slice(1).join(" "), rest[0]);
      return;
    case "shares":
      if (rest.length < 1) {
        console.log("usage: /shares <peer>");
        return;
      }
      bridge.command(rest[0], "shares");
      return;
    case "ls":
      if (rest.length < 2) {
        console.log("usage: /ls <peer> <share> [path]");
        return;
      }
      bridge.command(rest[0], "list-files", {
        share: rest[1],
        path: rest.slice(2).join(" "),
      });
      return;
    case "get":
      if (rest.length < 3) {
        console.log("usage: /get <peer> <share> <path>");
        return;
      }
      bridge.command(rest[0], "get-file", {
        share: rest[1],
        path: rest.slice(2).join(" "),
      });
      return;
    case "file":
    case "image":
      if (rest.length < 2) {
        console.log(`usage: /${command} <peer> <path>`);
        return;
      }
      sendFileFromPath(bridge, rest[0], path.resolve(rest.slice(1).join(" ")), command === "image" ? "image" : "file");
      return;
    case "cmd":
      if (rest.length < 2) {
        console.log("usage: /cmd <peer> <command> [json]");
        return;
      }
      bridge.command(rest[0], rest[1], rest[2] ? parseJsonMaybe(rest.slice(2).join(" ")) : undefined);
      return;
    case "respond":
      if (rest.length < 2) {
        console.log("usage: /respond <peer> <requestId> [json]");
        return;
      }
      sendCommandResponse(bridge, rest[0], rest[1], rest[2] ? parseJsonMaybe(rest.slice(2).join(" ")) : undefined);
      return;
    case "plan":
      if (rest.length < 2) {
        console.log("usage: /plan <peer> <request>");
        return;
      }
      bridge.command(rest[0], "plan", { request: rest.slice(1).join(" ") });
      return;
    case "task":
      if (rest.length < 2) {
        console.log("usage: /task <peer> <request>");
        return;
      }
      bridge.command(rest[0], "task", { request: rest.slice(1).join(" ") });
      return;
    case "review":
      if (rest.length < 2) {
        console.log("usage: /review <peer> <request>");
        return;
      }
      bridge.command(rest[0], "review", { request: rest.slice(1).join(" ") });
      return;
    case "approve":
      if (rest.length < 2) {
        console.log("usage: /approve <peer> <request>");
        return;
      }
      bridge.command(rest[0], "approve", { request: rest.slice(1).join(" ") });
      return;
    case "event":
      if (rest.length < 2) {
        console.log("usage: /event <topic> <kind> [json]");
        return;
      }
      bridge.publishEvent(rest[0], rest[1], rest[2] ? parseJsonMaybe(rest.slice(2).join(" ")) : undefined);
      return;
    default:
      console.log("unknown command; try /help");
  }
}

function payloadText(envelope: MessageEnvelope): string {
  if (typeof envelope.payload === "string") return envelope.payload;
  if (typeof envelope.payload === "object" && envelope.payload !== null) {
    const payload = envelope.payload as Record<string, unknown>;
    if (typeof payload.text === "string") return payload.text;
    if (typeof payload.message === "string") return payload.message;
  }
  return JSON.stringify(envelope.payload);
}

function getCommandArgString(args: unknown, key: string): string | null {
  if (typeof args !== "object" || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sendCommandResponse(
  bridge: VDOBridge,
  targetStreamId: string,
  requestId: string,
  result?: unknown,
  error?: string,
): MessageEnvelope {
  if (error) {
    return bridge.bus.send(targetStreamId, "command_response", {
      requestId,
      ok: false,
      error,
    });
  }
  return bridge.bus.send(targetStreamId, "command_response", {
    requestId,
    ok: true,
    result: result ?? null,
  });
}

function maybeHandleSidecarFileTransfer(bridge: VDOBridge, stateDir: string, envelope: MessageEnvelope): boolean {
  switch (envelope.type) {
    case "file_offer":
      return handleIncomingFileOffer(bridge, stateDir, envelope);
    case "file_chunk":
      return handleIncomingFileChunk(bridge, stateDir, envelope);
    case "file_complete":
      return handleIncomingFileComplete(bridge, stateDir, envelope);
    case "file_ack":
      return handleIncomingFileAck(stateDir, envelope);
    default:
      return false;
  }
}

function handleIncomingFileOffer(bridge: VDOBridge, stateDir: string, envelope: MessageEnvelope): boolean {
  const payload = envelope.payload as FileOfferPayload;
  const transferId = transferIdForError(envelope.payload);
  try {
    beginIncomingTransfer(stateDir, envelope.from, payload);
    storeInboxMessage(stateDir, createFileTransferEventEnvelope(envelope.from, "file_offered", {
      transferId: payload.transferId,
      name: payload.name,
      mimeType: payload.mimeType,
      transferKind: payload.kind,
      size: payload.size,
      totalChunks: payload.totalChunks,
    }));
  } catch (error) {
    bridge.bus.send(envelope.from.streamId, "file_ack", createFailedFileAckPayload(transferId, error));
    storeInboxMessage(stateDir, createFileTransferEventEnvelope(envelope.from, "file_receive_failed", {
      transferId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return true;
}

function handleIncomingFileChunk(bridge: VDOBridge, stateDir: string, envelope: MessageEnvelope): boolean {
  const payload = envelope.payload as FileChunkPayload;
  const transferId = transferIdForError(envelope.payload);
  try {
    appendIncomingTransferChunk(stateDir, payload, envelope.from.streamId);
  } catch (error) {
    discardIncomingTransfer(stateDir, transferId, envelope.from.streamId);
    bridge.bus.send(envelope.from.streamId, "file_ack", createFailedFileAckPayload(transferId, error));
    storeInboxMessage(stateDir, createFileTransferEventEnvelope(envelope.from, "file_receive_failed", {
      transferId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return true;
}

function handleIncomingFileComplete(bridge: VDOBridge, stateDir: string, envelope: MessageEnvelope): boolean {
  const payload = envelope.payload as FileCompletePayload;
  const transferId = transferIdForError(envelope.payload);
  try {
    const completed = completeIncomingTransfer(stateDir, payload, envelope.from.streamId);
    bridge.bus.send(envelope.from.streamId, "file_ack", createFileAckPayload(completed));
    storeInboxMessage(stateDir, createReceivedFileEventEnvelope(envelope.from, completed));
  } catch (error) {
    discardIncomingTransfer(stateDir, transferId, envelope.from.streamId);
    bridge.bus.send(envelope.from.streamId, "file_ack", createFailedFileAckPayload(transferId, error));
    storeInboxMessage(stateDir, createFileTransferEventEnvelope(envelope.from, "file_receive_failed", {
      transferId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return true;
}

function handleIncomingFileAck(stateDir: string, envelope: MessageEnvelope): boolean {
  if (typeof envelope.payload !== "object" || envelope.payload === null) return true;
  const payload = envelope.payload as FileAckPayload;
  if (typeof payload.transferId !== "string" || typeof payload.ok !== "boolean") return true;
  storeInboxMessage(stateDir, createFileTransferEventEnvelope(envelope.from, payload.ok ? "file_delivered" : "file_delivery_failed", {
    transferId: payload.transferId,
    name: payload.name ?? null,
    mimeType: payload.mimeType ?? null,
    transferKind: payload.kind ?? null,
    size: payload.size ?? null,
    sha256: payload.sha256 ?? null,
    savedPath: payload.savedPath ?? null,
    error: payload.error ?? null,
  }));
  return true;
}

function transferIdForError(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "invalid";
  const transferId = (payload as Record<string, unknown>).transferId;
  return typeof transferId === "string" && transferId ? transferId.slice(0, 128) : "invalid";
}

function createReceivedFileEventEnvelope(from: PeerIdentity, completed: CompletedTransferResult): MessageEnvelope {
  return createFileTransferEventEnvelope(from, "file_received", {
    transferId: completed.transferId,
    name: completed.name,
    mimeType: completed.mimeType,
    transferKind: completed.kind,
    size: completed.size,
    sha256: completed.sha256,
    savedPath: completed.savedPath,
  });
}

export function createFileTransferEventEnvelope(
  from: PeerIdentity,
  kind: "file_offered" | "file_received" | "file_delivered" | "file_delivery_failed" | "file_receive_failed" | "file_send_failed",
  details: Record<string, unknown>,
): MessageEnvelope {
  return createEnvelope(from, "event", {
    ...details,
    kind,
  });
}

export function composeSidecarAgentProfile(profile?: AgentProfile): AgentProfile {
  const shares = profile?.shares?.map((share) => ({ ...share }));
  const shareAsks = shares && shares.length > 0 ? SIDECAR_SHARE_ASKS : [];
  const asks = mergeAgentAsks(profile?.asks ?? [], deriveAgentAsksFromCapabilities(profile?.can ?? []), shareAsks, SIDECAR_DISCOVERY_ASKS);
  const can = profile?.can ? [...new Set(profile.can.map((value) => value.trim()).filter(Boolean))] : undefined;

  const composed: AgentProfile = {
    asks,
  };
  if (profile?.runtime) composed.runtime = profile.runtime;
  if (profile?.provider) composed.provider = profile.provider;
  if (profile?.model) composed.model = profile.model;
  if (profile?.summary) composed.summary = profile.summary;
  if (profile?.workspace) composed.workspace = profile.workspace;
  if (can && can.length > 0) composed.can = can;
  if (shares && shares.length > 0) composed.shares = shares;
  return composed;
}

export function buildSidecarCommandResponse(
  bridge: VDOBridge,
  stateDir: string,
  commandName: string,
  commandArgs?: unknown,
  sharedFolders: SharedFolderConfig[] = [],
  requesterStreamId?: string,
): { handled: boolean; result?: unknown; error?: string; transfer?: { targetStreamId: string; filePath: string; transferKind: "file" | "image" } } {
  const announce = bridge.getAnnouncePayload();
  const inbox = getInboxSummary(stateDir);
  const profile = announce.agent ?? null;
  const identity = bridge.identity;
  const requestExamples = buildRequestExamples(identity.streamId, profile?.asks ?? SIDECAR_DISCOVERY_ASKS);

  switch (commandName.trim().toLowerCase()) {
    case "help":
      return {
        handled: true,
        result: {
          kind: "ninja-p2p-sidecar",
          room: inbox.room,
          identity,
          connected: bridge.isConnected(),
          status: announce.status,
          statusDetail: announce.statusDetail ?? "",
          profile,
          commands: profile?.asks ?? SIDECAR_DISCOVERY_ASKS,
          requestExamples,
          recommendedFlow: [
            "Ask for profile or capabilities first.",
            "Use a command name from the peer's asks list when delegating work.",
            "If you need sign-off, send approve and wait for a command_response before proceeding.",
            "If the peer exposes shares, use shares, list-files, and get-file instead of assuming file paths.",
            "Use chat or DM for open-ended discussion and planning.",
            "Use events for room-wide updates such as build_failed or task_done.",
          ],
        },
      };
    case "profile":
    case "whoami":
      return {
        handled: true,
        result: {
          room: inbox.room,
          identity,
          profile,
        },
      };
    case "capabilities":
      return {
        handled: true,
        result: {
          room: inbox.room,
          identity,
          skills: announce.skills,
          topics: announce.topics,
          can: profile?.can ?? [],
          asks: profile?.asks ?? SIDECAR_DISCOVERY_ASKS,
          shares: profile?.shares ?? [],
          profile,
          requestExamples,
        },
      };
    case "status":
      return {
        handled: true,
        result: {
          room: inbox.room,
          identity,
          connected: bridge.isConnected(),
          status: announce.status,
          statusDetail: announce.statusDetail ?? "",
          pending: inbox.pending,
          queued: inbox.queued,
          stale: inbox.stale,
          peersKnown: inbox.peersKnown,
          peersConnected: inbox.peersConnected,
          senders: inbox.senders,
          types: inbox.types,
          commands: inbox.commands,
          events: inbox.events,
          peers: inbox.peers,
          profile,
        },
      };
    case "peers":
      return {
        handled: true,
        result: {
          room: inbox.room,
          peers: bridge.peers.toJSON(),
        },
      };
    case "shares":
      return {
        handled: true,
        result: {
          room: inbox.room,
          identity,
          shares: profile?.shares ?? [],
        },
      };
    case "list-files":
      try {
        const share = getCommandArgString(commandArgs, "share");
        const folderPath = getCommandArgString(commandArgs, "path") ?? "";
        if (!share) {
          return { handled: true, error: "list-files requires args.share" };
        }
        return {
          handled: true,
          result: listSharedFolderEntries(sharedFolders, share, folderPath),
        };
      } catch (error) {
        return {
          handled: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    case "get-file":
      try {
        const share = getCommandArgString(commandArgs, "share");
        const filePath = getCommandArgString(commandArgs, "path");
        if (!share || !filePath) {
          return { handled: true, error: "get-file requires args.share and args.path" };
        }
        if (!requesterStreamId) {
          return { handled: true, error: "missing requester stream id" };
        }
        const file = resolveSharedFile(sharedFolders, share, filePath);
        return {
          handled: true,
          result: {
            share: file.share,
            path: file.path,
            name: file.name,
            size: file.size,
            transferKind: file.kind,
          },
          transfer: {
            targetStreamId: requesterStreamId,
            filePath: file.filePath,
            transferKind: file.kind,
          },
        };
      } catch (error) {
        return {
          handled: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    case "inbox":
    case "pending":
      return {
        handled: true,
        result: inbox,
      };
    default:
      return { handled: false };
  }
}

export function maybeHandleSidecarCommand(bridge: VDOBridge, stateDir: string, envelope: MessageEnvelope): boolean {
  if (envelope.type !== "command" || typeof envelope.payload !== "object" || envelope.payload === null) {
    return false;
  }

  const payload = envelope.payload as Record<string, unknown>;
  if (typeof payload.command !== "string") {
    return false;
  }

  const session = readAgentSession(stateDir);
  const response = buildSidecarCommandResponse(
    bridge,
    stateDir,
    payload.command,
    payload.args,
    session?.sharedFolders ?? [],
    envelope.from.streamId,
  );
  if (!response.handled) {
    return false;
  }

  if (response.transfer) {
    try {
      const offer = sendFileFromPath(bridge, response.transfer.targetStreamId, response.transfer.filePath, response.transfer.transferKind);
      response.result = {
        ...(typeof response.result === "object" && response.result !== null ? response.result as Record<string, unknown> : {}),
        transferId: offer.transferId,
        mimeType: offer.mimeType,
        totalChunks: offer.totalChunks,
        sha256: offer.sha256,
      };
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
      response.result = undefined;
    }
  }

  bridge.commandResponse(envelope, response.result ?? null, response.error);
  return true;
}

export function createPeerNoticeEnvelope(
  peerIdentity: PeerIdentity,
  kind: "peer_discovered" | "peer_updated" | "peer_left",
  details: Record<string, unknown>,
): MessageEnvelope {
  return createEnvelope(peerIdentity, "event", {
    kind,
    ...details,
  });
}

export function recordPeerNotice(
  fingerprints: Map<string, string>,
  peerIdentity: PeerIdentity,
  kind: "peer_discovered" | "peer_updated",
  details: Record<string, unknown>,
): MessageEnvelope | null {
  const fingerprint = JSON.stringify(details);
  const previous = fingerprints.get(peerIdentity.streamId);
  if (previous === fingerprint) {
    return null;
  }
  const noticeKind = previous ? "peer_updated" : kind;
  fingerprints.set(peerIdentity.streamId, fingerprint);
  return createPeerNoticeEnvelope(peerIdentity, noticeKind, details);
}

function mergeAgentAsks(...groups: AgentAsk[][]): AgentAsk[] {
  const merged: AgentAsk[] = [];
  const seen = new Set<string>();

  for (const ask of groups.flat()) {
    const name = ask.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const mergedAsk: AgentAsk = {
      name,
      description: ask.description.trim() || `${name} command`,
    };
    if (ask.via) mergedAsk.via = ask.via;
    if (ask.example) mergedAsk.example = ask.example;
    merged.push(mergedAsk);
  }

  return merged;
}

function deriveAgentAsksFromCapabilities(capabilities: string[]): AgentAsk[] {
  const derived: AgentAsk[] = [];
  for (const capability of capabilities.map((value) => value.trim().toLowerCase()).filter(Boolean)) {
    derived.push(...(DERIVED_CAPABILITY_ASKS[capability] ?? []));
  }
  return derived;
}

function buildRequestExamples(peerStreamId: string, asks: AgentAsk[]): Array<Record<string, unknown>> {
  return asks.map((ask) => {
    const via = ask.via ?? "command";
    if (via === "chat") {
      return {
        ask: ask.name,
        via,
        example: ask.example ?? `ninja-p2p dm --id <you> ${peerStreamId} "Can you help with ${ask.name}?"`,
        text: `Can you help with ${ask.name}?`,
      };
    }
    if (via === "event") {
      return {
        ask: ask.name,
        via,
        example: ask.example ?? `ninja-p2p event --id <you> events ${ask.name} '{"request":"..."}'`,
        topic: "events",
        eventKind: ask.name,
        data: { request: `Please help with ${ask.name}` },
      };
    }
    return {
      ask: ask.name,
      via: "command",
      example: ask.example ?? `ninja-p2p command --id <you> ${peerStreamId} ${ask.name} '{"request":"..."}'`,
      command: ask.name,
      args: { request: `Please help with ${ask.name}` },
    };
  });
}

function resolveCliEntryPath(): string {
  const current = fileURLToPath(import.meta.url);
  if (current.endsWith(".ts")) {
    const built = path.resolve(path.dirname(current), "..", "dist", "cli.js");
    if (existsSync(built)) {
      return built;
    }
  }
  return current;
}

function getCommandPrefix(options: CliCommonOptions): string {
  return options.agentProfile?.runtime?.includes("claude") ? "/ninja-p2p" : "ninja-p2p";
}

function buildAgentArgs(options: CliCommonOptions): string[] {
  const args = [
    "--room", options.room,
    "--name", options.name,
    "--id", options.streamId,
    "--role", options.role,
    "--state-dir", options.stateDir ?? "",
  ];
  if (options.password !== false) {
    args.push("--password", String(options.password));
  }
  if (options.waitMs !== 1500) {
    args.push("--wait-ms", String(options.waitMs));
  }
  if (options.agentProfile?.runtime) {
    args.push("--runtime", options.agentProfile.runtime);
  }
  if (options.agentProfile?.provider) {
    args.push("--provider", options.agentProfile.provider);
  }
  if (options.agentProfile?.model) {
    args.push("--model", options.agentProfile.model);
  }
  if (options.agentProfile?.summary) {
    args.push("--summary", options.agentProfile.summary);
  }
  if (options.agentProfile?.workspace) {
    args.push("--workspace", options.agentProfile.workspace);
  }
  for (const capability of options.agentProfile?.can ?? []) {
    args.push("--can", capability);
  }
  for (const ask of options.agentProfile?.asks ?? []) {
    args.push("--ask", `${ask.name}:${ask.description}`);
  }
  for (const share of options.sharedFolders) {
    args.push("--share", `${share.name}=${share.path}`);
  }
  if (options.wake) {
    args.push("--on-message", options.wake.command);
    if (options.wake.debounceMs !== DEFAULT_WAKE_DEBOUNCE_MS) {
      args.push("--wake-debounce", String(options.wake.debounceMs));
    }
    if (options.wake.limitPerMinute !== DEFAULT_WAKE_LIMIT_PER_MINUTE) {
      args.push("--wake-limit", String(options.wake.limitPerMinute));
    }
  }
  return args;
}

function createSwarmBridge(options: CliCommonOptions, name: string, role: string): VDOBridge {
  return new VDOBridge({
    room: options.room,
    streamId: options.streamId,
    identity: { streamId: options.streamId, role, name },
    password: options.password,
    skills: ["swarm", "file-transfer"],
    topics: [],
  });
}

function swarmWorkDir(): string {
  return path.join(os.tmpdir(), "ninja-p2p-swarm");
}

/** Publish a file to the room and serve it until interrupted. */
async function runSeed(options: CliCommonOptions, filePath: string, chunkSize: number): Promise<void> {
  const bridge = createSwarmBridge(options, options.name || "Seeder", "seeder");
  const manager = new SwarmManager({
    bridge,
    downloadDir: path.resolve("."),
    workDir: swarmWorkDir(),
    log: (message) => console.log(message),
  });

  await bridge.connect();
  manager.start();

  const manifest = manager.seed(filePath, chunkSize);

  console.log("");
  console.log(`seeding ${manifest.name}`);
  console.log(`  room:    ${options.room}`);
  console.log(`  id:      ${options.streamId}`);
  console.log(`  file id: ${manifest.fileId}`);
  console.log(`  size:    ${formatBytes(manifest.size)} in ${manifest.totalChunks} chunk(s)`);
  console.log("");
  console.log("Fetch it from anywhere with:");
  console.log(`  ninja-p2p fetch ${manifest.name} --room ${options.room}`);
  console.log("");
  console.log("Anyone who finishes also becomes a source. Press Ctrl+C to stop.");

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    manager.stop();
    await bridge.disconnect();
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  await new Promise<void>((resolve) => {
    bridge.once("disconnected", () => resolve());
  });
}

/** Download a file from whoever in the room has it. */
async function runFetch(
  options: CliCommonOptions,
  query: string,
  outDir: string | null,
  keepSeeding: boolean,
  timeoutMs: number,
): Promise<void> {
  const downloadDir = path.resolve(outDir ?? ".");
  const bridge = createSwarmBridge(options, options.name || "Fetcher", "fetcher");

  let done: ((completion: SwarmCompletion | null) => void) | null = null;
  let failed: string | null = null;
  const finished = new Promise<SwarmCompletion | null>((resolve) => { done = resolve; });

  const manager = new SwarmManager({
    bridge,
    downloadDir,
    workDir: swarmWorkDir(),
    log: (message) => console.log(message),
    onComplete: (completion) => done?.(completion),
    onError: (message) => {
      failed = message;
      done?.(null);
    },
  });

  await bridge.connect();
  manager.start();
  console.log(`joined ${options.room} as ${options.streamId}, looking for "${query}"`);

  // Offers arrive on announce, so give the room a moment before giving up.
  const deadline = timeoutMs > 0
    ? Date.now() + Math.min(timeoutMs, 60_000)
    : Number.POSITIVE_INFINITY;
  let manifest = manager.resolveOffer(query);
  while (!manifest && Date.now() < deadline) {
    await delay(500);
    manifest = manager.resolveOffer(query);
  }

  if (!manifest) {
    const offers = manager.knownOffers();
    console.error(`no offer matching "${query}" in room ${options.room}`);
    if (offers.length > 0) {
      console.error("available:");
      for (const offer of offers) {
        console.error(`  ${offer.name}  ${offer.fileId.slice(0, 16)}  ${formatBytes(offer.size)}`);
      }
    }
    manager.stop();
    await bridge.disconnect();
    process.exitCode = 1;
    return;
  }

  console.log(`fetching ${manifest.name} (${formatBytes(manifest.size)}, ${manifest.totalChunks} chunks)`);
  const startedAt = Date.now();
  const accepted = manager.fetch(manifest.fileId);
  if (!accepted && failed) {
    console.error(failed);
    manager.stop();
    await bridge.disconnect();
    process.exitCode = 1;
    return;
  }

  const progressTimer = setInterval(() => {
    const progress = manager.sessionFor(manifest!.fileId)?.progress();
    if (progress && !progress.complete) {
      console.log(`  ${progress.percent}%  ${progress.haveChunks}/${progress.totalChunks} chunks  ${progress.peers} peer(s)  ${progress.inFlight} in flight`);
    }
  }, 2_000);
  progressTimer.unref?.();

  const timeoutTimer = timeoutMs > 0 ? setTimeout(() => done?.(null), timeoutMs) : null;
  timeoutTimer?.unref?.();

  const completion = await finished;
  clearInterval(progressTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);

  if (!completion) {
    const progress = manager.sessionFor(manifest.fileId)?.progress();
    if (failed) {
      console.error(failed);
    } else {
      console.error(`timed out after ${formatDuration(Date.now() - startedAt)} at ${progress?.percent ?? 0}%`);
    }
    manager.stop();
    await bridge.disconnect();
    process.exitCode = 1;
    return;
  }

  const elapsed = Date.now() - startedAt;
  console.log("");
  console.log(`saved ${completion.savedPath}`);
  console.log(`  ${formatBytes(completion.manifest.size)} in ${formatDuration(elapsed)} (${formatRate(completion.manifest.size, elapsed)})`);

  if (keepSeeding) {
    console.log("");
    console.log("Still seeding for other peers. Press Ctrl+C to stop.");
    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      manager.stop();
      await bridge.disconnect();
    };
    process.on("SIGINT", () => { void shutdown(); });
    process.on("SIGTERM", () => { void shutdown(); });
    await new Promise<void>((resolve) => {
      bridge.once("disconnected", () => resolve());
    });
    return;
  }

  manager.stop();
  await bridge.disconnect();
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRate(bytes: number, ms: number): string {
  if (ms <= 0) return "n/a";
  return `${formatBytes(Math.round((bytes * 1000) / ms))}/s`;
}

/**
 * Bridge Social Stream Ninja's live chat into a ninja-p2p room.
 *
 * Inbound: every chat message SSN aggregates becomes a topic event, so agents
 * can watch a stream's chat the same way they watch any other room traffic.
 *
 * Outbound: the bridge advertises a `say` command, so an agent that wants to
 * answer chat sends one message and SSN fans it out to every connected
 * platform. That is the whole co-host loop in two directions.
 */
async function runSocialStreamBridge(parsed: {
  options: CliCommonOptions;
  session: string;
  topic: string;
  host: string;
  inChannel: number;
  outChannel: number;
  echo: boolean;
  readOnly: boolean;
}): Promise<void> {
  const { options } = parsed;

  // An SSN session id grants everything: send chat, block users, clear
  // overlays, fake donations. Until SSN can issue read-scoped credentials, this
  // is the next best thing — the bridge structurally refuses to speak, so a
  // compromised or over-eager agent in the room cannot reach the audience.
  const readOnly = parsed.readOnly;
  const bridge = new VDOBridge({
    room: options.room,
    streamId: options.streamId,
    identity: {
      streamId: options.streamId,
      role: options.role,
      name: options.name,
    },
    password: options.password,
    skills: ["social", "chat", "command", "bridge"],
    topics: [parsed.topic, "events"],
    agentProfile: {
      ...options.agentProfile,
      summary: options.agentProfile?.summary
        ?? (readOnly
          ? "Read-only bridge for live stream chat from Social Stream Ninja."
          : "Bridges live stream chat from Social Stream Ninja into this room."),
      can: [...new Set([
        ...(options.agentProfile?.can ?? []),
        "social-chat",
        ...(readOnly ? [] : ["broadcast"]),
      ])],
      asks: [
        ...(options.agentProfile?.asks ?? []),
        // Do not advertise an ability we will refuse to perform.
        ...(readOnly ? [] : [{
          name: "say",
          description: "Send a message out to every live chat platform connected to Social Stream Ninja.",
          via: "command" as const,
          example: `ninja-p2p command --id <you> ${options.streamId} say '{"text":"hello chat"}'`,
        }]),
      ],
    },
  });

  let forwarded = 0;
  const social = new SocialStreamBridge({
    session: parsed.session,
    host: parsed.host,
    inChannel: parsed.inChannel,
    outChannel: parsed.outChannel,
    log: (message) => console.log(message),
    onMessage: (message) => {
      forwarded += 1;
      bridge.publishEvent(parsed.topic, "social_chat", message);
      if (parsed.echo) {
        console.log(describeSocialMessage(message));
      }
    },
  });

  bridge.bus.on("message:command", (envelope: MessageEnvelope) => {
    const payload = envelope.payload as { command?: string; args?: unknown };
    if (payload.command !== "say") return;

    if (readOnly) {
      // Refuse loudly. Silently dropping it would let an agent believe it spoke
      // to the audience when nothing was said.
      bridge.commandResponse(envelope, undefined, "bridge is running read-only; restart without --read-only to allow sending");
      console.log(`[ssn] refused say from ${envelope.from.streamId} (read-only)`);
      return;
    }

    const text = extractSayText(payload.args);
    if (!text) {
      bridge.commandResponse(envelope, undefined, "say requires text, e.g. '{\"text\":\"hello chat\"}'");
      return;
    }

    // Report the truth: if the relay is down the message did not reach chat.
    if (!social.isConnected()) {
      bridge.commandResponse(envelope, undefined, "not connected to Social Stream Ninja");
      return;
    }

    const sent = social.sendChat(text);
    bridge.commandResponse(
      envelope,
      sent ? { sent: true, text } : undefined,
      sent ? undefined : "failed to send to Social Stream Ninja",
    );
    console.log(`[ssn] ${envelope.from.streamId} -> chat: ${text}`);
  });

  await bridge.connect();
  social.connect();

  console.log(`social stream bridge ready`);
  console.log(`  room:    ${options.room}`);
  console.log(`  id:      ${options.streamId}`);
  console.log(`  session: ${parsed.session}`);
  console.log(`  topic:   ${parsed.topic}`);
  console.log("");
  if (readOnly) {
    console.log("Read-only: agents can watch chat but cannot send to it.");
  } else {
    console.log("Agents in this room can reply to every platform with:");
    console.log(`  ninja-p2p command --id <you> ${options.streamId} say '{"text":"hello chat"}'`);
    console.log("");
    console.log("Anything an agent says here reaches your real audience.");
    console.log("Use --read-only if you only want them to watch.");
  }
  console.log("");
  console.log("Press Ctrl+C to stop.");

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nforwarded ${forwarded} chat message(s)`);
    social.close();
    await bridge.disconnect();
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  await new Promise<void>((resolve) => {
    bridge.once("disconnected", () => resolve());
  });
}

function extractSayText(args: unknown): string {
  if (typeof args === "string") return args.trim();
  if (typeof args === "object" && args !== null) {
    const value = (args as Record<string, unknown>).text;
    if (typeof value === "string") return value.trim();
  }
  return "";
}

export const DASHBOARD_URL = "https://steveseguin.github.io/ninja-p2p/dashboard.html";

export function buildDashboardUrl(room: string, password: string | false): string {
  const params = new URLSearchParams({
    room,
    password: password === false ? "false" : password,
    name: "You",
    autoconnect: "true",
  });
  return `${DASHBOARD_URL}?${params.toString()}`;
}

/** One-command proof that the transport works on this machine and network. */
async function runDemoCommand(
  room: string | null,
  password: string | false,
  timeoutMs: number,
  keep: boolean,
): Promise<void> {
  console.log("ninja-p2p demo");
  console.log("");
  console.log("Two peers, no server of your own. Watch the round trip:");
  console.log("");

  const result = await runDemo({
    room: room ?? undefined,
    password,
    timeoutMs,
    log: (message) => console.log(message),
    hold: keep
      ? async (activeRoom) => {
        console.log("");
        console.log("Both peers are still in the room. Open this to watch:");
        console.log(`  ${buildDashboardUrl(activeRoom, password)}`);
        console.log("");
        console.log("Press Ctrl+C to stop.");
        await new Promise<void>((resolve) => {
          process.on("SIGINT", () => resolve());
          process.on("SIGTERM", () => resolve());
        });
      }
      : undefined,
  });

  console.log(formatDemoResult(result, buildDashboardUrl(result.room, password)));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

/** Run every diagnostic and exit non-zero if a required one failed. */
async function runDoctor(stateRoot: string): Promise<void> {
  const checks: DiagnosticCheck[] = [checkNodeVersion(process.version)];
  checks.push(await checkWebRtc());
  checks.push(await checkSignaling());
  checks.push(checkStateRoot(stateRoot));

  const sidecars = checkSidecars(stateRoot, readAgentSession, isPidRunning);
  checks.push(sidecars.check);

  const report = summarizeChecks(checks);
  console.log(formatReport(report, sidecars.sidecars));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

/**
 * Block until the sidecar's inbox has something in it.
 *
 * This is the pull half of the wake story: `--on-message` pushes a turn at the
 * agent, `wait` lets a shell loop pull one. Exit code 0 means mail arrived,
 * 1 means the timeout elapsed, so `while ninja-p2p wait --id x; do ...; done`
 * behaves the way a shell author expects.
 */
async function waitForInbox(stateDir: string, timeoutMs: number, intervalMs: number): Promise<void> {
  const startedAt = Date.now();

  for (;;) {
    const summary = getInboxSummary(stateDir);
    if (summary.pending > 0) {
      console.log(JSON.stringify({
        stateDir,
        pending: summary.pending,
        senders: summary.senders,
        types: summary.types,
        waitedMs: Date.now() - startedAt,
      }, null, 2));
      return;
    }

    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      console.log(JSON.stringify({
        stateDir,
        pending: 0,
        timedOut: true,
        waitedMs: Date.now() - startedAt,
      }, null, 2));
      process.exitCode = 1;
      return;
    }

    await delay(intervalMs);
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * End the process explicitly once a command is done.
 *
 * `@roamhq/wrtc` segfaults during normal process teardown if a data channel
 * has ever existed, which corrupts the exit code (139/127) even on a fully
 * successful run. Any script doing `ninja-p2p wait && ...` would break on it.
 * Calling process.exit() skips the native teardown path and the crash with it,
 * so every command ends through here rather than by draining the event loop.
 *
 * This is safe because `VDOBridge.disconnect()` already waits for the SDK to
 * finish its own cleanup, so nothing meaningful is still in flight.
 */
async function exitCleanly(): Promise<void> {
  // Let buffered stdout reach the terminal or pipe before we cut the process off.
  await new Promise<void>((resolve) => {
    if (process.stdout.write("")) {
      resolve();
      return;
    }
    process.stdout.once("drain", () => resolve());
  });

  process.exit(process.exitCode ?? 0);
}

const entry = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entry) {
  main(process.argv.slice(2))
    .then(exitCleanly)
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
