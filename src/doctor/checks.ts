import { delimiter, isAbsolute, join, basename } from "node:path";
import { CLIENT_LABELS, type DoctorClient, type DoctorFs, type ServerEntry } from "./config-files.js";

export const DOCTOR_TOOLS = ["grafana", "kubernetes", "github", "docs"] as const;
export type DoctorTool = (typeof DOCTOR_TOOLS)[number];

/** The shorter PATH that a desktop app starts its servers with. A terminal PATH is not used. */
export const DESKTOP_BASE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Clients that a person starts from a dock or a menu, not from a terminal. */
const DESKTOP_CLIENTS: ReadonlySet<DoctorClient> = new Set(["claude-desktop", "cursor"]);

interface ToolProfile {
  /** A server whose name matches is this tool. */
  name: RegExp;
  /** A server whose command line matches is this tool. */
  command: RegExp;
  /** Each group needs at least one of its names to be set in the entry. */
  env: string[][];
}

const PROFILES: Record<DoctorTool, ToolProfile> = {
  grafana: {
    name: /grafana/i,
    command: /mcp-grafana|grafana-mcp/i,
    env: [["GRAFANA_URL"], ["GRAFANA_SERVICE_ACCOUNT_TOKEN", "GRAFANA_API_KEY"]],
  },
  kubernetes: { name: /kubernetes|k8s|kubectl/i, command: /kubernetes-mcp-server|mcp-server-kubernetes/i, env: [] },
  github: { name: /github/i, command: /github-mcp-server|server-github/i, env: [["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"]] },
  docs: {
    // A documentation server, or the Atlassian, Confluence or Notion servers that hold the runbooks.
    // A Bitbucket server is a code server, not documentation.
    name: /^(?!.*bitbucket).*((^|[^a-z])(docs?|documentation|atlassian|jira|confluence|notion)([^a-z]|$))/i,
    command: /docs-mcp|mcp-docs|mcp-atlassian|atlassian[-/]?mcp|mcp\.atlassian\.com|confluence|notion-mcp|mcp\.notion\.com|@notionhq/i,
    env: [],
  },
};

/** The catalog tool an entry is, by its name first and then by its command line. */
export function toolOfEntry(entry: ServerEntry): DoctorTool | undefined {
  for (const tool of DOCTOR_TOOLS) if (PROFILES[tool].name.test(entry.name)) return tool;
  const line = [entry.command ?? "", ...entry.args, entry.url ?? ""].join(" ");
  for (const tool of DOCTOR_TOOLS) if (PROFILES[tool].command.test(line)) return tool;
  return undefined;
}

export type CheckStatus = "ok" | "failed" | "warning" | "not_checked";
export type AccessProblem = "missing_tool" | "auth_missing" | "unreachable";

export interface DoctorCheck {
  id: "command_resolves" | "env_present" | "health";
  label: string;
  status: CheckStatus;
  /** One plain sentence of what to do. It may name a path of this computer, so it never leaves it. */
  summary: string;
  /** The same fact in fixed words with no name, path or value. It is what --report sends. */
  reportSummary: string;
  /** For command_resolves: the full path to use in the command, when the command exists elsewhere. */
  fixCommand?: string;
}

export interface ToolResult {
  client: DoctorClient;
  source: string;
  serverName: string;
  tool: DoctorTool;
  checks: DoctorCheck[];
  problem?: AccessProblem;
  entry: ServerEntry;
}

export interface CheckDeps {
  fs: DoctorFs;
  /** The PATH of the shell that runs the doctor. */
  shellPath: string;
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<{ status: number }>;
  healthTimeoutMs?: number;
}

const COMMON_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", ".local/bin", ".cargo/bin", ".bun/bin"];

function executableNames(command: string, fs: DoctorFs): string[] {
  if (fs.platform !== "win32" || /\.[A-Za-z0-9]{1,4}$/.test(command)) return [command];
  return [command, ...[".exe", ".cmd", ".bat"].map((ext) => command + ext)];
}

function search(command: string, dirs: string[], fs: DoctorFs): string | undefined {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of executableNames(command, fs)) {
      const path = join(dir, name);
      if (fs.isExecutable(path)) return path;
    }
  }
  return undefined;
}

function pathList(value: string | undefined, fs: DoctorFs): string[] {
  return (value ?? "").split(fs.platform === "win32" ? ";" : delimiter).filter(Boolean);
}

function commandCheck(entry: ServerEntry, deps: CheckDeps): DoctorCheck {
  const { fs } = deps;
  const label = CLIENT_LABELS[entry.client];
  const first = (entry.command ?? "").split(/\s+/)[0] ?? "";
  const name = basename(first);
  const entryPath = pathList(entry.env.PATH ?? entry.env.Path, fs);
  const desktop = DESKTOP_CLIENTS.has(entry.client) && fs.platform !== "win32";
  const clientDirs = desktop ? [...pathList(DESKTOP_BASE_PATH, fs), ...entryPath] : [...pathList(deps.shellPath, fs), ...entryPath];
  const check = (status: CheckStatus, summary: string, reportSummary: string, fixCommand?: string): DoctorCheck => ({
    id: "command_resolves",
    label: "The command can be started",
    status,
    summary,
    reportSummary,
    ...(fixCommand ? { fixCommand } : {}),
  });

  if (isAbsolute(first) || /[\\/]/.test(first)) {
    const full = isAbsolute(first) ? first : join(fs.cwd, first);
    if (fs.isExecutable(full)) return check("ok", `${name} is there and can run.`, "The command is there and can run.");
    return check(
      "failed",
      `${label} cannot run the command ${name}: the file is missing or is not allowed to run. Install it again or fix the path in the command.`,
      "The command file is missing or cannot run.",
    );
  }
  const found = search(first, clientDirs, fs);
  if (found) {
    return check("ok", `${label} finds ${name}.`, "The command is found where the client starts it.");
  }
  const elsewhere = search(first, [...pathList(deps.shellPath, fs), ...COMMON_DIRS.map((dir) => (isAbsolute(dir) ? dir : join(fs.home, dir)))], fs);
  if (elsewhere) {
    const where = desktop ? `${label} starts ${name} from a shorter PATH than your terminal.` : `${label} does not find ${name} on its PATH.`;
    return check(
      "failed",
      `${where} Use ${elsewhere} in the command.`,
      desktop ? "The client starts the command from a shorter PATH than a terminal, so it cannot find it." : "The command is not on the PATH the client uses.",
      elsewhere,
    );
  }
  return check(
    "failed",
    `${name} is not on any PATH that ${label} uses, and was not found in the usual places. Install it, then use its full path in the command.`,
    "The command was not found on any PATH.",
  );
}

function envCheck(entry: ServerEntry, tool: DoctorTool): DoctorCheck | undefined {
  const groups = PROFILES[tool].env;
  if (groups.length === 0 || entry.url) return undefined;
  const missing = groups.filter((group) => !group.some((name) => (entry.env[name] ?? "").trim() !== "")).map((group) => group.join(" or "));
  if (missing.length === 0) {
    return { id: "env_present", label: "The settings the tool needs are set", status: "ok", summary: "Every setting the tool needs is in the entry.", reportSummary: "The required settings are in the client config." };
  }
  return {
    id: "env_present",
    label: "The settings the tool needs are set",
    status: "failed",
    summary: `Add ${missing.join(" and ")} to the env of the ${entry.name} entry. Only the names are checked, never the values.`,
    reportSummary: "A setting the tool needs is missing from the client config.",
  };
}

function healthAddress(entry: ServerEntry): URL | undefined {
  const raw = (entry.env.GRAFANA_URL ?? "").trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

async function healthCheck(entry: ServerEntry, deps: CheckDeps): Promise<DoctorCheck | undefined> {
  const base = healthAddress(entry);
  if (!base) return undefined;
  const target = `${base.origin}${base.pathname.replace(/\/+$/, "")}/api/health`;
  const label = "Grafana answers";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.healthTimeoutMs ?? 5000);
  try {
    // No token is sent: /api/health needs none.
    const res = await deps.fetch(target, { signal: controller.signal });
    if (res.status >= 200 && res.status < 300) {
      return { id: "health", label, status: "ok", summary: `${base.origin} answers /api/health.`, reportSummary: "Grafana answers its health check." };
    }
    return {
      id: "health",
      label,
      status: "failed",
      summary: `${base.origin} answered /api/health with status ${res.status}. Check GRAFANA_URL and the network.`,
      reportSummary: "Grafana did not answer its health check.",
    };
  } catch {
    return {
      id: "health",
      label,
      status: "failed",
      summary: `${base.origin} did not answer /api/health. Check GRAFANA_URL, the VPN and the network.`,
      reportSummary: "Grafana did not answer its health check.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the checks of one server entry that matches a catalog tool. */
export async function checkEntry(entry: ServerEntry, tool: DoctorTool, deps: CheckDeps): Promise<ToolResult> {
  const checks: DoctorCheck[] = [];
  if (entry.command) checks.push(commandCheck(entry, deps));
  const env = envCheck(entry, tool);
  if (env) checks.push(env);
  if (tool === "grafana") {
    const health = await healthCheck(entry, deps);
    if (health) checks.push(health);
  }
  const failed = (id: DoctorCheck["id"]) => checks.some((check) => check.id === id && check.status === "failed");
  const problem: AccessProblem | undefined = failed("command_resolves")
    ? "missing_tool"
    : failed("env_present")
      ? "auth_missing"
      : failed("health")
        ? "unreachable"
        : undefined;
  return { client: entry.client, source: entry.source, serverName: entry.name, tool, checks, ...(problem ? { problem } : {}), entry };
}
