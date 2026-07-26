#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const testRoot = path.join(repositoryRoot, "tests");

function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTests(entryPath);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [entryPath] : [];
  });
}

const testFiles = collectTests(testRoot).sort();
if (testFiles.length === 0) {
  throw new Error(`no TypeScript tests found below ${testRoot}`);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...testFiles],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
