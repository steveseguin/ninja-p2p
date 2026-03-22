import test from "node:test";
import assert from "node:assert/strict";
import {
  createEnvelope,
  createInstanceId,
  createMessageId,
  generateRoomName,
  isValidEnvelope,
  parseEnvelope,
  envelopeToWire,
  type PeerIdentity,
  type MessageEnvelope,
} from "../src/protocol.js";

const testIdentity: PeerIdentity = {
  streamId: "test_bot_1",
  role: "test",
  name: "TestBot",
  instanceId: "abc12345",
};

test("createMessageId returns unique 16-char base64url strings", () => {
  const id1 = createMessageId();
  const id2 = createMessageId();
  assert.ok(id1.length === 16);
  assert.ok(id2.length === 16);
  assert.notEqual(id1, id2);
});

test("createInstanceId returns 8-char hex string", () => {
  const id = createInstanceId();
  assert.ok(id.length === 8);
  assert.notEqual(createInstanceId(), createInstanceId());
});

test("generateRoomName starts with clawd_ and is 38 chars", () => {
  const room = generateRoomName();
  assert.ok(room.startsWith("clawd_"));
  assert.ok(room.length === 6 + 32); // "clawd_" + 32 hex chars
  assert.notEqual(generateRoomName(), generateRoomName());
});

test("createEnvelope produces a valid envelope", () => {
  const env = createEnvelope(testIdentity, "chat", { text: "hello" });
  assert.equal(env.v, 1);
  assert.equal(env.type, "chat");
  assert.deepEqual(env.from, testIdentity);
  assert.equal(env.to, null);
  assert.equal(env.topic, null);
  assert.ok(typeof env.id === "string");
  assert.ok(typeof env.ts === "number");
  assert.deepEqual(env.payload, { text: "hello" });
});

test("createEnvelope respects to and topic options", () => {
  const env = createEnvelope(testIdentity, "event", { kind: "test" }, { to: "peer_1", topic: "events" });
  assert.equal(env.to, "peer_1");
  assert.equal(env.topic, "events");
});

test("isValidEnvelope accepts valid envelopes", () => {
  const env = createEnvelope(testIdentity, "chat", "hello");
  assert.ok(isValidEnvelope(env));
});

test("isValidEnvelope rejects invalid data", () => {
  assert.ok(!isValidEnvelope(null));
  assert.ok(!isValidEnvelope(undefined));
  assert.ok(!isValidEnvelope("string"));
  assert.ok(!isValidEnvelope(42));
  assert.ok(!isValidEnvelope({}));
  assert.ok(!isValidEnvelope({ v: 2, id: "x", type: "chat", from: testIdentity, ts: 1 }));
  assert.ok(!isValidEnvelope({ v: 1, id: "x", type: "chat", from: null, ts: 1 }));
  assert.ok(!isValidEnvelope({ v: 1, id: "x", type: "chat", from: { noStreamId: true }, ts: 1 }));
});

test("parseEnvelope parses valid JSON string", () => {
  const env = createEnvelope(testIdentity, "chat", { text: "hi" });
  const json = JSON.stringify(env);
  const parsed = parseEnvelope(json);
  assert.ok(parsed !== null);
  assert.equal(parsed!.type, "chat");
  assert.deepEqual(parsed!.payload, { text: "hi" });
});

test("parseEnvelope parses valid object", () => {
  const env = createEnvelope(testIdentity, "announce", { skills: [] });
  const parsed = parseEnvelope(env);
  assert.ok(parsed !== null);
  assert.equal(parsed!.type, "announce");
});

test("parseEnvelope returns null for invalid data", () => {
  assert.equal(parseEnvelope("not json"), null);
  assert.equal(parseEnvelope("{}"), null);
  assert.equal(parseEnvelope(null), null);
  assert.equal(parseEnvelope(42), null);
});

test("envelopeToWire returns a plain object", () => {
  const env = createEnvelope(testIdentity, "chat", "hello");
  const wire = envelopeToWire(env);
  assert.ok(typeof wire === "object");
  assert.equal((wire as MessageEnvelope).v, 1);
  assert.equal((wire as MessageEnvelope).type, "chat");
});
