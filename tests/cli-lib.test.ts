import assert from "node:assert/strict";
import test from "node:test";

import { defaultStreamId, helpText, parseCliArgs } from "../src/cli-lib.js";

test("help text includes the simple install and connect flow", () => {
  const text = helpText();
  assert.match(text, /npm install -g @vdoninja\/ninja-p2p @roamhq\/wrtc/);
  assert.match(text, /ninja-p2p connect --room my-room --name Claude/);
});

test("parseCliArgs parses connect command", () => {
  const parsed = parseCliArgs(["connect", "--room", "demo", "--name", "Claude"]);
  assert.equal(parsed.kind, "connect");
  if (parsed.kind !== "connect") return;
  assert.equal(parsed.options.room, "demo");
  assert.equal(parsed.options.name, "Claude");
  assert.equal(parsed.options.role, "agent");
});

test("parseCliArgs parses chat command", () => {
  const parsed = parseCliArgs(["chat", "--room", "demo", "--name", "Steve", "hello", "world"]);
  assert.equal(parsed.kind, "chat");
  if (parsed.kind !== "chat") return;
  assert.equal(parsed.text, "hello world");
});

test("parseCliArgs parses direct message command", () => {
  const parsed = parseCliArgs(["dm", "--room", "demo", "--name", "Steve", "worker_bot", "hello"]);
  assert.equal(parsed.kind, "dm");
  if (parsed.kind !== "dm") return;
  assert.equal(parsed.target, "worker_bot");
  assert.equal(parsed.text, "hello");
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

test("defaultStreamId creates a readable id", () => {
  const id = defaultStreamId("Claude Code");
  assert.match(id, /^claude_code_[A-Za-z0-9_-]{6}$/);
});

test("parseCliArgs rejects missing room", () => {
  assert.throws(() => parseCliArgs(["connect"]), /missing room/);
});
