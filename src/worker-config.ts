import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type WorkerConfig = {
  mailboxConfig: string; workspace: string; stateDir: string;
  agent: "codex" | "opencode"; allowedPeers: string[]; instructions: string;
  executable?: string; model?: string; sandbox: "read-only" | "workspace-write";
  pollSeconds: number; timeoutSeconds: number;
};

export function readWorkerJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function writeWorkerJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temp, file); break; }
      catch (error) {
        if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } finally { rmSync(temp, { force: true }); }
}

export function workerPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Only the process holding this lock may mutate worker state. Never steal a live lock. */
export function lockWorker(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "worker.lock"), reaper = path.join(dir, "recovery.lock");
  const owner = { pid: process.pid, nonce: randomUUID() };
  try {
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(owner)); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const fd = openSync(reaper, "wx", 0o600);
    try {
      const previous = readWorkerJson<{ pid: number }>(file);
      if (previous && workerPidAlive(previous.pid)) throw new Error("Worker already running for this state directory");
      // A partial/corrupt lock is not silently discarded by readWorkerJson.
      rmSync(file, { force: true });
    } finally { closeSync(fd); rmSync(reaper, { force: true }); }
    return lockWorker(dir);
  }
  return () => {
    if (readWorkerJson<{ nonce: string }>(file)?.nonce === owner.nonce) rmSync(file, { force: true });
  };
}

export function loadWorkerConfig(file: string): WorkerConfig {
  const input = readWorkerJson<Record<string, unknown>>(file);
  if (!input || Array.isArray(input)) throw new Error("Worker config must be a JSON object");
  const keys = ["mailboxConfig", "workspace", "stateDir", "agent", "allowedPeers", "instructions", "executable", "model", "sandbox", "pollSeconds", "timeoutSeconds"];
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new Error(`Unknown worker setting: ${key}`);
  const text = (key: string): string => {
    if (typeof input[key] !== "string" || !(input[key] as string).trim() || (input[key] as string).includes("\0")) throw new Error(`Worker ${key} must be a nonempty string`);
    return input[key] as string;
  };
  const base = path.dirname(path.resolve(file));
  const workspace = realpathSync(path.resolve(base, text("workspace")));
  if (!statSync(workspace).isDirectory()) throw new Error("Worker workspace must be a directory");
  const mailboxConfig = realpathSync(path.resolve(base, text("mailboxConfig")));
  const stateDir = path.resolve(base, input.stateDir === undefined ? path.basename(file, ".json") + ".state" : text("stateDir"));
  const within = (parent: string, child: string) => { const rel = path.relative(parent, child); return !rel || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)); };
  let ancestor = stateDir;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actualState = path.join(realpathSync(ancestor), path.relative(ancestor, stateDir));
  if (within(workspace, actualState) || within(actualState, workspace) || within(workspace, mailboxConfig) || within(workspace, realpathSync(file))) {
    throw new Error("Keep worker config, mailbox credentials and worker state outside the agent workspace");
  }
  if (input.agent !== "codex" && input.agent !== "opencode") throw new Error("Worker agent must be codex or opencode");
  if (!Array.isArray(input.allowedPeers) || !input.allowedPeers.length || input.allowedPeers.length > 20 || input.allowedPeers.some(peer => typeof peer !== "string" || !/^[a-f0-9]{32}$/.test(peer))) throw new Error("Worker allowedPeers must list 1-20 paired mailbox IDs");
  const instructions = text("instructions");
  if (Buffer.byteLength(instructions) > 8000) throw new Error("Worker instructions exceed 8 KB");
  const sandbox = input.sandbox ?? "read-only";
  if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new Error("Worker sandbox must be read-only or workspace-write");
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = input[key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`);
    return value;
  };
  return { mailboxConfig, workspace, stateDir: actualState, agent: input.agent, allowedPeers: input.allowedPeers as string[], instructions, sandbox,
    ...(input.executable === undefined ? {} : { executable: text("executable") }),
    ...(input.model === undefined ? {} : { model: text("model") }),
    pollSeconds: integer("pollSeconds", 5, 2, 60), timeoutSeconds: integer("timeoutSeconds", 600, 30, 3600) };
}
