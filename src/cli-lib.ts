import path from "node:path";
import { createMessageId, generateRoomName, type AgentAsk, type AgentProfile } from "./protocol.js";
import { parseSharedFolderSpecs, toSharedFolderSummaries, type SharedFolderConfig } from "./shared-folders.js";

export type CliCommonOptions = {
  room: string;
  streamId: string;
  name: string;
  role: string;
  password: string | false;
  waitMs: number;
  stateDir: string | null;
  agentProfile?: AgentProfile;
  sharedFolders: SharedFolderConfig[];
};

export type SkillRuntime = "claude" | "codex";

export type CliCommand =
  | { kind: "help" }
  | { kind: "menu"; options: CliCommonOptions }
  | { kind: "install-skill"; runtime: SkillRuntime }
  | { kind: "start"; options: CliCommonOptions }
  | { kind: "stop"; stateDir: string }
  | { kind: "status"; stateDir: string }
  | { kind: "agent"; options: CliCommonOptions }
  | { kind: "notify"; stateDir: string }
  | { kind: "read"; stateDir: string; take: number; peek: boolean }
  | { kind: "connect"; options: CliCommonOptions }
  | { kind: "chat"; options: CliCommonOptions; text: string }
  | { kind: "dm"; options: CliCommonOptions; target: string; text: string }
  | { kind: "send-file"; options: CliCommonOptions; target: string; filePath: string }
  | { kind: "send-image"; options: CliCommonOptions; target: string; filePath: string }
  | { kind: "shares"; options: CliCommonOptions; target: string }
  | { kind: "list-files"; options: CliCommonOptions; target: string; share: string; folderPath: string }
  | { kind: "get-file"; options: CliCommonOptions; target: string; share: string; filePath: string }
  | { kind: "command"; options: CliCommonOptions; target: string; command: string; args: unknown }
  | { kind: "respond"; options: CliCommonOptions; target: string; requestId: string; result: unknown; error?: string }
  | { kind: "event"; options: CliCommonOptions; topic: string; eventKind: string; data: unknown }
  | { kind: "task"; options: CliCommonOptions; target: string; request: string }
  | { kind: "review"; options: CliCommonOptions; target: string; request: string }
  | { kind: "plan"; options: CliCommonOptions; target: string; request: string }
  | { kind: "approve"; options: CliCommonOptions; target: string; request: string };

export function helpText(): string {
  return [
    "ninja-p2p",
    "",
    "Start here:",
    "  ninja-p2p menu",
    "  ninja-p2p start --id claude",
    "  ninja-p2p start --id codex",
    "",
    "Install:",
    "  npm install -g @vdoninja/ninja-p2p @roamhq/wrtc",
    "  ninja-p2p install-skill codex",
    "  ninja-p2p install-skill claude",
    "",
    "Agent mode:",
    "  ninja-p2p start --room ai-room --id codex",
    "  ninja-p2p status --id codex",
    "  ninja-p2p notify --id codex",
    "  ninja-p2p read --id codex --take 10",
    "  ninja-p2p start --room ai-room --id codex --share docs=./docs",
    "  ninja-p2p shares --id codex worker",
    "  ninja-p2p list-files --id codex worker docs",
    "  ninja-p2p get-file --id codex worker docs guide.md",
    "  ninja-p2p send-file --id codex worker .\\notes.txt",
    "  ninja-p2p send-image --id codex worker .\\diagram.png",
    "  ninja-p2p plan --id codex planner \"Propose a safe rollout plan\"",
    "  ninja-p2p dm --id codex human \"working on it\"",
    "  ninja-p2p task --id codex worker \"Implement the patch\"",
    "  ninja-p2p review --id codex reviewer \"Review the change\"",
    "  ninja-p2p approve --id codex reviewer \"Approve this plan before I continue\"",
    "  ninja-p2p respond --id codex planner <requestId> '{\"approved\":true}'",
    "  ninja-p2p event --id codex builds build_failed '{\"job\":\"api\"}'",
    "  ninja-p2p command --id codex claude capabilities",
    "  ninja-p2p stop --id codex",
    "",
    "Use:",
    "  ninja-p2p connect --room my-room --name Claude",
    "  ninja-p2p chat --room my-room --name Steve \"hello\"",
    "  ninja-p2p dm --room my-room --name Steve worker_bot \"hello\"",
    "  ninja-p2p shares --room my-room --name Steve worker_bot",
    "  ninja-p2p list-files --room my-room --name Steve worker_bot docs",
    "  ninja-p2p get-file --room my-room --name Steve worker_bot docs guide.md",
    "  ninja-p2p send-file --room my-room --name Steve worker_bot ./notes.txt",
    "  ninja-p2p plan --room my-room --name Planner worker_bot \"Suggest a plan\"",
    "  ninja-p2p task --room my-room --name Planner worker_bot \"Implement this\"",
    "  ninja-p2p command --room my-room --name Steve worker_bot status",
    "",
    "Connect mode commands:",
    "  hello world              send chat to the room",
    "  /dm worker_bot hello     send direct chat",
    "  /shares worker_bot       list shared folders",
    "  /ls worker_bot docs      list a shared folder",
    "  /get worker_bot docs x   request one shared file",
    "  /file worker_bot a.txt   send a file",
    "  /image worker_bot a.png  send an image",
    "  /cmd worker_bot status   send command",
    "  /plan planner fix x      ask for a plan",
    "  /task worker_bot fix x   send a task request",
    "  /review reviewer diff    send a review request",
    "  /approve reviewer plan   ask for approval",
    "  /respond worker <id> {}  send a command response",
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

  if (kind === "menu") {
    const parsed = parseOptions(args, env);
    const options = buildCommonOptions(parsed.values, env, { requireRoom: false, requireStateDir: false, allowGeneratedRoom: false });
    return {
      kind,
      options: {
        ...options,
        stateDir: resolveStateDir(parsed.values, env, options.streamId),
      },
    };
  }

  if (kind === "install-skill") {
    const runtime = (args.shift() ?? "").toLowerCase();
    if (runtime !== "codex" && runtime !== "claude") {
      throw new Error("install-skill requires 'codex' or 'claude'");
    }
    return { kind, runtime };
  }

  const parsed = parseOptions(args, env);
  const positional = parsed.positional;

  switch (kind) {
    case "start":
      {
        const options = buildCommonOptions(parsed.values, env, { requireRoom: false, requireStateDir: false, allowGeneratedRoom: true });
        return {
          kind,
          options: {
            ...options,
            stateDir: resolveStateDir(parsed.values, env, options.streamId),
          },
        };
      }
    case "stop":
      return { kind, stateDir: resolveStateDir(parsed.values, env) };
    case "status":
      return { kind, stateDir: resolveStateDir(parsed.values, env) };
    case "agent":
      {
        const options = buildCommonOptions(parsed.values, env, { requireRoom: false, requireStateDir: false, allowGeneratedRoom: true });
        return {
          kind,
          options: {
            ...options,
            stateDir: resolveStateDir(parsed.values, env, options.streamId),
          },
        };
      }
    case "notify":
      return { kind, stateDir: resolveStateDir(parsed.values, env) };
    case "read":
      return {
        kind,
        stateDir: resolveStateDir(parsed.values, env),
        take: parsePositiveInt(getSingleValue(parsed.values, "take"), 20),
        peek: getSingleValue(parsed.values, "peek") === "true",
      };
    case "connect":
      return { kind, options: buildCommonOptions(parsed.values, env, { requireRoom: false, requireStateDir: false, allowGeneratedRoom: true }) };
    case "chat":
      if (positional.length < 1) {
        throw new Error("chat requires text");
      }
      {
        const useStateMode = shouldUseStateMode(parsed.values, env);
        const options = buildCommonOptions(parsed.values, env, {
          requireRoom: !useStateMode,
          requireStateDir: false,
        });
        if (useStateMode) {
          options.stateDir = resolveStateDir(parsed.values, env);
        }
      return {
        kind,
        options,
        text: positional.join(" "),
      };
      }
    case "dm":
      if (positional.length < 2) {
        throw new Error("dm requires a target and text");
      }
      {
        const useStateMode = shouldUseStateMode(parsed.values, env);
        const options = buildCommonOptions(parsed.values, env, {
          requireRoom: !useStateMode,
          requireStateDir: false,
        });
        if (useStateMode) {
          options.stateDir = resolveStateDir(parsed.values, env);
        }
      return {
        kind,
        options,
        target: positional[0],
        text: positional.slice(1).join(" "),
      };
      }
    case "send-file":
    case "send-image":
      if (positional.length < 2) {
        throw new Error(`${kind} requires a target and file path`);
      }
      {
        const useStateMode = shouldUseStateMode(parsed.values, env);
        const options = buildCommonOptions(parsed.values, env, {
          requireRoom: !useStateMode,
          requireStateDir: false,
        });
        if (useStateMode) {
          options.stateDir = resolveStateDir(parsed.values, env);
        }
        return {
          kind,
          options,
          target: positional[0],
          filePath: positional.slice(1).join(" "),
        };
      }
    case "shares":
      if (positional.length < 1) {
        throw new Error("shares requires a target");
      }
      {
        const useStateMode = shouldUseStateMode(parsed.values, env);
        const options = buildCommonOptions(parsed.values, env, {
          requireRoom: !useStateMode,
          requireStateDir: false,
        });
        if (useStateMode) {
          options.stateDir = resolveStateDir(parsed.values, env);
        }
        return {
          kind,
          options,
          target: positional[0],
        };
      }
    case "list-files":
      if (positional.length < 2) {
        throw new Error("list-files requires a target and share name");
      }
      {
        const useStateMode = shouldUseStateMode(parsed.values, env);
        const options = buildCommonOptions(parsed.values, env, {
          requireRoom: !useStateMode,
          requireStateDir: false,
        });
        if (useStateMode) {
          options.stateDir = resolveStateDir(parsed.values, env);
        }
        return {
          kind,
          options,
          target: positional[0],
          share: positional[1],
          folderPath: positional.slice(2).join(" "),
        };
      }
    case "get-file":
      if (positional.length < 3) {
        throw new Error("get-file requires a target, share name, and file path");
      }
      {
        const useStateMode = shouldUseStateMode(parsed.values, env);
        const options = buildCommonOptions(parsed.values, env, {
          requireRoom: !useStateMode,
          requireStateDir: false,
        });
        if (useStateMode) {
          options.stateDir = resolveStateDir(parsed.values, env);
        }
        return {
          kind,
          options,
          target: positional[0],
          share: positional[1],
          filePath: positional.slice(2).join(" "),
        };
      }
    case "command":
      if (positional.length < 2) {
        throw new Error("command requires a target and command name");
      }
      {
        const useStateMode = shouldUseStateMode(parsed.values, env);
        const options = buildCommonOptions(parsed.values, env, {
          requireRoom: !useStateMode,
          requireStateDir: false,
        });
        if (useStateMode) {
          options.stateDir = resolveStateDir(parsed.values, env);
        }
      return {
        kind,
        options,
        target: positional[0],
        command: positional[1],
        args: positional[2] ? parseJsonMaybe(positional.slice(2).join(" ")) : undefined,
      };
      }
    case "respond":
      if (positional.length < 2) {
        throw new Error("respond requires a target and request id");
      }
      {
        const useStateMode = shouldUseStateMode(parsed.values, env);
        const options = buildCommonOptions(parsed.values, env, {
          requireRoom: !useStateMode,
          requireStateDir: false,
        });
        if (useStateMode) {
          options.stateDir = resolveStateDir(parsed.values, env);
        }
        return {
          kind,
          options,
          target: positional[0],
          requestId: positional[1],
          result: positional[2] ? parseJsonMaybe(positional.slice(2).join(" ")) : undefined,
          error: getSingleValue(parsed.values, "error"),
        };
      }
    case "event":
      if (positional.length < 2) {
        throw new Error("event requires a topic and event name");
      }
      {
        const useStateMode = shouldUseStateMode(parsed.values, env);
        const options = buildCommonOptions(parsed.values, env, {
          requireRoom: !useStateMode,
          requireStateDir: false,
        });
        if (useStateMode) {
          options.stateDir = resolveStateDir(parsed.values, env);
        }
        return {
          kind,
          options,
          topic: positional[0],
          eventKind: positional[1],
          data: positional[2] ? parseJsonMaybe(positional.slice(2).join(" ")) : undefined,
        };
      }
    case "task":
    case "review":
    case "plan":
    case "approve":
      if (positional.length < 2) {
        throw new Error(`${kind} requires a target and request text`);
      }
      {
        const useStateMode = shouldUseStateMode(parsed.values, env);
        const options = buildCommonOptions(parsed.values, env, {
          requireRoom: !useStateMode,
          requireStateDir: false,
        });
        if (useStateMode) {
          options.stateDir = resolveStateDir(parsed.values, env);
        }
        return {
          kind,
          options,
          target: positional[0],
          request: positional.slice(1).join(" "),
        };
      }
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

export function defaultNameForRuntime(runtime: string | undefined): string {
  const value = (runtime || "").trim().toLowerCase();
  if (value.includes("claude")) return "Claude";
  if (value.includes("codex")) return "Codex";
  return "Agent";
}

export function defaultStreamIdForRuntime(name: string, runtime: string | undefined): string {
  const runtimeValue = (runtime || "").trim().toLowerCase();
  const normalizedName = name.trim().toLowerCase();
  if (runtimeValue.includes("claude") || normalizedName === "claude") return "claude";
  if (runtimeValue.includes("codex") || normalizedName === "codex") return "codex";
  return defaultStreamId(name);
}

export function parseJsonMaybe(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function getSkillInstallTarget(runtime: SkillRuntime, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE || env.HOME;
  if (!home) {
    throw new Error("cannot determine home directory");
  }

  if (runtime === "codex") {
    return path.join(home, ".codex", "skills", "ninja-p2p");
  }

  return path.join(home, ".claude", "skills", "ninja-p2p");
}

export function getSkillInstallTargets(runtime: SkillRuntime, env: NodeJS.ProcessEnv = process.env): string[] {
  const primary = getSkillInstallTarget(runtime, env);
  const home = env.USERPROFILE || env.HOME;
  if (!home) {
    throw new Error("cannot determine home directory");
  }

  if (runtime === "codex") {
    return [primary, path.join(home, ".agents", "skills", "ninja-p2p")];
  }

  return [primary];
}

export function getDefaultStateDir(streamId: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE || env.HOME;
  if (!home) {
    throw new Error("cannot determine home directory");
  }
  return path.join(home, ".ninja-p2p", streamId);
}

type CliOptionValue = string | string[];
type CliOptionValues = Record<string, CliOptionValue>;

function parseOptions(argv: string[], env: NodeJS.ProcessEnv): { values: CliOptionValues; positional: string[] } {
  const values: CliOptionValues = {};
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
    const existing = values[key];
    if (existing === undefined) {
      values[key] = next;
    } else if (Array.isArray(existing)) {
      existing.push(next);
    } else {
      values[key] = [existing, next];
    }
    i += 1;
  }

  if (!values.room && env.NINJA_ROOM) values.room = env.NINJA_ROOM;
  if (!values.name && env.NINJA_NAME) values.name = env.NINJA_NAME;
  if (!values.id && env.NINJA_ID) values.id = env.NINJA_ID;
  if (!values.role && env.NINJA_ROLE) values.role = env.NINJA_ROLE;
  if (!values.password && env.NINJA_PASSWORD) values.password = env.NINJA_PASSWORD;
  if (!values["state-dir"] && env.NINJA_STATE_DIR) values["state-dir"] = env.NINJA_STATE_DIR;
  if (!values["wait-ms"] && env.NINJA_WAIT_MS) values["wait-ms"] = env.NINJA_WAIT_MS;
  if (!values.runtime && env.NINJA_RUNTIME) values.runtime = env.NINJA_RUNTIME;
  if (!values.provider && env.NINJA_PROVIDER) values.provider = env.NINJA_PROVIDER;
  if (!values.model && env.NINJA_MODEL) values.model = env.NINJA_MODEL;
  if (!values.summary && env.NINJA_SUMMARY) values.summary = env.NINJA_SUMMARY;
  if (!values.workspace && env.NINJA_WORKSPACE) values.workspace = env.NINJA_WORKSPACE;
  if (!values.can && env.NINJA_CAN) values.can = env.NINJA_CAN;
  if (!values.ask && env.NINJA_ASKS) values.ask = env.NINJA_ASKS.split(";").map((item) => item.trim()).filter(Boolean);
  if (!values.share && env.NINJA_SHARE) values.share = env.NINJA_SHARE.split(";").map((item) => item.trim()).filter(Boolean);

  return { values, positional };
}

function buildCommonOptions(
  values: CliOptionValues,
  env: NodeJS.ProcessEnv,
  options?: { requireRoom?: boolean; requireStateDir?: boolean; allowGeneratedRoom?: boolean },
): CliCommonOptions {
  const requireRoom = options?.requireRoom ?? true;
  const room = getSingleValue(values, "room") || env.NINJA_ROOM || (options?.allowGeneratedRoom ? generateRoomName() : "");
  if (requireRoom && !room) {
    throw new Error("missing room; use --room my-room");
  }

  const runtime = getSingleValue(values, "runtime") || env.NINJA_RUNTIME;
  const name = getSingleValue(values, "name") || env.NINJA_NAME || defaultNameForRuntime(runtime);
  const streamId = getSingleValue(values, "id") || env.NINJA_ID || defaultStreamIdForRuntime(name, runtime);
  const role = getSingleValue(values, "role") || env.NINJA_ROLE || "agent";
  const passwordValue = getSingleValue(values, "password") ?? env.NINJA_PASSWORD;
  const password = passwordValue === "false" ? false : (passwordValue || false);
  const waitMsRaw = getSingleValue(values, "wait-ms") ?? env.NINJA_WAIT_MS ?? "1500";
  const waitMs = Number.parseInt(waitMsRaw, 10);
  const stateDir = getSingleValue(values, "state-dir") || env.NINJA_STATE_DIR || null;
  const sharedFolders = parseSharedFolderSpecs([
    ...getListValue(values, "share"),
    ...(env.NINJA_SHARE ? env.NINJA_SHARE.split(";") : []),
  ]);

  if (options?.requireStateDir && !stateDir) {
    throw new Error("missing state dir; use --state-dir or --id");
  }

  const agentProfile = buildAgentProfile(values, env, sharedFolders);

  return {
    room,
    streamId,
    name,
    role,
    password,
    waitMs: Number.isFinite(waitMs) ? waitMs : 1500,
    stateDir,
    agentProfile,
    sharedFolders,
  };
}

function resolveStateDir(values: CliOptionValues, env: NodeJS.ProcessEnv, fallbackStreamId?: string): string {
  const explicit = getSingleValue(values, "state-dir") || env.NINJA_STATE_DIR;
  if (explicit) return explicit;

  const streamId = getSingleValue(values, "id") || env.NINJA_ID || fallbackStreamId;
  if (!streamId) {
    throw new Error("missing state dir; use --state-dir or --id");
  }
  return getDefaultStateDir(streamId, env);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function shouldUseStateMode(values: CliOptionValues, env: NodeJS.ProcessEnv): boolean {
  if (getSingleValue(values, "state-dir") || env.NINJA_STATE_DIR) return true;
  return !getSingleValue(values, "room") && Boolean(getSingleValue(values, "id") || env.NINJA_ID);
}

function buildAgentProfile(values: CliOptionValues, env: NodeJS.ProcessEnv, sharedFolders: SharedFolderConfig[]): AgentProfile | undefined {
  const runtime = getSingleValue(values, "runtime") || env.NINJA_RUNTIME;
  const provider = getSingleValue(values, "provider") || env.NINJA_PROVIDER;
  const model = getSingleValue(values, "model") || env.NINJA_MODEL;
  const summary = getSingleValue(values, "summary") || env.NINJA_SUMMARY;
  const workspace = getSingleValue(values, "workspace") || env.NINJA_WORKSPACE;
  const can = splitList(getListValue(values, "can"), ",", env.NINJA_CAN);
  const asks = parseAgentAsks([
    ...getListValue(values, "ask"),
    ...(env.NINJA_ASKS ? env.NINJA_ASKS.split(";") : []),
  ]);

  if (!runtime && !provider && !model && !summary && !workspace && can.length === 0 && asks.length === 0 && sharedFolders.length === 0) {
    return undefined;
  }

  const profile: AgentProfile = {};
  if (runtime) profile.runtime = runtime;
  if (provider) profile.provider = provider;
  if (model) profile.model = model;
  if (summary) profile.summary = summary;
  if (workspace) profile.workspace = workspace;
  if (can.length > 0) profile.can = can;
  if (asks.length > 0) profile.asks = asks;
  if (sharedFolders.length > 0) profile.shares = toSharedFolderSummaries(sharedFolders);
  return profile;
}

function getSingleValue(values: CliOptionValues, key: string): string | undefined {
  const value = values[key];
  if (Array.isArray(value)) {
    return value[value.length - 1];
  }
  return value;
}

function getListValue(values: CliOptionValues, key: string): string[] {
  const value = values[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function splitList(rawValues: string[], delimiter: string, fallback?: string): string[] {
  const values = [...rawValues];
  if (values.length === 0 && fallback) {
    values.push(fallback);
  }
  return [...new Set(values
    .flatMap((value) => value.split(delimiter))
    .map((value) => value.trim())
    .filter(Boolean))];
}

function parseAgentAsks(values: string[]): AgentAsk[] {
  const asks: AgentAsk[] = [];
  const seen = new Set<string>();

  for (const raw of values.map((value) => value.trim()).filter(Boolean)) {
    const separatorIndex = raw.indexOf("=") >= 0 ? raw.indexOf("=") : raw.indexOf(":");
    const name = (separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw).trim();
    const description = (separatorIndex >= 0 ? raw.slice(separatorIndex + 1) : raw).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    asks.push({
      name,
      description: description || `${name} command`,
    });
  }

  return asks;
}
