import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";

import {
  buildWakeEnv,
  MAX_WAKE_TEXT_LENGTH,
  WakeRunner,
  type WakeChild,
} from "../src/wake.js";
import { createEnvelope, type PeerIdentity } from "../src/protocol.js";

const sender: PeerIdentity = {
  streamId: "planner",
  role: "agent",
  name: "Planner",
  instanceId: "aaaa1111",
};

const context = {
  streamId: "worker",
  room: "ai-room",
  stateDir: "/tmp/worker",
};

function chat(text: string) {
  return createEnvelope(sender, "chat", { text });
}

test("handoff wake text contains the request and preserves distinct message IDs", () => {
  const messages = [0, 1].map(() => createEnvelope(sender, "handoff", { request: "Review\0this patch", expiresAt: Date.now() + 1000 }, { to: "worker" }));
  const env = buildWakeEnv(messages, context);
  assert.equal(env.NINJA_WAKE_TEXT, "Review\uFFFDthis patch");
  assert.equal(env.NINJA_WAKE_TYPES, "handoff");
  assert.equal(env.NINJA_WAKE_COUNT, "2");
});

type FakeRun = {
  command: string;
  env: NodeJS.ProcessEnv;
  exit: () => void;
  error: (error: Error) => void;
};

function makeFakeSpawn() {
  const runs: FakeRun[] = [];
  const spawnFn = (command: string, env: NodeJS.ProcessEnv): WakeChild => {
    let exitListener: (() => void) | null = null;
    let errorListener: ((error: Error) => void) | null = null;
    runs.push({
      command,
      env,
      exit: () => exitListener?.(),
      error: (error) => errorListener?.(error),
    });
    return {
      on(event: "exit" | "error", callback: (() => void) | ((error: Error) => void)) {
        if (event === "exit") exitListener = callback as () => void;
        else errorListener = callback as (error: Error) => void;
        return this;
      },
    } as WakeChild;
  };
  return { runs, spawnFn };
}

test("buildWakeEnv exposes sender context without hijacking room mode", () => {
  const env = buildWakeEnv([chat("hello"), chat("again")], context);
  assert.equal(env.NINJA_ID, "worker");
  assert.equal(env.NINJA_STATE_DIR, "/tmp/worker");
  assert.equal(env.NINJA_WAKE_ROOM, "ai-room");
  assert.equal(env.NINJA_WAKE_COUNT, "2");
  assert.equal(env.NINJA_WAKE_FROM, "planner");
  assert.equal(env.NINJA_WAKE_TYPES, "chat");
  assert.equal(env.NINJA_WAKE_TEXT, "hello");
  // Setting NINJA_ROOM would push the woken command's CLI calls into one-shot
  // mode, opening a second connection under the same streamId.
  assert.equal(env.NINJA_ROOM, undefined);
});

test("buildWakeEnv de-duplicates senders and types across a batch", () => {
  const other: PeerIdentity = { ...sender, streamId: "reviewer", name: "Reviewer" };
  const env = buildWakeEnv(
    [chat("a"), chat("b"), createEnvelope(other, "command", { command: "status" })],
    context,
  );
  assert.equal(env.NINJA_WAKE_FROM, "planner,reviewer");
  assert.equal(env.NINJA_WAKE_TYPES, "chat,command");
  assert.equal(env.NINJA_WAKE_COUNT, "3");
});

test("buildWakeEnv bounds peer text before putting it in the process environment", () => {
  const env = buildWakeEnv([chat("x".repeat(MAX_WAKE_TEXT_LENGTH * 2))], context);
  assert.equal(env.NINJA_WAKE_TEXT.length, MAX_WAKE_TEXT_LENGTH);
  assert.match(env.NINJA_WAKE_TEXT, /…$/);
});

test("peer NUL characters cannot prevent a wake process from starting", () => {
  const message = createEnvelope({ ...sender, streamId: "peer\0name" }, "chat", { text: "hello\0world" });
  const env = buildWakeEnv([message], context);
  const result = spawnSync(process.execPath, ["-e",
    "process.stdout.write(JSON.stringify([process.env.NINJA_WAKE_FROM, process.env.NINJA_WAKE_TEXT]))",
  ], { env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["peer\uFFFDname", "hello\uFFFDworld"]);
  assert.equal(message.from.streamId, "peer\0name");
  assert.deepEqual(message.payload, { text: "hello\0world" });
});

test("WakeRunner removes an inherited room so child commands use the sidecar outbox", async () => {
  const previousRoom = process.env.NINJA_ROOM;
  const { runs, spawnFn } = makeFakeSpawn();
  const runner = new WakeRunner({
    config: { command: "echo hi", debounceMs: 1, limitPerMinute: 0 },
    context,
    spawnFn,
  });
  try {
    process.env.NINJA_ROOM = "parent-room";
    runner.notify(chat("wake up"));
    await delay(40);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].env.NINJA_ROOM, undefined);
    assert.equal(runs[0].env.NINJA_WAKE_ROOM, context.room);
    assert.equal(runs[0].env.NINJA_STATE_DIR, context.stateDir);
    assert.equal(runs[0].env.NINJA_ID, context.streamId);
    assert.equal(process.env.NINJA_ROOM, "parent-room", "the parent environment must remain intact");
  } finally {
    runner.dispose();
    if (previousRoom === undefined) delete process.env.NINJA_ROOM;
    else process.env.NINJA_ROOM = previousRoom;
  }
});

test("WakeRunner keeps relay secrets out of commands that read peer text", async () => {
  const previous = { token: process.env.NINJA_RELAY_TOKEN, key: process.env.NINJA_RELAY_KEY };
  const { runs, spawnFn } = makeFakeSpawn();
  const runner = new WakeRunner({
    config: { command: "echo hi", debounceMs: 1, limitPerMinute: 0 },
    context,
    spawnFn,
  });
  try {
    process.env.NINJA_RELAY_TOKEN = "relay-token";
    process.env.NINJA_RELAY_KEY = "a".repeat(64);
    runner.notify(chat("wake up"));
    await delay(40);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].env.NINJA_RELAY_TOKEN, undefined);
    assert.equal(runs[0].env.NINJA_RELAY_KEY, undefined);
    assert.equal(process.env.NINJA_RELAY_TOKEN, "relay-token", "the parent environment must remain intact");
  } finally {
    runner.dispose();
    for (const [name, value] of [["NINJA_RELAY_TOKEN", previous.token], ["NINJA_RELAY_KEY", previous.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("WakeRunner coalesces a burst into a single run", async () => {
  const { runs, spawnFn } = makeFakeSpawn();
  const runner = new WakeRunner({
    config: { command: "echo hi", debounceMs: 5, limitPerMinute: 0 },
    context,
    spawnFn,
  });

  runner.notify(chat("one"));
  runner.notify(chat("two"));
  runner.notify(chat("three"));
  assert.equal(runs.length, 0, "should wait for the debounce window");

  await delay(40);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, "echo hi");
  assert.equal(runs[0].env.NINJA_WAKE_COUNT, "3");
  runner.dispose();
});

test("WakeRunner never overlaps runs and re-fires for mid-run arrivals", async () => {
  const { runs, spawnFn } = makeFakeSpawn();
  const runner = new WakeRunner({
    config: { command: "echo hi", debounceMs: 5, limitPerMinute: 0 },
    context,
    spawnFn,
  });

  runner.notify(chat("first"));
  await delay(40);
  assert.equal(runs.length, 1);
  assert.equal(runner.isRunning(), true);

  // Arrives while the first wake command is still executing.
  runner.notify(chat("second"));
  await delay(40);
  assert.equal(runs.length, 1, "must not start a second wake while one runs");
  assert.equal(runner.pendingCount(), 1);

  runs[0].exit();
  await delay(40);
  assert.equal(runs.length, 2, "should re-fire once the first run exits");
  assert.equal(runs[1].env.NINJA_WAKE_COUNT, "1");
  runner.dispose();
});

test("WakeRunner throttles once the per-minute limit is reached", async () => {
  const { runs, spawnFn } = makeFakeSpawn();
  const frozenClock = 1_000_000;
  const runner = new WakeRunner({
    config: { command: "echo hi", debounceMs: 2, limitPerMinute: 2 },
    context,
    spawnFn,
    now: () => frozenClock,
  });

  for (let i = 0; i < 2; i += 1) {
    runner.notify(chat(`message ${i}`));
    await delay(30);
    runs[runs.length - 1].exit();
    await delay(10);
  }
  assert.equal(runs.length, 2);

  // A third message inside the same simulated minute must be deferred, not run.
  runner.notify(chat("message 2"));
  await delay(40);
  assert.equal(runs.length, 2, "third wake should be throttled");
  assert.equal(runner.pendingCount(), 1, "throttled messages stay queued");
  runner.dispose();
});

test("WakeRunner treats a zero limit as unlimited", async () => {
  const { runs, spawnFn } = makeFakeSpawn();
  const frozenClock = 2_000_000;
  const runner = new WakeRunner({
    config: { command: "echo hi", debounceMs: 2, limitPerMinute: 0 },
    context,
    spawnFn,
    now: () => frozenClock,
  });

  for (let i = 0; i < 4; i += 1) {
    runner.notify(chat(`message ${i}`));
    await delay(25);
    runs[runs.length - 1].exit();
    await delay(5);
  }
  assert.equal(runs.length, 4);
  runner.dispose();
});

test("unlimited wake runs do not accumulate unused rate-limit history", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { runs, spawnFn } = makeFakeSpawn();
  const runner = new WakeRunner({
    config: { command: "echo hi", debounceMs: 1, limitPerMinute: 0 },
    context,
    spawnFn,
  });
  try {
    for (let i = 0; i < 100; i++) {
      runner.notify(chat("next"));
      t.mock.timers.tick(1);
      runs.at(-1)!.exit();
    }
    assert.equal(runs.length, 100);
    assert.equal(runner.pendingCount(), 0);
    // Inspect retained bookkeeping without adding a public diagnostic API.
    assert.equal((runner as unknown as { recentRuns: number[] }).recentRuns.length, 0);
  } finally {
    runner.dispose();
    t.mock.timers.reset();
  }
});

test("WakeRunner rejects timer overflow and invalid rate limits before scheduling", () => {
  for (const debounceMs of [-1, NaN, Infinity, 2 ** 31]) {
    assert.throws(() => new WakeRunner({
      config: { command: "echo hi", debounceMs, limitPerMinute: 1 }, context,
    }), /debounceMs/);
  }
  for (const limitPerMinute of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new WakeRunner({
      config: { command: "echo hi", debounceMs: 0, limitPerMinute }, context,
    }), /limitPerMinute/);
  }
});

test("mutating the caller's wake config cannot disable the active rate limit", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { runs, spawnFn } = makeFakeSpawn();
  const config = { command: "echo hi", debounceMs: 1, limitPerMinute: 1 };
  const runner = new WakeRunner({ config, context, spawnFn, now: () => 1000 });
  try {
    runner.notify(chat("first"));
    t.mock.timers.tick(1);
    assert.equal(runs.length, 1);
    runs[0].exit();
    config.limitPerMinute = 0;
    runner.notify(chat("second"));
    t.mock.timers.tick(1);
    assert.equal(runs.length, 1);
    assert.equal(runner.pendingCount(), 1);
  } finally {
    runner.dispose();
    t.mock.timers.reset();
  }
});

test("dispose cancels a scheduled wake", async () => {
  const { runs, spawnFn } = makeFakeSpawn();
  const runner = new WakeRunner({
    config: { command: "echo hi", debounceMs: 5, limitPerMinute: 0 },
    context,
    spawnFn,
  });

  runner.notify(chat("one"));
  runner.dispose();
  await delay(40);
  assert.equal(runs.length, 0);
});

test("a spawn failure does not wedge the runner", async () => {
  const commands: string[] = [];
  let failNext = true;
  const runner = new WakeRunner({
    config: { command: "boom", debounceMs: 2, limitPerMinute: 0 },
    context,
    spawnFn: (command) => {
      if (failNext) {
        failNext = false;
        throw new Error("spawn failed");
      }
      commands.push(command);
      return { on() { return this; } } as WakeChild;
    },
  });

  runner.notify(chat("one"));
  await delay(30);
  assert.equal(commands.length, 0);
  assert.equal(runner.isRunning(), false, "a failed spawn must clear the running flag");

  runner.notify(chat("two"));
  await delay(30);
  assert.equal(commands.length, 1, "the runner should still accept later wakes");
  runner.dispose();
});

test("an asynchronous spawn error does not crash or wedge the runner", async () => {
  const { runs, spawnFn } = makeFakeSpawn();
  const logs: string[] = [];
  const runner = new WakeRunner({
    config: { command: "missing-command", debounceMs: 2, limitPerMinute: 0 },
    context,
    spawnFn,
    log: (message) => logs.push(message),
  });

  runner.notify(chat("one"));
  await delay(30);
  assert.equal(runner.isRunning(), true);
  runs[0].error(new Error("ENOENT"));
  assert.equal(runner.isRunning(), false);
  assert.ok(logs.some((line) => /process error: ENOENT/.test(line)));

  runner.notify(chat("two"));
  await delay(30);
  assert.equal(runs.length, 2, "later messages should still wake the agent");
  runner.dispose();
});
