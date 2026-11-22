import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  codeLocationsBlock,
  codeLocationsOf,
  codeProbeOff,
  repoOfRemote,
  resolveCodeLocations,
  withCodeLocations,
  type CodeLocationDeps,
} from "../src/code-locations.js";
import { guideSection } from "../src/guide-resources.js";
import { readFileSync } from "node:fs";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");

const pickup = (locations: unknown) => ({ request: { context: { code_locations: locations } }, server_capabilities: ["code_locations_v1"] });

const fake = (remotes: Record<string, string[]>, gh = false, listed: string[] = []): CodeLocationDeps => ({
  cwd: "/work/app",
  listed,
  remotesOf: async (dir) => remotes[dir] ?? [],
  childrenOf: (dir) => Object.keys(remotes).filter((path) => path.startsWith(`${dir}/`) && path !== dir),
  ghAvailable: async () => gh,
});

describe("code locations", () => {
  it("reads a repository from every kind of git remote", () => {
    expect(repoOfRemote("https://github.com/Acme/Web.git")).toBe("acme/web");
    expect(repoOfRemote("git@github.com:Acme/Web.git")).toBe("acme/web");
    expect(repoOfRemote("ssh://git@github.com/acme/web")).toBe("acme/web");
    expect(repoOfRemote("https://user:token@github.com/acme/web.git")).toBe("acme/web");
    expect(repoOfRemote("not a remote")).toBeUndefined();
    expect(repoOfRemote("")).toBeUndefined();
  });

  it("takes only well formed locations from the pickup, at most 10", () => {
    const list = [
      { repo: "acme/web", default_branch: "main", path_hint: "web/", source: "service", service: "web" },
      { repo: "../../etc/passwd" },
      { repo: "no-slash" },
      "text",
      { repo: "acme/monorepo", source: "default" },
      ...Array.from({ length: 20 }, (_, i) => ({ repo: `acme/r${i}` })),
    ];
    const found = codeLocationsOf(pickup(list));
    expect(found).toHaveLength(10);
    expect(found[0]).toEqual({ repo: "acme/web", default_branch: "main", path_hint: "web/", source: "service", service: "web" });
    expect(found[1]).toEqual({ repo: "acme/monorepo", source: "default" });
    expect(codeLocationsOf({})).toEqual([]);
    expect(codeLocationsOf(pickup("x"))).toEqual([]);
  });

  it("drops a branch name or a path hint that is not safe, and quotes the gh address", async () => {
    const found = codeLocationsOf(
      pickup([
        { repo: "acme/web", default_branch: "main;curl${IFS}x|sh", path_hint: "../../.ssh" },
        { repo: "acme/api", default_branch: "$(id)", path_hint: "/etc" },
        { repo: "acme/ok", default_branch: "release/1.2", path_hint: "web/src" },
      ]),
    );
    expect(found[0]).toEqual({ repo: "acme/web" });
    expect(found[1]).toEqual({ repo: "acme/api" });
    expect(found[2]).toEqual({ repo: "acme/ok", default_branch: "release/1.2", path_hint: "web/src" });
    const [block] = [codeLocationsBlock(await resolveCodeLocations(found, fake({}, true)))] as Array<{ locations: Array<{ how?: string }> }>;
    expect(block.locations[2]!.how).toContain("gh api 'repos/acme/ok/contents/<path>?ref=release/1.2'");
    expect(JSON.stringify(block)).not.toContain("curl");
  });

  it("tells the model never to cite the local folder", () => {
    const block = codeLocationsBlock([{ repo: "acme/web", read_with: "local_checkout", checkout_path: "/work/app" }]) as { rules: string[] };
    expect(block.rules.join(" ")).toContain("Never put a local folder");
  });

  it("matches a location to the working directory, then to a listed folder, then to gh, then to nothing", async () => {
    const deps = fake({ "/work/app": ["acme/web"], "/code": [], "/code/api": ["acme/api"] }, true, ["/code"]);
    const resolved = await resolveCodeLocations([{ repo: "Acme/Web" }, { repo: "acme/api" }, { repo: "acme/other" }], deps);
    expect(resolved.map((r) => [r.repo, r.read_with, r.checkout_path])).toEqual([
      ["Acme/Web", "local_checkout", "/work/app"],
      ["acme/api", "local_checkout", "/code/api"],
      ["acme/other", "gh", undefined],
    ]);
    const none = await resolveCodeLocations([{ repo: "acme/other" }], fake({}, false));
    expect(none[0]!.read_with).toBe("none");
  });

  it("says in the answer how each location is read and what to record when one cannot be", async () => {
    const resolved = await resolveCodeLocations([{ repo: "acme/web", path_hint: "web/" }, { repo: "acme/gone" }, { repo: "acme/viagh" }], fake({ "/work/app": ["acme/web"] }, false));
    const block = codeLocationsBlock(resolved) as { locations: Array<Record<string, unknown>>; not_readable: string[]; rules: string[]; untrusted_data: boolean };
    expect(block.untrusted_data).toBe(true);
    expect(block.not_readable).toEqual(["acme/gone", "acme/viagh"]);
    expect(block.locations[0]).toMatchObject({ read_with: "local_checkout", checkout_path: "/work/app", path_hint: "web/" });
    expect(String(block.locations[1]!.how)).toContain("not_connected");
    expect(block.rules.join(" ")).toContain("Read only");
  });

  it("adds nothing to an answer with no locations", async () => {
    const data = { request: {} };
    expect(await withCodeLocations(data, fake({}))).toBe(data);
  });

  it("is turned off by TELLAGEN_CODE_CHECKOUTS=off", () => {
    expect(codeProbeOff({ TELLAGEN_CODE_CHECKOUTS: "off" })).toBe(true);
    expect(codeProbeOff({ TELLAGEN_CODE_CHECKOUTS: "/code" })).toBe(false);
    expect(codeProbeOff({})).toBe(false);
  });

  it("is taught in the guide", () => {
    const section = guideSection(skill, "## How to fix it");
    for (const text of ["code_locations_v1", "mcp_code_locations", "local_checkout", "TELLAGEN_CODE_CHECKOUTS", "code_not_read", "Read only"]) {
      expect(section, text).toContain(text);
    }
  });
});

describe("the pickup with a real checkout", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let dir: string;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    dir = mkdtempSync(join(tmpdir(), "tellagen-code-"));
    const repo = join(dir, "web");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/web.git"]);
    vi.stubEnv("TELLAGEN_CODE_CHECKOUTS", dir);
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the source code, names the checkout and sends no path to Tellagen", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "code-run" }, request: { context: { code_locations: [{ repo: "acme/web", path_hint: "web/" }, { repo: "acme/missing" }] } }, server_capabilities: ["code_locations_v1"] }));
    const out = harness.json(await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "code-run", available_sources: [{ key: "grafana", state: "found" }] }));
    const sent = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(sent.available_sources).toEqual([{ key: "grafana", state: "found" }, { key: "code", state: "found", detail: "Local checkout" }]);
    expect(JSON.stringify(sent)).not.toContain(dir);
    expect(out.mcp_code_locations.locations[0]).toMatchObject({ repo: "acme/web", read_with: "local_checkout" });
    expect(String(out.mcp_code_locations.locations[0].checkout_path)).toContain("web");
    expect(["gh", "none"]).toContain(out.mcp_code_locations.locations[1].read_with);
  });

  it("probes git once for two pickups in the cache window, and stops at once when the probe is turned off", async () => {
    const harness = createToolHarness();
    const sent = async (id: string) => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id }, request: {} }));
      await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: id });
      return JSON.parse(String((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body)).available_sources;
    };
    expect(await sent("cache-1")).toEqual([{ key: "code", state: "found", detail: "Local checkout" }]);
    rmSync(join(dir, "web", ".git"), { recursive: true, force: true });
    expect(await sent("cache-2")).toEqual([{ key: "code", state: "found", detail: "Local checkout" }]);
    vi.stubEnv("TELLAGEN_CODE_CHECKOUTS", "off");
    expect(await sent("cache-3")).toBeUndefined();
  });

  it("keeps the code entry the model sent", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "code-run-2" }, request: {} }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "code-run-2", available_sources: [{ key: "code", state: "not_found" }] });
    const sent = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(sent.available_sources).toEqual([{ key: "code", state: "not_found" }]);
  });

  it("sends no code source when the probe is off", async () => {
    vi.stubEnv("TELLAGEN_CODE_CHECKOUTS", "off");
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "code-run-3" }, request: {} }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "code-run-3" });
    const sent = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(sent.available_sources).toBeUndefined();
  });
});
