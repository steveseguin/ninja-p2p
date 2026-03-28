#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const baseDir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-live-"));
const room = `live-${Math.random().toString(36).slice(2, 10)}`;

const agents = {
  planner: {
    stateDir: path.join(baseDir, "planner"),
    args: [
      "start",
      "--room", room,
      "--name", "Planner",
      "--id", "planner",
      "--state-dir", path.join(baseDir, "planner"),
      "--runtime", "codex-cli",
      "--provider", "openai",
      "--model", "gpt-5",
      "--summary", "Coordinates work and requests approval before risky steps",
      "--can", "plan,coordination",
      "--ask", "handoff:Break work into steps",
    ],
  },
  worker: {
    stateDir: path.join(baseDir, "worker"),
    args: [
      "start",
      "--room", room,
      "--name", "Worker",
      "--id", "worker",
      "--state-dir", path.join(baseDir, "worker"),
      "--runtime", "claude-code",
      "--provider", "anthropic",
      "--model", "sonnet",
      "--summary", "Implements patches and runs tests",
      "--can", "edit,tests,debug",
      "--ask", "implement:Implement a scoped patch",
    ],
  },
  reviewer: {
    stateDir: path.join(baseDir, "reviewer"),
    args: [
      "start",
      "--room", room,
      "--name", "Reviewer",
      "--id", "reviewer",
      "--state-dir", path.join(baseDir, "reviewer"),
      "--runtime", "codex-cli",
      "--provider", "openai",
      "--model", "gpt-5",
      "--summary", "Reviews diffs, gives second opinions, and approves plans",
      "--can", "review,approve,docs",
      "--ask", "github-review:Review a GitHub pull request or diff",
    ],
  },
  operator: {
    stateDir: path.join(baseDir, "operator"),
    args: [
      "start",
      "--room", room,
      "--name", "Operator",
      "--id", "operator",
      "--state-dir", path.join(baseDir, "operator"),
      "--runtime", "web",
      "--provider", "human",
      "--model", "browser",
      "--summary", "Human operator monitoring the room",
      "--can", "monitor,chat,command",
    ],
  },
};

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`command failed: node ${path.relative(repoRoot, cliPath)} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function runCliJson(args) {
  const output = runCli(args);
  return JSON.parse(output);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs = 60000, intervalMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function statusFor(name) {
  return runCliJson(["status", "--state-dir", agents[name].stateDir]);
}

function notifyFor(name) {
  return runCliJson(["notify", "--state-dir", agents[name].stateDir]);
}

function readFor(name, take = 20, peek = true) {
  const args = ["read", "--state-dir", agents[name].stateDir, "--take", String(take)];
  if (peek) {
    args.push("--peek", "true");
  }
  return runCliJson(args);
}

function sendFrom(name, ...args) {
  return runCli(args.flatMap((value) => String(value)));
}

function stopAll() {
  for (const { stateDir } of Object.values(agents)) {
    try {
      runCli(["stop", "--state-dir", stateDir]);
    } catch {
      // best effort cleanup
    }
  }
}

function expectMessage(messages, predicate, description) {
  const message = messages.find(predicate);
  assert.ok(message, `missing message: ${description}`);
  return message;
}

async function main() {
  let succeeded = false;
  try {
    const fixturesDir = path.join(baseDir, "fixtures");
    const notePath = path.join(fixturesDir, "operator-notes.txt");
    const imagePath = path.join(fixturesDir, "review.png");
    const sharedDocsDir = path.join(fixturesDir, "shared-docs");
    const sharedGuidePath = path.join(sharedDocsDir, "guide.md");
    mkdirSync(fixturesDir, { recursive: true });
    mkdirSync(sharedDocsDir, { recursive: true });
    writeFileSync(notePath, "planner: ask reviewer for approval before rollout\n", "utf8");
    writeFileSync(imagePath, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlH0KQAAAAASUVORK5CYII=",
      "base64",
    ));
    writeFileSync(sharedGuidePath, "shared guide for planner\n", "utf8");

    agents.worker.args.push("--share", `docs=${sharedDocsDir}`);

    for (const agent of Object.values(agents)) {
      runCli(agent.args);
    }

    const converged = await waitFor("all agents to discover each other", () => {
      const snapshots = Object.keys(agents).map((name) => [name, statusFor(name)]);
      const ready = snapshots.every(([, status]) => status.running && status.connected && status.peersKnown >= 3);
      return ready ? Object.fromEntries(snapshots) : null;
    });

    const plannerNotify = notifyFor("planner");
    assert.ok(plannerNotify.peers.some((peer) => peer.streamId === "worker" && peer.can.includes("edit")), "planner did not learn worker capabilities");
    assert.ok(plannerNotify.peers.some((peer) => peer.streamId === "reviewer" && peer.can.includes("approve")), "planner did not learn reviewer approval capability");
    assert.ok(plannerNotify.peers.some((peer) => peer.streamId === "worker" && peer.shares.some((share) => share.name === "docs")), "planner did not learn worker shared folder");

    sendFrom("planner", "command", "--state-dir", agents.planner.stateDir, "worker", "capabilities");
    sendFrom("planner", "shares", "--state-dir", agents.planner.stateDir, "worker");
    sendFrom("planner", "list-files", "--state-dir", agents.planner.stateDir, "worker", "docs");
    sendFrom("planner", "get-file", "--state-dir", agents.planner.stateDir, "worker", "docs", "guide.md");
    sendFrom("planner", "plan", "--state-dir", agents.planner.stateDir, "worker", "Suggest a safe rollout for the parser refactor");
    sendFrom("planner", "task", "--state-dir", agents.planner.stateDir, "worker", "Implement parser fixes and add regression coverage");
    sendFrom("planner", "review", "--state-dir", agents.planner.stateDir, "reviewer", "Review GitHub PR #42 parser changes for regressions");
    sendFrom("planner", "approve", "--state-dir", agents.planner.stateDir, "reviewer", "Approve the parser rollout plan before implementation continues");
    sendFrom("operator", "command", "--state-dir", agents.operator.stateDir, "planner", "status");
    sendFrom("worker", "event", "--state-dir", agents.worker.stateDir, "events", "build_failed", "{\"job\":\"parser-ci\",\"reason\":\"failing regression\"}");
    sendFrom("operator", "send-file", "--state-dir", agents.operator.stateDir, "worker", notePath);
    sendFrom("reviewer", "send-image", "--state-dir", agents.reviewer.stateDir, "planner", imagePath);

    const workerInbox = await waitFor("worker to receive planning and task requests", () => {
      const inbox = readFor("worker");
      const commands = inbox.messages.filter((message) => message.type === "command");
      const hasPlan = commands.some((message) => message.payload?.command === "plan");
      const hasTask = commands.some((message) => message.payload?.command === "task");
      return hasPlan && hasTask ? inbox : null;
    });

    const reviewerInbox = await waitFor("reviewer to receive review and approval requests", () => {
      const inbox = readFor("reviewer");
      const commands = inbox.messages.filter((message) => message.type === "command");
      const hasReview = commands.some((message) => message.payload?.command === "review");
      const hasApprove = commands.some((message) => message.payload?.command === "approve");
      return hasReview && hasApprove ? inbox : null;
    });

    const operatorInbox = await waitFor("operator to receive planner status", () => {
      const inbox = readFor("operator");
      return inbox.messages.some((message) => message.type === "command_response") ? inbox : null;
    });

    const workerPlan = expectMessage(workerInbox.messages, (message) => message.type === "command" && message.payload?.command === "plan", "worker plan request");
    const workerTask = expectMessage(workerInbox.messages, (message) => message.type === "command" && message.payload?.command === "task", "worker task request");
    const reviewerReview = expectMessage(reviewerInbox.messages, (message) => message.type === "command" && message.payload?.command === "review", "review request");
    const reviewerApprove = expectMessage(reviewerInbox.messages, (message) => message.type === "command" && message.payload?.command === "approve", "approval request");
    const operatorStatus = expectMessage(operatorInbox.messages, (message) => message.type === "command_response", "operator status response");

    sendFrom("worker", "respond", "--state-dir", agents.worker.stateDir, "planner", workerPlan.id, "{\"steps\":[\"inspect diff\",\"patch parser\",\"run targeted tests\"],\"confidence\":\"medium\"}");
    sendFrom("worker", "respond", "--state-dir", agents.worker.stateDir, "planner", workerTask.id, "{\"accepted\":true,\"next\":\"implement parser fix\"}");
    sendFrom("reviewer", "respond", "--state-dir", agents.reviewer.stateDir, "planner", reviewerReview.id, "{\"summary\":\"Looks mostly good, add one regression test\",\"secondOpinion\":\"Parser edge case needs coverage\"}");
    sendFrom("reviewer", "respond", "--state-dir", agents.reviewer.stateDir, "planner", reviewerApprove.id, "{\"approved\":true,\"note\":\"Plan looks safe after test coverage is added\"}");

    const plannerInbox = await waitFor("planner to receive responses and event", () => {
      const inbox = readFor("planner");
      const responses = inbox.messages.filter((message) => message.type === "command_response");
      const hasCapabilityResponse = responses.some((message) => message.from.streamId === "worker");
      const hasSharesResponse = responses.some((message) => message.from.streamId === "worker" && Array.isArray(message.payload?.result?.shares));
      const hasListFilesResponse = responses.some((message) => message.from.streamId === "worker" && Array.isArray(message.payload?.result?.entries));
      const hasGuide = inbox.messages.some((message) => message.type === "event" && message.payload?.kind === "file_received" && message.payload?.name === "guide.md");
      const hasPlanResponse = responses.some((message) => message.payload?.requestId === workerPlan.id);
      const hasTaskResponse = responses.some((message) => message.payload?.requestId === workerTask.id);
      const hasReviewResponse = responses.some((message) => message.payload?.requestId === reviewerReview.id);
      const hasApprovalResponse = responses.some((message) => message.payload?.requestId === reviewerApprove.id);
      const hasBuildEvent = inbox.messages.some((message) => message.type === "event" && message.payload?.kind === "build_failed");
      const hasImage = inbox.messages.some((message) => message.type === "event" && message.payload?.kind === "file_received" && message.payload?.name === "review.png");
      return hasCapabilityResponse && hasSharesResponse && hasListFilesResponse && hasGuide && hasPlanResponse && hasTaskResponse && hasReviewResponse && hasApprovalResponse && hasBuildEvent && hasImage ? inbox : null;
    });

    const workerFileInbox = await waitFor("worker to receive operator file", () => {
      const inbox = readFor("worker");
      return inbox.messages.some((message) => message.type === "event" && message.payload?.kind === "file_received" && message.payload?.name === "operator-notes.txt") ? inbox : null;
    });

    const operatorAckInbox = await waitFor("operator to receive file delivery ack", () => {
      const inbox = readFor("operator");
      return inbox.messages.some((message) => message.type === "event" && message.payload?.kind === "file_delivered" && message.payload?.name === "operator-notes.txt") ? inbox : null;
    });

    const reviewerAckInbox = await waitFor("reviewer to receive image delivery ack", () => {
      const inbox = readFor("reviewer");
      return inbox.messages.some((message) => message.type === "event" && message.payload?.kind === "file_delivered" && message.payload?.name === "review.png") ? inbox : null;
    });

    const plannerApproval = expectMessage(plannerInbox.messages, (message) => message.type === "command_response" && message.payload?.requestId === reviewerApprove.id, "approval response");
    assert.equal(plannerApproval.payload?.ok, true, "approval response was not successful");
    assert.equal(plannerApproval.payload?.result?.approved, true, "approval response did not approve the plan");

    const plannerEvent = expectMessage(plannerInbox.messages, (message) => message.type === "event" && message.payload?.kind === "build_failed", "build_failed event");
    assert.equal(plannerEvent.payload?.job, "parser-ci");

    const plannerImage = expectMessage(plannerInbox.messages, (message) => message.type === "event" && message.payload?.kind === "file_received" && message.payload?.name === "review.png", "planner image receipt");
    const plannerGuide = expectMessage(plannerInbox.messages, (message) => message.type === "event" && message.payload?.kind === "file_received" && message.payload?.name === "guide.md", "planner shared guide receipt");
    const workerFile = expectMessage(workerFileInbox.messages, (message) => message.type === "event" && message.payload?.kind === "file_received" && message.payload?.name === "operator-notes.txt", "worker file receipt");
    const operatorFileAck = expectMessage(operatorAckInbox.messages, (message) => message.type === "event" && message.payload?.kind === "file_delivered" && message.payload?.name === "operator-notes.txt", "operator file delivery ack");
    const reviewerImageAck = expectMessage(reviewerAckInbox.messages, (message) => message.type === "event" && message.payload?.kind === "file_delivered" && message.payload?.name === "review.png", "reviewer image delivery ack");

    assert.equal(readFileSync(workerFile.payload.savedPath, "utf8"), "planner: ask reviewer for approval before rollout\n");
    assert.deepEqual(readFileSync(plannerImage.payload.savedPath), readFileSync(imagePath));
    assert.equal(readFileSync(plannerGuide.payload.savedPath, "utf8"), "shared guide for planner\n");
    assert.equal(operatorFileAck.payload.savedPath, workerFile.payload.savedPath);
    assert.equal(reviewerImageAck.payload.savedPath, plannerImage.payload.savedPath);

    const report = {
      room,
      baseDir,
      converged: Object.fromEntries(Object.entries(converged).map(([name, status]) => [name, {
        connected: status.connected,
        peersKnown: status.peersKnown,
        peersConnected: status.peersConnected,
      }])),
      plannerPeers: plannerNotify.peers.map((peer) => ({
        streamId: peer.streamId,
        connected: peer.connected,
        can: peer.can,
        asks: peer.asks.map((ask) => ask.name),
      })),
      responses: {
        operatorStatusRequestId: operatorStatus.payload.requestId,
        workerPlanRequestId: workerPlan.id,
        workerTaskRequestId: workerTask.id,
        reviewerReviewRequestId: reviewerReview.id,
        reviewerApproveRequestId: reviewerApprove.id,
      },
      transfers: {
        plannerGuideSavedPath: plannerGuide.payload.savedPath,
        workerFileSavedPath: workerFile.payload.savedPath,
        plannerImageSavedPath: plannerImage.payload.savedPath,
      },
      plannerInboxSummary: {
        pending: notifyFor("planner").pending,
        commands: notifyFor("planner").commands,
        events: notifyFor("planner").events,
      },
    };

    console.log(JSON.stringify(report, null, 2));
    succeeded = true;
  } finally {
    stopAll();
    if (succeeded) {
      rmSync(baseDir, { recursive: true, force: true });
    } else {
      console.error(`live validation logs preserved at ${baseDir}`);
    }
  }
}

await main();
