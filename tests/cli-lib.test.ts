import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  defaultNameForRuntime,
  defaultStreamId,
  defaultStreamIdForRuntime,
  getDefaultStateDir,
  getSkillInstallTarget,
  getSkillInstallTargets,
  helpText,
  parseCliArgs,
} from "../src/cli-lib.js";

test("help text includes the simple install and connect flow", () => {
  const text = helpText();
  assert.match(text, /ninja-p2p menu/);
  assert.match(text, /ninja-p2p start --id claude/);
  assert.match(text, /ninja-p2p room --id codex/);
  assert.match(text, /npm install -g @vdoninja\/ninja-p2p @roamhq\/wrtc/);
  assert.match(text, /ninja-p2p connect --room my-room --name Claude/);
  assert.match(text, /ninja-p2p start --room ai-room --id codex/);
  assert.match(text, /ninja-p2p command --id codex claude capabilities/);
  assert.match(text, /ninja-p2p shares --id codex worker/);
  assert.match(text, /ninja-p2p list-files --id codex worker docs/);
  assert.match(text, /ninja-p2p get-file --id codex worker docs guide.md/);
  assert.match(text, /ninja-p2p send-file --id codex worker/);
  assert.match(text, /ninja-p2p send-image --id codex worker/);
  assert.match(text, /ninja-p2p plan --id codex planner "Propose a safe rollout plan"/);
  assert.match(text, /ninja-p2p task --id codex worker "Implement the patch"/);
  assert.match(text, /ninja-p2p approve --id codex reviewer "Approve this plan before I continue"/);
  assert.match(text, /ninja-p2p respond --id codex planner <requestId>/);
  assert.match(text, /ninja-p2p event --id codex builds build_failed/);
});

test("parseCliArgs parses connect command", () => {
  const parsed = parseCliArgs(["connect", "--room", "demo", "--name", "Claude"]);
  assert.equal(parsed.kind, "connect");
  if (parsed.kind !== "connect") return;
  assert.equal(parsed.options.room, "demo");
  assert.equal(parsed.options.name, "Claude");
  assert.equal(parsed.options.role, "agent");
});

test("parseCliArgs parses install-skill command", () => {
  const parsed = parseCliArgs(["install-skill", "codex"]);
  assert.equal(parsed.kind, "install-skill");
  if (parsed.kind !== "install-skill") return;
  assert.equal(parsed.runtime, "codex");
});

test("parseCliArgs parses menu command with default state dir", () => {
  const parsed = parseCliArgs(["menu", "--runtime", "claude-code"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "menu");
  if (parsed.kind !== "menu") return;
  assert.equal(parsed.options.name, "Claude");
  assert.equal(parsed.options.streamId, "claude");
  assert.equal(parsed.options.stateDir, path.join("/home/steve", ".ninja-p2p", "claude"));
});

test("parseCliArgs parses agent command with default state dir", () => {
  const parsed = parseCliArgs(["agent", "--room", "demo", "--name", "Codex", "--id", "codex"], {
    USERPROFILE: "C:\\Users\\steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "agent");
  if (parsed.kind !== "agent") return;
  assert.equal(parsed.options.stateDir, path.join("C:\\Users\\steve", ".ninja-p2p", "codex"));
});

test("parseCliArgs parses start command with default state dir", () => {
  const parsed = parseCliArgs([
    "start",
    "--room", "demo",
    "--name", "Codex",
    "--id", "codex",
    "--runtime", "codex-cli",
    "--provider", "openai",
    "--model", "gpt-5",
    "--summary", "Reviews and edits code",
    "--can", "review,tests",
    "--can", "edit",
    "--ask", "review=Review a diff",
    "--ask", "implement:Implement a scoped change",
    "--share", "docs=./docs",
  ], {
    USERPROFILE: "C:\\Users\\steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "start");
  if (parsed.kind !== "start") return;
  assert.equal(parsed.options.stateDir, path.join("C:\\Users\\steve", ".ninja-p2p", "codex"));
  assert.deepEqual(parsed.options.agentProfile, {
    runtime: "codex-cli",
    provider: "openai",
    model: "gpt-5",
    summary: "Reviews and edits code",
    can: ["review", "tests", "edit"],
    asks: [
      { name: "review", description: "Review a diff" },
      { name: "implement", description: "Implement a scoped change" },
    ],
    shares: [
      { name: "docs" },
    ],
  });
  assert.deepEqual(parsed.options.sharedFolders, [
    { name: "docs", path: path.join(process.cwd(), "docs") },
  ]);
});

test("parseCliArgs start generates a room and stable Claude defaults", () => {
  const parsed = parseCliArgs(["start", "--runtime", "claude-code"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "start");
  if (parsed.kind !== "start") return;
  assert.match(parsed.options.room, /^clawd_[a-f0-9]{32}$/);
  assert.equal(parsed.options.name, "Claude");
  assert.equal(parsed.options.streamId, "claude");
  assert.equal(parsed.options.stateDir, path.join("/home/steve", ".ninja-p2p", "claude"));
});

test("parseCliArgs parses status command", () => {
  const parsed = parseCliArgs(["status", "--id", "codex"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "status");
  if (parsed.kind !== "status") return;
  assert.equal(parsed.stateDir, path.join("/home/steve", ".ninja-p2p", "codex"));
});

test("parseCliArgs parses room command", () => {
  const parsed = parseCliArgs(["room", "--id", "codex"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "room");
  if (parsed.kind !== "room") return;
  assert.equal(parsed.stateDir, path.join("/home/steve", ".ninja-p2p", "codex"));
});

test("parseCliArgs parses stop command", () => {
  const parsed = parseCliArgs(["stop", "--id", "codex"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "stop");
  if (parsed.kind !== "stop") return;
  assert.equal(parsed.stateDir, path.join("/home/steve", ".ninja-p2p", "codex"));
});

test("parseCliArgs parses notify command", () => {
  const parsed = parseCliArgs(["notify", "--id", "codex"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "notify");
  if (parsed.kind !== "notify") return;
  assert.equal(parsed.stateDir, path.join("/home/steve", ".ninja-p2p", "codex"));
});

test("parseCliArgs parses read command", () => {
  const parsed = parseCliArgs(["read", "--id", "codex", "--take", "10", "--peek", "true"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "read");
  if (parsed.kind !== "read") return;
  assert.equal(parsed.take, 10);
  assert.equal(parsed.peek, true);
});

test("parseCliArgs parses chat command", () => {
  const parsed = parseCliArgs(["chat", "--room", "demo", "--name", "Steve", "hello", "world"]);
  assert.equal(parsed.kind, "chat");
  if (parsed.kind !== "chat") return;
  assert.equal(parsed.text, "hello world");
  assert.equal(parsed.options.stateDir, null);
  assert.equal(parsed.options.agentProfile, undefined);
});

test("parseCliArgs uses state mode for chat when only id is provided", () => {
  const parsed = parseCliArgs(["chat", "--id", "codex", "hello"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "chat");
  if (parsed.kind !== "chat") return;
  assert.equal(parsed.options.room, "");
  assert.equal(parsed.options.stateDir, path.join("/home/steve", ".ninja-p2p", "codex"));
});

test("parseCliArgs parses direct message command", () => {
  const parsed = parseCliArgs(["dm", "--room", "demo", "--name", "Steve", "worker_bot", "hello"]);
  assert.equal(parsed.kind, "dm");
  if (parsed.kind !== "dm") return;
  assert.equal(parsed.target, "worker_bot");
  assert.equal(parsed.text, "hello");
});

test("parseCliArgs parses send-file command", () => {
  const parsed = parseCliArgs(["send-file", "--room", "demo", "--name", "Steve", "worker_bot", "./notes.txt"]);
  assert.equal(parsed.kind, "send-file");
  if (parsed.kind !== "send-file") return;
  assert.equal(parsed.target, "worker_bot");
  assert.equal(parsed.filePath, "./notes.txt");
});

test("parseCliArgs parses send-image command in state mode", () => {
  const parsed = parseCliArgs(["send-image", "--id", "codex", "worker", ".\\diagram.png"], {
    USERPROFILE: "C:\\Users\\steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "send-image");
  if (parsed.kind !== "send-image") return;
  assert.equal(parsed.target, "worker");
  assert.equal(parsed.filePath, ".\\diagram.png");
  assert.equal(parsed.options.stateDir, path.join("C:\\Users\\steve", ".ninja-p2p", "codex"));
});

test("parseCliArgs parses shares command", () => {
  const parsed = parseCliArgs(["shares", "--id", "codex", "worker"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "shares");
  if (parsed.kind !== "shares") return;
  assert.equal(parsed.target, "worker");
  assert.equal(parsed.options.stateDir, path.join("/home/steve", ".ninja-p2p", "codex"));
});

test("parseCliArgs parses list-files command", () => {
  const parsed = parseCliArgs(["list-files", "--room", "demo", "worker", "docs", "api"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "list-files");
  if (parsed.kind !== "list-files") return;
  assert.equal(parsed.target, "worker");
  assert.equal(parsed.share, "docs");
  assert.equal(parsed.folderPath, "api");
});

test("parseCliArgs parses get-file command", () => {
  const parsed = parseCliArgs(["get-file", "--id", "codex", "worker", "docs", "guide.md"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "get-file");
  if (parsed.kind !== "get-file") return;
  assert.equal(parsed.target, "worker");
  assert.equal(parsed.share, "docs");
  assert.equal(parsed.filePath, "guide.md");
  assert.equal(parsed.options.stateDir, path.join("/home/steve", ".ninja-p2p", "codex"));
});

test("parseCliArgs parses command with JSON args", () => {
  const parsed = parseCliArgs([
    "command",
    "--room",
    "demo",
    "--name",
    "Steve",
    "worker_bot",
    "status",
    "{\"deep\":true}",
  ]);
  assert.equal(parsed.kind, "command");
  if (parsed.kind !== "command") return;
  assert.deepEqual(parsed.args, { deep: true });
});

test("parseCliArgs parses respond command with JSON result", () => {
  const parsed = parseCliArgs([
    "respond",
    "--id",
    "reviewer",
    "planner",
    "req_123",
    "{\"approved\":true}",
  ], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "respond");
  if (parsed.kind !== "respond") return;
  assert.equal(parsed.target, "planner");
  assert.equal(parsed.requestId, "req_123");
  assert.deepEqual(parsed.result, { approved: true });
  assert.equal(parsed.options.stateDir, path.join("/home/steve", ".ninja-p2p", "reviewer"));
});

test("parseCliArgs parses event command with JSON data", () => {
  const parsed = parseCliArgs([
    "event",
    "--room",
    "demo",
    "--name",
    "Steve",
    "builds",
    "build_failed",
    "{\"job\":\"api\"}",
  ]);
  assert.equal(parsed.kind, "event");
  if (parsed.kind !== "event") return;
  assert.equal(parsed.topic, "builds");
  assert.equal(parsed.eventKind, "build_failed");
  assert.deepEqual(parsed.data, { job: "api" });
});

test("parseCliArgs parses task helper command", () => {
  const parsed = parseCliArgs(["task", "--id", "codex", "worker", "Implement", "the", "fix"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "task");
  if (parsed.kind !== "task") return;
  assert.equal(parsed.target, "worker");
  assert.equal(parsed.request, "Implement the fix");
  assert.equal(parsed.options.stateDir, path.join("/home/steve", ".ninja-p2p", "codex"));
  assert.deepEqual(parsed.options.sharedFolders, []);
});

test("parseCliArgs parses review helper command", () => {
  const parsed = parseCliArgs(["review", "--room", "demo", "reviewer", "Review", "this", "diff"]);
  assert.equal(parsed.kind, "review");
  if (parsed.kind !== "review") return;
  assert.equal(parsed.target, "reviewer");
  assert.equal(parsed.request, "Review this diff");
});

test("parseCliArgs parses plan helper command", () => {
  const parsed = parseCliArgs(["plan", "--room", "demo", "planner", "Suggest", "the", "steps"]);
  assert.equal(parsed.kind, "plan");
  if (parsed.kind !== "plan") return;
  assert.equal(parsed.target, "planner");
  assert.equal(parsed.request, "Suggest the steps");
});

test("parseCliArgs parses approve helper command", () => {
  const parsed = parseCliArgs(["approve", "--room", "demo", "reviewer", "Approve", "the", "plan"]);
  assert.equal(parsed.kind, "approve");
  if (parsed.kind !== "approve") return;
  assert.equal(parsed.target, "reviewer");
  assert.equal(parsed.request, "Approve the plan");
});

test("defaultStreamId creates a readable id", () => {
  const id = defaultStreamId("Claude Code");
  assert.match(id, /^claude_code_[A-Za-z0-9_-]{6}$/);
});

test("runtime defaults pick friendly names and stable ids for Claude and Codex", () => {
  assert.equal(defaultNameForRuntime("claude-code"), "Claude");
  assert.equal(defaultNameForRuntime("codex-cli"), "Codex");
  assert.equal(defaultStreamIdForRuntime("Claude", "claude-code"), "claude");
  assert.equal(defaultStreamIdForRuntime("Codex", "codex-cli"), "codex");
});

test("getSkillInstallTarget uses tool-specific user directories", () => {
  assert.equal(
    getSkillInstallTarget("codex", { USERPROFILE: "C:\\Users\\steve" } as NodeJS.ProcessEnv),
    path.join("C:\\Users\\steve", ".codex", "skills", "ninja-p2p"),
  );
  assert.equal(
    getSkillInstallTarget("claude", { HOME: "/home/steve" } as NodeJS.ProcessEnv),
    path.join("/home/steve", ".claude", "skills", "ninja-p2p"),
  );
});

test("getSkillInstallTargets includes a Codex compatibility copy", () => {
  assert.deepEqual(
    getSkillInstallTargets("codex", { USERPROFILE: "C:\\Users\\steve" } as NodeJS.ProcessEnv),
    [
      path.join("C:\\Users\\steve", ".codex", "skills", "ninja-p2p"),
      path.join("C:\\Users\\steve", ".agents", "skills", "ninja-p2p"),
    ],
  );
  assert.deepEqual(
    getSkillInstallTargets("claude", { HOME: "/home/steve" } as NodeJS.ProcessEnv),
    [path.join("/home/steve", ".claude", "skills", "ninja-p2p")],
  );
});

test("getDefaultStateDir uses the per-user ninja-p2p folder", () => {
  assert.equal(
    getDefaultStateDir("codex", { USERPROFILE: "C:\\Users\\steve" } as NodeJS.ProcessEnv),
    path.join("C:\\Users\\steve", ".ninja-p2p", "codex"),
  );
});

test("parseCliArgs connect generates a room when omitted", () => {
  const parsed = parseCliArgs(["connect", "--runtime", "claude-code"], {
    HOME: "/home/steve",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "connect");
  if (parsed.kind !== "connect") return;
  assert.match(parsed.options.room, /^clawd_[a-f0-9]{32}$/);
  assert.equal(parsed.options.name, "Claude");
  assert.equal(parsed.options.streamId, "claude");
});

test("parseCliArgs rejects invalid install-skill target", () => {
  assert.throws(() => parseCliArgs(["install-skill", "mcp"]), /install-skill requires 'codex' or 'claude'/);
});

test("parseCliArgs rejects notify without state-dir or id", () => {
  assert.throws(() => parseCliArgs(["notify"], {} as NodeJS.ProcessEnv), /missing state dir/);
});

test("parseCliArgs builds agent profile from environment", () => {
  const parsed = parseCliArgs(["agent", "--room", "demo", "--id", "claude"], {
    HOME: "/home/steve",
    NINJA_RUNTIME: "claude-code",
    NINJA_PROVIDER: "anthropic",
    NINJA_MODEL: "sonnet",
    NINJA_SUMMARY: "Handles planning and review",
    NINJA_WORKSPACE: "/repo",
    NINJA_CAN: "plan,review",
    NINJA_ASKS: "review:Review a patch;handoff:Take over a task",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.kind, "agent");
  if (parsed.kind !== "agent") return;
  assert.deepEqual(parsed.options.agentProfile, {
    runtime: "claude-code",
    provider: "anthropic",
    model: "sonnet",
    summary: "Handles planning and review",
    workspace: "/repo",
    can: ["plan", "review"],
    asks: [
      { name: "review", description: "Review a patch" },
      { name: "handoff", description: "Take over a task" },
    ],
  });
  assert.deepEqual(parsed.options.sharedFolders, []);
});
