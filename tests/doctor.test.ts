import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkNodeVersion,
  checkSidecars,
  checkStateRoot,
  checkWebRtc,
  formatReport,
  summarizeChecks,
  type DiagnosticCheck,
} from "../src/doctor.js";

test("checkNodeVersion accepts the supported floor and above", () => {
  assert.equal(checkNodeVersion("v20.0.0").status, "ok");
  assert.equal(checkNodeVersion("v22.14.0").status, "ok");
  assert.equal(checkNodeVersion("24.1.0").status, "ok");
});

test("checkNodeVersion fails below the supported floor", () => {
  const check = checkNodeVersion("v18.19.0");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /below the required v20/);
  assert.ok(check.hint);
});

test("checkNodeVersion warns rather than fails on an unparseable version", () => {
  const check = checkNodeVersion("banana");
  assert.equal(check.status, "warn");
});

test("checkWebRtc reports ok when the native module loads", async () => {
  const check = await checkWebRtc(async () => ({}));
  assert.equal(check.status, "ok");
});

test("checkWebRtc fails when a Node sidecar cannot load the native module", async () => {
  const check = await checkWebRtc(async () => {
    throw new Error("Cannot find module '@roamhq/wrtc'");
  });
  // The library remains usable in a browser, but this command diagnoses the
  // Node sidecar, which cannot carry a data channel without WebRTC.
  assert.equal(check.status, "fail");
  assert.match(check.detail, /Cannot find module/);
  assert.match(check.hint ?? "", /npm install/);
});

test("checkStateRoot confirms a writable folder and cleans up its probe", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-doctor-"));
  try {
    const check = checkStateRoot(path.join(dir, "nested", "state"));
    assert.equal(check.status, "ok");
    assert.match(check.detail, /is writable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkSidecars reports nothing when the state root is absent", () => {
  const result = checkSidecars(
    path.join(os.tmpdir(), "ninja-p2p-doctor-missing-root"),
    () => null,
    () => false,
  );
  assert.equal(result.check.status, "ok");
  assert.deepEqual(result.sidecars, []);
});

test("checkSidecars separates running sidecars from stale ones", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-doctor-"));
  try {
    mkdirSync(path.join(dir, "claude"));
    mkdirSync(path.join(dir, "codex"));

    const sessions: Record<string, { room: string; streamId: string; pid: number }> = {
      claude: { room: "ai-room", streamId: "claude", pid: 111 },
      codex: { room: "ai-room", streamId: "codex", pid: 222 },
    };

    const result = checkSidecars(
      dir,
      (stateDir) => sessions[path.basename(stateDir)] ?? null,
      (pid) => pid === 111,
    );

    assert.equal(result.sidecars.length, 2);
    assert.equal(result.check.detail, "1 running, 1 stopped");
    assert.equal(result.sidecars.find((s) => s.id === "claude")?.running, true);
    assert.equal(result.sidecars.find((s) => s.id === "codex")?.running, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeChecks fails only on hard failures", () => {
  const warned: DiagnosticCheck[] = [
    { name: "node", status: "ok", detail: "" },
    { name: "webrtc", status: "warn", detail: "" },
  ];
  assert.equal(summarizeChecks(warned).ok, true);

  const failed: DiagnosticCheck[] = [...warned, { name: "signaling", status: "fail", detail: "" }];
  assert.equal(summarizeChecks(failed).ok, false);
});

test("formatReport renders hints and the sidecar table", () => {
  const report = summarizeChecks([
    { name: "node", status: "ok", detail: "Node v22.14.0" },
    { name: "signaling", status: "fail", detail: "unreachable", hint: "check your firewall" },
  ]);
  const text = formatReport(report, [
    { id: "claude", room: "ai-room", pid: 111, running: true },
  ]);

  assert.match(text, /\[ok {2}\] node/);
  assert.match(text, /\[FAIL\] signaling/);
  assert.match(text, /-> check your firewall/);
  assert.match(text, /claude {11}running pid=111 {2}room=ai-room/);
  assert.match(text, /Some checks failed/);
});
