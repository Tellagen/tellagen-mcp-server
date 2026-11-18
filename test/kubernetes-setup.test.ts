import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { kubernetesCommand, kubernetesServerConfig, nodeFiles, serviceAccountKubeconfig, shortPath, type RunResult, type SetupFiles } from "../src/cli/kubernetes.js";
import type { CliIo } from "../src/cli/io.js";
import type { DoctorFs } from "../src/doctor/config-files.js";
import { parseToml } from "../src/doctor/toml.js";
import { kubernetesEntryReadOnly, kubernetesReadOnlyOfClient } from "../src/doctor/k8s-read-only.js";
import type { ServerEntry } from "../src/doctor/config-files.js";

const HOME = "/home/someone";
const TOKEN = "eyJ-secret-token-value";

function setup(initial: Record<string, string> = { "/home/someone/.claude.json": "{}" }) {
  const disk = new Map(Object.entries(initial));
  const writes: Array<{ path: string; private: boolean }> = [];
  const fs: DoctorFs = {
    platform: "linux",
    home: HOME,
    cwd: "/work",
    appData: "",
    xdgConfig: "",
    readText: (path) => disk.get(path),
    isExecutable: () => false,
  };
  const files: SetupFiles = {
    writePrivate(path, text) {
      disk.set(path, text);
      writes.push({ path, private: true });
    },
    write(path, text) {
      disk.set(path, text);
      writes.push({ path, private: false });
    },
  };
  const calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
  const answers: Record<string, boolean> = {};
  const run = async (command: string, args: string[], env?: Record<string, string>): Promise<RunResult> => {
    calls.push({ command, args, ...(env ? { env } : {}) });
    const line = args.join(" ");
    if (command === "kubectl" && line.startsWith("config view --minify --raw -o json")) {
      return { code: 0, stdout: JSON.stringify({ clusters: [{ name: "c", cluster: { server: "https://k.example.test:6443", "certificate-authority-data": "Q0E=" } }] }), stderr: "" };
    }
    if (command === "kubectl" && line.startsWith("config view --minify --flatten")) return { code: 0, stdout: "apiVersion: v1\nkind: Config\n", stderr: "" };
    if (command === "kubectl" && line.startsWith("create token")) return { code: 0, stdout: `${TOKEN}\n`, stderr: "" };
    if (command === "kubectl" && args[0] === "auth") {
      const yes = answers[line.split(" ").slice(2).join(" ")] ?? false;
      return { code: yes ? 0 : 1, stdout: yes ? "yes\n" : "no\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  let out = "";
  let err = "";
  const io: CliIo = { env: {}, stdout: (t) => void (out += t), stderr: (t) => void (err += t), readStdin: async () => "" };
  const posts: Array<{ path: string; body: any }> = [];
  const reportClient = async () =>
    ({
      session: { identity: undefined as unknown },
      post: async (path: string, body: unknown) => void posts.push({ path, body }),
    }) as any;
  return { disk, writes, fs, files, calls, answers, run, io, out: () => out, err: () => err, posts, reportClient };
}

const now = () => new Date("2026-01-01T10:00:00Z");

describe("the settings file", () => {
  it("is read-only, has destructive tools off, denies Secret and parses as TOML", () => {
    const text = kubernetesServerConfig();
    const toml = parseToml(text) as any;
    expect(toml.toolsets).toEqual(["core"]);
    expect(toml.read_only).toBe(true);
    expect(toml.disable_destructive).toBe(true);
    expect(text).toContain('[[denied_resources]]\ngroup = ""\nversion = "v1"\nkind = "Secret"');
    expect(text).not.toContain("kubeconfig");
    expect((parseToml(kubernetesServerConfig("/x/kubeconfig")) as any).kubeconfig).toBe("/x/kubeconfig");
  });

  it("shows a home folder as ~ so no user name is printed", () => {
    expect(shortPath("/home/someone/.config/tellagen/kubeconfig", HOME)).toBe("~/.config/tellagen/kubeconfig");
    expect(serviceAccountKubeconfig("sa", { server: "https://k", ca: { data: "AA==" } }, "tok")).toContain('token: "tok"');
  });
});

describe("kubernetes setup", () => {
  it("rejects bad arguments", async () => {
    const t = setup();
    expect(await kubernetesCommand([], t.io)).toBe(2);
    expect(await kubernetesCommand(["setup", "--client", "vim"], t.io)).toBe(2);
    expect(await kubernetesCommand(["setup", "--context", "a b; rm -rf"], t.io)).toBe(2);
    expect(await kubernetesCommand(["setup", "--service-account", "Bad_Name"], t.io)).toBe(2);
    expect(await kubernetesCommand(["setup", "-n", "tellagen"], t.io)).toBe(2);
    expect(await kubernetesCommand(["setup", "--service-account", "a", "--duration", "forever"], t.io)).toBe(2);
    expect(t.calls).toEqual([]);
  });

  it("asks which client when it cannot tell", async () => {
    const none = setup({});
    expect(await kubernetesCommand(["setup"], none.io, { fs: none.fs, files: none.files, run: none.run, now })).toBe(2);
    const two = setup({ "/home/someone/.claude.json": "{}", "/home/someone/.cursor/mcp.json": "{}" });
    expect(await kubernetesCommand(["setup"], two.io, { fs: two.fs, files: two.files, run: two.run, now })).toBe(2);
    expect(two.err()).toContain("More than one");
  });

  it("with Claude Code: writes the settings, adds the server after a yes, runs four checks and reports read-only", async () => {
    const t = setup();
    t.answers["pods"] = false;
    const code = await kubernetesCommand(["setup", "--no-report"], t.io, { fs: t.fs, files: t.files, run: t.run, confirm: async () => true, now });
    expect(code).toBe(0);
    const toml = parseToml(t.disk.get("/home/someone/.config/tellagen/kubernetes-mcp.toml")!) as any;
    expect(toml.read_only).toBe(true);
    const add = t.calls.find((c) => c.command === "claude")!;
    expect(add.args).toEqual(["mcp", "add", "kubernetes", "--scope", "user", "--", "npx", "-y", "kubernetes-mcp-server@latest", "--config", "/home/someone/.config/tellagen/kubernetes-mcp.toml"]);
    expect(t.calls.filter((c) => c.args[0] === "auth").map((c) => c.args.join(" "))).toEqual([
      "auth can-i create pods",
      "auth can-i delete pods",
      "auth can-i create pods --subresource=exec",
      "auth can-i get secrets",
    ]);
    expect(t.out()).toContain("Read-only access checked");
    expect(t.out()).not.toContain("/home/someone");
  });

  it("changes nothing in the client when the person says no, and prints the command", async () => {
    const t = setup();
    await kubernetesCommand(["setup", "--no-report"], t.io, { fs: t.fs, files: t.files, run: t.run, confirm: async () => false, now });
    expect(t.calls.some((c) => c.command === "claude")).toBe(false);
    expect(t.out()).toContain("was not changed");
    expect(t.out()).toContain("claude mcp add kubernetes");
  });

  it("with Codex: adds the server with the codex command", async () => {
    const t = setup({ "/home/someone/.codex/config.toml": "" });
    await kubernetesCommand(["setup", "--client", "codex", "--yes", "--no-report"], t.io, { fs: t.fs, files: t.files, run: t.run, now });
    expect(t.calls.find((c) => c.command === "codex")!.args.slice(0, 4)).toEqual(["mcp", "add", "kubernetes", "--"]);
  });

  it("with Cursor: adds the entry to its JSON config and keeps the other servers", async () => {
    const t = setup({ "/home/someone/.cursor/mcp.json": JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: 1 }) });
    await kubernetesCommand(["setup", "--client", "cursor", "--yes", "--no-report"], t.io, { fs: t.fs, files: t.files, run: t.run, now });
    const json = JSON.parse(t.disk.get("/home/someone/.cursor/mcp.json")!);
    expect(json.theme).toBe(1);
    expect(json.mcpServers.other).toEqual({ command: "x" });
    expect(json.mcpServers.kubernetes.command).toBe("npx");
    expect(json.mcpServers.kubernetes.args.at(-1)).toBe("/home/someone/.config/tellagen/kubernetes-mcp.toml");
  });

  it("is safe to run again: the entry is there, so the client is not changed twice", async () => {
    const t = setup({ "/home/someone/.cursor/mcp.json": "{}" });
    const deps = { fs: t.fs, files: t.files, run: t.run, now };
    await kubernetesCommand(["setup", "--client", "cursor", "--yes", "--no-report"], t.io, deps);
    const first = t.disk.get("/home/someone/.cursor/mcp.json");
    await kubernetesCommand(["setup", "--client", "cursor", "--yes", "--no-report"], t.io, deps);
    expect(t.disk.get("/home/someone/.cursor/mcp.json")).toBe(first);
    expect(t.out()).toContain("already has");
  });

  it("leaves a different server named kubernetes alone", async () => {
    const t = setup({ "/home/someone/.cursor/mcp.json": JSON.stringify({ mcpServers: { kubernetes: { command: "other" } } }) });
    await kubernetesCommand(["setup", "--client", "cursor", "--yes", "--no-report"], t.io, { fs: t.fs, files: t.files, run: t.run, now });
    expect(JSON.parse(t.disk.get("/home/someone/.cursor/mcp.json")!).mcpServers.kubernetes).toEqual({ command: "other" });
    expect(t.out()).toContain("left as it is");
  });

  it("with --context: writes a private kubeconfig with only that context and points the settings at it", async () => {
    const t = setup();
    await kubernetesCommand(["setup", "--context", "kind-dev", "--yes", "--no-report"], t.io, { fs: t.fs, files: t.files, run: t.run, now });
    expect(t.writes.find((w) => w.path.endsWith("/kubeconfig"))!.private).toBe(true);
    expect((parseToml(t.disk.get("/home/someone/.config/tellagen/kubernetes-mcp.toml")!) as any).kubeconfig).toBe("/home/someone/.config/tellagen/kubeconfig");
    expect(t.calls.find((c) => c.args[0] === "config")!.args).toContain("kind-dev");
    expect(t.calls.filter((c) => c.args[0] === "auth").every((c) => c.env?.KUBECONFIG === "/home/someone/.config/tellagen/kubeconfig")).toBe(true);
  });

  it("with --service-account: mints a token, writes a private kubeconfig, says how long it lasts, and never prints the token", async () => {
    const t = setup();
    await kubernetesCommand(["setup", "--service-account", "tellagen-diagnosis", "-n", "tellagen", "--yes", "--no-report"], t.io, { fs: t.fs, files: t.files, run: t.run, now });
    const mint = t.calls.find((c) => c.args[0] === "create")!;
    expect(mint.args).toEqual(["create", "token", "tellagen-diagnosis", "-n", "tellagen", "--duration", "8h"]);
    const kubeconfig = t.disk.get("/home/someone/.config/tellagen/kubeconfig")!;
    expect(kubeconfig).toContain(TOKEN);
    expect(kubeconfig).toContain("https://k.example.test:6443");
    expect(t.writes.find((w) => w.path.endsWith("/kubeconfig"))!.private).toBe(true);
    expect(t.out()).toContain("The token lasts 8h");
    expect(t.out()).toContain("renew");
    expect(t.out()).not.toContain(TOKEN);
    expect(t.err()).not.toContain(TOKEN);
  });

  it("a second run with --service-account renews the token", async () => {
    const t = setup();
    const deps = { fs: t.fs, files: t.files, run: t.run, now };
    await kubernetesCommand(["setup", "--service-account", "a", "--yes", "--no-report"], t.io, deps);
    t.disk.set("/home/someone/.config/tellagen/kubeconfig", "old");
    await kubernetesCommand(["setup", "--service-account", "a", "--yes", "--no-report"], t.io, deps);
    expect(t.disk.get("/home/someone/.config/tellagen/kubeconfig")).toContain(TOKEN);
  });

  it("stops with a clear message when the token cannot be minted", async () => {
    const t = setup();
    const run = async (command: string, args: string[]) => (args[0] === "create" ? { code: 1, stdout: "", stderr: "forbidden" } : t.run(command, args));
    expect(await kubernetesCommand(["setup", "--service-account", "a", "--yes", "--no-report"], t.io, { fs: t.fs, files: t.files, run, now })).toBe(1);
    expect(t.err()).toContain("Could not create a token");
    expect(t.disk.has("/home/someone/.config/tellagen/kubeconfig")).toBe(false);
  });

  it("says the account can still change the cluster when a check answers yes, and reports the read-only flag", async () => {
    const t = setup();
    t.answers["create pods"] = true;
    await kubernetesCommand(["setup", "--yes"], t.io, { fs: t.fs, files: t.files, run: t.run, now, reportClient: t.reportClient });
    expect(t.out()).toContain("can still create pods");
    expect(t.out()).not.toContain("Read-only access checked");
    const post = t.posts[0]!;
    expect(post.path).toBe("/api/v1/settings/agent/tool-report");
    expect(post.body.kubernetes_read_only_tools).toBe(true);
    expect(post.body.available_sources).toEqual([{ key: "kubernetes", state: "found" }]);
    expect(post.body.kubernetes_checks).toContainEqual({ id: "k8s_can_create_pods", status: "failed" });
    expect(JSON.stringify(post.body)).not.toContain("/home/someone");
  });

  it("reports nothing about the new server when the client does not run it (declined, printed, kept)", async () => {
    const declined = setup();
    await kubernetesCommand(["setup"], declined.io, { fs: declined.fs, files: declined.files, run: declined.run, confirm: async () => false, now, reportClient: declined.reportClient });
    expect(declined.posts).toEqual([]);
    expect(declined.calls.some((c) => c.args[0] === "auth")).toBe(false);

    const printed = setup();
    const failing = async (command: string, args: string[]) => (command === "claude" ? { code: 127, stdout: "", stderr: "" } : printed.run(command, args));
    await kubernetesCommand(["setup", "--yes"], printed.io, { fs: printed.fs, files: printed.files, run: failing, now, reportClient: printed.reportClient });
    expect(printed.posts).toEqual([]);

    const kept = setup({ "/home/someone/.cursor/mcp.json": JSON.stringify({ mcpServers: { kubernetes: { command: "other" } } }) });
    await kubernetesCommand(["setup", "--client", "cursor", "--yes"], kept.io, { fs: kept.fs, files: kept.files, run: kept.run, now, reportClient: kept.reportClient });
    expect(kept.calls.some((c) => c.args[0] === "auth")).toBe(false);
    // Nothing is sent, so the checks that the last Recheck stored are not replaced.
    expect(kept.posts).toEqual([]);
    expect(kept.out()).toContain("Nothing was checked or reported");
  });

  it("asks before it replaces a settings file the person edited", async () => {
    const path = "/home/someone/.config/tellagen/kubernetes-mcp.toml";
    const t = setup({ "/home/someone/.claude.json": "{}", [path]: "# my own settings\n" });
    expect(await kubernetesCommand(["setup", "--no-report"], t.io, { fs: t.fs, files: t.files, run: t.run, confirm: async () => false, now })).toBe(1);
    expect(t.disk.get(path)).toBe("# my own settings\n");
    expect(await kubernetesCommand(["setup", "--no-report", "--yes"], t.io, { fs: t.fs, files: t.files, run: t.run, now })).toBe(0);
    expect(t.disk.get(path)).toContain("read_only = true");
    expect(t.out()).toContain("the earlier text is gone");
  });

  it("a check that cannot run is a warning, not an answer", async () => {
    const t = setup();
    const run = async (command: string, args: string[]) => (args[0] === "auth" ? { code: 127, stdout: "", stderr: "" } : t.run(command, args));
    await kubernetesCommand(["setup", "--yes"], t.io, { fs: t.fs, files: t.files, run, now, reportClient: t.reportClient });
    expect(t.posts[0]!.body.kubernetes_checks.every((c: any) => c.status === "warning")).toBe(true);
    expect(t.out()).toContain("could not answer every check");
  });
});

describe("reading whether a Kubernetes server is read-only", () => {
  const fs = (files: Record<string, string>): DoctorFs => ({ platform: "linux", home: HOME, cwd: "/work", appData: "", xdgConfig: "", readText: (p) => files[p], isExecutable: () => false });
  const entry = (args: string[], extra: Partial<ServerEntry> = {}): ServerEntry => ({ client: "codex", source: "s", name: "kubernetes", command: "npx", args, env: {}, ...extra });

  it("reads --read-only, --config and the home forms", () => {
    expect(kubernetesEntryReadOnly(entry(["--read-only"]), fs({}))).toBe(true);
    expect(kubernetesEntryReadOnly(entry(["--read-only=false"]), fs({}))).toBe(false);
    expect(kubernetesEntryReadOnly(entry(["--config", "~/k.toml"]), fs({ "/home/someone/k.toml": "read_only = true\n" }))).toBe(true);
    expect(kubernetesEntryReadOnly(entry(["--config=$HOME/k.toml"]), fs({ "/home/someone/k.toml": "read_only = false\n" }))).toBe(false);
    expect(kubernetesEntryReadOnly(entry(["--config", "/k.toml"]), fs({ "/k.toml": 'toolsets = ["core"]\n' }))).toBe(false);
    expect(kubernetesEntryReadOnly(entry(["--config", "/missing.toml"]), fs({}))).toBeUndefined();
    expect(kubernetesEntryReadOnly(entry([]), fs({}))).toBe(false);
    expect(kubernetesEntryReadOnly(entry([], { command: undefined, url: "https://k.example.test" }), fs({}))).toBeUndefined();
  });

  it("is true for a client only when every Kubernetes server of it is read-only", () => {
    const codex = (blocks: string) => fs({ "/home/someone/.codex/config.toml": blocks });
    const ro = '[mcp_servers.k1]\ncommand = "npx"\nargs = ["-y", "kubernetes-mcp-server", "--read-only"]\n';
    const rw = '[mcp_servers.k2]\ncommand = "npx"\nargs = ["-y", "kubernetes-mcp-server"]\n';
    expect(kubernetesReadOnlyOfClient("codex", codex(ro))).toBe(true);
    expect(kubernetesReadOnlyOfClient("codex", codex(ro + rw))).toBe(false);
    expect(kubernetesReadOnlyOfClient("codex", codex(""))).toBeUndefined();
  });
});

describe("writing a client config", () => {
  it("keeps the mode of an existing file and makes a new one private", () => {
    const dir = mkdtempSync(join(tmpdir(), "k8s-setup-"));
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "{}");
    chmodSync(existing, 0o600);
    nodeFiles.write(existing, '{"a":1}');
    expect(statSync(existing).mode & 0o777).toBe(0o600);
    expect(readFileSync(existing, "utf8")).toBe('{"a":1}');
    const open = join(dir, "open.json");
    writeFileSync(open, "{}");
    chmodSync(open, 0o644);
    nodeFiles.write(open, "{}");
    expect(statSync(open).mode & 0o777).toBe(0o644);
    const fresh = join(dir, "sub", "fresh.json");
    nodeFiles.write(fresh, "{}");
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });
});
