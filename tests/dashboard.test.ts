import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rootDashboard = readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
const docsDashboard = readFileSync(new URL("../docs/dashboard.html", import.meta.url), "utf8");
const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version as string;

test("the dashboard copy served by GitHub Pages matches the package source", () => {
  assert.equal(docsDashboard, rootDashboard, "run npm run sync:docs after editing dashboard.html");
});

test("the dashboard announces the package version", () => {
  const advertised = rootDashboard.match(/const DASHBOARD_VERSION = '([^']+)'/)?.[1];
  assert.equal(advertised, packageVersion);
});

test("the dashboard has one checksum helper and observes rejected sends", () => {
  assert.equal((rootDashboard.match(/async function sha256Hex\(/g) ?? []).length, 1);
  assert.match(rootDashboard, /if \(!isSendReady\(target\)\) return false/);
  assert.match(rootDashboard, /sdk\.sendData\(env, target\) !== false/);
  assert.match(rootDashboard, /readyUuids\.add\(uuid\)/);
  assert.match(rootDashboard, /readyUuids\.delete\(uuid\)/);
  assert.match(rootDashboard, /getBufferedAmount/);
  assert.doesNotMatch(rootDashboard, /\{\s*UUID:/);
});

test("history replay filters unrelated direct messages and mobile chat stays reachable", () => {
  assert.match(rootDashboard, /if \(orig\.to && orig\.to !== myStreamId\) break/);
  assert.match(rootDashboard, /#chat-bar\{position:fixed/);
  assert.match(rootDashboard, /if \(sdk !== connectionSdk\) return/);
});

test("the dashboard advertises both directions of its checked file transfer", () => {
  assert.match(rootDashboard, /checked file transfers/);
  assert.match(rootDashboard, /'send-file'/);
  assert.match(rootDashboard, /'receive-file'/);
  assert.match(rootDashboard, /MAX_BROWSER_RECEIVE_SIZE = 64 \* 1024 \* 1024/);
  assert.match(rootDashboard, /MAX_BROWSER_SEND_SIZE = 256 \* 1024 \* 1024/);
});
