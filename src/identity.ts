import { hostname } from "node:os";

/**
 * Who is on the other end of the MCP connection, as the client said in the
 * `initialize` request.
 */
export interface ClientIdentity {
  /** The short name Tellagen stores, such as "claude-code". */
  name: string;
  /** The name a person reads, such as "Claude Code". */
  label: string;
  /** The client's own version; empty when it sent none. */
  version: string;
}

/** Request headers that carry the client facts on every Tellagen call. */
export const CLIENT_HEADER_NAME = "X-Tellagen-Client";
export const CLIENT_HEADER_VERSION = "X-Tellagen-Client-Version";
export const CLIENT_HEADER_COMPUTER = "X-Tellagen-Computer";
export const CLIENT_HEADER_SERVER_VERSION = "X-Tellagen-Server-Version";
export const CLIENT_HEADER_SESSION = "X-Tellagen-Client-Session";

/**
 * Names some clients send in `clientInfo.name`, the short name Tellagen
 * knows them by, and how a person calls them.
 */
const KNOWN_CLIENTS: Record<string, { name: string; label: string }> = {
  "claude-code": { name: "claude-code", label: "Claude Code" },
  "claude-desktop": { name: "claude-desktop", label: "Claude Desktop" },
  "claude-ai": { name: "claude-ai", label: "Claude" },
  "codex-mcp-client": { name: "codex", label: "Codex" },
  "codex-cli": { name: "codex", label: "Codex" },
  codex: { name: "codex", label: "Codex" },
  "cursor-vscode": { name: "cursor", label: "Cursor" },
  cursor: { name: "cursor", label: "Cursor" },
};

const MAX_NAME = 64;
const MAX_VERSION = 40;
const MAX_COMPUTER = 120;

/**
 * A value that is safe in a request header and in a JSON field: printable
 * ASCII, single spaces, at most `max` characters. The client name comes from
 * outside, so it is never trusted to be well formed.
 */
export function cleanIdentityValue(value: unknown, max = 100): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** The identity from the `clientInfo` of the MCP handshake, if it has a name. */
export function identityFromClientInfo(info: unknown): ClientIdentity | undefined {
  if (typeof info !== "object" || info === null) return undefined;
  const record = info as Record<string, unknown>;
  const rawName = cleanIdentityValue(record.name, MAX_NAME);
  if (!rawName) return undefined;
  const version = cleanIdentityValue(record.version, MAX_VERSION);
  const known = KNOWN_CLIENTS[rawName.toLowerCase()];
  if (known) return { ...known, version };
  return { name: rawName, label: cleanIdentityValue(record.title, MAX_NAME) || rawName, version };
}

/**
 * The deprecated TELLAGEN_MCP_CLIENT setting, read for one more release. It
 * is used only when the client sent no name in the handshake, and for a
 * Tellagen that still accepts only `codex` or `claude`.
 */
function legacyEnvClient(): "codex" | "claude" | undefined {
  const value = (process.env.TELLAGEN_MCP_CLIENT ?? "").trim().toLowerCase();
  return value === "codex" || value === "claude" ? value : undefined;
}

/** The name for a Tellagen that accepts only `codex` or `claude`. */
export function legacyClientName(identity: ClientIdentity | undefined): "codex" | "claude" {
  const fromEnv = legacyEnvClient();
  if (fromEnv) return fromEnv;
  return identity && /claude/i.test(identity.name) ? "claude" : "codex";
}

/** The name sent to Tellagen: the handshake name, else the deprecated setting. */
export function reportedClientName(identity: ClientIdentity | undefined): string {
  return identity?.name ?? legacyEnvClient() ?? "mcp-client";
}

/** This computer's name, cleaned for a header. Empty when it has none. */
export function computerName(): string {
  try {
    return cleanIdentityValue(hostname(), MAX_COMPUTER);
  } catch {
    return "";
  }
}
