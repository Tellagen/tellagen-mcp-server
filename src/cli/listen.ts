import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../bootstrap.js";
import { runCommand, type CredentialVault } from "../credentials.js";
import { tellagenHome } from "../home.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROBE_PROMPT, verifyEnforcement, type Enforcement, type ProbeDeps } from "../listen-probe.js";
import { acquireLock, buildClientCommand, CLIENT_ENFORCES_TOOL_LIST, clientRefusal, Listener, readListenStatus, startClientProcess, type ListenerDeps } from "../listener.js";
import { inspectClientSettings } from "../listen-settings.js";
import { ListenConfigError, listenConfigPath, readListenConfig } from "../listen-config.js";
import type { SignInIndex } from "../signin-index.js";
import { processAlive } from "../run-state.js";
import { parseArgs, type CliIo } from "./io.js";

export interface ListenCommandDeps {
  vault?: CredentialVault;
  index?: SignInIndex;
  listener?: Partial<ListenerDeps>;
  /** For a test: gets the listener, so the test can stop it. */
  onListener?: (listener: Listener) => void;
  /** For a test: the folder that holds `.claude/settings.json` of the person. */
  settingsHome?: string;
  /** For a test: the process id written to the lock, to stand in for another process. */
  lockPid?: number;
  /** For a test: do not install signal handlers. */
  signals?: boolean;
  /** For a test: the version of the client program, or nothing when it is not installed. */
  clientVersion?: (command: string) => Promise<string | undefined>;
  /** For a test: the proof that the client calls the shell guard. */
  verify?: (deps: ProbeDeps) => Promise<Enforcement>;
}

/** An empty folder of the listener's own, for a run that was given no working folder. */
function scratchFolder(home: string): string {
  const folder = join(home, "listen", "work");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

/** The built `index.js` that wraps a client in its own timer; nothing when this runs from source. */
function builtScript(): string | undefined {
  try {
    const path = fileURLToPath(new URL("../index.js", import.meta.url));
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

const CLIENT_COMMAND = { claude: "claude", codex: "codex" } as const;

async function clientVersion(command: string): Promise<string | undefined> {
  const result = await runCommand(command, ["--version"], { timeoutMs: 8_000 });
  return !result.missing && result.code === 0 ? result.stdout.trim().slice(0, 80) || "unknown" : undefined;
}

function showStatus(io: CliIo, home: string): number {
  const status = readListenStatus(home);
  if (!status) {
    io.stdout("The listener has not run on this computer.\nStart it with: npx @tellagen/mcp-server listen\n");
    return 0;
  }
  const alive = processAlive(status.listener.pid);
  io.stdout(`Listener: ${alive ? `running (pid ${status.listener.pid})` : "not running"}\n`);
  io.stdout(`Client: ${status.listener.client}   Folder: ${status.listener.working_folder}   At most ${status.listener.max_runs} at a time\n`);
  if (status.problem) io.stdout(`Stopped because: ${status.problem}\n`);
  io.stdout(status.current.length > 0 ? "Current run:\n" : "No run is going on.\n");
  for (const run of status.current) io.stdout(`  ${run.run_id}  started ${run.started_at}\n    log: ${run.log}\n`);
  if (status.recent.length > 0) io.stdout("Last runs:\n");
  for (const run of status.recent) io.stdout(`  ${run.run_id}  ${run.result ?? ""}  (${run.ended_at ?? ""})\n    log: ${run.log}\n`);
  return 0;
}

/**
 * `listen`: take the diagnosis runs that wait in Tellagen for this person
 * and run each with the person's own AI client, with no window. Ctrl+C stops
 * listening and lets the current run finish; a second Ctrl+C stops that run.
 */
export async function listenCommand(args: readonly string[], io: CliIo, deps: ListenCommandDeps = {}): Promise<number> {
  const parsed = parseArgs(args, [], ["status", "help"]);
  if (parsed.unknown.length > 0 || parsed.positional.length > 0 || parsed.flags.has("help")) {
    io.stderr(
      "Usage: tellagen-mcp-server listen [--status]\nSettings: " + listenConfigPath(tellagenHome(io.env)) + " (optional)\n",
    );
    return parsed.flags.has("help") ? 0 : 2;
  }
  const home = tellagenHome(io.env);
  if (parsed.flags.has("status")) return showStatus(io, home);

  let config;
  try {
    config = readListenConfig(home);
  } catch (err) {
    io.stderr(`${err instanceof ListenConfigError ? err.message : "The listener settings could not be read."}\n`);
    return 2;
  }
  if (!CLIENT_ENFORCES_TOOL_LIST[config.client]) {
    io.stderr(`${clientRefusal(config.client)}\n`);
    return 2;
  }
  // With no folder named, the client starts in an empty folder of its own, so a run reads nothing by accident.
  const cwd = config.working_folder ?? scratchFolder(home);
  try {
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch {
    io.stderr(`The working folder ${cwd.slice(0, 120)} is not a folder.\n`);
    return 2;
  }

  // The client reads the person's own allow rules too. Refuse to start when one goes beyond the read-only list.
  const settings = inspectClientSettings(
    cwd,
    { grafana: config.mcp_servers.grafana, github: config.mcp_servers.github, extra: config.extra_allowed_tools },
    deps.settingsHome,
    io.env,
  );
  if (settings.problems.length > 0 || settings.unreadable.length > 0) {
    for (const problem of settings.problems.slice(0, 5)) {
      io.stderr(`Your Claude Code settings allow "${problem.rule}" (${problem.file}). A listened run reads only, and the client would add that rule to its own.\n`);
    }
    for (const file of settings.unreadable) io.stderr(`${file} could not be read, so the listener cannot tell what it allows.\n`);
    io.stderr(
      `Remove those rules, or set "working_folder" in ${listenConfigPath(home)} to a folder whose settings do not allow more (a rule in ~/.claude/settings.json applies in every folder). Nothing was started.\n`,
    );
    return 1;
  }

  const { client, credentials } = await createRuntime(io.env, { vault: deps.vault, index: deps.index });
  if (!credentials.apiKey || !credentials.apiUrl) {
    io.stderr(`${credentials.problem ?? "Tellagen is not set up on this computer."} Sign in first: npx @tellagen/mcp-server login\n`);
    return 1;
  }
  const program = CLIENT_COMMAND[config.client];
  const version = await (deps.clientVersion ?? clientVersion)(program);
  if (version === undefined) {
    io.stderr(`${program} is not installed or does not run. Install it, or set "client" in ${listenConfigPath(home)}.\n`);
    return 1;
  }
  // The shell guard is part of the built server. Without it no shell call could be held to the rule.
  const guardScript = deps.listener?.guardScript ?? builtScript();
  if (!guardScript) {
    io.stderr("The shell guard is part of the built server, and it was not found. Run the listener from the installed package: npx @tellagen/mcp-server listen\n");
    return 1;
  }
  // Prove, once for each client version, that the client calls the guard before a shell call.
  let probeCommand;
  try {
    probeCommand = buildClientCommand(config, "probe", cwd, { nodePath: process.execPath, scriptPath: guardScript }, { prompt: PROBE_PROMPT });
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : "The client command could not be built."}\n`);
    return 1;
  }
  io.stdout("Checking that the shell guard is active in your client (once for each version; it makes one short model call)...\n");
  const enforcement = await (deps.verify ?? verifyEnforcement)({
    home,
    command: { command: probeCommand.command, args: probeCommand.args },
    cwd,
    clientVersion: version,
    guardScript,
  });
  if (!enforcement.ok) {
    io.stderr(`${enforcement.reason}\n`);
    return 1;
  }
  client.session.identity = {
    name: config.client === "claude" ? "claude-code" : "codex",
    label: config.client === "claude" ? "Claude Code" : "Codex",
    version: "",
  };

  const lock = acquireLock(home, deps.lockPid);
  if (!lock.ok) {
    io.stderr(
      lock.pid
        ? `A listener is already running on this computer (pid ${lock.pid}). Stop it first, or check it with: listen --status\n`
        : "The listener lock could not be taken.\n",
    );
    return 1;
  }

  const listener = new Listener({
    client,
    config,
    cwd,
    home,
    out: (line) => io.stdout(`${new Date().toISOString().slice(11, 19)} ${line}\n`),
    startProcess: startClientProcess,
    wrapperScript: builtScript(),
    guardScript,
    // The person's own settings can change between two runs: look again before each one.
    preflight: () => {
      const again = inspectClientSettings(cwd, { grafana: config.mcp_servers.grafana, github: config.mcp_servers.github, extra: config.extra_allowed_tools }, deps.settingsHome, io.env);
      if (again.problems.length === 0 && again.unreadable.length === 0) return undefined;
      const first = again.problems[0];
      return first
        ? `Your Claude Code settings now allow "${first.rule}" (${first.file}), which a listened run may not have`
        : `${again.unreadable[0]} could not be read`;
    },
    ...deps.listener,
  });
  deps.onListener?.(listener);
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals === 1) listener.stop();
    else listener.forceStop();
  };
  const useSignals = deps.signals !== false;
  if (useSignals) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    // A closed terminal is a stop too. The runs have their own timer in the wrapper.
    process.on("SIGHUP", onSignal);
  }
  try {
    await listener.run();
  } finally {
    if (useSignals) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
    }
    lock.release();
  }
  if (listener.fatal) return 1;
  io.stdout("Stopped listening.\n");
  return 0;
}
