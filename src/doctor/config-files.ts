import { join } from "node:path";
import { parseToml, type TomlValue } from "./toml.js";

export const DOCTOR_CLIENTS = ["claude-code", "claude-desktop", "codex", "cursor"] as const;
export type DoctorClient = (typeof DOCTOR_CLIENTS)[number];

export const CLIENT_LABELS: Record<DoctorClient, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  cursor: "Cursor",
};

/** What the doctor needs from the computer, so a test can run it on fixture folders. */
export interface DoctorFs {
  platform: NodeJS.Platform;
  home: string;
  cwd: string;
  /** The folder of Windows application data; empty elsewhere. */
  appData: string;
  /** The folder of Linux user config; empty elsewhere. */
  xdgConfig: string;
  /** The text of a file, or undefined when it is not there or cannot be read. */
  readText(path: string): string | undefined;
  /** Whether a path is a file that the person may run. */
  isExecutable(path: string): boolean;
}

/** One MCP server entry of a client config. The values of env are kept only inside the doctor. */
export interface ServerEntry {
  client: DoctorClient;
  /** Which file it came from, as a short name for the output. */
  source: string;
  /** The name the entry has in the config. */
  name: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  /** A remote server is reached by address, so it has no command to start. */
  url?: string;
}

export interface ConfigFile {
  client: DoctorClient;
  /** A short name such as "Claude Desktop config", never a path. */
  source: string;
  path: string;
}

/** The config files each client may have, in reading order. */
export function configFilesFor(client: DoctorClient, fs: DoctorFs): ConfigFile[] {
  switch (client) {
    case "claude-code":
      return [
        { client, source: "~/.claude.json", path: join(fs.home, ".claude.json") },
        { client, source: ".mcp.json of the current folder", path: join(fs.cwd, ".mcp.json") },
      ];
    case "claude-desktop": {
      const file = "claude_desktop_config.json";
      const path =
        fs.platform === "darwin"
          ? join(fs.home, "Library", "Application Support", "Claude", file)
          : fs.platform === "win32"
            ? join(fs.appData || join(fs.home, "AppData", "Roaming"), "Claude", file)
            : join(fs.xdgConfig || join(fs.home, ".config"), "Claude", file);
      return [{ client, source: "Claude Desktop config", path }];
    }
    case "codex":
      return [{ client, source: "~/.codex/config.toml", path: join(fs.home, ".codex", "config.toml") }];
    case "cursor":
      return [{ client, source: "~/.cursor/mcp.json", path: join(fs.home, ".cursor", "mcp.json") }];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryFrom(client: DoctorClient, source: string, name: string, raw: unknown): ServerEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const env: Record<string, string> = {};
  if (isRecord(raw.env)) {
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value === "string" || typeof value === "number") env[key] = String(value);
    }
  }
  const command = typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : undefined;
  const url = typeof raw.url === "string" ? raw.url : typeof raw.serverUrl === "string" ? raw.serverUrl : undefined;
  if (!command && !url) return undefined;
  return {
    client,
    source,
    name,
    ...(command ? { command } : {}),
    args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [],
    env,
    ...(url ? { url } : {}),
  };
}

function fromServerMap(client: DoctorClient, source: string, map: unknown): ServerEntry[] {
  if (!isRecord(map)) return [];
  const out: ServerEntry[] = [];
  for (const [name, raw] of Object.entries(map)) {
    const entry = entryFrom(client, source, name, raw);
    if (entry) out.push(entry);
  }
  return out;
}

/** The server entries of one config file's text. A file that does not parse gives none. */
export function parseServerEntries(file: ConfigFile, text: string, fs: DoctorFs): ServerEntry[] {
  try {
    if (file.client === "codex") {
      const root = parseToml(text);
      return fromServerMap("codex", file.source, root.mcp_servers as TomlValue);
    }
    const json: unknown = JSON.parse(text);
    if (!isRecord(json)) return [];
    const entries = fromServerMap(file.client, file.source, json.mcpServers);
    if (file.client === "claude-code" && isRecord(json.projects)) {
      // The local scope of Claude Code keeps servers under the project folder.
      const project = json.projects[fs.cwd];
      if (isRecord(project)) {
        entries.push(...fromServerMap("claude-code", "~/.claude.json (this project)", project.mcpServers));
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export interface ClientScan {
  client: DoctorClient;
  /** Files that exist, by short name. */
  filesRead: string[];
  /** Files that exist but could not be read as a config. */
  unreadable: string[];
  entries: ServerEntry[];
}

export function scanClient(client: DoctorClient, fs: DoctorFs): ClientScan {
  const scan: ClientScan = { client, filesRead: [], unreadable: [], entries: [] };
  for (const file of configFilesFor(client, fs)) {
    const text = fs.readText(file.path);
    if (text === undefined) continue;
    const entries = parseServerEntries(file, text, fs);
    const parsed = (() => {
      try {
        if (client === "codex") return true;
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    })();
    if (parsed) scan.filesRead.push(file.source);
    else scan.unreadable.push(file.source);
    scan.entries.push(...entries);
  }
  return scan;
}
