import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type MailboxConfig = { url: string; token: string };

export function loadMailboxConfig(file: string): MailboxConfig {
  let value;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("Cannot read mailbox config; provide a private JSON file with url and token"); }
  let url: URL;
  try { url = new URL(value.url); } catch { throw new Error("Mailbox URL must be an HTTPS origin"); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Mailbox URL requires an HTTPS origin; HTTP is allowed only on loopback");
  }
  if (typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) {
    throw new Error("Invalid mailbox token; use the config supplied by your service operator");
  }
  return { url: url.origin, token: value.token };
}

/** Stateless MCP client: no WebRTC runtime or continuously running local agent. */
export async function callMailbox(config: MailboxConfig, name: string, args: Record<string, unknown>): Promise<unknown> {
  const version = "2026-07-28";
  const requestId = randomUUID();
  let response: Response;
  try {
    response = await fetch(new URL("/mcp", config.url), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json",
        Accept: "application/json", Connection: "close", "MCP-Protocol-Version": version, "Mcp-Method": "tools/call", "Mcp-Name": name },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: {
        name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientInfo": { name: "ninja-p2p", version: "0.2.4" },
          "io.modelcontextprotocol/clientCapabilities": {} },
      } }),
    });
  } catch {
    throw new Error("Mailbox connection failed; a send may have been stored. Retry with the same request key");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Mailbox HTTP ${response.status}${response.status === 401 ? "; renew your mailbox credential" : ""}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty mailbox response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error("Mailbox response too large");
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("Incomplete mailbox response; retry sends with the same request key");
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Invalid mailbox response"); }
  if (data.id !== requestId || data.jsonrpc !== "2.0") throw new Error("Mismatched mailbox response");
  if (data.error) throw new Error("Mailbox MCP request failed");
  if (data.result?.isError) throw new Error(String(data.result.content?.[0]?.text || "Mailbox tool failed"));
  if (data.result?.structuredContent !== undefined) return data.result.structuredContent;
  throw new Error("Missing mailbox result");
}

export function parseMailboxCommand(args: string[], env: NodeJS.ProcessEnv): {
  kind: "mailbox"; configFile: string; tool: string; arguments: Record<string, unknown>;
} {
  let configFile = env.NINJA_MAILBOX_CONFIG;
  let requestKey: string | undefined;
  let after = 0;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (!["--config", "--request-key", "--after"].includes(arg)) throw new Error(`Unknown mailbox option ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--config") configFile = value;
    if (arg === "--request-key") requestKey = value;
    if (arg === "--after") {
      after = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(after)) throw new Error("--after must be a nonnegative safe integer");
    }
  }
  if (!configFile) throw new Error("Use mailbox --config FILE or NINJA_MAILBOX_CONFIG");
  const [command, target, ...rest] = positional;
  const text = rest.join(" ");
  const result = (tool: string, arguments_: Record<string, unknown>) => ({ kind: "mailbox" as const, configFile, tool, arguments: arguments_ });
  if (command === "identity" && positional.length === 1) return result("get_mailbox", {});
  if (command === "read" && positional.length === 1) return result("read_messages", { after_sequence: after });
  if (command === "invite" && positional.length === 1) return result("create_peer_invitation", {});
  if (command === "pair" && positional.length === 2) return result("accept_peer_invitation", { invitation: target });
  if (command === "unpair" && positional.length === 2) return result("disconnect_peer", { peer_id: target });
  if ((command === "send" || command === "reply") && /^[a-f0-9]{32}$/.test(target || "") && text.trim() && Buffer.byteLength(text) <= 16000) {
    if (command === "reply") return result("reply_to_message", { message_id: target, text });
    if (!requestKey || !/^[A-Za-z0-9_-]{8,100}$/.test(requestKey)) throw new Error("send requires --request-key (8-100 letters, digits, underscores or hyphens); reuse it for retries only");
    return result("send_message", { recipient_id: target, text, request_key: requestKey });
  }
  throw new Error("Use mailbox identity, read [--after N], send PEER TEXT --request-key KEY, reply MESSAGE TEXT, invite, pair INVITATION, or unpair PEER");
}
