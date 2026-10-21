import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentArgs } from "../src/cli.js";
import { parseCliArgs } from "../src/cli-lib.js";

const baseArgs = ["--room", "test-room", "--id", "test-agent", "--state-dir", "test-state"];

for (const { label, passwordArgs, environmentPassword, expected } of [
  { label: "explicit false overrides the environment", passwordArgs: ["--password", "false"], environmentPassword: "environment-password", expected: false },
  { label: "omitted password uses the environment", passwordArgs: [], environmentPassword: "environment-password", expected: "environment-password" },
  { label: "explicit password overrides the environment", passwordArgs: ["--password", "explicit-password"], environmentPassword: "environment-password", expected: "explicit-password" },
  { label: "omitted password defaults to false", passwordArgs: [], environmentPassword: undefined, expected: false },
  { label: "explicit false without an environment password", passwordArgs: ["--password", "false"], environmentPassword: undefined, expected: false },
  { label: "an environment false remains disabled", passwordArgs: [], environmentPassword: "false", expected: false },
  { label: "passwords containing spaces remain one argument", passwordArgs: ["--password", "password with spaces"], environmentPassword: undefined, expected: "password with spaces" },
]) {
  test(`detached agent password: ${label}`, () => {
    const env = { HOME: "/test-home", NINJA_PASSWORD: environmentPassword };
    const start = parseCliArgs(["start", ...baseArgs, ...passwordArgs], env);
    const foreground = parseCliArgs(["agent", ...baseArgs, ...passwordArgs], env);
    assert.equal(start.kind, "start");
    assert.equal(foreground.kind, "agent");
    if (start.kind !== "start" || foreground.kind !== "agent") return;
    assert.equal(start.options.password, expected);
    assert.equal(foreground.options.password, expected);

    const detached = parseCliArgs(["agent", ...buildAgentArgs(start.options)], env);
    assert.equal(detached.kind, "agent");
    if (detached.kind !== "agent") return;
    assert.equal(detached.options.password, expected);
    assert.equal(detached.options.password, foreground.options.password);
  });
}
