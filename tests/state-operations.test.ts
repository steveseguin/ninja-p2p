import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureAgentState, getAgentReceipt, pruneAgentArchive, queueAgentAction, storeInboxMessage, takeInboxMessages } from "../src/agent-state.js";
import { createEnvelope, type MessageEnvelope } from "../src/protocol.js";
import { parseCliArgs } from "../src/cli-lib.js";
import { initialHandoffStatus, isHandoff, storeHandoff, writeHandoffStatus } from "../src/handoff.js";

const peer = { streamId: "reviewer", instanceId: "one", role: "agent", name: "Reviewer" };
function temporary(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-state-ops-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("concurrent CLI readers claim every handoff once even when request text is identical", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-handoff-readers-"));
  try {
    const expected = Array.from({ length: 24 }, () => createEnvelope(peer, "handoff", {
      request: "same request", expiresAt: Date.now() + 60_000,
    }, { to: "worker" }));
    for (const message of expected) storeHandoff(dir, message);
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const read = () => new Promise<MessageEnvelope[]>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", cli, "read", "--state-dir", dir, "--take", "24"],
        { windowsHide: true, timeout: 10_000 });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.on("error", reject);
      child.on("close", code => {
        if (code !== 0) return reject(new Error(stderr || `reader exited ${code}`));
        try { resolve(JSON.parse(stdout).messages); } catch (error) { reject(error); }
      });
    });
    const delivered = (await Promise.all([read(), read(), read(), read()])).flat();
    assert.equal(delivered.length, expected.length, "no duplicates or unexplained exclusions");
    assert.deepEqual(delivered.map(message => message.id).sort(), expected.map(message => message.id).sort());
    for (const message of expected) assert.equal(storeHandoff(dir, message), "duplicate");
    assert.deepEqual(takeInboxMessages(dir, 30), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI handoff prints a request ID and receipt waiting reports storage or timeout without consuming mail", () => temporary(dir => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const invoke = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...args, "--state-dir", dir],
    { encoding: "utf8", timeout: 10_000, windowsHide: true });
  const queued = invoke(["handoff", "reviewer", "Review the patch"]);
  assert.equal(queued.status, 0, queued.stderr);
  const { requestId } = JSON.parse(queued.stdout);
  assert.equal(typeof requestId, "string");
  const timeout = invoke(["receipt", requestId, "--from", "reviewer", "--timeout", "40"]);
  assert.equal(timeout.status, 1, timeout.stderr);
  const waiting = JSON.parse(timeout.stdout);
  assert.equal(waiting.status, "queued");
  assert.equal(waiting.timedOut, true);
  assert.ok(waiting.waitedMs >= 40 && waiting.waitedMs < 2000);

  const request = { ...createEnvelope(peer, "handoff", { request: "Review the patch", expiresAt: Date.now() + 60_000 }, { to: "reviewer" }), id: requestId };
  assert.ok(isHandoff(request));
  const ack = createEnvelope(peer, "ack", { forType: "handoff", receipt: "stored", messageId: requestId, senderInstanceId: peer.instanceId }, { to: "worker" });
  writeHandoffStatus(dir, { ...initialHandoffStatus(request), status: "stored", receipt: ack });
  storeInboxMessage(dir, createEnvelope(peer, "chat", { text: "unrelated pending mail" }));
  const confirmed = invoke(["receipt", requestId, "--from", "reviewer", "--timeout", "5000"]);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(JSON.parse(confirmed.stdout).status, "stored");
  assert.equal(takeInboxMessages(dir, 20, true).length, 1);
}));

test("archive pruning previews first, combines age and keep, and preserves active/malformed state", () => temporary(dir => {
  const paths = ensureAgentState(dir);
  const files = [1, 2, 3].map(index => {
    const file = path.join(paths.archiveDir, `${index}.json`);
    writeFileSync(file, JSON.stringify({ envelope: createEnvelope(peer, "chat", "old"), receivedAt: 0 }));
    const date = new Date(Date.now() - (40 - index) * 86400000);
    utimesSync(file, date, date);
    return file;
  });
  const fresh = path.join(paths.archiveDir, "fresh.json");
  writeFileSync(fresh, JSON.stringify({ envelope: createEnvelope(peer, "chat", "fresh") }));
  const malformed = path.join(paths.archiveDir, "broken.json");
  writeFileSync(malformed, "{broken");
  const unread = storeInboxMessage(dir, createEnvelope(peer, "chat", "unread"));
  queueAgentAction(dir, { kind: "dm", target: "reviewer", text: "queued" });
  const options = { olderThanDays: 30, keep: 2 };
  const preview = pruneAgentArchive(dir, options);
  assert.deepEqual(preview.candidates.sort(), files.slice(0, 2));
  assert.deepEqual(preview.removed, []);
  files.forEach(file => assert.ok(existsSync(file)));
  const applied = pruneAgentArchive(dir, { ...options, apply: true });
  assert.deepEqual(applied.removed.sort(), files.slice(0, 2));
  for (const file of [files[2], fresh, malformed, unread.path]) assert.ok(existsSync(file));
  assert.equal(readFileSync(malformed, "utf8"), "{broken");
  assert.deepEqual(pruneAgentArchive(dir, options).candidates, []);
  for (const value of [-1, NaN, Infinity, 0.5]) {
    assert.throws(() => pruneAgentArchive(dir, { olderThanDays: value, keep: 0 }), /olderThanDays/);
    assert.throws(() => pruneAgentArchive(dir, { olderThanDays: 0, keep: value }), /keep/);
  }
}));

test("receipt lookup preserves evidence, rejects unrelated peers, and never treats ack as execution", () => temporary(dir => {
  const action = queueAgentAction(dir, { kind: "command", target: peer.streamId, command: "review" });
  assert.equal(getAgentReceipt(dir, action.id, peer.streamId).status, "queued");
  storeInboxMessage(dir, createEnvelope({ ...peer, streamId: "stranger" }, "command_response", { requestId: action.id, ok: true }));
  storeInboxMessage(dir, createEnvelope(peer, "command_response", { requestId: action.id, ok: "true" }));
  assert.equal(getAgentReceipt(dir, action.id, peer.streamId).status, "queued");
  const ack = createEnvelope(peer, "ack", { messageId: action.id });
  storeInboxMessage(dir, ack);
  assert.equal(getAgentReceipt(dir, action.id, peer.streamId).status, "acknowledged");
  takeInboxMessages(dir, 20);
  storeInboxMessage(dir, ack); // A repeated receipt is not new evidence.
  const response = { ...createEnvelope(peer, "command_response", { requestId: action.id, ok: false, error: "declined" }), ts: ack.ts + 1 };
  storeInboxMessage(dir, response);
  const result = getAgentReceipt(dir, action.id, peer.streamId);
  assert.equal(result.status, "responded");
  assert.equal(result.queued, true); // Preserve crash-window state instead of deleting the action.
  assert.deepEqual(result.receipts.map(item => item.id), [ack.id, response.id]);
  assert.equal(getAgentReceipt(dir, "unknown-id", peer.streamId).status, "unknown");
  assert.equal(takeInboxMessages(dir, 20, true).length, 2);
}));

test("pruning refuses an archive junction and leaves its target intact", () => temporary(dir => {
  const outside = path.join(dir, "unrelated");
  mkdirSync(outside);
  const state = path.join(dir, "state");
  mkdirSync(state);
  const file = path.join(outside, "keep.json");
  writeFileSync(file, JSON.stringify({ envelope: createEnvelope(peer, "chat", "keep") }));
  symlinkSync(outside, path.join(state, "archive"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => pruneAgentArchive(state, { olderThanDays: 0, keep: 0, apply: true }), /linked archive/);
  assert.ok(existsSync(file));
}));

test("maintenance CLI requires explicit retention controls and peer correlation", () => {
  const base = ["prune-archive", "--state-dir", "./state"];
  assert.throws(() => parseCliArgs(base), /requires/);
  const args = [...base, "--older-than-days", "30", "--keep-newest", "200"];
  assert.deepEqual(parseCliArgs(args), { kind: "prune-archive", stateDir: "./state", olderThanDays: 30, keep: 200, apply: false });
  assert.equal((parseCliArgs([...args, "--apply", "true"]) as { apply: boolean }).apply, true);
  assert.throws(() => parseCliArgs([...args, "--apply", "yes"]), /apply/);
  assert.throws(() => parseCliArgs(["receipt", "id", "--state-dir", "./state"]), /--from/);
  assert.deepEqual(parseCliArgs(["receipt", "id", "--state-dir", "./state", "--from", "reviewer"]),
    { kind: "receipt", stateDir: "./state", requestId: "id", peer: "reviewer" });
});

test("maintenance commands run through the CLI without consuming active mail", () => temporary(dir => {
  const receipt = createEnvelope(peer, "command_response", { requestId: "request-123", ok: true, result: "reviewed" });
  storeInboxMessage(dir, receipt);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const invoke = (args: string[]) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args, "--state-dir", dir],
      { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const status = invoke(["receipt", "request-123", "--from", peer.streamId]);
  assert.equal(status.status, "responded");
  assert.equal(status.receipts[0].payload.result, "reviewed");
  assert.equal(takeInboxMessages(dir, 20, true).length, 1);
  const [archived] = takeInboxMessages(dir, 1);
  const old = new Date(Date.now() - 40 * 86400000);
  utimesSync(archived.path, old, old);
  const args = ["prune-archive", "--older-than-days", "30", "--keep-newest", "0"];
  assert.equal(invoke(args).dryRun, true);
  assert.ok(existsSync(archived.path));
  assert.deepEqual(invoke([...args, "--apply", "true"]).removed, [archived.path]);
  assert.equal(invoke(["receipt", "request-123", "--from", peer.streamId]).status, "unknown");
}));
