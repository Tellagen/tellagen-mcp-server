import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { TellagenClient } from "../client.js";
import { createRuntime } from "../bootstrap.js";
import { checkEntry, DOCTOR_TOOLS, toolOfEntry, type CheckDeps, type DoctorTool, type ToolResult } from "../doctor/checks.js";
import {
  CLIENT_LABELS,
  DOCTOR_CLIENTS,
  scanClient,
  type ClientScan,
  type DoctorClient,
  type DoctorFs,
} from "../doctor/config-files.js";
import { formatError, TellagenAPIError } from "../errors.js";
import { TOOL_REPORT_PATH } from "../tool-report.js";
import { MCP_SERVER_VERSION } from "../version.js";
import { parseArgs, type CliIo } from "./io.js";

const MAX_CONFIG_BYTES = 4 << 20;

export const DOCTOR_USAGE =
  "Usage: tellagen-mcp-server doctor [--client claude-code|claude-desktop|codex|cursor] [--tool grafana|kubernetes|github|docs] [--fix] [--report]\n";

/** The computer this process runs on. */
export function realDoctorFs(): DoctorFs {
  return {
    platform: process.platform,
    home: homedir(),
    cwd: process.cwd(),
    appData: process.env.APPDATA ?? "",
    xdgConfig: process.env.XDG_CONFIG_HOME ?? "",
    readText(path) {
      try {
        if (statSync(path).size > MAX_CONFIG_BYTES) return undefined;
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    isExecutable(path) {
      try {
        if (!statSync(path).isFile()) return false;
        if (process.platform !== "win32") accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface DoctorDeps {
  fs?: DoctorFs;
  shellPath?: string;
  fetch?: CheckDeps["fetch"];
  /** The client that posts the report. Left out, one is built from the environment and the sign-in. */
  reportClient?: () => Promise<TellagenClient>;
}

interface ClientReport {
  scan: ClientScan;
  results: ToolResult[];
}

/** One line of what a person does to read the result: the status word first. */
function statusWord(status: string): string {
  return status === "ok" ? "ok  " : status === "failed" ? "FAIL" : "warn";
}

/**
 * Args the doctor prints: flags that take no value and names of programs and
 * packages it recognises. Anything else, including any value that follows a
 * flag, prints as a placeholder, because the output may be pasted.
 */
const SAFE_ARGS: ReadonlySet<string> = new Set([
  "-y", "--yes", "-q", "--quiet", "--stdio", "stdio", "server", "run", "-i", "--rm",
  "npx", "uvx", "node", "mcp-grafana", "kubernetes-mcp-server", "mcp-server-kubernetes",
  "github-mcp-server", "@modelcontextprotocol/server-github", "@tellagen/mcp-server", "docs-mcp",
]);

export function safeArgs(args: readonly string[]): string[] {
  return args.map((arg) => (SAFE_ARGS.has(arg) ? arg : "<keep your arg>"));
}

/** A corrected entry for the person to paste. Env values are never printed, only their names. */
function correctedEntry(result: ToolResult, fixCommand: string): string {
  const entry = result.entry;
  const envNames = Object.keys(entry.env);
  const args = safeArgs(entry.args);
  if (entry.client === "codex") {
    const lines = [`[mcp_servers.${JSON.stringify(entry.name).slice(1, -1)}]`, `command = ${JSON.stringify(fixCommand)}`];
    if (args.length > 0) lines.push(`args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`);
    if (envNames.length > 0) lines.push(`env = { ${envNames.map((n) => `${n} = "<keep your value>"`).join(", ")} }`);
    return lines.join("\n");
  }
  const body: Record<string, unknown> = { command: fixCommand };
  if (args.length > 0) body.args = args;
  if (envNames.length > 0) body.env = Object.fromEntries(envNames.map((n) => [n, "<keep your value>"]));
  return JSON.stringify({ [entry.name]: body }, null, 2);
}

function printReport(io: CliIo, reports: ClientReport[], wanted: DoctorTool | undefined, fix: boolean): boolean {
  let problems = false;
  for (const { scan, results } of reports) {
    const label = CLIENT_LABELS[scan.client];
    if (scan.filesRead.length === 0 && scan.unreadable.length === 0) {
      io.stdout(`${label}: no config file found.\n`);
      continue;
    }
    io.stdout(`${label} (read: ${scan.filesRead.join(", ") || "nothing"})\n`);
    for (const name of scan.unreadable) io.stdout(`  Could not read ${name} as a config file. Open it and check that it is valid.\n`);
    if (results.length === 0) {
      io.stdout(wanted ? `  No ${wanted} server in this client's config.\n` : "  No grafana, kubernetes, github or docs server in this client's config.\n");
      continue;
    }
    for (const result of results) {
      io.stdout(`  ${result.tool}: server "${result.serverName}" (${result.source})\n`);
      for (const check of result.checks) {
        io.stdout(`    ${statusWord(check.status)}  ${check.summary}\n`);
        if (fix && check.fixCommand) io.stdout(`\n    Corrected entry (print only; nothing was changed):\n${correctedEntry(result, check.fixCommand).replace(/^/gm, "      ")}\n\n`);
      }
      if (result.checks.length === 0) io.stdout("    Nothing to check for this entry.\n");
      if (result.problem) problems = true;
    }
  }
  return problems;
}

/** A tool has a problem only when every server of the client that is this tool has one. */
function problemsByTool(results: ToolResult[]): Map<DoctorTool, ToolResult> {
  const out = new Map<DoctorTool, ToolResult>();
  for (const tool of DOCTOR_TOOLS) {
    const mine = results.filter((r) => r.tool === tool);
    if (mine.length > 0 && mine.every((r) => r.problem)) out.set(tool, mine[0]!);
  }
  return out;
}

/** The sentence --report sends. A fixed word list: no name, path, value or file text. */
export function reportDetail(result: ToolResult): string {
  const failed = result.checks.find((check) => check.status === "failed");
  return (failed?.reportSummary ?? "The doctor found a problem in the client config.").slice(0, 200);
}

async function sendReports(io: CliIo, reports: ClientReport[], deps: DoctorDeps): Promise<number> {
  const sent: string[] = [];
  const client = await (deps.reportClient ?? (async () => (await createRuntime(io.env)).client))();
  for (const { scan, results } of reports) {
    const problems = problemsByTool(results);
    if (problems.size === 0) continue;
    client.session.identity = { name: scan.client, label: CLIENT_LABELS[scan.client], version: "" };
    const sources = [...problems.entries()].map(([tool, result]) => ({ key: tool, state: "not_found", access_status: result.problem ?? "missing_tool", detail: reportDetail(result) }));
    try {
      await client.post(TOOL_REPORT_PATH, { available_sources: sources }, { safeToRepeat: true });
      sent.push(`${CLIENT_LABELS[scan.client]}: ${[...problems.keys()].join(", ")}`);
    } catch (err) {
      if (err instanceof TellagenAPIError && (err.status === 404 || err.status === 405)) {
        io.stderr("This Tellagen does not take a tool report without a check yet. Run the doctor without --report, or ask an admin to update Tellagen.\n");
        return 1;
      }
      const text = formatError(err);
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        /* keep the text */
      }
      io.stderr(`Could not report ${CLIENT_LABELS[scan.client]}: ${message}\n`);
      return 1;
    }
  }
  if (sent.length === 0) io.stdout("Nothing was reported: the doctor found no problem. It never reports a tool as found, because only a running session can show that.\n");
  else io.stdout(`Reported to Tellagen (names and statuses only, no paths, values or file text): ${sent.join("; ")}.\n`);
  return 0;
}

/** `doctor`: find why a client cannot see a tool, from the config files of the clients on this computer. */
export async function doctorCommand(args: readonly string[], io: CliIo, deps: DoctorDeps = {}): Promise<number> {
  const parsed = parseArgs(args, ["client", "tool"], ["fix", "report", "help"]);
  if (parsed.unknown.length > 0 || parsed.positional.length > 0 || parsed.flags.has("help")) {
    io.stderr(DOCTOR_USAGE);
    return parsed.flags.has("help") ? 0 : 2;
  }
  const clientArg = parsed.values.client;
  if (clientArg !== undefined && !(DOCTOR_CLIENTS as readonly string[]).includes(clientArg)) {
    io.stderr(`Unknown client "${clientArg.slice(0, 40)}". Use one of: ${DOCTOR_CLIENTS.join(", ")}.\n`);
    return 2;
  }
  const toolArg = parsed.values.tool;
  if (toolArg !== undefined && !(DOCTOR_TOOLS as readonly string[]).includes(toolArg)) {
    io.stderr(`Unknown tool "${toolArg.slice(0, 40)}". Use one of: ${DOCTOR_TOOLS.join(", ")}.\n`);
    return 2;
  }
  const wanted = toolArg as DoctorTool | undefined;
  const fs = deps.fs ?? realDoctorFs();
  const checkDeps: CheckDeps = {
    fs,
    shellPath: deps.shellPath ?? io.env.PATH ?? io.env.Path ?? "",
    fetch: deps.fetch ?? ((url, init) => fetch(url, { ...init, redirect: "manual" })),
  };

  io.stdout(`Tellagen doctor ${MCP_SERVER_VERSION}\n`);
  io.stdout("It reads the MCP config files of the AI clients on this computer, because you ran it. It never changes them");
  io.stdout(parsed.flags.has("report") ? " and sends only names and statuses to Tellagen.\n\n" : " and sends nothing to Tellagen.\n\n");

  const reports: ClientReport[] = [];
  for (const client of (clientArg ? [clientArg as DoctorClient] : DOCTOR_CLIENTS)) {
    const scan = scanClient(client, fs);
    const results: ToolResult[] = [];
    for (const entry of scan.entries) {
      const tool = toolOfEntry(entry);
      if (!tool || (wanted && tool !== wanted)) continue;
      results.push(await checkEntry(entry, tool, checkDeps));
    }
    reports.push({ scan, results });
  }

  const problems = printReport(io, reports, wanted, parsed.flags.has("fix"));
  io.stdout("\nThe doctor cannot see a running session: it reads config files only. The model check (Recheck in Tellagen settings, or /tellagen:check-tools) is still the truth for a session.\n");
  if (!wanted || wanted === "kubernetes") io.stdout("It does not test what a Kubernetes identity can change. The model check reports that.\n");

  if (parsed.flags.has("report")) {
    const code = await sendReports(io, reports, deps);
    if (code !== 0) return code;
  }
  return problems ? 1 : 0;
}
