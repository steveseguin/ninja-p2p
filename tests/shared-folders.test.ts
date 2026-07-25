import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inferTransferKind,
  listSharedFolderEntries,
  parseSharedFolderSpecs,
  resolveSharedFile,
  toSharedFolderSummaries,
} from "../src/shared-folders.js";

test("parseSharedFolderSpecs resolves and validates declared shares", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-shares-"));
  try {
    const docsDir = path.join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });

    const shares = parseSharedFolderSpecs(["docs=./docs"], dir);
    assert.deepEqual(shares, [{ name: "docs", path: docsDir }]);
    assert.deepEqual(toSharedFolderSummaries(shares), [{ name: "docs" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSharedFolderEntries lists one directory level and sorts folders first", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-shares-"));
  try {
    const docsDir = path.join(dir, "docs");
    mkdirSync(path.join(docsDir, "nested"), { recursive: true });
    writeFileSync(path.join(docsDir, "guide.md"), "# guide\n", "utf8");

    const shares = parseSharedFolderSpecs(["docs=./docs"], dir);
    const listing = listSharedFolderEntries(shares, "docs");

    assert.equal(listing.share, "docs");
    assert.equal(listing.path, "");
    assert.deepEqual(listing.entries, [
      { name: "nested", path: "nested", type: "dir", size: null },
      { name: "guide.md", path: "guide.md", type: "file", size: 8 },
    ]);
    assert.equal(listing.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSharedFile rejects paths that escape the declared folder", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-shares-"));
  try {
    const docsDir = path.join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(docsDir, "guide.md"), "# guide\n", "utf8");

    const shares = parseSharedFolderSpecs(["docs=./docs"], dir);
    assert.throws(() => resolveSharedFile(shares, "docs", "../secret.txt"), /escapes the declared folder/);
    assert.throws(() => listSharedFolderEntries(shares, "docs", "/"), /must be relative/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSharedFile returns file details and transfer kind", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-shares-"));
  try {
    const docsDir = path.join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(docsDir, "diagram.png"), Buffer.from([137, 80, 78, 71]));

    const shares = parseSharedFolderSpecs(["docs=./docs"], dir);
    const file = resolveSharedFile(shares, "docs", "diagram.png");

    assert.equal(file.share, "docs");
    assert.equal(file.path, "diagram.png");
    assert.equal(file.name, "diagram.png");
    assert.equal(file.kind, "image");
    assert.equal(file.filePath, path.join(docsDir, "diagram.png"));
    assert.equal(inferTransferKind(file.filePath), "image");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSharedFile refuses a symlink that escapes the declared share", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-shares-"));
  try {
    const docsDir = path.join(dir, "docs");
    const secretDir = path.join(dir, "secret");
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(path.join(secretDir, "private.txt"), "do not share", "utf8");

    const linkPath = path.join(docsDir, "leak.txt");
    try {
      symlinkSync(path.join(secretDir, "private.txt"), linkPath, "file");
    } catch {
      // Windows needs Developer Mode or admin rights to create symlinks.
      return;
    }

    const shares = parseSharedFolderSpecs(["docs=./docs"], dir);
    // The path stays lexically inside the share, so only a real-path check
    // catches this.
    assert.throws(
      () => resolveSharedFile(shares, "docs", "leak.txt"),
      /escapes the declared folder/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSharedFile still serves ordinary files inside the share", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-shares-"));
  try {
    const docsDir = path.join(dir, "docs", "nested");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(docsDir, "guide.md"), "hello", "utf8");

    const shares = parseSharedFolderSpecs(["docs=./docs"], dir);
    const resolved = resolveSharedFile(shares, "docs", "nested/guide.md");
    assert.equal(resolved.name, "guide.md");
    assert.equal(resolved.share, "docs");
    assert.equal(resolved.size, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
