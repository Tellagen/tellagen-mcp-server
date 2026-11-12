import { createRuntime } from "../bootstrap.js";
import { type CredentialVault, openVault, describeStore } from "../credentials.js";
import type { ClientIdentity } from "../identity.js";
import { openRunLine } from "../open-run.js";
import { defaultStateDir, RunStateStore, workspaceKey } from "../run-state.js";
import { SignInIndex } from "../signin-index.js";
import {
  daysUntil,
  expiryLine,
  KEY_NOT_REVOKED_NOTE,
  type FetchLike,
  SignInManager,
  signOut,
} from "../signin.js";
import { accountFor } from "../credentials.js";
import { MCP_SERVER_VERSION } from "../version.js";
import { parseArgs, type CliIo } from "./io.js";

export interface AuthDeps {
  vault?: CredentialVault;
  index?: SignInIndex;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (address: string) => boolean;
  canOpenBrowser?: () => boolean;
}

const KNOWN_LOGIN_CLIENTS: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", cli: "Command line" };

/** `login`: sign in with the browser from a terminal. */
export async function loginCommand(args: readonly string[], io: CliIo, deps: AuthDeps = {}): Promise<number> {
  const parsed = parseArgs(args, ["url", "client"], ["no-browser", "help"]);
  if (parsed.unknown.length > 0 || parsed.positional.length > 0 || parsed.flags.has("help")) {
    io.stderr("Usage: tellagen-mcp-server login [--url <Tellagen API address>] [--no-browser] [--client claude-code|codex|cursor]\n");
    return parsed.flags.has("help") ? 0 : 2;
  }
  const clientName = parsed.values.client ?? "cli";
  if (!(clientName in KNOWN_LOGIN_CLIENTS)) {
    io.stderr(`Unknown client "${clientName.slice(0, 40)}". Use one of: ${Object.keys(KNOWN_LOGIN_CLIENTS).join(", ")}.\n`);
    return 2;
  }
  const vault = deps.vault ?? openVault();
  const index = deps.index ?? new SignInIndex();
  const { client } = await createRuntime(io.env, { vault, index });
  const identity: ClientIdentity = { name: clientName, label: KNOWN_LOGIN_CLIENTS[clientName]!, version: "" };
  client.session.identity = identity;
  const manager = new SignInManager(client, {
    env: io.env,
    vault,
    index,
    fetch: deps.fetch,
    // A command line has nothing else to keep the process alive while it waits.
    sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    openBrowser: deps.openBrowser,
    canOpenBrowser: deps.canOpenBrowser,
  });
  try {
    let view = await manager.begin({ restart: true, baseUrl: parsed.values.url, openBrowser: !parsed.flags.has("no-browser") });
    if (view.status === "waiting") {
      io.stdout(`\nTo sign in to Tellagen, open:\n\n  ${view.verification_uri}\n\nand enter this code:\n\n  ${view.user_code}\n\n`);
      io.stdout(
        view.opened_browser
          ? "A browser window was opened with the code filled in. Check that the code on the page matches, then approve.\n"
          : "Check that the code on the page matches, then approve. (Over SSH, open the address on your own computer.)\n",
      );
      io.stdout("Waiting for approval. Press Ctrl+C to stop.\n");
      while (view.status === "waiting") {
        view = await manager.begin({ waitMs: 25_000 });
      }
    }
    if (view.status !== "signed_in") {
      io.stderr(`${view.message}\n`);
      return 1;
    }
    io.stdout(`\n${view.message}\n`);
    if (view.key_expires_at) io.stdout(`The key works until ${view.key_expires_at.slice(0, 10)}.\n`);
    if (view.storage_notice) io.stderr(`Note: ${view.storage_notice}\n`);
    io.stdout("Restart your AI client, or reconnect the Tellagen MCP server, if it was running.\n");
    return 0;
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : "The sign-in failed."}\n`);
    return 1;
  } finally {
    manager.cancel();
  }
}

/** `logout`: remove the stored key from this computer. */
export async function logoutCommand(args: readonly string[], io: CliIo, deps: AuthDeps = {}): Promise<number> {
  const parsed = parseArgs(args, ["url"], ["all", "help"]);
  if (parsed.unknown.length > 0 || parsed.positional.length > 0 || parsed.flags.has("help")) {
    io.stderr("Usage: tellagen-mcp-server logout [--url <Tellagen API address> | --all]\n");
    return parsed.flags.has("help") ? 0 : 2;
  }
  const vault = deps.vault ?? openVault();
  const index = deps.index ?? new SignInIndex();
  let account: string | undefined;
  if (parsed.values.url) {
    try {
      account = accountFor(parsed.values.url);
    } catch (err) {
      io.stderr(`${err instanceof Error ? err.message : "That address is not valid."}\n`);
      return 2;
    }
  } else if (!parsed.flags.has("all")) {
    account = index.find()?.account;
  }
  if (!account && !parsed.flags.has("all")) {
    io.stdout("No sign-in is stored on this computer.\n");
    if ((io.env.TELLAGEN_API_KEY ?? "").trim()) io.stdout("TELLAGEN_API_KEY is set in the environment. Remove it from your settings to stop using that key.\n");
    return 0;
  }
  // The local store is always cleared, whatever the server says.
  const result = await signOut(vault, index, account);
  io.stdout(`Signed out: ${result.signedOut.join(", ") || "nothing was stored"}.\n`);
  io.stdout(`${KEY_NOT_REVOKED_NOTE}\n`);
  if ((io.env.TELLAGEN_API_KEY ?? "").trim()) io.stdout("TELLAGEN_API_KEY is also set in the environment, and it still works. Remove it from your settings.\n");
  if (result.remaining.length > 0) io.stdout(`Other sign-ins remain: ${result.remaining.join(", ")}.\n`);
  return 0;
}

interface StatusReport {
  signed_in: boolean;
  source: "environment" | "sign-in" | "none";
  api_url?: string;
  workspace?: string;
  storage?: string;
  key_expires_at?: string;
  expires_in_days?: number;
  server_version: string;
  update_available?: { your_version: string; current_version: string };
  open_run?: string;
  other_sign_ins: string[];
  problem?: string;
}

async function collect(io: CliIo, deps: AuthDeps): Promise<{ report: StatusReport; line: string | undefined }> {
  const vault = deps.vault ?? openVault();
  const index = deps.index ?? new SignInIndex();
  const { credentials } = await createRuntime(io.env, { vault, index });
  const entry = credentials.entry ?? index.find()?.entry;
  const signedIn = Boolean(credentials.apiKey && credentials.apiUrl);
  const stateDir = (io.env.TELLAGEN_STATE_DIR ?? "").trim() || defaultStateDir();
  let openRun: string | undefined;
  if (credentials.apiUrl) {
    const state = new RunStateStore(stateDir, workspaceKey(credentials.apiUrl)).read();
    if (state && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(state.run_id)) openRun = state.run_id;
  }
  const report: StatusReport = {
    signed_in: signedIn,
    source: credentials.source,
    api_url: credentials.apiUrl || undefined,
    workspace: credentials.entry?.workspace_name,
    storage: credentials.entry ? describeStore(credentials.entry.storage) : undefined,
    key_expires_at: credentials.entry?.expires_at,
    expires_in_days: daysUntil(credentials.entry?.expires_at),
    server_version: MCP_SERVER_VERSION,
    update_available: entry?.update_available
      ? { your_version: entry.update_available.your_version, current_version: entry.update_available.current_version }
      : undefined,
    open_run: openRun,
    other_sign_ins: index.list().filter((item) => item.account !== credentials.account).map((item) => item.account),
    problem: credentials.problem,
  };
  const parts: string[] = [];
  if (!signedIn) {
    parts.push(
      credentials.problem ??
        "Tellagen is not set up on this computer: no sign-in and no TELLAGEN_API_KEY. Tell the person to run /tellagen:connect to sign in.",
    );
  } else {
    const expiry = expiryLine(credentials.entry);
    if (expiry) parts.push(expiry);
  }
  if (openRun) parts.push(openRunLine(openRun));
  // A server that is older than the workspace wants is only worth a line if it is still this version.
  if (report.update_available && report.update_available.your_version === MCP_SERVER_VERSION) {
    parts.push(
      `The Tellagen MCP server on this computer (${MCP_SERVER_VERSION}) is older than ${report.update_available.current_version}, which this workspace wants. Restart the client so it fetches the latest.`,
    );
  }
  return { report, line: parts.length > 0 ? parts.join(" ") : undefined };
}

/**
 * `status`: who is signed in, until when, and where the key is. With
 * `--line` it prints one short sentence for a client hook, or nothing when
 * all is well. It never contacts Tellagen, so a hook is fast.
 */
export async function statusCommand(args: readonly string[], io: CliIo, deps: AuthDeps = {}): Promise<number> {
  const parsed = parseArgs(args, [], ["line", "json", "help"]);
  if (parsed.unknown.length > 0 || parsed.positional.length > 0 || parsed.flags.has("help")) {
    io.stderr("Usage: tellagen-mcp-server status [--line | --json]\n");
    return parsed.flags.has("help") ? 0 : 2;
  }
  let result: Awaited<ReturnType<typeof collect>>;
  try {
    result = await collect(io, deps);
  } catch {
    // A hook must never fail a session start.
    if (parsed.flags.has("line")) return 0;
    io.stderr("The status could not be read.\n");
    return 1;
  }
  if (parsed.flags.has("line")) {
    if (result.line) io.stdout(`${result.line}\n`);
    return 0;
  }
  const r = result.report;
  if (parsed.flags.has("json")) {
    io.stdout(`${JSON.stringify(r, null, 2)}\n`);
    return 0;
  }
  if (!r.signed_in) {
    io.stdout(`Not signed in.${r.problem ? ` ${r.problem}` : ""}\nRun: npx @tellagen/mcp-server login\n`);
  } else if (r.source === "environment") {
    io.stdout(`Signed in with TELLAGEN_API_KEY from the environment.\nAddress: ${r.api_url}\n`);
  } else {
    io.stdout(`Signed in${r.workspace ? ` to ${r.workspace}` : ""}.\nAddress: ${r.api_url}\nKey stored in: ${r.storage}\n`);
    if (r.key_expires_at) io.stdout(`Key expires: ${r.key_expires_at.slice(0, 10)}${r.expires_in_days !== undefined ? ` (${r.expires_in_days} days)` : ""}\n`);
  }
  io.stdout(`Server version: ${r.server_version}\n`);
  if (r.update_available) io.stdout(`This workspace wants server ${r.update_available.current_version} or later (seen at ${r.update_available.your_version}).\n`);
  if (r.open_run) io.stdout(`Open diagnosis run: ${r.open_run}\n`);
  if (r.other_sign_ins.length > 0) io.stdout(`Other sign-ins: ${r.other_sign_ins.join(", ")}\n`);
  return 0;
}
