#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { VDOBridge } from "./vdo-bridge.js";
import { createEnvelope, envelopeToWire, type MessageEnvelope } from "./protocol.js";
import { helpText, parseCliArgs, parseJsonMaybe, type CliCommonOptions } from "./cli-lib.js";

async function main(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);

  switch (parsed.kind) {
    case "help":
      console.log(helpText());
      return;
    case "connect":
      await runConnect(parsed.options);
      return;
    case "chat":
      await runOneShot(parsed.options, (bridge) => {
        bridge.chat(parsed.text);
        console.log(`sent chat to room ${parsed.options.room}`);
      });
      return;
    case "dm":
      await runOneShot(parsed.options, (bridge) => {
        const envelope = createEnvelope(bridge.identity, "chat", { text: parsed.text }, { to: parsed.target });
        bridge.sendRaw(envelopeToWire(envelope), parsed.target);
        console.log(`sent direct chat to ${parsed.target}`);
      });
      return;
    case "command":
      await runOneShot(parsed.options, (bridge) => {
        const envelope = createEnvelope(bridge.identity, "command", {
          command: parsed.command,
          args: parsed.args,
        }, { to: parsed.target });
        bridge.sendRaw(envelopeToWire(envelope), parsed.target);
        console.log(`sent command ${parsed.command} to ${parsed.target}`);
      });
      return;
  }
}

function createBridge(options: CliCommonOptions): VDOBridge {
  return new VDOBridge({
    room: options.room,
    streamId: options.streamId,
    identity: {
      streamId: options.streamId,
      role: options.role,
      name: options.name,
    },
    password: options.password,
    skills: ["cli", "chat", "command"],
    topics: ["events"],
  });
}

async function runOneShot(options: CliCommonOptions, send: (bridge: VDOBridge) => void): Promise<void> {
  const bridge = createBridge(options);
  await bridge.connect();
  await delay(options.waitMs);
  send(bridge);
  await delay(500);
  await bridge.disconnect();
}

async function runConnect(options: CliCommonOptions): Promise<void> {
  const bridge = createBridge(options);
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
    case "cmd":
      if (rest.length < 2) {
        console.log("usage: /cmd <peer> <command> [json]");
        return;
      }
      bridge.command(rest[0], rest[1], rest[2] ? parseJsonMaybe(rest.slice(2).join(" ")) : undefined);
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

const entry = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
