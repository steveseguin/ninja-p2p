import { createMessageId } from "./protocol.js";

export type CliCommonOptions = {
  room: string;
  streamId: string;
  name: string;
  role: string;
  password: string | false;
  waitMs: number;
};

export type CliCommand =
  | { kind: "help" }
  | { kind: "connect"; options: CliCommonOptions }
  | { kind: "chat"; options: CliCommonOptions; text: string }
  | { kind: "dm"; options: CliCommonOptions; target: string; text: string }
  | { kind: "command"; options: CliCommonOptions; target: string; command: string; args: unknown };

export function helpText(): string {
  return [
    "ninja-p2p",
    "",
    "Install:",
    "  npm install -g @vdoninja/ninja-p2p @roamhq/wrtc",
    "",
    "Use:",
    "  ninja-p2p connect --room my-room --name Claude",
    "  ninja-p2p chat --room my-room --name Steve \"hello\"",
    "  ninja-p2p dm --room my-room --name Steve worker_bot \"hello\"",
    "  ninja-p2p command --room my-room --name Steve worker_bot status",
    "",
    "Connect mode commands:",
    "  hello world              send chat to the room",
    "  /dm worker_bot hello     send direct chat",
    "  /cmd worker_bot status   send command",
    "  /event events ping       publish event",
    "  /status busy writing     update local status",
    "  /peers                   list peers",
    "  /quit                    disconnect",
  ].join("\n");
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliCommand {
  const args = [...argv];
  const kind = (args.shift() ?? "help").toLowerCase();
  if (kind === "help" || kind === "--help" || kind === "-h") {
    return { kind: "help" };
  }

  const parsed = parseOptions(args, env);
  const options = buildCommonOptions(parsed.values, env);
  const positional = parsed.positional;

  switch (kind) {
    case "connect":
      return { kind, options };
    case "chat":
      if (positional.length < 1) {
        throw new Error("chat requires text");
      }
      return { kind, options, text: positional.join(" ") };
    case "dm":
      if (positional.length < 2) {
        throw new Error("dm requires a target and text");
      }
      return {
        kind,
        options,
        target: positional[0],
        text: positional.slice(1).join(" "),
      };
    case "command":
      if (positional.length < 2) {
        throw new Error("command requires a target and command name");
      }
      return {
        kind,
        options,
        target: positional[0],
        command: positional[1],
        args: positional[2] ? parseJsonMaybe(positional.slice(2).join(" ")) : undefined,
      };
    default:
      throw new Error(`unknown command: ${kind}`);
  }
}

export function defaultStreamId(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "agent";
  return `${base}_${createMessageId().slice(0, 6)}`;
}

export function parseJsonMaybe(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseOptions(argv: string[], env: NodeJS.ProcessEnv): { values: Record<string, string>; positional: string[] } {
  const values: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    values[key] = next;
    i += 1;
  }

  if (!values.room && env.NINJA_ROOM) values.room = env.NINJA_ROOM;
  if (!values.name && env.NINJA_NAME) values.name = env.NINJA_NAME;
  if (!values.id && env.NINJA_ID) values.id = env.NINJA_ID;
  if (!values.role && env.NINJA_ROLE) values.role = env.NINJA_ROLE;
  if (!values.password && env.NINJA_PASSWORD) values.password = env.NINJA_PASSWORD;
  if (!values["wait-ms"] && env.NINJA_WAIT_MS) values["wait-ms"] = env.NINJA_WAIT_MS;

  return { values, positional };
}

function buildCommonOptions(values: Record<string, string>, env: NodeJS.ProcessEnv): CliCommonOptions {
  const room = values.room || env.NINJA_ROOM || "";
  if (!room) {
    throw new Error("missing room; use --room my-room");
  }

  const name = values.name || env.NINJA_NAME || "Agent";
  const streamId = values.id || env.NINJA_ID || defaultStreamId(name);
  const role = values.role || env.NINJA_ROLE || "agent";
  const passwordValue = values.password ?? env.NINJA_PASSWORD;
  const password = passwordValue === "false" ? false : (passwordValue || false);
  const waitMsRaw = values["wait-ms"] ?? env.NINJA_WAIT_MS ?? "1500";
  const waitMs = Number.parseInt(waitMsRaw, 10);

  return {
    room,
    streamId,
    name,
    role,
    password,
    waitMs: Number.isFinite(waitMs) ? waitMs : 1500,
  };
}
