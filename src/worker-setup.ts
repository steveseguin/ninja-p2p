import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { callMailbox, loadMailboxConfig } from "./mailbox.js";
import { agentExecutable } from "./worker-agent.js";
import { loadWorkerConfig, lockWorker, readWorkerJson, workerPidAlive, writeWorkerJson } from "./worker-config.js";

export type SetupOptions = { agent?: "codex" | "opencode"; workspace?: string; server?: string; config?: string;
  executable?: string; model?: string; noOpen: boolean; wait: number };
type Approval = { status: string; credential?: { url: string; token: string; mailbox_id: string };
  requester?: { id: string; label: string }; first_task_id?: string | null };
type Journal = { version: 1; agent: "codex" | "opencode"; workspace: string; server: string; deviceSecret: string;
  executable?: string; model?: string; requester?: { id: string; label: string }; firstTaskId?: string | null; mailboxId?: string };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const env = () => ({ ...process.env, UV_THREADPOOL_SIZE: "1", NODE_OPTIONS: "--v8-pool-size=1", RAYON_NUM_THREADS: "2", TOKIO_WORKER_THREADS: "2" });
const within = (parent: string, child: string) => { const rel = path.relative(parent, child); return !rel || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)); };

/** Resolve existing ancestors too, so a symlink cannot put private files in the project. */
function privatePath(file: string, workspace: string): string {
  const absolute = path.resolve(file);
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actual = path.join(realpathSync(ancestor), path.relative(ancestor, absolute));
  if (within(workspace, actual) || within(actual, workspace)) throw new Error("Choose a private config location outside the project folder");
  return actual;
}

async function request(server: string, action: string, input: unknown): Promise<any> {
  let response: Response;
  try {
    response = await fetch(server + "/worker-setup/" + action, { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  } catch { throw new Error("Connection interrupted. Run the same setup command to resume."); }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) throw new Error("This mailbox server needs an update to support worker setup");
    if (response.status === 410) throw new Error("Connection code expired. Run the same setup command for a new code.");
    if (response.status === 401) throw new Error("Connection revoked or expired. Check the worker connection on the mailbox website.");
    throw new Error(`Setup HTTP ${response.status}. Check the mailbox website, then run the same command to resume.`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > 16000) throw new Error("Invalid setup response");
  try { return JSON.parse(text); } catch { throw new Error("Invalid setup response"); }
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { windowsHide: true, detached: true, stdio: "ignore" });
  child.on("error", () => console.log("Open the link above in your browser.")); child.unref();
}

export async function setupWorker(options: SetupOptions): Promise<void> {
  let { agent, workspace } = options;
  if ((!agent || !workspace) && !process.stdin.isTTY) throw new Error("Use worker setup --agent codex|opencode --workspace PATH in a noninteractive terminal");
  if (!agent || !workspace) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!agent) {
        const answer = (await prompt.question("Agent: 1) Codex  2) OpenCode [1]: ")).trim().toLowerCase();
        if (!["", "1", "2", "codex", "opencode"].includes(answer)) throw new Error("Choose codex or opencode");
        agent = ["2", "opencode"].includes(answer) ? "opencode" : "codex";
      }
      if (!workspace) workspace = (await prompt.question(`Project folder [${process.cwd()}]: `)).trim() || process.cwd();
    } finally { prompt.close(); }
  }
  workspace = realpathSync(path.resolve(workspace!));
  if (!statSync(workspace).isDirectory()) throw new Error("Project folder must be a directory");
  const selected = agent!;
  const origin = new URL(options.server || "https://mcp.steves.app");
  if (origin.username || origin.password || origin.pathname !== "/" || origin.hash || origin.search ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)))) throw new Error("--server must be an HTTPS origin (HTTP only on loopback)");
  const server = origin.origin;
  const name = selected + "-" + createHash("sha256").update(workspace + "\n" + server).digest("hex").slice(0, 12);
  const file = privatePath(options.config || path.join(homedir(), ".ninja-p2p", "workers", name, "worker.json"), workspace);
  const journalFile = privatePath(file + ".setup.json", workspace);
  const mailboxFile = privatePath(file + ".mailbox.json", workspace);
  const stateDir = privatePath(file + ".state", workspace);
  const setupLock = privatePath(file + ".setup-lock", workspace);
  const executable = options.executable && (/[/\\]/.test(options.executable) ? path.resolve(options.executable) : options.executable);
  const launch = agentExecutable({ agent: selected, executable });
  const version = spawnSync(launch.command, [...launch.args, "--version"], { cwd: workspace, windowsHide: true, timeout: 10000, stdio: "ignore", env: env() });
  if (version.error || version.status !== 0) throw new Error(`Cannot run ${selected}. Install its CLI and sign in, then rerun setup.`);
  const unlock = lockWorker(setupLock);
  try {
    let journal = readWorkerJson<Journal>(journalFile);
    if (journal && (journal.version !== 1 || journal.agent !== selected || journal.workspace !== workspace || journal.server !== server || journal.executable !== executable || journal.model !== options.model)) {
      throw new Error("This setup belongs to different settings. Use the original command or choose another --config file.");
    }
    if (!journal) {
      if ([file, mailboxFile, stateDir].some(existsSync)) throw new Error("Worker settings already exist. Use worker start --config FILE, or choose another setup --config file.");
      journal = { version: 1, agent: selected, workspace, server, deviceSecret: randomBytes(32).toString("base64url"),
        ...(executable ? { executable } : {}), ...(options.model ? { model: options.model } : {}) };
      writeWorkerJson(journalFile, journal);
    }
    console.log(`\n${selected === "codex" ? "Codex" : "OpenCode"} worker · ${workspace}\nRead-only project access. Uses your existing agent CLI login.\n`);
    if (!existsSync(file)) {
      // A retry uses the same secret, so a lost response cannot create a second connection.
      const begun = await request(server, "start", { device_secret: journal.deviceSecret, agent: selected,
        label: (selected + " · " + path.basename(workspace)).replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 80) });
      if (!/^[A-F0-9]{4}(-[A-F0-9]{4}){2}$/.test(begun.code) || begun.verification_url !== server + "/connect?code=" + begun.code || !Number.isFinite(Date.parse(begun.expires_at))) throw new Error("Invalid connection code response");
      console.log(`Connect at ${begun.verification_url}\nCode: ${begun.code}\nSign in with your mailbox account key, select the requester, and connect.\n`);
      if (!options.noOpen) openBrowser(begun.verification_url);
      let approval: Approval | undefined;
      const deadline = Math.min(Date.parse(begun.expires_at), Date.now() + 600000);
      while (Date.now() < deadline) {
        const value = await request(server, "poll", { device_secret: journal.deviceSecret }) as Approval;
        if (value.status === "approved") { approval = value; break; }
        if (value.status === "denied") {
          rmSync(journalFile); // A definite decline permits a fresh code on the next invocation.
          throw new Error("Connection declined. No worker was started. Run setup again when ready.");
        }
        if (value.status !== "pending") throw new Error("Connection already received. Use the saved worker configuration.");
        await sleep(3000);
      }
      if (!approval) throw new Error("Connection code expired. Run the same setup command for a new code.");
      const { credential, requester, first_task_id } = approval;
      if (!credential || credential.url !== server || !/^[A-Za-z0-9_-]{43}$/.test(credential.token) || !/^[a-f0-9]{32}$/.test(credential.mailbox_id) ||
          !requester || !/^[a-f0-9]{32}$/.test(requester.id) || typeof requester.label !== "string" ||
          (first_task_id !== null && !/^[a-f0-9]{32}$/.test(first_task_id || ""))) throw new Error("Invalid worker connection response");
      writeWorkerJson(mailboxFile, credential);
      journal.requester = requester; journal.mailboxId = credential.mailbox_id; journal.firstTaskId = first_task_id;
      writeWorkerJson(journalFile, journal);
      writeWorkerJson(file, { mailboxConfig: mailboxFile, workspace, stateDir, agent: selected, allowedPeers: [requester.id],
        sandbox: "read-only", instructions: "Review files in this project and return concise findings. Do not edit files, install packages, publish, read secrets, contact external services, or perform unrelated work.",
        ...(executable ? { executable } : {}), ...(options.model ? { model: options.model } : {}) });
    }
    const config = loadWorkerConfig(file), mailbox = loadMailboxConfig(config.mailboxConfig);
    if (config.workspace !== workspace || config.agent !== selected || config.mailboxConfig !== mailboxFile || mailbox.url !== server ||
        config.allowedPeers.length !== 1 || config.allowedPeers[0] !== journal.requester?.id) throw new Error("Saved worker settings changed. Use worker start --config FILE to run your edited configuration.");
    // Acknowledgement only follows durable local storage. Expired acknowledgements do not invalidate saved credentials.
    try { await request(server, "finish", { device_secret: journal.deviceSecret }); }
    catch { console.log("Settings saved; the temporary connection code will expire automatically."); }
    const identity = await callMailbox(mailbox, "get_mailbox", {}) as { mailbox_id: string; peers: { id: string }[] };
    if (identity.mailbox_id !== journal.mailboxId || !identity.peers.some(peer => peer.id === journal!.requester?.id)) throw new Error("Worker pairing is missing. Check its connection on the mailbox website.");
    console.log(`Paired with ${journal.requester!.label.replace(/[\x00-\x1f\x7f-\x9f]/g, "")} (${journal.requester!.id}).\nSettings: ${file}`);
    const started = spawnSync(process.execPath, ["--v8-pool-size=1", fileURLToPath(new URL("./cli.js", import.meta.url)), "worker", "start", "--config", file],
      { cwd: workspace, windowsHide: true, timeout: 15000, encoding: "utf8", env: env() });
    if (started.error || started.status !== 0) throw new Error("Worker could not start. Check " + path.join(config.stateDir, "worker.log"));
    const readyDeadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      const lock = readWorkerJson<{ pid: number }>(path.join(config.stateDir, "worker.lock"));
      const status = readWorkerJson<{ pid: number; state: string }>(path.join(config.stateDir, "status.json"));
      if (!workerPidAlive(lock?.pid)) throw new Error("Worker exited. Check " + path.join(config.stateDir, "worker.log"));
      if (status?.pid === lock?.pid && ["waiting", "working"].includes(status?.state || "")) { ready = true; break; }
      await sleep(1000);
    }
    if (!ready) throw new Error(`Worker has not connected yet. Run ninja-p2p worker status --config "${file}"`);
    console.log(`Worker connected and running.\nStatus: ninja-p2p worker status --config "${file}"\nStop:   ninja-p2p worker stop --config "${file}"`);
    if (!journal.firstTaskId) {
      console.log("No first task was selected. Ask your paired agent to create a task for worker " + identity.mailbox_id + "."); return;
    }
    const taskUrl = server + "/tasks?box=" + journal.requester!.id + "&task=" + journal.firstTaskId;
    console.log("\nWaiting for your first task result. Follow it at " + taskUrl);
    const deadline = Date.now() + options.wait * 1000;
    let last = "";
    do {
      const task = await callMailbox(mailbox, "get_task", { task_id: journal.firstTaskId }) as { status: string; result?: string; note: string };
      if (task.status !== last) { console.log("First task: " + task.status); last = task.status; }
      if (task.status === "completed") {
        console.log("\nFirst task completed. Result returned to your requester:\n\n" + String(task.result || "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")); return;
      }
      if (["failed", "cancelled", "expired", "awaiting_approval"].includes(task.status)) throw new Error("First task " + task.status + ". Review it at " + taskUrl);
      if (Date.now() >= deadline) break;
      await sleep(3000);
    } while (Date.now() < deadline);
    console.log("First task is still pending; the worker remains available. Run the same setup command to check its result.");
    process.exitCode = 2;
  } finally { unlock(); }
}
