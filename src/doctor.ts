/**
 * Diagnostics
 *
 * When a P2P connection fails, the user has no idea whether the problem is the
 * native WebRTC module, the network, the room name, or a sidecar that quietly
 * died. `ninja-p2p doctor` answers that in one command so "it does not connect"
 * becomes an actionable report instead of a support thread.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type CheckStatus = "ok" | "warn" | "fail";

export type DiagnosticCheck = {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
};

export type DiagnosticsReport = {
  ok: boolean;
  checks: DiagnosticCheck[];
};

export const MINIMUM_NODE_MAJOR = 20;
export const DEFAULT_SIGNALING_URL = "wss://wss.vdo.ninja";

/** Node 20 is the documented floor; below that the ESM + native combo breaks. */
export function checkNodeVersion(version: string): DiagnosticCheck {
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!Number.isFinite(major)) {
    return {
      name: "node",
      status: "warn",
      detail: `could not parse Node version "${version}"`,
    };
  }
  if (major < MINIMUM_NODE_MAJOR) {
    return {
      name: "node",
      status: "fail",
      detail: `Node ${version} is below the required v${MINIMUM_NODE_MAJOR}`,
      hint: `install Node ${MINIMUM_NODE_MAJOR} or newer`,
    };
  }
  return { name: "node", status: "ok", detail: `Node ${version}` };
}

/**
 * The native WebRTC module is optional for the library but required for a Node
 * sidecar to actually hold a data channel, so a miss is a warning with a fix
 * rather than a hard failure.
 */
export async function checkWebRtc(
  load: () => Promise<unknown> = () => import("@roamhq/wrtc"),
): Promise<DiagnosticCheck> {
  try {
    await load();
    return { name: "webrtc", status: "ok", detail: "@roamhq/wrtc is installed" };
  } catch (error) {
    return {
      name: "webrtc",
      status: "warn",
      detail: `@roamhq/wrtc not loadable: ${errorMessage(error)}`,
      hint: "npm install -g @roamhq/wrtc (Node sidecars need it to hold data channels)",
    };
  }
}

/** Confirm the VDO.Ninja signaling server is reachable before blaming NAT. */
export async function checkSignaling(
  url: string = DEFAULT_SIGNALING_URL,
  timeoutMs = 8000,
): Promise<DiagnosticCheck> {
  const startedAt = Date.now();
  let SocketImpl: typeof WebSocket | undefined = globalThis.WebSocket;

  if (!SocketImpl) {
    try {
      const ws = await import("ws");
      SocketImpl = (ws.default ?? ws) as unknown as typeof WebSocket;
    } catch (error) {
      return {
        name: "signaling",
        status: "warn",
        detail: `no WebSocket implementation available: ${errorMessage(error)}`,
        hint: "use Node 22+, which ships a global WebSocket",
      };
    }
  }

  return new Promise<DiagnosticCheck>((resolve) => {
    let settled = false;
    let socket: WebSocket;

    const finish = (check: DiagnosticCheck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // The socket may already be closed; nothing useful to do here.
      }
      resolve(check);
    };

    const timer = setTimeout(() => {
      finish({
        name: "signaling",
        status: "fail",
        detail: `no response from ${url} within ${timeoutMs}ms`,
        hint: "check your firewall or proxy; outbound wss:// must be allowed",
      });
    }, timeoutMs);

    try {
      socket = new SocketImpl!(url);
    } catch (error) {
      finish({
        name: "signaling",
        status: "fail",
        detail: `could not open ${url}: ${errorMessage(error)}`,
      });
      return;
    }

    socket.onopen = () => {
      finish({
        name: "signaling",
        status: "ok",
        detail: `${url} reachable in ${Date.now() - startedAt}ms`,
      });
    };

    socket.onerror = () => {
      finish({
        name: "signaling",
        status: "fail",
        detail: `could not reach ${url}`,
        hint: "check your firewall or proxy; outbound wss:// must be allowed",
      });
    };
  });
}

/** A sidecar that cannot write its state folder will fail in confusing ways. */
export function checkStateRoot(stateRoot: string): DiagnosticCheck {
  const probe = path.join(stateRoot, ".doctor-write-probe");
  try {
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe, { force: true });
    return { name: "state", status: "ok", detail: `${stateRoot} is writable` };
  } catch (error) {
    return {
      name: "state",
      status: "fail",
      detail: `cannot write ${stateRoot}: ${errorMessage(error)}`,
      hint: "set NINJA_STATE_DIR to a writable folder",
    };
  }
}

export type SidecarSnapshot = {
  id: string;
  room: string | null;
  pid: number | null;
  running: boolean;
};

/** Report sidecars this machine believes it started, and whether they survived. */
export function checkSidecars(
  stateRoot: string,
  readSession: (dir: string) => { room?: string; streamId?: string; pid?: number } | null,
  isRunning: (pid: number) => boolean,
): { check: DiagnosticCheck; sidecars: SidecarSnapshot[] } {
  if (!existsSync(stateRoot)) {
    return {
      check: { name: "sidecars", status: "ok", detail: "no sidecars have been started yet" },
      sidecars: [],
    };
  }

  const sidecars: SidecarSnapshot[] = [];
  for (const entry of safeReadDir(stateRoot)) {
    const session = readSession(path.join(stateRoot, entry));
    if (!session) continue;
    const pid = typeof session.pid === "number" ? session.pid : null;
    sidecars.push({
      id: session.streamId ?? entry,
      room: session.room ?? null,
      pid,
      running: pid !== null && isRunning(pid),
    });
  }

  const live = sidecars.filter((sidecar) => sidecar.running);
  if (sidecars.length === 0) {
    return {
      check: { name: "sidecars", status: "ok", detail: "no sidecars have been started yet" },
      sidecars,
    };
  }

  const stale = sidecars.length - live.length;
  return {
    check: {
      name: "sidecars",
      status: live.length > 0 || stale === 0 ? "ok" : "warn",
      detail: `${live.length} running, ${stale} stopped`,
      hint: stale > 0 && live.length === 0 ? "start one with: ninja-p2p start --id <name>" : undefined,
    },
    sidecars,
  };
}

/** A report fails only on hard failures; warnings are survivable. */
export function summarizeChecks(checks: DiagnosticCheck[]): DiagnosticsReport {
  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

export function formatReport(report: DiagnosticsReport, sidecars: SidecarSnapshot[]): string {
  const symbols: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  const lines = ["ninja-p2p doctor", ""];

  for (const check of report.checks) {
    lines.push(`[${symbols[check.status]}] ${check.name.padEnd(10)} ${check.detail}`);
    if (check.hint) {
      lines.push(`${" ".repeat(18)}-> ${check.hint}`);
    }
  }

  if (sidecars.length > 0) {
    lines.push("", "Sidecars:");
    for (const sidecar of sidecars) {
      const state = sidecar.running ? `running pid=${sidecar.pid}` : "stopped";
      lines.push(`  ${sidecar.id.padEnd(16)} ${state}  room=${sidecar.room ?? "unknown"}`);
    }
  }

  lines.push("", report.ok ? "All required checks passed." : "Some checks failed; see hints above.");
  return lines.join("\n");
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
