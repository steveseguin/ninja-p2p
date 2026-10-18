import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { readWorkerJson, writeWorkerJson, type WorkerConfig } from "./worker-config.js";

export type AgentResult = { status: "completed" | "needs_approval" | "failed"; text: string };
export type AgentJob = Pick<WorkerConfig, "agent" | "workspace" | "executable" | "model" | "sandbox" | "timeoutSeconds"> & { prompt: string };
export type AgentOutcome = { result?: AgentResult; error?: string; finishedAt: string };

export function parseAgentResult(text: string): AgentResult {
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1"));
  if (!value || !["completed", "needs_approval", "failed"].includes(value.status) || typeof value.text !== "string" ||
      !value.text.trim() || Buffer.byteLength(value.text) > (value.status === "completed" ? 8000 : 2000)) throw new Error("Agent returned an invalid or oversized result");
  return { status: value.status, text: value.text.trim() };
}

/** Resolve executable launchers without passing a task through a command shell. */
export function agentExecutable(config: Pick<WorkerConfig, "agent" | "executable">): { command: string; args: string[] } {
  const name = config.executable || config.agent;
  if (/\.(?:js|mjs|cjs)$/i.test(name)) return { command: process.execPath, args: [path.resolve(name)] };
  if (/\.(?:cmd|bat|ps1)$/i.test(name)) throw new Error("Use the agent's native executable or Node .js entry point instead of a shell wrapper");
  if (process.platform !== "win32" || path.isAbsolute(name)) return { command: name, args: [] };
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, name + ".exe");
    if (existsSync(exe)) return { command: exe, args: [] };
  }
  if (name === "codex") {
    for (const dir of [...dirs, path.join(process.env.APPDATA || "", "npm")]) {
      const entry = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(entry)) return { command: process.execPath, args: [entry] };
    }
  }
  throw new Error(`Cannot find ${name}; set executable to its native executable or Node entry point`);
}

export function workerAgentEnv(job: AgentJob): NodeJS.ProcessEnv {
  const env = { ...process.env, UV_THREADPOOL_SIZE: "1", NODE_OPTIONS: "--v8-pool-size=1", RAYON_NUM_THREADS: "2", TOKIO_WORKER_THREADS: "2" };
  for (const key of Object.keys(env)) if (key.startsWith("NINJA_")) delete (env as NodeJS.ProcessEnv)[key];
  if (job.agent === "opencode") {
    // This invocation only. Never change the user's saved OpenCode configuration.
    // --pure excludes project/global plugins; permission checks still apply.
    (env as NodeJS.ProcessEnv).OPENCODE_CONFIG_CONTENT = JSON.stringify({ autoupdate: false, share: "disabled",
      permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow",
        external_directory: "deny", edit: job.sandbox === "workspace-write" ? "allow" : "deny" } });
    (env as NodeJS.ProcessEnv).OPENCODE_DISABLE_AUTOUPDATE = "true";
    (env as NodeJS.ProcessEnv).OPENCODE_DISABLE_LSP_DOWNLOAD = "true";
  }
  return env;
}

/** A separate process saves the outcome even if the mailbox listener restarts. */
export async function runWorkerAgent(dir: string): Promise<void> {
  const job = readWorkerJson<AgentJob>(path.join(dir, "job.json"));
  if (!job) throw new Error("Missing worker job");
  // A dispatch is attempted at most once. Uncertain execution needs an owner decision.
  const once = openSync(path.join(dir, "launched.lock"), "wx", 0o600); closeSync(once);
  writeWorkerJson(path.join(dir, "running.json"), { pid: process.pid, startedAt: Date.now() });
  let outcome: AgentOutcome;
  try { outcome = { result: await executeAgent(job, dir), finishedAt: new Date().toISOString() }; }
  catch (error) { outcome = { error: error instanceof Error ? error.message : "Agent failed", finishedAt: new Date().toISOString() }; }
  writeWorkerJson(path.join(dir, "outcome.json"), outcome);
}

async function executeAgent(job: AgentJob, dir: string): Promise<AgentResult> {
  const launch = agentExecutable(job), finalFile = path.join(dir, "final.json");
  const schema = { type: "object", properties: { status: { type: "string", enum: ["completed", "needs_approval", "failed"] }, text: { type: "string" } }, required: ["status", "text"], additionalProperties: false };
  writeWorkerJson(path.join(dir, "schema.json"), schema);
  const args = job.agent === "codex"
    ? ["exec", "--sandbox", job.sandbox, "-c", 'approval_policy="never"', "--cd", job.workspace, "--skip-git-repo-check", "--json", "--output-schema", path.join(dir, "schema.json"), "-o", finalFile, ...(job.model ? ["--model", job.model] : []), "-"]
    : ["run", "--pure", "--format", "json", "--dir", job.workspace, ...(job.model ? ["--model", job.model] : [])];
  const out = openSync(path.join(dir, "events.jsonl"), "a", 0o600), err = openSync(path.join(dir, "stderr.log"), "a", 0o600);
  let lastText = "", pending = "", bytes = 0, failure: string | undefined, stopping = false;
  const decoder = new StringDecoder("utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(launch.command, [...launch.args, ...args], { cwd: job.workspace, windowsHide: true,
        detached: process.platform !== "win32", env: workerAgentEnv(job), stdio: ["pipe", "pipe", "pipe"] });
      writeWorkerJson(path.join(dir, "running.json"), { pid: process.pid, childPid: child.pid, startedAt: Date.now() });
      const stop = (reason: string) => {
        if (stopping) return;
        stopping = true;
        failure = reason;
        if (!child.pid) return;
        if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      };
      const timeout = setTimeout(() => stop("Agent time limit reached; review its work before retrying"), job.timeoutSeconds * 1000);
      const cancel = setInterval(() => { if (existsSync(path.join(dir, "cancel.json"))) stop("Cancellation requested; agent process stopped"); }, 500);
      const consume = (buffer: Buffer, fd: number) => {
        bytes += buffer.length;
        if (bytes > 8 * 1024 * 1024) { stop("Agent log limit reached; review its work before retrying"); return; }
        writeSync(fd, buffer);
        if (fd !== out || job.agent !== "opencode") return;
        pending += decoder.write(buffer);
        let index;
        while ((index = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, index); pending = pending.slice(index + 1);
          try { const event = JSON.parse(line); if (event.type === "text" && typeof event.part?.text === "string") lastText = event.part.text; if (event.type === "error") failure = "OpenCode reported a failed turn; inspect events.jsonl"; } catch { /* Non-event diagnostic output. */ }
        }
      };
      child.stdout.on("data", chunk => consume(chunk, out)); child.stderr.on("data", chunk => consume(chunk, err));
      child.stdin.on("error", () => {});
      child.stdin.end(job.prompt);
      child.on("error", error => { clearTimeout(timeout); clearInterval(cancel); reject(error); });
      child.on("close", code => { clearTimeout(timeout); clearInterval(cancel); if (failure || code !== 0) reject(new Error(failure || `Agent exited with code ${code}; inspect stderr.log`)); else resolve(); });
    });
  } finally { closeSync(out); closeSync(err); }
  return parseAgentResult(job.agent === "codex" ? readFileSync(finalFile, "utf8") : lastText);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkerAgent(path.resolve(process.argv[2])).catch(error => { console.error(error.message); process.exitCode = 1; });
}
