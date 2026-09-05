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

test("share listings handle internal, external and broken directory links", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-shares-"));
  try {
    const root = path.join(dir, "docs");
    mkdirSync(path.join(root, "nested"), { recursive: true });
    mkdirSync(path.join(dir, "outside"));
    writeFileSync(path.join(root, "guide.txt"), "hello");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(path.join(root, "nested"), path.join(root, "internal"), linkType);
    symlinkSync(path.join(dir, "outside"), path.join(root, "external"), linkType);
    symlinkSync(path.join(dir, "missing"), path.join(root, "broken"), linkType);
    const listing = listSharedFolderEntries([{ name: "docs", path: root }], "docs");
    assert.deepEqual(listing.entries, [
      { name: "internal", path: "internal", type: "dir", size: null },
      { name: "nested", path: "nested", type: "dir", size: null },
      { name: "guide.txt", path: "guide.txt", type: "file", size: 5 },
    ]);
    assert.equal(listing.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit filesystem-root shares can resolve their own files", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-shares-"));
  try {
    const file = path.join(dir, "guide.txt");
    writeFileSync(file, "hello");
    const root = path.parse(dir).root;
    const result = resolveSharedFile([{ name: "root", path: root }], "root", path.relative(root, file));
    assert.equal(result.filePath, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listed paths preserve leading spaces and resolve to the file actually listed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-p2p-shares-"));
  try {
    writeFileSync(path.join(dir, "notes.txt"), "short");
    writeFileSync(path.join(dir, " notes.txt"), "different contents");
    const shares = [{ name: "docs", path: dir }];
    const listing = listSharedFolderEntries(shares, "docs");
    const entry = listing.entries.find(item => item.name === " notes.txt");
    assert.ok(entry);
    assert.equal(entry.size, Buffer.byteLength("different contents"));
    assert.equal(resolveSharedFile(shares, "docs", entry.path).filePath, path.join(dir, " notes.txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("listing truncation uses the same normalized limit as the returned entries", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-share-limit-"));
  try {
    writeFileSync(path.join(dir, "one.txt"), "one");
    const shares = [{ name: "docs", path: dir }];
    for (const limit of [-1, 0, 0.5, 1, 1.5]) {
      const result = listSharedFolderEntries(shares, "docs", "", limit);
      assert.equal(result.entries.length, 1);
      assert.equal(result.truncated, false, `limit ${limit} returned the entire directory`);
    }
    writeFileSync(path.join(dir, "two.txt"), "two");
    assert.equal(listSharedFolderEntries(shares, "docs", "", 1.5).truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listing rejects non-finite limits instead of returning misleading results", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ninja-share-limit-"));
  try {
    writeFileSync(path.join(dir, "one.txt"), "one");
    for (const limit of [NaN, Infinity, -Infinity]) {
      assert.throws(() => listSharedFolderEntries([{ name: "docs", path: dir }], "docs", "", limit), /maxEntries/);
    }
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
