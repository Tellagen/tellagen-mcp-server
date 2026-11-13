import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chooseGithubBase, chooseGrafanaBase, cleanSourceBases, sourceBasesOf } from "../src/source-bases.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const API = "https://acme.api.tellagen.com";
const PICKUP_GRAFANA = "https://grafana.pickup.example.com";
const ENV_GRAFANA = "https://grafana.env.example.com";
const DATASOURCE_GRAFANA = "https://grafana.datasource.example.com";

const bases = (extra: unknown[] = []) => [
  { kind: "grafana", name: "Grafana prod", base_url: PICKUP_GRAFANA },
  ...extra,
];

const pickupAnswer = (source_bases?: unknown) =>
  jsonResponse({
    run: { id: "run-1", status: "running" },
    incident: { id: 42 },
    request: { skills: [] },
    server_capabilities: ["diagnosis_structure_v1"],
    ...(source_bases === undefined ? {} : { source_bases }),
  });

const datasources = () =>
  jsonResponse({
    datasources: [
      {
        id: 1,
        name: "Grafana prod",
        type: "grafana",
        enabled: true,
        metadata: { base_url: DATASOURCE_GRAFANA },
      },
    ],
  });

const explore = { kind: "explore", datasource: "prom-uid-1", query: "up", from: "now-6h", to: "now" };

describe("cleanSourceBases", () => {
  it("keeps Grafana and GitHub addresses and removes credentials, query and fragment", () => {
    expect(
      cleanSourceBases([
        { kind: "grafana", name: "Grafana prod", base_url: "https://me:secret@grafana.example.com/g/?token=abc#x", network: "private" },
        { kind: "github", name: "GitHub", base_url: "https://github.com", repositories: ["acme/checkout", 7, ""] },
      ]),
    ).toEqual([
      { kind: "grafana", name: "Grafana prod", base_url: "https://grafana.example.com/g", network: "private" },
      { kind: "github", name: "GitHub", base_url: "https://github.com", repositories: ["acme/checkout"] },
    ]);
  });

  it.each([
    ["a script address", "javascript:alert(1)"],
    ["a file address", "file:///etc/passwd"],
    ["an ftp address", "ftp://grafana.example.com"],
    ["a reserved example address", "https://grafana.demo.invalid"],
    ["not an address", "grafana"],
    ["a number", 5],
  ])("drops %s", (_label, base_url) => {
    expect(cleanSourceBases([{ kind: "grafana", name: "G", base_url }])).toEqual([]);
  });

  it("drops an unknown kind, an entry with no name, and anything that is not a list", () => {
    expect(
      cleanSourceBases([
        { kind: "pagerduty", name: "PD", base_url: "https://pd.example.com" },
        { kind: "grafana", name: "  ", base_url: "https://grafana.example.com" },
        "text",
        null,
      ]),
    ).toEqual([]);
    expect(cleanSourceBases(undefined)).toEqual([]);
    expect(cleanSourceBases({ kind: "grafana" })).toEqual([]);
    expect(sourceBasesOf("text")).toEqual([]);
    expect(sourceBasesOf({})).toEqual([]);
  });

  it("keeps at most 10 addresses", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ kind: "grafana", name: `G${i}`, base_url: `https://g${i}.example.com` }));
    expect(cleanSourceBases(many)).toHaveLength(10);
  });
});

describe("choosing an address", () => {
  const g = (name: string) => ({ kind: "grafana" as const, name, base_url: `https://${name}.example.com` });
  const gh = (name: string, repositories?: string[]) => ({
    kind: "github" as const,
    name,
    base_url: `https://${name}.example.com`,
    ...(repositories ? { repositories } : {}),
  });

  it("takes the only Grafana, the named one, and says when several are ambiguous", () => {
    expect(chooseGrafanaBase([g("a")]).base?.name).toBe("a");
    expect(chooseGrafanaBase([g("a"), g("b")], "b").base?.name).toBe("b");
    expect(chooseGrafanaBase([g("a"), g("b")])).toEqual({ ambiguous: ["a", "b"] });
    expect(chooseGrafanaBase([g("a")], "other")).toEqual({});
    expect(chooseGrafanaBase([gh("x")])).toEqual({});
  });

  it("takes the GitHub address that lists the repository, or the only one that lists none", () => {
    expect(chooseGithubBase([gh("one", ["acme/a"]), gh("two", ["Acme/B"])], "acme/b")?.name).toBe("two");
    expect(chooseGithubBase([gh("one")], "acme/a")?.name).toBe("one");
    expect(chooseGithubBase([gh("one", ["acme/a"])], "acme/z")).toBeUndefined();
    expect(chooseGithubBase([gh("one"), gh("two")], "acme/a")).toBeUndefined();
    expect(chooseGithubBase([g("a")], "acme/a")).toBeUndefined();
  });
});

describe("source addresses of a run", () => {
  let dir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const file = () => join(dir, "state", "acme.api.tellagen.com.json");
  const harnessFor = () => createToolHarness(API, { apiKey: "tllg_secret", stateDir: join(dir, "state") });
  const urlsCalled = () =>
    fetchSpy.mock.calls.map((call) => `${(call[1] as RequestInit).method} ${String(call[0]).replace(API, "")}`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tellagen-bases-"));
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("GRAFANA_URL", "");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function pickUp(harness: ReturnType<typeof harnessFor>, source_bases?: unknown) {
    fetchSpy.mockResolvedValueOnce(pickupAnswer(source_bases));
    const result = await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    expect(result.isError).toBeUndefined();
    fetchSpy.mockClear();
  }

  it("builds an Explore link from the pickup address with no GRAFANA_URL and no other request", async () => {
    const harness = harnessFor();
    await pickUp(harness, bases());
    const result = await harness.callTool("tellagen_build_source_link", explore);
    expect(result.isError).toBeUndefined();
    const url = harness.json(result).links[0].url as string;
    expect(url.startsWith(`${PICKUP_GRAFANA}/explore?`)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the pickup address first, GRAFANA_URL second and the datasource last", async () => {
    vi.stubEnv("GRAFANA_URL", ENV_GRAFANA);
    const withPickup = harnessFor();
    await pickUp(withPickup, bases());
    const first = await withPickup.callTool("tellagen_build_source_link", explore);
    expect(withPickup.json(first).links[0].url).toContain(PICKUP_GRAFANA);

    // No pickup address: the explicit override.
    const withoutPickup = harnessFor();
    await pickUp(withoutPickup);
    const second = await withoutPickup.callTool("tellagen_build_source_link", explore);
    expect(withoutPickup.json(second).links[0].url).toContain(ENV_GRAFANA);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Neither: the address of the Tellagen datasource.
    vi.stubEnv("GRAFANA_URL", "");
    fetchSpy.mockResolvedValueOnce(datasources());
    const third = await withoutPickup.callTool("tellagen_build_source_link", explore);
    expect(withoutPickup.json(third).links[0].url).toContain(DATASOURCE_GRAFANA);
    expect(urlsCalled()).toEqual(["GET /api/v1/datasources"]);
  });

  it("works as before with a Tellagen that sends no source_bases", async () => {
    const harness = harnessFor();
    await pickUp(harness);
    // The old answer has no field: the datasource is read, as in the earlier version.
    fetchSpy.mockResolvedValueOnce(datasources());
    const result = await harness.callTool("tellagen_build_source_link", explore);
    expect(harness.json(result).links[0].url).toContain(DATASOURCE_GRAFANA);
    expect(urlsCalled()).toEqual(["GET /api/v1/datasources"]);
    // The state file has no addresses.
    expect(JSON.parse(readFileSync(file(), "utf8"))).not.toHaveProperty("source_bases");
  });

  it("ignores a pickup address that is not http or https and falls back", async () => {
    vi.stubEnv("GRAFANA_URL", ENV_GRAFANA);
    const harness = harnessFor();
    await pickUp(harness, [
      { kind: "grafana", name: "Grafana prod", base_url: "javascript:alert(1)" },
      { kind: "grafana", name: "Other", base_url: "file:///etc" },
    ]);
    const result = await harness.callTool("tellagen_build_source_link", explore);
    expect(harness.json(result).links[0].url).toContain(ENV_GRAFANA);
    expect(JSON.parse(readFileSync(file(), "utf8"))).not.toHaveProperty("source_bases");

    // With no override either, no link is built from a bad address.
    vi.stubEnv("GRAFANA_URL", "");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ datasources: [] }));
    const none = await harness.callTool("tellagen_build_source_link", explore);
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain("No enabled Grafana datasource");
  });

  it("does not use an invalid GRAFANA_URL when the pickup has an address", async () => {
    vi.stubEnv("GRAFANA_URL", "javascript:alert(1)");
    const harness = harnessFor();
    await pickUp(harness, bases());
    const result = await harness.callTool("tellagen_build_source_link", explore);
    expect(result.isError).toBeUndefined();
    expect(harness.json(result).links[0].url).toContain(PICKUP_GRAFANA);
  });

  it("asks for a connector when the pickup lists several Grafana addresses, and uses the name it gets", async () => {
    const harness = harnessFor();
    await pickUp(harness, [
      { kind: "grafana", name: "Grafana prod", base_url: PICKUP_GRAFANA },
      { kind: "grafana", name: "Grafana eu", base_url: "https://grafana.eu.example.com" },
    ]);
    const named = await harness.callTool("tellagen_build_source_link", { ...explore, connector: "Grafana eu" });
    expect(harness.json(named).links[0].url).toContain("https://grafana.eu.example.com");

    // No name: the pickup cannot choose, so the datasource list decides and reports the ambiguity.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        datasources: [
          { name: "Grafana prod", type: "grafana", enabled: true, metadata: { base_url: DATASOURCE_GRAFANA } },
          { name: "Grafana eu", type: "grafana", enabled: true, metadata: { base_url: DATASOURCE_GRAFANA } },
        ],
      }),
    );
    const ambiguous = await harness.callTool("tellagen_build_source_link", explore);
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain("Pass connector");
  });

  it("keeps a copyable command and never makes a link for Kubernetes with an address present", async () => {
    const harness = harnessFor();
    await pickUp(harness, bases());
    const result = await harness.callTool("tellagen_build_source_link", {
      kind: "logs",
      source: "kubernetes",
      query: "kubectl -n checkout logs deploy/api",
    });
    const body = harness.json(result);
    expect(body.links).toEqual([]);
    expect(body.command).toBe("kubectl -n checkout logs deploy/api");
  });

  it("uses the GitHub address of the pickup for a repository it lists, and lets github_url win", async () => {
    const harness = harnessFor();
    await pickUp(harness, [
      { kind: "github", name: "GitHub Enterprise", base_url: "https://git.example.com", repositories: ["acme/checkout"] },
    ]);
    const listed = await harness.callTool("tellagen_build_source_link", { kind: "commit", repo: "acme/checkout", sha: "abc1234" });
    expect(harness.json(listed).links[0].url).toBe("https://git.example.com/acme/checkout/commit/abc1234");
    const other = await harness.callTool("tellagen_build_source_link", { kind: "commit", repo: "acme/other", sha: "abc1234" });
    expect(harness.json(other).links[0].url).toBe("https://github.com/acme/other/commit/abc1234");
    const explicit = await harness.callTool("tellagen_build_source_link", {
      kind: "commit",
      repo: "acme/checkout",
      sha: "abc1234",
      github_url: "https://ghe.example.org",
    });
    expect(harness.json(explicit).links[0].url).toBe("https://ghe.example.org/acme/checkout/commit/abc1234");
  });

  it("writes the addresses to the state file and keeps no secret there", async () => {
    const harness = harnessFor();
    await pickUp(harness, bases());
    const raw = readFileSync(file(), "utf8");
    expect(JSON.parse(raw).source_bases).toEqual([{ kind: "grafana", name: "Grafana prod", base_url: PICKUP_GRAFANA }]);
    expect(raw).not.toContain("tllg_secret");
  });

  it("a new process uses the remembered addresses for the run, before and after resume", async () => {
    const first = harnessFor();
    await pickUp(first, bases());
    // The first process is gone.
    const state = JSON.parse(readFileSync(file(), "utf8"));
    writeFileSync(file(), JSON.stringify({ ...state, pid: 2 ** 22 + 12345 }));

    // A new process that has not resumed yet, asked about the run by its id.
    const second = harnessFor();
    const early = await second.callTool("tellagen_build_source_link", { ...explore, investigation_run_id: "run-1" });
    expect(second.json(early).links[0].url).toContain(PICKUP_GRAFANA);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Resume: the run is picked up again; the answer carries a changed list.
    const changed = [{ kind: "grafana", name: "Grafana prod", base_url: "https://grafana.moved.example.com" }];
    fetchSpy
      .mockResolvedValueOnce(pickupAnswer(changed)) // context read
      .mockResolvedValueOnce(pickupAnswer(changed)) // pickup
      .mockResolvedValueOnce(jsonResponse({ steps: [] }))
      .mockResolvedValueOnce(jsonResponse({ findings: [] }));
    const resumed = await second.callTool("tellagen_resume", {});
    expect(second.json(resumed).resumed).toBe(true);
    fetchSpy.mockClear();
    expect(JSON.parse(readFileSync(file(), "utf8")).source_bases).toEqual(changed);
    const later = await second.callTool("tellagen_build_source_link", explore);
    expect(second.json(later).links[0].url).toContain("https://grafana.moved.example.com");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("learns the addresses of a context read", async () => {
    const harness = harnessFor();
    await pickUp(harness);
    fetchSpy.mockResolvedValueOnce(pickupAnswer(bases()));
    await harness.callTool("tellagen_get_incident_context", {});
    fetchSpy.mockClear();
    const result = await harness.callTool("tellagen_build_source_link", explore);
    expect(harness.json(result).links[0].url).toContain(PICKUP_GRAFANA);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file(), "utf8")).source_bases).toHaveLength(1);

    // The workspace removed the connector: the next read empties the list.
    fetchSpy.mockResolvedValueOnce(pickupAnswer());
    await harness.callTool("tellagen_get_incident_context", {});
    expect(JSON.parse(readFileSync(file(), "utf8"))).not.toHaveProperty("source_bases");
  });

  it("does not write the state file when a context read changes nothing", async () => {
    const harness = harnessFor();
    await pickUp(harness, bases());
    // Compact JSON: any write by the server would format it again.
    const state = JSON.parse(readFileSync(file(), "utf8"));
    const compact = JSON.stringify(state);
    writeFileSync(file(), compact);
    fetchSpy.mockResolvedValueOnce(pickupAnswer(bases()));
    await harness.callTool("tellagen_get_incident_context", {});
    expect(readFileSync(file(), "utf8")).toBe(compact);

    // With an older Tellagen (no field before, none after) there is no write either.
    const old = harnessFor();
    fetchSpy.mockClear();
    await pickUp(old);
    const before = readFileSync(file(), "utf8");
    fetchSpy.mockResolvedValueOnce(pickupAnswer());
    await old.callTool("tellagen_get_incident_context", {});
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("cleans the addresses it reads from the state file again", async () => {
    const harness = harnessFor();
    await pickUp(harness, bases());
    const state = JSON.parse(readFileSync(file(), "utf8"));
    writeFileSync(
      file(),
      JSON.stringify({
        ...state,
        source_bases: [
          { kind: "grafana", name: "bad", base_url: "javascript:alert(1)" },
          { kind: "grafana", name: "creds", base_url: "https://me:pw@grafana.file.example.com/g?token=abc" },
        ],
      }),
    );
    const fresh = harnessFor();
    expect(fresh.client.session.sourceBasesFor("run-1")).toEqual([
      { kind: "grafana", name: "creds", base_url: "https://grafana.file.example.com/g" },
    ]);
  });

  it("forgets the addresses when the run ends", async () => {
    const harness = harnessFor();
    await pickUp(harness, bases());
    expect(harness.client.session.sourceBasesFor("run-1")).toHaveLength(1);
    harness.client.session.clearActiveRun("run-1");
    expect(harness.client.session.sourceBasesFor("run-1")).toBeUndefined();
  });

  it("does not use the addresses of another run", async () => {
    const harness = harnessFor();
    await pickUp(harness, bases());
    fetchSpy.mockResolvedValueOnce(datasources());
    const result = await harness.callTool("tellagen_build_source_link", { ...explore, investigation_run_id: "run-other" });
    expect(harness.json(result).links[0].url).toContain(DATASOURCE_GRAFANA);
  });

  describe("tellagen_probe_datasource", () => {
    const grafana = {
      id: 7,
      name: "Grafana prod",
      type: "grafana",
      enabled: true,
      config: {
        base_url: DATASOURCE_GRAFANA,
        required_env_vars: ["GRAFANA_URL", "GRAFANA_SERVICE_ACCOUNT_TOKEN"],
      },
    };
    const TOKEN = "glsa_secret";
    const healthCalls = () =>
      fetchSpy.mock.calls
        .filter((call) => String(call[0]).endsWith("/api/health"))
        .map((call) => ({ url: String(call[0]), headers: ((call[1] as RequestInit).headers ?? {}) as Record<string, string> }));

    async function probe(harness: ReturnType<typeof harnessFor>, datasource: unknown = grafana) {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ datasources: [datasource] }))
        .mockResolvedValueOnce(jsonResponse({ database: "ok" }));
      return harness.json(await harness.callTool("tellagen_probe_datasource", { name: "Grafana prod" }));
    }

    it("names where each address came from, calls GRAFANA_URL with the token and still lists the pickup address", async () => {
      vi.stubEnv("GRAFANA_URL", ENV_GRAFANA);
      vi.stubEnv("GRAFANA_SERVICE_ACCOUNT_TOKEN", TOKEN);
      const harness = harnessFor();
      await pickUp(harness, bases());
      const body = await probe(harness);
      expect(body.ok).toBe(true);
      expect(body.addresses).toEqual([
        { source: "pickup", url: PICKUP_GRAFANA, used: false, token_sent: false },
        { source: "GRAFANA_URL", url: ENV_GRAFANA, used: true, token_sent: true },
        { source: "datasource", url: DATASOURCE_GRAFANA, used: false, token_sent: false },
      ]);
      expect(healthCalls()).toEqual([
        { url: `${ENV_GRAFANA}/api/health`, headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }) },
      ]);
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    });

    it("never sends the token to the pickup address: it calls /api/health with no Authorization header and says so", async () => {
      vi.stubEnv("GRAFANA_SERVICE_ACCOUNT_TOKEN", TOKEN);
      const harness = harnessFor();
      await pickUp(harness, bases());
      const body = await probe(harness);
      expect(body.ok).toBe(true);
      expect(body.missing_env_vars).toEqual([]);
      expect(body.addresses).toEqual([
        { source: "pickup", url: PICKUP_GRAFANA, used: true, token_sent: false },
        { source: "datasource", url: DATASOURCE_GRAFANA, used: false, token_sent: false },
      ]);
      const calls = healthCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${PICKUP_GRAFANA}/api/health`);
      expect(calls[0]!.headers).not.toHaveProperty("Authorization");
      expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain(TOKEN);
      expect(body.checks.find((check: any) => check.name === "grafana_health").message).toContain("No token was sent");
      expect(body.recommended_action).toContain("GRAFANA_URL");
    });

    it("never sends the token to the datasource address", async () => {
      vi.stubEnv("GRAFANA_SERVICE_ACCOUNT_TOKEN", TOKEN);
      // GRAFANA_URL is not needed by this datasource's own list of variables.
      const noUrlVar = { ...grafana, config: { ...grafana.config, required_env_vars: ["GRAFANA_SERVICE_ACCOUNT_TOKEN"] } };
      const harness = harnessFor();
      await pickUp(harness);
      const body = await probe(harness, noUrlVar);
      expect(body.addresses).toEqual([{ source: "datasource", url: DATASOURCE_GRAFANA, used: true, token_sent: false }]);
      const calls = healthCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${DATASOURCE_GRAFANA}/api/health`);
      expect(calls[0]!.headers).not.toHaveProperty("Authorization");
      expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain(TOKEN);
    });

    it("reports a GRAFANA_URL that is not http or https and calls nothing with the token", async () => {
      vi.stubEnv("GRAFANA_URL", "file:///etc/passwd");
      vi.stubEnv("GRAFANA_SERVICE_ACCOUNT_TOKEN", TOKEN);
      for (const withPickup of [false, true]) {
        const harness = harnessFor();
        await pickUp(harness, withPickup ? bases() : undefined);
        fetchSpy.mockResolvedValueOnce(jsonResponse({ datasources: [grafana] }));
        const body = harness.json(await harness.callTool("tellagen_probe_datasource", { name: "Grafana prod" }));
        expect(body.ok).toBe(false);
        expect(body.checks).toContainEqual(expect.objectContaining({ name: "grafana_url", status: "error" }));
        expect(body.checks[body.checks.length - 1].message).toContain("GRAFANA_URL is not an http or https address");
        expect(body.addresses.some((address: any) => address.source === "GRAFANA_URL")).toBe(false);
        expect(healthCalls()).toEqual([]);
        expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain(TOKEN);
        fetchSpy.mockClear();
      }
    });

    it("does not ask for GRAFANA_URL when the pickup has an address", async () => {
      vi.stubEnv("GRAFANA_SERVICE_ACCOUNT_TOKEN", TOKEN);
      const harness = harnessFor();
      await pickUp(harness, bases());
      const body = await probe(harness);
      expect(body.missing_env_vars).toEqual([]);
    });

    it("still reports a missing GRAFANA_URL when nothing came from the pickup, as before", async () => {
      const harness = harnessFor();
      await pickUp(harness);
      fetchSpy.mockResolvedValueOnce(jsonResponse({ datasources: [grafana] }));
      const body = harness.json(await harness.callTool("tellagen_probe_datasource", { datasource_id: 7 }));
      expect(body.ok).toBe(false);
      expect(body.missing_env_vars).toEqual(["GRAFANA_URL", "GRAFANA_SERVICE_ACCOUNT_TOKEN"]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
