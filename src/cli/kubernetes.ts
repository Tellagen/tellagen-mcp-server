import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createRuntime } from "../bootstrap.js";
import type { TellagenClient } from "../client.js";
import { configFilesFor, DOCTOR_CLIENTS, scanClient, CLIENT_LABELS, type DoctorClient, type DoctorFs } from "../doctor/config-files.js";
import { realDoctorFs } from "../doctor/real-fs.js";
import { formatError, TellagenAPIError } from "../errors.js";
import { KUBERNETES_SAFETY_CHECKS, kubernetesSafetyVerdict, type KubernetesSafetyCheck } from "../k8s-safety.js";
import { TOOL_REPORT_PATH } from "../tool-report.js";
import { parseArgs, type CliIo } from "./io.js";

export const KUBERNETES_USAGE = `Usage: tellagen-mcp-server kubernetes setup [--client claude-code|claude-desktop|codex|cursor] [--context NAME]
                                          [--service-account NAME [-n NAMESPACE] [--duration 8h]] [--yes] [--no-report]

Sets up a read-only Kubernetes server for diagnosis: writes its settings file, adds the server to your AI client
(it asks first), runs four access checks and reports them to Tellagen.
`;

export const SETUP_DIR_PARTS = [".config", "tellagen"] as const;
const SERVER_NAME = "kubernetes";
const DEFAULT_NAMESPACE = "tellagen";
const DEFAULT_DURATION = "8h";
const NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/@=+,-]{0,251}$/;
const DURATION_PATTERN = /^([1-9]\d{0,3})([hms])$/;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What the setup writes, so a test can run it on a fake computer. */
export interface SetupFiles {
  /** Writes a file with mode 600 (a private file), creating its folder. */
  writePrivate(path: string, text: string): void;
  /** Writes a file that holds no secret. */
  write(path: string, text: string): void;
}

export interface KubernetesSetupDeps {
  fs?: DoctorFs;
  files?: SetupFiles;
  /** Runs a program with no shell. */
  run?: (command: string, args: string[], env?: Record<string, string>) => Promise<RunResult>;
  confirm?: (question: string) => Promise<boolean>;
  reportClient?: () => Promise<TellagenClient>;
  now?: () => Date;
}

export const nodeFiles: SetupFiles = {
  writePrivate(path, text) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, text, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  },
  write(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    // A file that exists keeps its mode, so a private client config never becomes readable by others.
    let mode = 0o600;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      /* a new file is private */
    }
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  },
};

function realRun(command: string, args: string[], env?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(command, args, { env: { ...process.env, ...env }, timeout: 30_000, maxBuffer: 4 << 20, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function realConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** A path as a person reads it: the home folder is `~`, so no user name is printed. */
export function shortPath(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** The settings file of the server: read tools only, a few write-side guards, and secrets denied. */
export function kubernetesServerConfig(kubeconfigPath?: string): string {
  const lines = ['toolsets = ["core"]', "read_only = true", "disable_destructive = true"];
  if (kubeconfigPath) lines.push(`kubeconfig = ${JSON.stringify(kubeconfigPath)}`);
  lines.push("", "[[denied_resources]]", 'group = ""', 'version = "v1"', 'kind = "Secret"', "");
  return lines.join("\n");
}

/** The program and arguments a client starts for the server. */
export function serverCommand(configPath: string): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", "kubernetes-mcp-server@latest", "--config", configPath] };
}

/** A kubeconfig for one service account token. JSON strings are valid YAML, so values are quoted safely. */
export function serviceAccountKubeconfig(name: string, cluster: { server: string; ca?: { data?: string; file?: string }; insecure?: boolean }, token: string): string {
  const entries: string[] = [`server: ${JSON.stringify(cluster.server)}`];
  if (cluster.ca?.data) entries.push(`certificate-authority-data: ${JSON.stringify(cluster.ca.data)}`);
  else if (cluster.ca?.file) entries.push(`certificate-authority: ${JSON.stringify(cluster.ca.file)}`);
  if (cluster.insecure) entries.push("insecure-skip-tls-verify: true");
  return [
    "apiVersion: v1",
    "kind: Config",
    "clusters:",
    "- name: target",
    `  cluster: {${entries.join(", ")}}`,
    "users:",
    `- name: ${JSON.stringify(name)}`,
    `  user: {token: ${JSON.stringify(token)}}`,
    "contexts:",
    "- name: diagnosis",
    `  context: {cluster: target, user: ${JSON.stringify(name)}}`,
    "current-context: diagnosis",
    "",
  ].join("\n");
}

function durationMs(value: string): number {
  const match = DURATION_PATTERN.exec(value)!;
  return Number(match[1]) * { h: 3_600_000, m: 60_000, s: 1_000 }[match[2] as "h" | "m" | "s"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The server address and certificate of the current (or chosen) context, from `kubectl config view`. */
function clusterOf(json: string): { server: string; ca?: { data?: string; file?: string }; insecure?: boolean } | undefined {
  try {
    const root: unknown = JSON.parse(json);
    const clusters = isRecord(root) && Array.isArray(root.clusters) ? root.clusters : [];
    const cluster = isRecord(clusters[0]) && isRecord(clusters[0].cluster) ? clusters[0].cluster : undefined;
    if (!cluster || typeof cluster.server !== "string") return undefined;
    const data = cluster["certificate-authority-data"];
    const file = cluster["certificate-authority"];
    return {
      server: cluster.server,
      ca: { ...(typeof data === "string" ? { data } : {}), ...(typeof file === "string" ? { file } : {}) },
      insecure: cluster["insecure-skip-tls-verify"] === true,
    };
  } catch {
    return undefined;
  }
}

type AddResult = "added" | "already" | "kept" | "declined" | "printed" | "failed";

interface ClientAdd {
  result: AddResult;
  /** A line for the person: what happened or what to run. */
  note: string;
}

function commandLine(client: DoctorClient, configPath: string): string {
  const { command, args } = serverCommand(configPath);
  const cli = client === "claude-code" ? `claude mcp add ${SERVER_NAME} --scope user --` : `codex mcp add ${SERVER_NAME} --`;
  return `${cli} ${command} ${args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
}

/** Adds the server to the client the way a person would, unless it is there already. */
async function addToClient(
  client: DoctorClient,
  configPath: string,
  yes: boolean,
  fs: DoctorFs,
  files: SetupFiles,
  run: NonNullable<KubernetesSetupDeps["run"]>,
  confirm: NonNullable<KubernetesSetupDeps["confirm"]>,
): Promise<ClientAdd> {
  const label = CLIENT_LABELS[client];
  const existing = scanClient(client, fs).entries.find((entry) => entry.name === SERVER_NAME);
  if (existing) {
    const points = existing.args.includes(configPath) || existing.args.some((arg) => arg === `--config=${configPath}`);
    return points
      ? { result: "already", note: `${label} already has the "${SERVER_NAME}" server with this settings file. Nothing changed.` }
      : { result: "kept", note: `${label} already has a server named "${SERVER_NAME}" that does not use this settings file, so it was left as it is. Remove it, then run this command again.` };
  }

  const question =
    client === "claude-code" || client === "codex"
      ? `Add the "${SERVER_NAME}" server to ${label}? It runs: ${commandLine(client, "<settings file>")}`
      : `Add the "${SERVER_NAME}" server to the ${label} config file?`;
  if (!yes && !(await confirm(question))) {
    const how =
      client === "claude-code" || client === "codex"
        ? `Run this yourself to add it:\n  ${commandLine(client, "~/.config/tellagen/kubernetes-mcp.toml")}`
        : `Add this to mcpServers in the ${label} config file (the path is the settings file written above, with your home folder in it):\n  ${JSON.stringify({ [SERVER_NAME]: serverCommand(configPath) })}`;
    return { result: "declined", note: `${label} was not changed. ${how}` };
  }

  if (client === "claude-code" || client === "codex") {
    const program = client === "claude-code" ? "claude" : "codex";
    const args = client === "claude-code" ? ["mcp", "add", SERVER_NAME, "--scope", "user", "--"] : ["mcp", "add", SERVER_NAME, "--"];
    const { command, args: serverArgs } = serverCommand(configPath);
    const out = await run(program, [...args, command, ...serverArgs]);
    if (out.code === 0) return { result: "added", note: `Added the "${SERVER_NAME}" server to ${label}.` };
    return {
      result: "printed",
      note: `Could not run ${program} (${out.code === 127 ? "it is not on the PATH" : "it refused"}). Run this yourself:\n  ${commandLine(client, "~/.config/tellagen/kubernetes-mcp.toml")}`,
    };
  }

  const file = configFilesFor(client, fs)[0]!;
  const text = fs.readText(file.path) ?? "{}";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { result: "failed", note: `${label}: the config file is not valid JSON, so it was not changed. Fix it and run this command again.` };
  }
  if (!isRecord(json)) return { result: "failed", note: `${label}: the config file has an unexpected shape, so it was not changed.` };
  const servers = isRecord(json.mcpServers) ? json.mcpServers : {};
  files.write(file.path, `${JSON.stringify({ ...json, mcpServers: { ...servers, [SERVER_NAME]: serverCommand(configPath) } }, null, 2)}\n`);
  return { result: "added", note: `Added the "${SERVER_NAME}" server to the ${label} config file (${file.source}). Restart ${label} to load it.` };
}

async function sendReport(
  io: CliIo,
  deps: KubernetesSetupDeps,
  client: DoctorClient,
  checks: KubernetesSafetyCheck[],
  readOnly: boolean | undefined,
): Promise<void> {
  let api: TellagenClient;
  try {
    api = await (deps.reportClient ?? (async () => (await createRuntime(io.env)).client))();
  } catch (err) {
    io.stderr(`Not reported to Tellagen: ${formatError(err)}\n`);
    return;
  }
  api.session.identity = { name: client, label: CLIENT_LABELS[client], version: "" };
  const body = { available_sources: [{ key: "kubernetes", state: "found" }] };
  const withChecks = checks.length > 0 ? { kubernetes_checks: checks } : {};
  const withFlag = readOnly !== undefined ? { kubernetes_read_only_tools: readOnly } : {};
  const attempts: Record<string, unknown>[] = [{ ...body, ...withChecks, ...withFlag }];
  if (checks.length > 0 && readOnly !== undefined) attempts.push({ ...body, ...withChecks });
  if (checks.length > 0 || readOnly !== undefined) attempts.push(body);
  for (let i = 0; i < attempts.length; i++) {
    try {
      await api.post(TOOL_REPORT_PATH, attempts[i], { safeToRepeat: true });
      io.stdout(
        i === 0
          ? "Reported to Tellagen: the tools table shows the result now. No Recheck is needed.\n"
          : "Reported to Tellagen, but this Tellagen is older and does not show every part of the result yet.\n",
      );
      return;
    } catch (err) {
      if (err instanceof TellagenAPIError && err.status === 400 && err.code === "unknown_field" && i < attempts.length - 1) continue;
      if (err instanceof TellagenAPIError && (err.status === 404 || err.status === 405)) {
        io.stderr("Not reported: this Tellagen does not take a tool report yet. Ask an admin to update Tellagen.\n");
        return;
      }
      let message = formatError(err);
      try {
        message = (JSON.parse(message) as { message?: string }).message ?? message;
      } catch {
        /* keep the text */
      }
      io.stderr(`Not reported to Tellagen: ${message}\n`);
      return;
    }
  }
}

/** `kubernetes setup`: one command for the computer side of the Kubernetes setup. */
export async function kubernetesCommand(args: readonly string[], io: CliIo, deps: KubernetesSetupDeps = {}): Promise<number> {
  const normalized = args.map((arg) => (arg === "-n" ? "--namespace" : arg === "-y" ? "--yes" : arg));
  const parsed = parseArgs(normalized, ["client", "context", "service-account", "namespace", "duration"], ["yes", "no-report", "help"]);
  const [sub, ...rest] = parsed.positional;
  if (parsed.flags.has("help") || sub !== "setup" || rest.length > 0 || parsed.unknown.length > 0) {
    io.stderr(KUBERNETES_USAGE);
    return parsed.flags.has("help") ? 0 : 2;
  }

  const clientArg = parsed.values.client;
  if (clientArg !== undefined && !(DOCTOR_CLIENTS as readonly string[]).includes(clientArg)) {
    io.stderr(`Unknown client "${clientArg.slice(0, 40)}". Use one of: ${DOCTOR_CLIENTS.join(", ")}.\n`);
    return 2;
  }
  const context = parsed.values.context;
  if (context !== undefined && !CONTEXT_PATTERN.test(context)) {
    io.stderr("The context name has a character that is not allowed. Use the name that `kubectl config get-contexts` shows.\n");
    return 2;
  }
  const account = parsed.values["service-account"];
  const namespace = parsed.values.namespace ?? DEFAULT_NAMESPACE;
  const duration = parsed.values.duration ?? DEFAULT_DURATION;
  if (account !== undefined && !NAME_PATTERN.test(account)) {
    io.stderr("The service account name must be a Kubernetes name: lower case letters, digits, - and .\n");
    return 2;
  }
  if (!NAME_PATTERN.test(namespace)) {
    io.stderr("The namespace must be a Kubernetes name: lower case letters, digits, - and .\n");
    return 2;
  }
  if (!DURATION_PATTERN.test(duration)) {
    io.stderr("The duration is a number and one letter, for example 8h, 90m or 3600s.\n");
    return 2;
  }
  if (account === undefined && (parsed.values.namespace !== undefined || parsed.values.duration !== undefined)) {
    io.stderr("-n and --duration go with --service-account.\n");
    return 2;
  }

  const fs = deps.fs ?? realDoctorFs();
  const files = deps.files ?? nodeFiles;
  const run = deps.run ?? realRun;
  const confirm = deps.confirm ?? realConfirm;
  const now = deps.now ?? (() => new Date());
  const yes = parsed.flags.has("yes");
  const dir = join(fs.home, ...SETUP_DIR_PARTS);
  const configPath = join(dir, "kubernetes-mcp.toml");
  const kubeconfigPath = join(dir, "kubeconfig");

  // 1. Which client.
  let client: DoctorClient;
  if (clientArg) client = clientArg as DoctorClient;
  else {
    const found = DOCTOR_CLIENTS.filter((name) => scanClient(name, fs).filesRead.length > 0);
    if (found.length !== 1) {
      io.stderr(
        found.length === 0
          ? "No AI client config was found on this computer. Pass --client claude-code|claude-desktop|codex|cursor.\n"
          : `More than one AI client was found (${found.map((name) => CLIENT_LABELS[name]).join(", ")}). Pass --client to choose one.\n`,
      );
      return 2;
    }
    client = found[0]!;
  }

  // 2. The kubeconfig the server will use.
  const contextArgs = context ? ["--context", context] : [];
  let kubeconfig: string | undefined;
  if (account) {
    const view = await run("kubectl", ["config", "view", "--minify", "--raw", "-o", "json", ...contextArgs]);
    const cluster = view.code === 0 ? clusterOf(view.stdout) : undefined;
    if (!cluster) {
      io.stderr("Could not read the cluster address from kubectl. Check that kubectl is installed and that the context exists.\n");
      return 1;
    }
    const minted = await run("kubectl", ["create", "token", account, "-n", namespace, "--duration", duration, ...contextArgs]);
    const token = minted.stdout.trim();
    if (minted.code !== 0 || !token) {
      io.stderr(`Could not create a token for the service account ${account} in ${namespace}. Check that it exists and that you may create tokens for it.\n`);
      return 1;
    }
    files.writePrivate(kubeconfigPath, serviceAccountKubeconfig(account, cluster, token));
    kubeconfig = kubeconfigPath;
    const until = new Date(now().getTime() + durationMs(duration));
    io.stdout(`Wrote a kubeconfig for the service account ${account} (${shortPath(kubeconfigPath, fs.home)}, private to you).\n`);
    io.stdout(`The token lasts ${duration}, until ${until.toLocaleString()}. Run this command again to renew it.\n`);
  } else if (context) {
    const view = await run("kubectl", ["config", "view", "--minify", "--flatten", ...contextArgs]);
    if (view.code !== 0 || !view.stdout.trim()) {
      io.stderr("Could not read that context with kubectl. Check that it exists in your kubeconfig.\n");
      return 1;
    }
    files.writePrivate(kubeconfigPath, view.stdout);
    kubeconfig = kubeconfigPath;
    io.stdout(`Wrote a kubeconfig with only the context ${context} (${shortPath(kubeconfigPath, fs.home)}, private to you). The server cannot reach your other contexts.\n`);
  }

  // 3. The settings file of the server.
  const settingsText = kubernetesServerConfig(kubeconfig);
  const current = fs.readText(configPath);
  if (current !== undefined && current !== settingsText && !yes && !(await confirm(`${shortPath(configPath, fs.home)} has changes of your own. Replace it with the read-only settings?`))) {
    io.stderr(`${shortPath(configPath, fs.home)} was not changed. Move it away or run this command again with --yes.\n`);
    return 1;
  }
  if (current !== undefined && current !== settingsText) io.stdout(`Replaced ${shortPath(configPath, fs.home)}; the earlier text is gone.\n`);
  files.write(configPath, settingsText);
  io.stdout(`Wrote ${shortPath(configPath, fs.home)}: read-only tools, destructive tools off, Secret denied.\n`);

  // 4. The client.
  const added = await addToClient(client, configPath, yes, fs, files, run, confirm);
  io.stdout(`${added.note}\n`);
  if (added.result === "failed") return 1;
  if (added.result !== "added" && added.result !== "already") {
    // The client does not run the server written here, so its checks would describe an identity the client does not use.
    io.stdout("Nothing was checked or reported, because your client does not run this server yet. Run this command again after it is added.\n");
    return 0;
  }

  // 5. The four access checks, with the kubeconfig the server uses.
  const env = kubeconfig ? { KUBECONFIG: kubeconfig } : undefined;
  const checks: KubernetesSafetyCheck[] = [];
  for (const check of KUBERNETES_SAFETY_CHECKS) {
    const [, ...checkArgs] = check.command.split(" ");
    const out = await run("kubectl", [...checkArgs, ...(kubeconfig ? [] : contextArgs)], env);
    const answer = out.stdout.trim().toLowerCase();
    const status: KubernetesSafetyCheck["status"] = out.code === 0 && answer.startsWith("yes") ? "failed" : out.code === 1 && answer.startsWith("no") ? "ok" : "warning";
    checks.push({ id: check.id, status });
  }
  const verdict = kubernetesSafetyVerdict(checks);
  const can = KUBERNETES_SAFETY_CHECKS.filter((check) => checks.find((c) => c.id === check.id)?.status === "failed").map((check) => check.label.replace(/^Can /, "").toLowerCase());
  io.stdout(
    verdict === "read_only"
      ? "Access check: the server offers read tools only, and this identity cannot create, delete, exec or read secrets. Read-only access checked.\n"
      : verdict === "can_change"
        ? `Access check: the server offers read tools only, but this identity can still ${can.join(", ")}. That is expected with your own account. For a cluster that refuses writes, use a read-only account: run this command again with --service-account.\n`
        : "Access check: kubectl could not answer every check, so the result is not complete. Check that the cluster is reachable, then run this command again.\n",
  );

  // 6. Tell Tellagen.
  if (!parsed.flags.has("no-report")) await sendReport(io, deps, client, checks, true);
  return 0;
}
