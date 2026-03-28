import assert from "node:assert/strict";
import test from "node:test";

import {
  MessageBus,
  PeerRegistry,
  VDOBridge,
  createEnvelope,
  generateRoomName,
} from "../src/index.js";

test("root index exports the public runtime API", () => {
  assert.equal(typeof VDOBridge, "function");
  assert.equal(typeof MessageBus, "function");
  assert.equal(typeof PeerRegistry, "function");
  assert.equal(typeof createEnvelope, "function");
  assert.equal(typeof generateRoomName, "function");
});
