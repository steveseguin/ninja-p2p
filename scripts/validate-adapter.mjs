#!/usr/bin/env node

import assert from "node:assert/strict";

import { checkWebRtc } from "../dist/doctor.js";

const expected = process.argv[2];
assert.ok(expected, "expected adapter name is required");

const check = await checkWebRtc();
assert.equal(check.status, "ok", check.detail);
assert.match(
  check.detail,
  new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  `doctor selected the wrong adapter: ${check.detail}`,
);

console.log(check.detail);
