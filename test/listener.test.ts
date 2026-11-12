import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listenCommand } from "../src/cli/listen.js";
import type { CliIo } from "../src/cli/io.js";
import { TellagenClient } from "../src/client.js";
import { TellagenAPIError } from "../src/errors.js";
import {
  acquireLock,
  Listener,
  readListenStatus,
  type ClientCommand,
  type ListenerDeps,
  type ProcessEnd,
  type RunningProcess,
  type WaitingRun,
} from "../src/listener.js";
import { readListenConfig } from "../src/listen-config.js";
import { parseWrapArgs, runWrapped } from "../src/listen-wrap.js";
import { jsonResponse } from "./helpers/harness.js";

const API = "https://acme.api.tellagen.com";
const KEY = "tgn_TheKeyOfTheListenerTest_0123456789";

/** A client program that a test controls. */
class FakeClient {
  started: Array<{ command: ClientCommand; logPath: string; end: (end?: ProcessEnd) => void; killed: string[] }> = [];
  startFails: string | undefined;
  start = (command: ClientCommand, logPath: string): RunningProcess => {
    let resolve!: (end: ProcessEnd) => void;
    const exited = new Promise<ProcessEnd>((r) => (resolve = r));
    const killed: string[] = [];
    const entry = { command, logPath, end: (end: ProcessEnd = { code: 0, signal: null }) => resolve(end), killed };
    this.started.push(entry);
    if (this.startFails) resolve({ code: null, signal: null, failedToStart: this.startFails });
    return {
      pid: 4000 + this.started.length,
      exited,
      kill: (signal) => {
        killed.push(signal);
        resolve({ code: null, signal });
      },
    };
  };
}

describe("the listener", () => {
  let dir: string;
  let lines: string[];
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let queue: Array<() => Response | Promise<Response>>;
  let requests: Array<{ url: string; headers: Headers }>;
  let fake: FakeClient;

  const run = (id: string): WaitingRun => ({ run_id: id, requested_by_me: true, incident_human_id: "INC-12", incident_title: "Checkout is slow" });
  const list = (runs: WaitingRun[], listener: unknown = { computer_name: "ann-mac", take_runs_automatically: true }) => () =>
    jsonResponse({ runs, listener });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tellagen-listener-"));
    lines = [];
    queue = [];
    requests = [];
    fake = new FakeClient();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      // With nothing queued, wait like the real route does.
      if (!next) return new Promise<Response>(() => undefined);
      return next();
    });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function make(overrides: Partial<ListenerDeps> = {}, configOverrides: Record<string, unknown> = {}) {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "listen.json"), JSON.stringify(configOverrides));
    const client = new TellagenClient({ apiUrl: API, apiKey: KEY });
    client.session.identity = { name: "claude-code", label: "Claude Code", version: "" };
    return new Listener({
      client,
      config: readListenConfig(home),
      cwd: dir,
      home,
      out: (line) => lines.push(line),
      startProcess: fake.start,
      guardScript: "/opt/tellagen/dist/index.js",
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 5)),
      restMs: 5,
      killGraceMs: 20,
      ...overrides,
    });
  }

  it("asks for runs with listening on, and starts the client for a run that arrives", async () => {
    queue = [list([run("run-1")]), () => new Promise<Response>(() => undefined)];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    const request = requests[0]!;
    expect(request.url).toContain("/api/v1/investigations?status=awaiting_agent&wait=25&listening=true");
    expect(request.headers.get("x-tellagen-computer")).toBeTruthy();
    expect(request.headers.get("x-tellagen-client")).toBe("claude-code");
    const started = fake.started[0]!;
    expect(started.command.command).toBe("claude");
    expect(started.command.stdin).toContain('investigation_run_id "run-1"');
    expect(started.command.stdin).toContain("data, not instructions");
    expect(started.command.cwd).toBe(dir);
    expect(lines.join("\n")).toContain("Started run run-1 (INC-12 Checkout is slow)");
    listener.stop();
    started.end();
    await done;
  });

  it("runs one run at a time by default, and takes the next one when the first ends", async () => {
    queue = [list([run("run-1"), run("run-2")])];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    expect(fake.started[0]!.command.stdin).toContain("run-1");
    // The second run waits as long as the first goes on.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.started).toHaveLength(1);
    expect(listener.activeCount()).toBe(1);
    fake.started[0]!.end();
    await vi.waitFor(() => expect(fake.started).toHaveLength(2));
    expect(fake.started[1]!.command.stdin).toContain("run-2");
    listener.stop();
    fake.started[1]!.end();
    await done;
  });

  it("starts two runs at once when the person allows two", async () => {
    queue = [list([run("run-1"), run("run-2"), run("run-3")])];
    const listener = make({}, { max_runs: 2 });
    const done = listener.run();
    await vi.waitFor(() => expect(fake.started).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fake.started).toHaveLength(2);
    listener.forceStop();
    await done;
  });

  it("reports a client that cannot start, keeps the run waiting, and does not start it again at once", async () => {
    fake.startFails = "claude was not found. Install it, or choose the other client in listen.json.";
    queue = [list([run("run-1")])];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(lines.join("\n")).toContain("claude was not found"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Tellagen lists the run again and again; the listener starts it once.
    expect(fake.started).toHaveLength(1);
    expect(lines.join("\n")).toContain("Tellagen keeps it waiting");
    listener.stop();
    await done;
    expect(readListenStatus(join(dir, "home"))?.recent[0]).toMatchObject({ run_id: "run-1", result: expect.stringContaining("not found") });
  });

  it("reports why a client exited with an error, with the last line of its log and no secret", async () => {
    queue = [list([run("run-1")]), () => new Promise<Response>(() => undefined)];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    const entry = fake.started[0]!;
    mkdirSync(join(entry.logPath, ".."), { recursive: true });
    writeFileSync(entry.logPath, `starting\nNot logged in. token=abcdef0123456789abcdef\n`);
    listener.stop();
    entry.end({ code: 1, signal: null });
    await done;
    const text = lines.join("\n");
    expect(text).toContain("exited with code 1");
    expect(text).toContain("Not logged in");
    expect(text).not.toContain("abcdef0123456789abcdef");
  });

  it("stops asking on a stop signal, lets the run finish, and ends cleanly", async () => {
    queue = [list([run("run-1")]), () => new Promise<Response>(() => undefined)];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    listener.stop();
    let finished = false;
    void done.then(() => (finished = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The run in progress holds the listener open; nothing killed it.
    expect(finished).toBe(false);
    expect(fake.started[0]!.killed).toEqual([]);
    expect(lines.join("\n")).toContain("Waiting for 1 run to finish");
    fake.started[0]!.end();
    await done;
    expect(finished).toBe(true);
    const status = readListenStatus(join(dir, "home"));
    expect(status?.current).toEqual([]);
    expect(status?.recent[0]?.result).toBe("finished");
  });

  it("ends at once when a stop comes while it waits for Tellagen", async () => {
    queue = [() => new Promise<Response>(() => undefined)];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    listener.stop();
    await done;
    expect(fake.started).toHaveLength(0);
  });

  it("stops the run on a second stop: first a termination signal", async () => {
    queue = [list([run("run-1")]), () => new Promise<Response>(() => undefined)];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    listener.stop();
    listener.forceStop();
    await done;
    expect(fake.started[0]!.killed).toContain("SIGTERM");
    expect(readListenStatus(join(dir, "home"))?.recent[0]?.result).toBe("stopped by you");
  });

  it("stops a run that goes over its time limit", async () => {
    queue = [list([run("run-1")]), () => new Promise<Response>(() => undefined)];
    const listener = make({ runLimitMs: 40 });
    const done = listener.run();
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    await vi.waitFor(() => expect(fake.started[0]!.killed).toContain("SIGTERM"));
    listener.stop();
    await done;
    expect(readListenStatus(join(dir, "home"))?.recent[0]?.result).toContain("stopped after 45 minutes");
  });

  it("stops with a plain message when Tellagen refuses the sign-in or is too old", async () => {
    queue = [() => jsonResponse({ code: "unauthorized", message: "bad key" }, 401)];
    const first = make();
    await first.run();
    expect(first.fatal).toContain("npx @tellagen/mcp-server login");
    queue = [() => jsonResponse({ message: "not found" }, 404)];
    const second = make();
    await second.run();
    expect(second.fatal).toContain("cannot hand runs to a listener yet");
    expect(fake.started).toHaveLength(0);
  });

  it("keeps trying when the network fails, and says so once", async () => {
    let calls = 0;
    queue = [
      () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
    ];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 3000 });
    listener.stop();
    await done;
    expect(lines.filter((line) => line.includes("cannot be reached"))).toHaveLength(1);
  });

  it("tells the person when the switch is off", async () => {
    queue = [list([], { computer_name: "ann-mac", take_runs_automatically: false }), () => new Promise<Response>(() => undefined)];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(lines.join("\n")).toContain("Take my runs automatically"));
    listener.stop();
    await done;
  });

  it("does not start a run whose id is not an id", async () => {
    queue = [list([{ run_id: "x; rm -rf /" } as WaitingRun]), () => new Promise<Response>(() => undefined)];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 30));
    listener.stop();
    await done;
    expect(fake.started).toHaveLength(0);
  });

  it("starts no run when the list does not say it is for this computer, or the run is not the person's", async () => {
    queue = [() => jsonResponse({ runs: [{ run_id: "run-1", requested_by_me: true }] }), () => new Promise<Response>(() => undefined)];
    const noListener = make();
    const done = noListener.run();
    await vi.waitFor(() => expect(lines.join("\n")).toContain("did not say that this list is for this computer"));
    noListener.stop();
    await done;
    expect(fake.started).toHaveLength(0);

    lines.length = 0;
    queue = [
      list([{ run_id: "run-foreign", requested_by_me: false }, { run_id: "run-unknown" }, run("run-mine")]),
      () => new Promise<Response>(() => undefined),
    ];
    const foreign = make();
    const done2 = foreign.run();
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    expect(fake.started[0]!.command.stdin).toContain('investigation_run_id "run-mine"');
    foreign.forceStop();
    await done2;
    expect(fake.started).toHaveLength(1);
  });

  it("counts a client that ends with code 0 and leaves the run waiting, waits longer each time, and stops after five starts", async () => {
    let clock = 0;
    queue = [list([run("run-1")])];
    const listener = make({ now: () => clock });
    const done = listener.run();
    const waits = [1, 4, 16, 60, 60];
    for (let start = 1; start <= 5; start++) {
      await vi.waitFor(() => expect(fake.started).toHaveLength(start));
      fake.started[start - 1]!.end({ code: 0, signal: null });
      // Inside the wait, the same run is listed again and is not started.
      await vi.waitFor(() => expect(listener.activeCount()).toBe(0));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fake.started).toHaveLength(start);
      clock += waits[start - 1]! * 60_000 + 1;
    }
    await vi.waitFor(() => expect(lines.join("\n")).toContain("was started 5 times and is still waiting"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.started).toHaveLength(5);
    listener.stop();
    await done;
  });

  it("refuses the Codex client before it asks Tellagen for anything", async () => {
    const listener = make({}, { client: "codex" });
    await listener.run();
    expect(listener.fatal).toContain("cannot start codex");
    expect(requests).toHaveLength(0);
    expect(fake.started).toHaveLength(0);
  });

  it("sends the coded reason once, on the next wait request, for a client that cannot start", async () => {
    fake.startFails = "claude was not found. Install it, or choose the other client in listen.json.";
    queue = [list([run("run-1")]), list([run("run-1")]), list([run("run-1")]), () => new Promise<Response>(() => undefined)];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(3));
    listener.stop();
    await done;
    expect(requests[0]!.url).not.toContain("listener_reason");
    expect(requests[1]!.url).toContain("&listener_reason=client_not_installed&listener_run=run-1");
    expect(requests[2]!.url).not.toContain("listener_reason");
  });

  it("says client_not_signed_in when the client ends with a login message, and gave_up after five starts", async () => {
    let clock = 0;
    queue = [list([run("run-1")])];
    const listener = make({ now: () => clock });
    const done = listener.run();
    for (let start = 1; start <= 5; start++) {
      await vi.waitFor(() => expect(fake.started).toHaveLength(start));
      const entry = fake.started[start - 1]!;
      mkdirSync(join(entry.logPath, ".."), { recursive: true });
      writeFileSync(entry.logPath, "Not logged in. Please run /login\n");
      entry.end({ code: 1, signal: null });
      await vi.waitFor(() => expect(listener.activeCount()).toBe(0));
      clock += 61 * 60_000;
    }
    await vi.waitFor(() => expect(requests.some((r) => r.url.includes("listener_reason=client_not_signed_in&listener_run=run-1"))).toBe(true));
    await vi.waitFor(() => expect(requests.some((r) => r.url.includes("listener_reason=gave_up&listener_run=run-1"))).toBe(true));
    listener.stop();
    await done;
  });

  it("says limit_reached once for a run that the limit holds back", async () => {
    queue = [list([run("run-1"), run("run-2")])];
    const listener = make();
    const done = listener.run();
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    await vi.waitFor(() => expect(requests.some((r) => r.url.includes("listener_reason=limit_reached&listener_run=run-2"))).toBe(true), { timeout: 3000 });
    listener.forceStop();
    await done;
  });

  it("does not start a run when the person's own settings now allow too much", async () => {
    queue = [list([run("run-1")]), () => new Promise<Response>(() => undefined)];
    const listener = make({ preflight: () => 'Your Claude Code settings now allow "Bash(*)" (settings.json), which a listened run may not have' });
    const done = listener.run();
    await vi.waitFor(() => expect(lines.join("\n")).toContain('now allow "Bash(*)"'));
    listener.stop();
    await done;
    expect(fake.started).toHaveLength(0);
  });

  it("holds a lock so that a second listener on the computer is refused", () => {
    const home = join(dir, "lock-home");
    const first = acquireLock(home);
    expect(first.ok).toBe(true);
    // Another process asks while this one holds the lock.
    const second = acquireLock(home, 999_999);
    expect(second).toEqual({ ok: false, pid: process.pid });
    if (first.ok) first.release();
    const third = acquireLock(home);
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
  });
});

describe("listen refuses to start a client whose guard it cannot prove", () => {
  it("exits with 1 and starts nothing when the proof fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tellagen-noproof-"));
    const err: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Promise<Response>(() => undefined));
    try {
      const io: CliIo = {
        env: { TELLAGEN_HOME: join(dir, "home"), TELLAGEN_API_URL: API, TELLAGEN_API_KEY: KEY, TELLAGEN_STATE_DIR: join(dir, "state") },
        stdout: () => undefined,
        stderr: (t) => void err.push(t),
        readStdin: async () => "",
      };
      const code = await listenCommand([], io, {
        signals: false,
        settingsHome: join(dir, "none"),
        clientVersion: async () => "9.9.9",
        verify: async () => ({ ok: false, reason: "Could not prove that the shell guard is active (The client did not call the shell guard at all.) The listener will not start the client." }),
        listener: { guardScript: "/opt/tellagen/dist/index.js" },
      });
      expect(code).toBe(1);
      expect(err.join("")).toContain("will not start the client");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits with 1 when the built server with the guard is not found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tellagen-noguard-"));
    const err: string[] = [];
    try {
      const io: CliIo = {
        env: { TELLAGEN_HOME: join(dir, "home"), TELLAGEN_API_URL: API, TELLAGEN_API_KEY: KEY },
        stdout: () => undefined,
        stderr: (t) => void err.push(t),
        readStdin: async () => "",
      };
      // Running from source: there is no built index.js beside the module, so there is no guard.
      const code = await listenCommand([], io, { signals: false, settingsHome: join(dir, "none"), clientVersion: async () => "9.9.9" });
      expect(code).toBe(1);
      expect(err.join("")).toContain("shell guard");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the time limit holds without the listener", () => {
  it("parses the wrapper arguments and refuses a call without a limit or a command", () => {
    expect(parseWrapArgs(["--limit-seconds", "30", "--", "claude", "-p"])).toEqual({ limitSeconds: 30, graceSeconds: undefined, command: "claude", args: ["-p"] });
    expect(parseWrapArgs(["--", "claude"])).toBeUndefined();
    expect(parseWrapArgs(["--limit-seconds", "30"])).toBeUndefined();
    expect(parseWrapArgs(["--limit-seconds", "0", "--", "x"])).toBeUndefined();
  });

  it("ends a client that runs over the limit, with code 124, and passes the exit code of one that does not", async () => {
    const slow = await runWrapped({ limitSeconds: 0.3, graceSeconds: 1, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
    expect(slow).toBe(124);
    const fast = await runWrapped({ limitSeconds: 10, command: process.execPath, args: ["-e", "process.exit(3)"] });
    expect(fast).toBe(3);
    expect(await runWrapped({ limitSeconds: 10, command: "definitely-not-a-program-xyz", args: [] })).toBe(127);
  }, 10_000);

  it("kills a client that ignores the termination signal after the grace time", async () => {
    const started = Date.now();
    const code = await runWrapped({
      limitSeconds: 0.3,
      graceSeconds: 0.5,
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    });
    expect(code).toBe(124);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);
});

describe("listen with a fake client program", () => {
  let dir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tellagen-fake-claude-"));
  });
  afterEach(() => {
    process.env.PATH = originalPath;
    fetchSpy?.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts a real process with the prompt on its input, logs to a private file, and stops cleanly", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const record = join(dir, "record");
    mkdirSync(record);
    // The fake client: records its arguments and its input, prints a line, exits 0.
    const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi
printf '%s\\n' "$@" > "${record}/args"
cat > "${record}/stdin"
pwd > "${record}/cwd"
echo "diagnosis done"
exit 0
`;
    writeFileSync(join(bin, "claude"), script);
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    let waiting = true;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (waiting) {
        waiting = false;
        return jsonResponse({ runs: [{ run_id: "run-fake-1", requested_by_me: true, incident_human_id: "INC-1", incident_title: "T" }], listener: { take_runs_automatically: true } });
      }
      return new Promise<Response>(() => undefined);
    });

    const work = join(dir, "work");
    mkdirSync(work);
    const home = join(dir, "home");
    mkdirSync(home);
    writeFileSync(join(home, "listen.json"), JSON.stringify({ working_folder: work }));
    const out: string[] = [];
    const io: CliIo = {
      env: { TELLAGEN_HOME: home, TELLAGEN_API_URL: API, TELLAGEN_API_KEY: KEY, TELLAGEN_STATE_DIR: join(dir, "state") },
      stdout: (text) => void out.push(text),
      stderr: (text) => void out.push(text),
      readStdin: async () => "",
    };
    let listener: Listener | undefined;
    const finished = listenCommand([], io, { signals: false, settingsHome: join(dir, "no-settings"), verify: async () => ({ ok: true, fromCache: true }), listener: { restMs: 5, guardScript: "/opt/tellagen/dist/index.js" }, onListener: (l) => (listener = l) });
    await vi.waitFor(() => expect(existsSync(join(record, "stdin"))).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(readListenStatus(home)?.recent[0]?.result).toBe("finished"), { timeout: 5000 });

    const args = readFileSync(join(record, "args"), "utf8");
    expect(args).toContain("--permission-mode\ndontAsk");
    for (const forbidden of ["--dangerously-skip-permissions", "bypassPermissions"]) expect(args).not.toContain(forbidden);
    expect(readFileSync(join(record, "stdin"), "utf8")).toContain('investigation_run_id "run-fake-1"');
    expect(readFileSync(join(record, "cwd"), "utf8").trim().endsWith("work")).toBe(true);

    const logs = join(home, "listen", "logs");
    const [logName] = readdirSync(logs);
    expect(readFileSync(join(logs, logName!), "utf8")).toContain("diagnosis done");
    expect(statSync(join(logs, logName!)).mode & 0o777).toBe(0o600);
    expect(out.join("")).not.toContain(KEY);

    // A second listener on the same computer is refused while the first runs.
    const second = await listenCommand([], io, { signals: false, lockPid: 999_999, settingsHome: join(dir, "no-settings"), verify: async () => ({ ok: true, fromCache: true }), listener: { guardScript: "/opt/tellagen/dist/index.js" } });
    expect(second).toBe(1);
    expect(out.join("")).toContain("already running");

    // Stop it the way the first Ctrl+C does.
    listener!.stop();
    expect(await finished).toBe(0);
    expect(out.join("")).toContain("Stopped listening");
    expect(existsSync(join(home, "listen", "listener.lock"))).toBe(false);
  }, 15_000);
});
