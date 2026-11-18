import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listenGuardCommand } from "../src/cli/listen-guard.js";
import type { CliIo } from "../src/cli/io.js";
import type { CommandResult } from "../src/credentials.js";
import { findHookBlockers, inspectClientSettings } from "../src/listen-settings.js";
import { clientText, explainClientResult, judgeCanary, judgeGuardLog, PROBE_CANARY, PROBE_PASS, PROBE_PROMPT, readGuardLog, verifyEnforcement } from "../src/listen-probe.js";
import { reasonForEnd } from "../src/listener.js";

const event = (command: string, mode = "dontAsk") => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, permission_mode: mode });

function guardIo(stdin: string, env: Record<string, string> = {}) {
  const out: string[] = [];
  const io: CliIo = { env, stdout: (t) => void out.push(t), stderr: () => undefined, readStdin: async () => stdin };
  return { io, out };
}

describe("the shell guard command", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tellagen-guard-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prints an explicit pass for a command on the list, and a refusal with a reason for any other", async () => {
    const pass = guardIo(event("kubectl get pods -n prod"));
    expect(await listenGuardCommand([], pass.io)).toBe(0);
    expect(JSON.parse(pass.out.join("")).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "allow" });
    const refuse = guardIo(event("kubectl get pods -s https://evil.example --insecure-skip-tls-verify"));
    await listenGuardCommand([], refuse.io);
    const refusal = JSON.parse(refuse.out.join("")).hookSpecificOutput;
    expect(refusal.permissionDecision).toBe("deny");
    expect(refusal.permissionDecisionReason.length).toBeGreaterThan(10);
  });

  it("refuses an event it cannot read, and a tool that is not the shell", async () => {
    for (const stdin of ["", "not json", "[]", JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x", content: "y" } })]) {
      const run = guardIo(stdin);
      await listenGuardCommand([], run.io);
      expect(JSON.parse(run.out.join("")).hookSpecificOutput.permissionDecision, stdin).toBe("deny");
    }
  });

  it("writes one private log line for each decision when asked, for the proof at the start", async () => {
    const log = join(dir, "guard.log");
    await listenGuardCommand([], guardIo(event("kubectl version --client"), { TELLAGEN_GUARD_LOG: log }).io);
    await listenGuardCommand([], guardIo(event("cat /etc/hostname"), { TELLAGEN_GUARD_LOG: log }).io);
    expect(readGuardLog(log)).toEqual([
      { decision: "allow", mode: "dontAsk", command: "kubectl version --client" },
      { decision: "deny", mode: "dontAsk", command: "cat /etc/hostname" },
    ]);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    // No log without the variable.
    await listenGuardCommand([], guardIo(event("kubectl get pods")).io);
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("the proof that the client calls the guard", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tellagen-probe-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ok: CommandResult = { code: 0, stdout: "done", stderr: "", missing: false, timedOut: false };
  const guardScript = () => {
    const path = join(dir, "index.js");
    writeFileSync(path, "// guard");
    return path;
  };
  const deps = (run: (command: string, args: readonly string[], options?: { env?: Record<string, string>; input?: string }) => Promise<CommandResult>) => ({
    home: dir,
    command: { command: "claude", args: ["-p"] },
    cwd: dir,
    clientVersion: "9.9.9",
    guardScript: guardScript(),
    run,
    hookBlockers: () => [] as string[],
  });
  /**
   * A client that calls the guard for both test commands, as the real one does, runs the
   * command that the guard passed (the stand-in kubectl records it) and, if `obeys` is false,
   * also runs the one it refused.
   */
  const callsGuard = (mode = "dontAsk", obeys = true): Parameters<typeof deps>[0] => async (_c, _a, options) => {
    writeFileSync(options!.env!.TELLAGEN_GUARD_LOG!, `allow\t${mode}\t${PROBE_PASS}\ndeny\t${mode}\t${PROBE_CANARY}\n`);
    appendFileSync(options!.env!.TELLAGEN_PROBE_CALLS!, "version --client\n");
    if (!obeys) appendFileSync(options!.env!.TELLAGEN_PROBE_CALLS!, "get pods --server=https://canary.invalid\n");
    return ok;
  };

  it("passes when the guard saw one pass and one refusal in the refusing mode, and remembers it for that client version", async () => {
    let calls = 0;
    const run: Parameters<typeof deps>[0] = async (c, a, o) => {
      calls += 1;
      expect(o!.input).toBe(PROBE_PROMPT);
      return callsGuard()(c, a, o);
    };
    expect(await verifyEnforcement(deps(run))).toEqual({ ok: true, fromCache: false });
    expect(await verifyEnforcement(deps(run))).toEqual({ ok: true, fromCache: true });
    expect(calls).toBe(1);
    // A new client version is proved again.
    expect(await verifyEnforcement({ ...deps(run), clientVersion: "10.0.0" })).toEqual({ ok: true, fromCache: false });
    expect(calls).toBe(2);
    expect(existsSync(join(dir, "listen", "enforcement.json"))).toBe(true);
  });

  it("refuses a client that never calls the guard, and does not remember it", async () => {
    const result = await verifyEnforcement(deps(async () => ok));
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("did not call the shell guard");
    expect(existsSync(join(dir, "listen", "enforcement.json"))).toBe(false);
  });

  it("refuses a client that calls the guard in another mode, or for one command only", async () => {
    const wrongMode = await verifyEnforcement(deps(callsGuard("acceptEdits")));
    expect(wrongMode.ok).toBe(false);
    const one = await verifyEnforcement(
      deps(async (_c, _a, o) => {
        writeFileSync(o!.env!.TELLAGEN_GUARD_LOG!, `allow\tdontAsk\t${PROBE_PASS}\n`);
        return ok;
      }),
    );
    expect(one.ok).toBe(false);
    expect(judgeGuardLog([])).toContain("did not call the shell guard at all");
  });

  it("refuses to start a client on a platform where it cannot run the canary", async () => {
    let called = false;
    const result = await verifyEnforcement({ ...deps(async () => ((called = true), ok)), platform: "win32" });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("only on macOS and Linux");
    expect(called).toBe(false);
    // Not even a remembered proof for another platform counts.
    expect(existsSync(join(dir, "listen", "enforcement.json"))).toBe(false);
  });

  it("refuses a client that calls the guard, hears the refusal, and runs the refused command anyway", async () => {
    const result = await verifyEnforcement(deps(callsGuard("dontAsk", false)));
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("RAN a command that the guard refused");
    expect(existsSync(join(dir, "listen", "enforcement.json"))).toBe(false);
  });

  it("refuses a client that did not run even the passed command", () => {
    expect(judgeCanary([])).toContain("did not run the command that the guard passed");
    expect(judgeCanary(["version --client"])).toBeUndefined();
    expect(judgeCanary(["version --client", "get pods --server=https://canary.invalid"])).toContain("RAN");
  });

  it("puts a stand-in kubectl first on the client's PATH and removes it again", async () => {
    let seenPath = "";
    await verifyEnforcement(deps(async (c, a, o) => {
      seenPath = o!.env!.PATH!;
      return callsGuard()(c, a, o);
    }));
    expect(seenPath).toContain("probe-");
    expect(seenPath.split(":")[0]!.endsWith("/bin")).toBe(true);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(dir, "listen")).filter((name) => name.startsWith("probe-"))).toEqual([]);
  });

  it("refuses when the client is missing or the guard script is not found", async () => {
    expect((await verifyEnforcement(deps(async () => ({ ...ok, missing: true })))).ok).toBe(false);
    const missing = await verifyEnforcement({ ...deps(callsGuard()), guardScript: join(dir, "nope.js") });
    expect(missing.ok).toBe(false);
    expect((missing as { reason: string }).reason).toContain("not found");
  });

  it("leaves no probe log behind", async () => {
    await verifyEnforcement(deps(callsGuard()));
    mkdirSync(join(dir, "listen"), { recursive: true });
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(dir, "listen")).filter((name) => name.startsWith("probe-"))).toEqual([]);
  });
});

describe("what the client printed when the guard saw nothing, and how to fix it", () => {
  const result = (over: Partial<CommandResult>): CommandResult => ({ code: 1, stdout: "", stderr: "", missing: false, timedOut: false, ...over });

  it("names an expired sign-in and tells the person to sign in again", () => {
    const { detail, fix } = explainClientResult(result({ stdout: "Failed to authenticate: OAuth session expired and could not be refreshed\n" }), "claude", [], {});
    // The generic key: value mask hides "OAuth" after "authenticate:"; the fix is still found from the raw text.
    expect(detail).toBe('The client stopped with exit code 1. The client said: "Failed to authenticate: [redacted] session expired and could not be refreshed"');
    expect(fix).toContain("run `claude` in a terminal, type /login");
  });

  it("sends a refused key to ANTHROPIC_API_KEY only when that variable is set", () => {
    const refused = result({ stdout: "Invalid API key · Please run /login" });
    expect(explainClientResult(refused, "claude", [], { ANTHROPIC_API_KEY: "x" }).fix).toContain("unset ANTHROPIC_API_KEY");
    expect(explainClientResult(refused, "claude", [], {}).fix).toContain("type /login");
  });

  it("names a usage limit, a missing model and a timeout", () => {
    expect(explainClientResult(result({ stderr: "Claude AI usage limit reached" }), "claude", [], {}).fix).toContain("usage limit");
    expect(explainClientResult(result({ stderr: "model claude-x not found" }), "claude", [], {}).fix).toContain('Remove "model" from listen.json');
    const slow = explainClientResult(result({ code: null, timedOut: true }), "claude", [], {});
    expect(slow.detail).toBe("The client did not finish in 3 minutes.");
    expect(slow.fix).toContain('claude -p "say ok"');
  });

  it("names a setting that turns hooks off when the client gave no other reason", () => {
    const { detail, fix } = explainClientResult(result({ code: 0, stdout: "done" }), "claude", ['"disableAllHooks": true in /h/.claude/settings.json'], {});
    expect(detail).toContain('turn hooks off: "disableAllHooks": true in /h/.claude/settings.json.');
    expect(fix).toContain("Remove that setting");
  });

  it("says the model did not use the shell tool when the client finished, and gives a general step for an unknown error", () => {
    expect(explainClientResult(result({ code: 0, stdout: "I will not run that." }), "claude", [], {}).fix).toContain("If the model did not try the two commands");
    const unknown = explainClientResult(result({ code: 2, stderr: "segfault" }), "claude", [], {});
    expect(unknown.detail).toBe('The client stopped with exit code 2. The client said: "segfault"');
    expect(unknown.fix).toContain('claude -p "say ok"');
    expect(explainClientResult(result({ code: 3 }), "claude", [], {}).detail).toBe("The client stopped with exit code 3. The client printed nothing.");
  });

  it("puts the client's words on one short line with colour codes and secrets removed", () => {
    const text = clientText({ stdout: `\x1b[31mError\x1b[0m\n  token=sk-ant-api03-${"a".repeat(40)}\n${"x".repeat(400)}`, stderr: "" });
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("aaaaaaaa");
    expect(text).not.toContain("\n");
    expect(text.length).toBe(300);
    expect(text.endsWith("...")).toBe(true);
  });

  it("puts the client's error and the fix in the refusal of the listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tellagen-probe-why-"));
    try {
      const guard = join(dir, "index.js");
      writeFileSync(guard, "// guard");
      const refusal = await verifyEnforcement({
        home: dir,
        command: { command: "claude", args: ["-p"] },
        cwd: dir,
        clientVersion: "9.9.9",
        guardScript: guard,
        run: async () => result({ stdout: "Failed to authenticate: OAuth session expired and could not be refreshed\n" }),
        hookBlockers: () => [],
      });
      expect(refusal.ok).toBe(false);
      const lines = (refusal as { reason: string }).reason.split("\n");
      expect(lines[0]).toBe("Could not prove that the shell guard is active (The client did not call the shell guard at all.) The listener will not start the client.");
      expect(lines[1]).toContain("session expired and could not be refreshed");
      expect(lines[2]).toMatch(/^To fix it: Sign in to Claude Code again/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the settings that turn the client's hooks off", () => {
  it("finds disableAllHooks and allowManagedHooksOnly in the files the client reads, and names no other key", () => {
    const home = mkdtempSync(join(tmpdir(), "tellagen-hooks-"));
    try {
      const work = join(home, "work");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(work, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: true, permissions: { allow: [] } }));
      writeFileSync(join(work, ".claude", "settings.local.json"), JSON.stringify({ allowManagedHooksOnly: true }));
      const found = findHookBlockers(work, home, {});
      expect(found).toContain(`"disableAllHooks": true in ${join(home, ".claude", "settings.json")}`);
      expect(found).toContain(`"allowManagedHooksOnly": true in ${join(work, ".claude", "settings.local.json")}`);
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: false }));
      expect(findHookBlockers(work, home, {}).some((entry) => entry.includes("disableAllHooks"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("why a run could not be started, as the codes Tellagen accepts", () => {
  it("maps the end of a client to a code", () => {
    expect(reasonForEnd({ code: null, failedToStart: "claude was not found. Install it" }, "")).toBe("client_not_installed");
    expect(reasonForEnd({ code: null, failedToStart: "claude could not be started (EACCES)." }, "")).toBe("client_start_failed");
    expect(reasonForEnd({ code: 1 }, "Not logged in. Run /login")).toBe("client_not_signed_in");
    expect(reasonForEnd({ code: 1 }, "Invalid API key")).toBe("client_not_signed_in");
    expect(reasonForEnd({ code: 1 }, "something else broke")).toBe("client_start_failed");
    expect(reasonForEnd({ code: 0 }, "")).toBeUndefined();
    expect(reasonForEnd({ code: 143, timedOut: true }, "")).toBeUndefined();
  });
});

describe("the settings of the client, wider than the working folder", () => {
  it("reads the folders above the working folder and the folder that CLAUDE_CONFIG_DIR names", () => {
    const root = mkdtempSync(join(tmpdir(), "tellagen-walk-"));
    try {
      const project = join(root, "repo", "service");
      mkdirSync(project, { recursive: true });
      mkdirSync(join(root, "repo", ".claude"), { recursive: true });
      writeFileSync(join(root, "repo", ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(*)"] } }));
      const config = join(root, "other-config");
      mkdirSync(config);
      writeFileSync(join(config, "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
      const found = inspectClientSettings(project, {}, join(root, "home"), { CLAUDE_CONFIG_DIR: config });
      expect(found.problems.map((p) => p.rule).sort()).toEqual(["Bash(*)", "Read"]);
      expect(inspectClientSettings(project, {}, join(root, "home"), {}).problems.map((p) => p.rule)).toEqual(["Bash(*)"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
