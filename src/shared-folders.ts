import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { FileTransferKind, SharedFolderSummary } from "./protocol.js";

export type SharedFolderConfig = {
  name: string;
  path: string;
  description?: string;
};

export type SharedFolderEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number | null;
};

export type SharedFolderListing = {
  share: string;
  path: string;
  entries: SharedFolderEntry[];
  truncated: boolean;
};

export type ResolvedSharedFile = {
  share: string;
  path: string;
  filePath: string;
  name: string;
  kind: FileTransferKind;
  size: number;
};

export function parseSharedFolderSpecs(rawValues: string[], cwd = process.cwd()): SharedFolderConfig[] {
  const shares: SharedFolderConfig[] = [];
  const seen = new Set<string>();

  for (const raw of rawValues.map((value) => value.trim()).filter(Boolean)) {
    const separatorIndex = raw.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
      throw new Error(`invalid share spec: ${raw}; use --share name=path`);
    }

    const name = raw.slice(0, separatorIndex).trim();
    const folderPath = raw.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`invalid share name: ${name}`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`duplicate share name: ${name}`);
    }

    const resolved = path.resolve(cwd, folderPath);
    if (!existsSync(resolved)) {
      throw new Error(`shared folder does not exist: ${resolved}`);
    }
    const stats = statSync(resolved);
    if (!stats.isDirectory()) {
      throw new Error(`shared folder is not a directory: ${resolved}`);
    }

    seen.add(key);
    shares.push({
      name,
      path: resolved,
    });
  }

  return shares;
}

export function toSharedFolderSummaries(sharedFolders: SharedFolderConfig[]): SharedFolderSummary[] {
  return sharedFolders.map((share) => {
    const summary: SharedFolderSummary = { name: share.name };
    if (share.description) summary.description = share.description;
    return summary;
  });
}

export function listSharedFolderEntries(
  sharedFolders: SharedFolderConfig[],
  shareName: string,
  relativePath = "",
  maxEntries = 200,
): SharedFolderListing {
  if (!Number.isFinite(maxEntries)) throw new RangeError("maxEntries must be finite");
  const limit = Math.max(1, Math.floor(maxEntries));
  const share = requireSharedFolder(sharedFolders, shareName);
  const resolved = resolveSharedPath(share, relativePath);
  const stats = statSync(resolved.filePath);
  if (!stats.isDirectory()) {
    throw new Error(`shared path is not a directory: ${resolved.path || "."}`);
  }

  const entries = readdirSync(resolved.filePath, { withFileTypes: true })
    .flatMap((entry): SharedFolderEntry[] => {
      const childPath = resolved.path ? `${resolved.path}/${entry.name}` : entry.name;
      try {
        // Apply the same containment rule as a file request before following
        // links for metadata. Broken or inaccessible children must not hide
        // the rest of an otherwise readable shared directory.
        const child = resolveSharedPath(share, childPath);
        const stats = statSync(child.filePath);
        if (!stats.isDirectory() && !stats.isFile()) return [];
        return [{
          name: entry.name,
          path: childPath,
          type: stats.isDirectory() ? "dir" : "file",
          size: stats.isDirectory() ? null : stats.size,
        }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => Number(a.type === "file") - Number(b.type === "file") || a.name.localeCompare(b.name));

  return {
    share: share.name,
    path: resolved.path,
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}

export function resolveSharedFile(
  sharedFolders: SharedFolderConfig[],
  shareName: string,
  relativePath: string,
): ResolvedSharedFile {
  const share = requireSharedFolder(sharedFolders, shareName);
  const resolved = resolveSharedPath(share, relativePath);
  const stats = statSync(resolved.filePath);
  if (!stats.isFile()) {
    throw new Error(`shared path is not a file: ${resolved.path || "."}`);
  }

  return {
    share: share.name,
    path: resolved.path,
    filePath: resolved.filePath,
    name: path.basename(resolved.filePath),
    kind: inferTransferKind(resolved.filePath),
    size: stats.size,
  };
}

export function inferTransferKind(filePath: string): FileTransferKind {
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(ext)) {
    return "image";
  }
  return "file";
}

function requireSharedFolder(sharedFolders: SharedFolderConfig[], shareName: string): SharedFolderConfig {
  const share = sharedFolders.find((item) => item.name.toLowerCase() === shareName.trim().toLowerCase());
  if (!share) {
    throw new Error(`unknown share: ${shareName}`);
  }
  return share;
}

function resolveSharedPath(share: SharedFolderConfig, relativePath: string): { filePath: string; path: string } {
  const normalized = normalizeRelativeSharePath(relativePath);
  const target = path.resolve(share.path, normalized || ".");
  if (!isPathContained(share.path, target)) {
    throw new Error("shared path escapes the declared folder");
  }
  if (!existsSync(target)) {
    throw new Error(`shared path does not exist: ${normalized || "."}`);
  }

  // The check above is lexical, so a symlink sitting inside the share and
  // pointing outside it would still pass. Compare the real paths too, or
  // `--share docs=./docs` could hand out anything the link reaches.
  assertRealPathContained(share.path, target);

  return {
    filePath: target,
    path: normalized,
  };
}

function assertRealPathContained(shareRoot: string, target: string): void {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(shareRoot);
    realTarget = realpathSync(target);
  } catch {
    // If either path cannot be resolved, refuse rather than guess.
    throw new Error("shared path escapes the declared folder");
  }

  if (!isPathContained(realRoot, realTarget)) {
    throw new Error("shared path escapes the declared folder");
  }
}

function isPathContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeRelativeSharePath(relativePath: string): string {
  const raw = relativePath.replace(/\\/g, "/");
  if (!raw) return "";
  if (raw.startsWith("/")) {
    throw new Error("shared path must be relative");
  }

  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("shared path escapes the declared folder");
  }
  if (normalized.includes("/../")) {
    throw new Error("shared path escapes the declared folder");
  }
  return normalized === "." ? "" : normalized;
}
