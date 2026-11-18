import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { doctorCommand, reportDetail, safeArgs } from "../src/cli/doctor.js";
import type { CliIo } from "../src/cli/io.js";
import { TellagenClient } from "../src/client.js";
import { checkEntry, toolOfEntry, type CheckDeps } from "../src/doctor/checks.js";
import { configFilesFor, scanClient, type DoctorFs, type ServerEntry } from "../src/doctor/config-files.js";
import { parseToml } from "../src/doctor/toml.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "doctor");
const HOME = join(fixtures, "home");
const SHELL_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

/** A computer whose config files are the fixture folder and whose programs are a list. */
function computer(executables: string[], platform: NodeJS.Platform = "darwin", cwd = "/work/project"): DoctorFs {
  const programs = new Set(executables);
  return {
    platform,
    home: HOME,
    cwd,
    appData: "",
    xdgConfig: "",
    readText(path) {
      const mapped = path.startsWith(cwd) ? join(fixtures, "project", path.slice(cwd.length)) : path;
      try {
        return readFileSync(mapped, "utf8");
      } catch {
        return undefined;
      }
    },
    isExecutable: (path) => programs.has(path),
  };
}

const healthy = async () => ({ status: 200 });
const deps = (fs: DoctorFs, fetch: CheckDeps["fetch"] = healthy): CheckDeps => ({ fs, shellPath: SHELL_PATH, fetch });

function memoryIo(env: Record<string, string | undefined> = { PATH: SHELL_PATH }) {
  let out = "";
  let err = "";
  const io: CliIo = { env, stdout: (t) => void (out += t), stderr: (t) => void (err += t), readStdin: async () => "" };
  return { io, out: () => out, err: () => err };
}

describe("reading the config files of each client", () => {
  const fs = computer([]);

  it("reads a small TOML config with tables, arrays over lines and inline tables", () => {
    const toml = parseToml(readFileSync(join(HOME, ".codex", "config.toml"), "utf8")) as any;
    expect(toml.model).toBe("fixture-model");
    expect(toml.mcp_servers.grafana.args).toEqual(["mcp-grafana"]);
    expect(toml.mcp_servers.grafana.env.GRAFANA_URL).toBe("https://grafana.example.test");
    expect(toml.mcp_servers.github.args).toEqual(["-y", "github-mcp-server"]);
    expect(toml.mcp_servers.github.env.GITHUB_TOKEN).toBe("fixture");
  });

  it("skips a line it cannot read and keeps the rest, and ignores a prototype key", () => {
    const toml = parseToml('a = 1\nb = ???\n[__proto__]\nx = 1\n[ok]\nc = "d"\n') as any;
    expect(toml.a).toBe(1);
    expect(toml.ok.c).toBe("d");
    expect(({} as any).x).toBeUndefined();
  });

  it("finds Claude Desktop entries", () => {
    const scan = scanClient("claude-desktop", fs);
    expect(scan.filesRead).toEqual(["Claude Desktop config"]);
    expect(scan.entries.map((e) => e.name)).toEqual(["grafana", "kubernetes", "notes"]);
  });

  it("finds Claude Code user, local scope and .mcp.json entries, and not another project's", () => {
    const scan = scanClient("claude-code", fs);
    expect(scan.entries.map((e) => e.name).sort()).toEqual(["docs", "github", "grafana-local"]);
    expect(scan.entries.find((e) => e.name === "docs")!.source).toBe(".mcp.json of the current folder");
  });

  it("finds Codex and Cursor entries, with a remote server that has no command", () => {
    expect(scanClient("codex", fs).entries.map((e) => e.name)).toEqual(["grafana", "github"]);
    const cursor = scanClient("cursor", fs).entries;
    expect(cursor.map((e) => e.name)).toEqual(["grafana", "github"]);
    expect(cursor[1]!.command).toBeUndefined();
    expect(cursor[1]!.url).toBe("https://github.example.test/mcp");
  });

  it("says a missing client has no file, and a broken file is unreadable", () => {
    const none = { ...fs, readText: () => undefined };
    expect(scanClient("cursor", none)).toMatchObject({ filesRead: [], unreadable: [], entries: [] });
    const broken = { ...fs, readText: () => "{ not json" };
    expect(scanClient("cursor", broken).unreadable).toEqual(["~/.cursor/mcp.json"]);
  });

  it("knows the Windows and Linux places of the Desktop config", () => {
    const win = { ...fs, platform: "win32" as const, appData: "C:\\Users\\x\\AppData\\Roaming" };
    expect(configFilesFor("claude-desktop", win)[0]!.path).toContain("Claude");
    expect(configFilesFor("claude-desktop", win)[0]!.path).toContain("claude_desktop_config.json");
    const linux = { ...fs, platform: "linux" as const };
    expect(configFilesFor("claude-desktop", linux)[0]!.path).toContain(join(".config", "Claude"));
  });

  it("matches a server to a catalog tool by name, then by command line", () => {
    const entry = (name: string, command: string, args: string[] = []): ServerEntry => ({ client: "codex", source: "s", name, command, args, env: {} });
    expect(toolOfEntry(entry("grafana-prod", "x"))).toBe("grafana");
    expect(toolOfEntry(entry("k", "npx", ["-y", "kubernetes-mcp-server"]))).toBe("kubernetes");
    expect(toolOfEntry(entry("notes", "node"))).toBeUndefined();
    expect(toolOfEntry(entry("docs", "docs-mcp"))).toBe("docs");
  });

  it("recognises the Atlassian, Confluence and Notion servers as docs, by name, command or address", () => {
    const entry = (name: string, command: string | undefined, args: string[] = [], url?: string): ServerEntry => ({
      client: "claude-code", source: "s", name, ...(command ? { command } : {}), args, env: {}, ...(url ? { url } : {}),
    });
    expect(toolOfEntry(entry("atlassian", "npx", ["-y", "mcp-remote"]))).toBe("docs");
    expect(toolOfEntry(entry("my-confluence", "uvx", ["mcp-atlassian"]))).toBe("docs");
    expect(toolOfEntry(entry("x", "uvx", ["mcp-atlassian"]))).toBe("docs");
    expect(toolOfEntry(entry("wiki", "npx", ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"]))).toBe("docs");
    expect(toolOfEntry(entry("wiki", undefined, [], "https://mcp.atlassian.com/v1/sse"))).toBe("docs");
    expect(toolOfEntry(entry("notion", undefined, [], "https://mcp.notion.com/mcp"))).toBe("docs");
    expect(toolOfEntry(entry("pages", "npx", ["-y", "@notionhq/notion-mcp-server"]))).toBe("docs");
    expect(toolOfEntry(entry("notes", "node"))).toBeUndefined();
    expect(toolOfEntry(entry("notional", "node"))).toBeUndefined();
    expect(toolOfEntry(entry("atlassian-bitbucket", "node"))).toBeUndefined();
  });

  it("doctor --tool docs finds an Atlassian server entry", async () => {
    const fs = computer(["/usr/bin/npx"]);
    const file = join(fs.home, ".cursor", "mcp.json");
    const text = JSON.stringify({ mcpServers: { atlassian: { command: "npx", args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"] } } });
    const io = memoryIo();
    const code = await doctorCommand(["--client", "cursor", "--tool", "docs"], io.io, { fs: { ...fs, readText: (p: string) => (p === file ? text : fs.readText(p)) }, shellPath: "/usr/bin", fetch: async () => ({ status: 200 }) });
    expect(io.out()).toContain('docs: server "atlassian"');
    expect(code).toBe(0);
  });
});

describe("the checks", () => {
  it("fails a Desktop entry whose uvx is only on the terminal PATH, and says which path to use", async () => {
    const fs = computer(["/opt/homebrew/bin/uvx", "/usr/bin/npx"]);
    const grafana = scanClient("claude-desktop", fs).entries.find((e) => e.name === "grafana")!;
    const result = await checkEntry(grafana, "grafana", deps(fs));
    const command = result.checks.find((c) => c.id === "command_resolves")!;
    expect(command.status).toBe("failed");
    expect(command.summary).toBe("Claude Desktop starts uvx from a shorter PATH than your terminal. Use /opt/homebrew/bin/uvx in the command.");
    expect(command.fixCommand).toBe("/opt/homebrew/bin/uvx");
    expect(command.reportSummary).not.toContain("/opt");
    expect(result.problem).toBe("missing_tool");
  });

  it("passes the same entry when uvx is in a folder of the short PATH or in the entry's own PATH", async () => {
    const short = computer(["/usr/bin/uvx"]);
    const grafana = scanClient("claude-desktop", short).entries.find((e) => e.name === "grafana")!;
    expect((await checkEntry(grafana, "grafana", deps(short))).problem).toBeUndefined();
    const cursor = computer(["/opt/homebrew/bin/uvx"]);
    const entry = scanClient("cursor", cursor).entries.find((e) => e.name === "grafana")!;
    expect((await checkEntry(entry, "grafana", deps(cursor))).problem).toBeUndefined();
  });

  it("uses the shell PATH for a client that starts from a terminal", async () => {
    const fs = computer(["/opt/homebrew/bin/uvx"]);
    const codex = scanClient("codex", fs).entries.find((e) => e.name === "grafana")!;
    expect((await checkEntry(codex, "grafana", deps(fs))).checks[0]!.status).toBe("ok");
    const none = computer([]);
    const missing = await checkEntry(codex, "grafana", deps(none));
    expect(missing.checks[0]!.summary).toContain("not on any PATH");
    expect(missing.checks[0]!.fixCommand).toBeUndefined();
  });

  it("checks an absolute command by the file", async () => {
    const fs = computer(["/opt/homebrew/bin/uvx"]);
    const entry: ServerEntry = { client: "claude-desktop", source: "s", name: "grafana", command: "/opt/homebrew/bin/uvx", args: [], env: { GRAFANA_URL: "https://g.example.test", GRAFANA_API_KEY: "x" } };
    expect((await checkEntry(entry, "grafana", deps(fs))).problem).toBeUndefined();
    const gone = await checkEntry({ ...entry, command: "/opt/gone/uvx" }, "grafana", deps(fs));
    expect(gone.problem).toBe("missing_tool");
  });

  it("checks env names only: a missing name is auth_missing, a value is never printed", async () => {
    const fs = computer(["/usr/bin/npx", "/usr/bin/github-mcp-server"]);
    const entry: ServerEntry = { client: "claude-code", source: "s", name: "github", command: "github-mcp-server", args: [], env: { OTHER: "v" } };
    const result = await checkEntry(entry, "github", { ...deps(fs), shellPath: "/usr/bin" });
    const env = result.checks.find((c) => c.id === "env_present")!;
    expect(env.status).toBe("failed");
    expect(env.summary).toContain("GITHUB_PERSONAL_ACCESS_TOKEN or GITHUB_TOKEN");
    expect(result.problem).toBe("auth_missing");
    const withToken = await checkEntry({ ...entry, env: { GITHUB_TOKEN: "x" } }, "github", { ...deps(fs), shellPath: "/usr/bin" });
    expect(withToken.problem).toBeUndefined();
  });

  it("has no command or env check for a remote server", async () => {
    const fs = computer([]);
    const remote = scanClient("cursor", fs).entries.find((e) => e.name === "github")!;
    expect((await checkEntry(remote, "github", deps(fs))).checks).toEqual([]);
  });

  it("calls /api/health with no token, and reports a bad answer or no answer as unreachable", async () => {
    const fs = computer(["/opt/homebrew/bin/uvx"]);
    const entry = scanClient("codex", fs).entries.find((e) => e.name === "grafana")!;
    const calls: Array<{ url: string; init: unknown }> = [];
    const ok = await checkEntry(entry, "grafana", deps(fs, async (url, init) => (calls.push({ url, init }), { status: 200 })));
    expect(calls[0]!.url).toBe("https://grafana.example.test/api/health");
    expect(Object.keys(calls[0]!.init as object)).toEqual(["signal"]);
    expect(ok.checks.find((c) => c.id === "health")!.status).toBe("ok");
    const bad = await checkEntry(entry, "grafana", deps(fs, async () => ({ status: 503 })));
    expect(bad.problem).toBe("unreachable");
    expect(bad.checks.find((c) => c.id === "health")!.summary).toContain("status 503");
    const down = await checkEntry(entry, "grafana", deps(fs, async () => Promise.reject(new Error("ECONNREFUSED 10.0.0.1"))));
    expect(down.problem).toBe("unreachable");
    expect(down.checks.find((c) => c.id === "health")!.summary).not.toContain("10.0.0.1");
  });

  it("does not call a GRAFANA_URL that is not http or https", async () => {
    const fs = computer(["/usr/bin/uvx"]);
    const entry: ServerEntry = { client: "claude-desktop", source: "s", name: "grafana", command: "uvx", args: [], env: { GRAFANA_URL: "file:///etc/passwd", GRAFANA_API_KEY: "x" } };
    const fetch = vi.fn(healthy);
    const result = await checkEntry(entry, "grafana", deps(fs, fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.checks.some((c) => c.id === "health")).toBe(false);
  });

  it("builds the report sentence from fixed words only", async () => {
    const fs = computer(["/opt/homebrew/bin/uvx"]);
    const grafana = scanClient("claude-desktop", fs).entries.find((e) => e.name === "grafana")!;
    const detail = reportDetail(await checkEntry(grafana, "grafana", deps(fs)));
    expect(detail).toBe("The client starts the command from a shorter PATH than a terminal, so it cannot find it.");
  });
});

describe("the doctor command", () => {
  const fixtureValues = ["glsa_fixture_value_not_real", "ghp_fixture_value_not_real", "glsa_fixture_arg_not_real"];

  it("prints the cause in words, says what it reads, and that it cannot see a session", async () => {
    const { io, out } = memoryIo();
    const code = await doctorCommand(["--client", "claude-desktop"], io, { fs: computer(["/opt/homebrew/bin/uvx", "/usr/bin/npx"]), shellPath: SHELL_PATH, fetch: healthy });
    expect(code).toBe(1);
    const text = out();
    expect(text).toContain("reads the MCP config files of the AI clients on this computer, because you ran it");
    expect(text).toContain("sends nothing to Tellagen");
    expect(text).toContain("Claude Desktop starts uvx from a shorter PATH than your terminal. Use /opt/homebrew/bin/uvx in the command.");
    expect(text).toContain("cannot see a running session");
    expect(text).toContain("still the truth for a session");
    expect(text).toContain("FAIL");
  });

  it("exits 0 when every entry passes, and filters by tool", async () => {
    const fs = computer(["/usr/bin/uvx", "/usr/bin/npx"]);
    const { io, out } = memoryIo();
    const code = await doctorCommand(["--client", "claude-desktop", "--tool", "kubernetes"], io, { fs, shellPath: SHELL_PATH, fetch: healthy });
    expect(code).toBe(0);
    expect(out()).toContain('kubernetes: server "kubernetes"');
    expect(out()).not.toContain("grafana:");
  });

  it("covers every client when none is named, and says when a client has no file", async () => {
    const fs = computer(["/opt/homebrew/bin/uvx", "/usr/bin/npx", "/opt/homebrew/bin/github-mcp-server", "/usr/local/bin/docs-mcp"]);
    const { io, out } = memoryIo();
    await doctorCommand([], io, { fs: { ...fs, readText: (p) => (p.endsWith("config.toml") ? undefined : fs.readText(p)) }, shellPath: SHELL_PATH, fetch: healthy });
    expect(out()).toContain("Claude Code (read:");
    expect(out()).toContain("Claude Desktop (read:");
    expect(out()).toContain("Cursor (read:");
    expect(out()).toContain("Codex: no config file found.");
  });

  it("rejects an unknown client, tool or option", async () => {
    for (const args of [["--client", "vim"], ["--tool", "jira"], ["--write"], ["extra"]]) {
      const { io, err } = memoryIo();
      expect(await doctorCommand(args, io, { fs: computer([]) })).toBe(2);
      expect(err()).not.toBe("");
    }
  });

  it("prints a corrected entry with --fix, with no secret value, and writes nothing", async () => {
    const fs = computer(["/opt/homebrew/bin/uvx"]);
    const { io, out } = memoryIo();
    await doctorCommand(["--client", "claude-code", "--fix"], io, { fs, shellPath: "/usr/bin", fetch: healthy });
    const text = out();
    expect(text).toContain("Corrected entry (print only; nothing was changed)");
    expect(text).toContain('"command": "/opt/homebrew/bin/uvx"');
    expect(text).toContain("<keep your value>");
    expect(text).toContain("<keep your arg>");
    for (const value of fixtureValues) expect(text).not.toContain(value);
    expect(Object.keys(fs)).not.toContain("writeText");
  });

  it("never prints a value from a config file", async () => {
    const { io, out } = memoryIo();
    await doctorCommand(["--fix"], io, { fs: computer([]), shellPath: SHELL_PATH, fetch: healthy });
    for (const value of fixtureValues) expect(out()).not.toContain(value);
  });
});

describe("doctor --report", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });
  const api = () => new TellagenClient({ apiUrl: "https://test.api.tellagen.com", apiKey: "tllg_test" });
  const ok = () => new Response(JSON.stringify({ accepted_sources: [] }), { status: 200 });

  it("posts names and statuses, one report for each client with a problem, under that client's name", async () => {
    fetchSpy.mockImplementation(async () => ok());
    const { io, out } = memoryIo();
    const client = api();
    const code = await doctorCommand(["--report", "--client", "claude-desktop"], io, {
      fs: computer(["/opt/homebrew/bin/uvx", "/usr/bin/npx"]),
      shellPath: SHELL_PATH,
      fetch: healthy,
      reportClient: async () => client,
    });
    expect(code).toBe(1);
    const posts = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/settings/agent/tool-report"));
    expect(posts).toHaveLength(1);
    const init = posts[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      available_sources: [{ key: "grafana", state: "not_found", access_status: "missing_tool", detail: "The client starts the command from a shorter PATH than a terminal, so it cannot find it." }],
    });
    expect(new Headers(init.headers as HeadersInit).get("X-Tellagen-Client")).toBe("claude-desktop");
    const sent = String(init.body);
    for (const leak of ["/opt/homebrew", "glsa_", "grafana.example.test", HOME, "uvx"]) expect(sent).not.toContain(leak);
    expect(out()).toContain("Reported to Tellagen (names and statuses only");
  });

  it("reports nothing, and says it never reports a tool as found, when there is no problem", async () => {
    const { io, out } = memoryIo();
    const code = await doctorCommand(["--report", "--client", "claude-desktop"], io, {
      fs: computer(["/usr/bin/uvx", "/usr/bin/npx"]),
      shellPath: SHELL_PATH,
      fetch: healthy,
      reportClient: async () => api(),
    });
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out()).toContain("Nothing was reported");
  });

  it("sends nothing without --report", async () => {
    const { io } = memoryIo();
    await doctorCommand([], io, { fs: computer([]), shellPath: SHELL_PATH, fetch: healthy, reportClient: async () => api() });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says plainly when Tellagen has no such route", async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    const { io, err } = memoryIo();
    const code = await doctorCommand(["--report", "--client", "claude-desktop"], io, {
      fs: computer(["/opt/homebrew/bin/uvx", "/usr/bin/npx"]),
      shellPath: SHELL_PATH,
      fetch: healthy,
      reportClient: async () => api(),
    });
    expect(code).toBe(1);
    expect(err()).toContain("does not take a tool report without a check yet");
  });
});

describe("doctor never prints a secret from an entry", () => {
  const secrets = ["glsa_leak_value", "Bearer abc.def", "ghp_inline_leak", "hunter2", "https://user:pw@example.test"];
  it("prints only known flags and package names, and hides every value", () => {
    const shapes = [
      ["--auth", "X_secretvalue1"], ["-p", "hunter2"], ["--pat", "patvalue123"], ["--credential", "credvalue123"],
      ["xoxb-1234-abcd-efgh"], ["AKIAIOSFODNN7EXAMPLE"], ["8f3a9c1e77b24d0f"], ["--header", "Authorization: Bearer abc.def"],
      ["-e", "GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_leak_value"], ["--url=https://user:pw@example.test"], ["ghp_inline_leak"],
    ];
    for (const shape of shapes) {
      const out = safeArgs(["-y", "mcp-grafana", ...shape]);
      expect(out.slice(0, 2)).toEqual(["-y", "mcp-grafana"]);
      for (const hidden of out.slice(2)) expect(["<keep your arg>", "-e", "--header"].includes(hidden) || hidden.startsWith("--") === false).toBe(true);
      for (const value of shape.filter((x) => !x.startsWith("-"))) expect(out.join(" ")).not.toContain(value);
    }
    expect(safeArgs(["--auth", "X"])).toEqual(["<keep your arg>", "<keep your arg>"]);
    expect(safeArgs(["npx", "-y", "@tellagen/mcp-server"])).toEqual(["npx", "-y", "@tellagen/mcp-server"]);
  });

  it("prints no such value with --fix, for Claude Code, Cursor and Codex shapes", async () => {
    const base = computer(["/opt/homebrew/bin/uvx"]);
    const fs: DoctorFs = {
      ...base,
      readText(path) {
        if (path.endsWith(".cursor/mcp.json"))
          return JSON.stringify({
            mcpServers: {
              grafana: {
                command: "uvx",
                args: ["mcp-grafana", "--header", "Authorization: Bearer abc.def", "-e", "GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_leak_value"],
                env: { GRAFANA_URL: "https://grafana.example.test", GRAFANA_API_KEY: "hunter2" },
              },
            },
          });
        return base.readText(path);
      },
    };
    const { io, out, err } = memoryIo();
    await doctorCommand(["--client", "cursor", "--fix", "--report"], io, { fs, shellPath: "/usr/bin", fetch: healthy, reportClient: async () => new TellagenClient({ apiUrl: "https://test.api.tellagen.com", apiKey: "tllg_test" }) }).catch(() => 1);
    const everything = out() + err();
    for (const secret of ["glsa_leak_value", "abc.def", "hunter2"]) expect(everything).not.toContain(secret);
    expect(out()).toContain("<keep your arg>");
  });
});
