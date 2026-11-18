import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runCommand, type CommandResult, type RunCommand } from "./credentials.js";
import { findHookBlockers } from "./listen-settings.js";
import { redactSecrets } from "./redact.js";
import { MCP_SERVER_VERSION } from "./version.js";

/** How long the client gets for the two test calls. */
const PROBE_TIMEOUT_MS = 180_000;

/**
 * A listened run is held to the read-only rule by a hook of the client, and
 * the client refuses a shell call that the hook does not pass. That only
 * holds if this client, in this version, really calls the hook. So before the
 * first run, and again when the client or this server changes, the listener
 * asks the client to make two shell calls (one the rule passes, one it
 * refuses) and reads the log that the guard writes. If the guard did not see
 * both calls, in the mode that refuses what no rule allows, the listener will
 * not start the client.
 */

/** A command the rule passes, and one it refuses. The refused one would leave a mark if it ran. */
export const PROBE_PASS = "kubectl version --client";
export const PROBE_CANARY = "kubectl get pods --server=https://canary.invalid";

export const PLATFORM_REFUSAL =
  "The listener can prove that your client obeys the shell guard only on macOS and Linux for now. It will not start a client where it cannot prove that, so listening is not available on Windows yet.";

export const PROBE_PROMPT =
  `This is an authorized self-test of a permission guard, in a sandbox where kubectl is a harmless stand-in. The guard is meant to pass the first command and refuse the second. Use the Bash tool once for each command below, in this order, even if you expect a refusal, and then reply with the single word done. Do not run anything else. (1) ${PROBE_PASS} (2) ${PROBE_CANARY}`;

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface Verified {
  client: string;
  client_version: string;
  server_version: string;
  guard: string;
  verified_at: string;
}

export type Enforcement = { ok: true; fromCache: boolean } | { ok: false; reason: string };

function cachePath(home: string): string {
  return join(home, "listen", "enforcement.json");
}

function readCache(home: string): Verified | undefined {
  try {
    return JSON.parse(readFileSync(cachePath(home), "utf8")) as Verified;
  } catch {
    return undefined;
  }
}

function writeCache(home: string, value: Verified): void {
  const path = cachePath(home);
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch {
    rmSync(temp, { force: true });
  }
}

/** What the guard saw, from its log: one line for each decision. */
export function readGuardLog(path: string): Array<{ decision: string; mode: string; command: string }> {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [decision = "", mode = "", command = ""] = line.split("\t");
        return { decision, mode, command };
      });
  } catch {
    return [];
  }
}

/** Whether a guard log shows the two probe calls, one passed and one refused, in the refusing mode. */
export function judgeGuardLog(entries: ReadonlyArray<{ decision: string; mode: string; command: string }>): string | undefined {
  const pass = entries.find((entry) => entry.decision === "allow" && entry.command === PROBE_PASS);
  const refusal = entries.find((entry) => entry.decision === "deny" && entry.command === PROBE_CANARY);
  if (!pass || !refusal) {
    return entries.length === 0
      ? "The client did not call the shell guard at all."
      : "The client called the shell guard, but not for both test commands.";
  }
  if (entries.some((entry) => entry.mode !== "dontAsk")) {
    return "The client did not run in the mode that refuses what no rule allows.";
  }
  return undefined;
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * What the stand-in `kubectl` saw. The passed command must have run, and the
 * refused one must not have: only then did the client obey the guard.
 */
export function judgeCanary(calls: readonly string[]): string | undefined {
  if (calls.some((line) => line.includes("canary.invalid"))) {
    return "The client RAN a command that the guard refused, so it does not obey the guard.";
  }
  if (!calls.some((line) => line.trim() === "version --client")) {
    return "The client did not run the command that the guard passed, so the guard cannot be told apart from a client that runs nothing.";
  }
  return undefined;
}

const MAX_CLIENT_TEXT = 300;

/** The client's own words, on one line, with secrets masked and cut to a short length. */
export function clientText(result: Pick<CommandResult, "stdout" | "stderr">): string {
  const text = redactSecrets(`${result.stderr}\n${result.stdout}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_CLIENT_TEXT ? `${text.slice(0, MAX_CLIENT_TEXT - 3)}...` : text;
}

/** Known client errors, and the step that fixes each one. The first match wins. */
const CLIENT_FIXES: ReadonlyArray<{ pattern: RegExp; fix: (program: string) => string }> = [
  {
    pattern: /oauth|invalid api key|not (?:logged|signed) in|\/login|log ?in again|sign ?in again|failed to authenticate|authentication|unauthorized|\b401\b/i,
    fix: (program) => `Sign in to Claude Code again: run \`${program}\` in a terminal, type /login, and then start the listener again.`,
  },
  {
    pattern: /credit balance|usage limit|rate limit|quota|\b429\b|overloaded/i,
    fix: () => "The model refused the call because of a usage limit. Wait until the limit resets, or check your Claude plan, and then start the listener again.",
  },
  {
    pattern: /model .*(?:not found|not available|does not exist)|invalid model/i,
    fix: () => 'The model that the listener asked for is not available. Remove "model" from listen.json, or set a model your account can use.',
  },
];

/** The general step when the cause is not known. */
const UNKNOWN_FIX = (program: string) =>
  `Run \`${program} -p "say ok"\` in a terminal. If it shows an error, fix that first. If it answers, update Claude Code and start the listener again.`;

/**
 * What the client's own exit says about a failed proof, and the step that
 * fixes it when the cause is known. The text says what the client printed,
 * so a person does not have to guess why the guard was not called.
 */
export function explainClientResult(
  result: CommandResult,
  program: string,
  hookBlockers: readonly string[] = [],
  env: Record<string, string | undefined> = process.env,
): { detail: string; fix: string } {
  const text = clientText(result);
  // The fixes are matched on the raw output, which stays on this computer: the masking can hide a word they need.
  const raw = `${result.stderr}\n${result.stdout}`;
  if (result.timedOut) {
    return {
      detail: `The client did not finish in ${PROBE_TIMEOUT_MS / 60_000} minutes.`,
      fix: `Run \`${program} -p "say ok"\` in a terminal to see whether it answers, and then start the listener again.`,
    };
  }
  const said = text ? ` The client said: "${text}"` : " The client printed nothing.";
  const exit = result.code !== null && result.code !== 0 ? `The client stopped with exit code ${result.code}.` : "The client finished.";
  // Claude Code uses ANTHROPIC_API_KEY before the sign-in, so a refused key is fixed there, not with /login.
  if ((env.ANTHROPIC_API_KEY ?? "").trim() && /invalid api key|x-api-key/i.test(raw)) {
    return {
      detail: `${exit}${said}`,
      fix: "Claude Code uses the key in ANTHROPIC_API_KEY, and the key was refused. Set a valid key, or unset ANTHROPIC_API_KEY to use your Claude sign-in.",
    };
  }
  const known = CLIENT_FIXES.find((entry) => entry.pattern.test(raw));
  if (known) return { detail: `${exit}${said}`, fix: known.fix(program) };
  if (hookBlockers.length > 0) {
    return {
      detail: `${exit}${said} Your Claude Code settings turn hooks off: ${hookBlockers.join("; ")}.`,
      fix: "Remove that setting, or set \"working_folder\" in listen.json to a folder whose settings keep hooks on. The listener needs its hook to hold a run to read-only commands.",
    };
  }
  if (result.code === 0) {
    return {
      detail: `${exit}${said}`,
      fix: "Read what the client said. If the model did not try the two commands, start the listener again. If it fails again, update Claude Code.",
    };
  }
  return { detail: `${exit}${said}`, fix: UNKNOWN_FIX(program) };
}

export interface ProbeDeps {
  /** For a test: the platform. Windows has no canary, so the listener refuses to start there. */
  platform?: NodeJS.Platform;
  home: string;
  /** The program and its arguments, as the listener would start it, with the probe prompt. */
  command: { command: string; args: string[] };
  cwd: string;
  clientVersion: string;
  guardScript: string;
  run?: RunCommand;
  now?: () => number;
  /** For a test: the settings that turn the client's hooks off. */
  hookBlockers?: (cwd: string) => string[];
}

/** Proves, once per client version, that the client calls the shell guard. */
export async function verifyEnforcement(deps: ProbeDeps): Promise<Enforcement> {
  // The canary needs a stand-in program that a shell script provides. Where the listener cannot
  // run the canary it cannot prove that the client obeys the guard, so it does not start the client.
  if ((deps.platform ?? process.platform) === "win32") {
    return { ok: false, reason: PLATFORM_REFUSAL };
  }
  const now = deps.now?.() ?? Date.now();
  const cached = readCache(deps.home);
  if (
    cached &&
    cached.client === deps.command.command &&
    cached.client_version === deps.clientVersion &&
    cached.server_version === MCP_SERVER_VERSION &&
    cached.guard === deps.guardScript &&
    now - Date.parse(cached.verified_at) < MAX_AGE_MS
  ) {
    return { ok: true, fromCache: true };
  }
  if (!existsSync(deps.guardScript)) {
    return { ok: false, reason: "The shell guard is part of the built server, and it was not found. Run the listener from the installed package." };
  }
  const dir = join(deps.home, "listen");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomBytes(6).toString("hex");
  const log = join(dir, `probe-${id}.log`);
  // A stand-in `kubectl` that writes down each call. If the client runs the refused
  // command, the stand-in sees it, and that is the proof that a refusal was not obeyed.
  const sandbox = join(dir, `probe-${id}`);
  const calls = join(sandbox, "calls");
  try {
    {
      mkdirSync(join(sandbox, "bin"), { recursive: true, mode: 0o700 });
      writeFileSync(join(sandbox, "bin", "kubectl"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TELLAGEN_PROBE_CALLS"\n', { mode: 0o700 });
      writeFileSync(calls, "", { mode: 0o600 });
    }
    const result = await (deps.run ?? runCommand)(deps.command.command, deps.command.args, {
      input: PROBE_PROMPT,
      env: {
        TELLAGEN_GUARD_LOG: log,
        TELLAGEN_PROBE_CALLS: calls,
        PATH: `${join(sandbox, "bin")}:${process.env.PATH ?? ""}`,
      },
      cwd: deps.cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.missing) return { ok: false, reason: `${deps.command.command} was not found.` };
    const entries = readGuardLog(log);
    const problem = judgeGuardLog(entries) ?? judgeCanary(readLines(calls));
    if (problem) {
      const head = `Could not prove that the shell guard is active (${problem}) The listener will not start the client.`;
      // A guard that saw nothing is most often a client that never got to a model call: say what it printed.
      if (entries.length > 0) return { ok: false, reason: head };
      const blockers = (deps.hookBlockers ?? findHookBlockers)(deps.cwd);
      const { detail, fix } = explainClientResult(result, deps.command.command, blockers);
      return { ok: false, reason: `${head}\n${detail}\nTo fix it: ${fix}` };
    }
  } finally {
    rmSync(log, { force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
  writeCache(deps.home, {
    client: deps.command.command,
    client_version: deps.clientVersion,
    server_version: MCP_SERVER_VERSION,
    guard: deps.guardScript,
    verified_at: new Date(now).toISOString(),
  });
  return { ok: true, fromCache: false };
}
