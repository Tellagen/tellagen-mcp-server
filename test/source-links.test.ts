import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGrafanaExploreLink,
  classifySource,
  kubectlCommandFromK8sUrl,
  sanitizeSourceUrl,
} from "../src/source-links.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";
import vectors from "./fixtures/sourceLinkVectors.json" with { type: "json" };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("shared source link vectors (same cases as the web resolver)", () => {
  it.each(vectors.explore)("builds the Explore link: $name", (vector) => {
    expect(buildGrafanaExploreLink(vector.input as never)).toBe(vector.url);
  });

  it.each(vectors.exploreRejected)("refuses an Explore link: $name", (vector) => {
    expect(buildGrafanaExploreLink(vector.input as never)).toBeNull();
  });

  it.each(vectors.classify)(
    "classifies source $source as $family",
    ({ source, family, key, viaGrafana }) => {
      const result = classifySource(source);
      expect(result.family).toBe(family);
      expect(result.key).toBe(key);
      expect(result.viaGrafana).toBe(viaGrafana);
    },
  );

  it.each(vectors.sanitizeUrl)("sanitizes $input", ({ input, output }) => {
    expect(sanitizeSourceUrl(input)?.url ?? null).toBe(output);
  });

  it.each(vectors.kubectl)("maps $input to a command", ({ input, command }) => {
    expect(kubectlCommandFromK8sUrl(input)).toBe(command);
  });

  // When the app repo is checked out next to this one, the vendored copy must
  // be the app's file. Set TELLAGEN_APP_REPO to point at it.
  const appVectors = join(
    process.env.TELLAGEN_APP_REPO ?? join(root, "..", "tellagen"),
    "web",
    "lib",
    "investigation",
    "sourceLinkVectors.json",
  );
  it.skipIf(!existsSync(appVectors))(
    "matches the app repo's vectors file byte for byte",
    () => {
      expect(readFileSync(join(root, "test", "fixtures", "sourceLinkVectors.json"), "utf8")).toBe(
        readFileSync(appVectors, "utf8"),
      );
    },
  );
});

describe("tellagen_build_source_link", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("GRAFANA_URL", "");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  const grafanaConnector = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    name: "Grafana prod",
    type: "grafana",
    enabled: true,
    metadata: { base_url: "https://grafana.example.com/" },
    ...overrides,
  });

  it("builds an Explore link from GRAFANA_URL without calling anything", async () => {
    vi.stubEnv("GRAFANA_URL", "https://grafana.example.com");
    const harness = createToolHarness();
    const result = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      datasource: "prom-uid-1",
      query: "up",
      from: "now-6h",
      to: "now",
    });
    expect(result.isError).toBeUndefined();
    const body = harness.json(result);
    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({ kind: "explore" });
    expect(body.links[0].label.length).toBeLessThanOrEqual(60);
    // Same string the shared builder produces; orgId stays out when unknown.
    expect(body.links[0].url).toBe(
      buildGrafanaExploreLink({
        baseUrl: "https://grafana.example.com",
        datasource: "prom-uid-1",
        query: "up",
        from: "now-6h",
        to: "now",
        orgId: null,
      }),
    );
    expect(body.links[0].url).toContain("/explore?left=");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reproduces the shared Explore vectors through the tool", async () => {
    const harness = createToolHarness();
    for (const vector of vectors.explore) {
      const input = vector.input as {
        baseUrl: string;
        datasource?: string;
        query: string;
        from?: string;
        to?: string;
        orgId?: number | null;
      };
      // The tool leaves the org out unless given, so only vectors with
      // orgId null or a number map onto it.
      if (input.orgId === undefined) continue;
      vi.stubEnv("GRAFANA_URL", input.baseUrl);
      const result = await harness.callTool("tellagen_build_source_link", {
        kind: "explore",
        datasource: input.datasource,
        query: input.query,
        from: input.from,
        to: input.to,
        ...(typeof input.orgId === "number" ? { org_id: input.orgId } : {}),
      });
      expect(harness.json(result).links[0].url, vector.name).toBe(vector.url);
    }
  });

  it("reads the Grafana base_url and the incident window from Tellagen", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ datasources: [grafanaConnector()] }))
      .mockResolvedValueOnce(
        jsonResponse({
          request: {
            context: {
              time_range: {
                from: "2026-06-18T08:40:00Z",
                to: "2026-06-18T10:20:00Z",
              },
            },
          },
        }),
      );
    const harness = createToolHarness();
    const result = await harness.callTool("tellagen_build_source_link", {
      kind: "logs",
      datasource: "loki-uid-2",
      query: '{app="api"} |= "timeout"',
      investigation_run_id: "run-1",
    });
    const link = harness.json(result).links[0];
    expect(link.kind).toBe("logs");
    expect(link.url).toContain("https://grafana.example.com/explore?left=");
    expect(decodeURIComponent(link.url)).toContain('"from":"1781772000000"');
    expect(decodeURIComponent(link.url)).toContain('"to":"1781778000000"');
    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://test.api.tellagen.com/api/v1/datasources",
      "https://test.api.tellagen.com/api/v1/investigations/run-1/context",
    ]);
  });

  it("lets GRAFANA_URL win over the Tellagen datasource", async () => {
    vi.stubEnv("GRAFANA_URL", "https://local-grafana.example.org/g");
    const harness = createToolHarness();
    const result = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      query: "up",
    });
    expect(harness.json(result).links[0].url).toMatch(
      /^https:\/\/local-grafana\.example\.org\/g\/explore\?left=/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("explains a missing Grafana datasource and lists what exists", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ datasources: [{ name: "GitHub", type: "github", enabled: true }] }),
    );
    const harness = createToolHarness();
    const result = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      query: "up",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No enabled Grafana datasource");
    expect(result.content[0].text).toContain("GitHub");
    expect(result.content[0].text).toContain("GRAFANA_URL");
  });

  it("explains a datasource without a readable base_url", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ datasources: [grafanaConnector({ metadata: {} })] }),
    );
    const harness = createToolHarness();
    const result = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      query: "up",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no usable base_url");
    expect(result.content[0].text).toContain("GRAFANA_URL");
  });

  it("asks for connector when several Grafana datasources exist, and picks by name", async () => {
    const list = {
      datasources: [
        grafanaConnector(),
        grafanaConnector({
          id: 2,
          name: "Grafana eu",
          metadata: { base_url: "https://eu.grafana.example.com" },
        }),
      ],
    };
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(list)));
    const harness = createToolHarness();
    const ambiguous = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      query: "up",
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain("Grafana prod, Grafana eu");

    const picked = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      query: "up",
      connector: "Grafana eu",
    });
    expect(harness.json(picked).links[0].url).toContain("https://eu.grafana.example.com/explore");
  });

  it("builds a panel link and validates the dashboard uid", async () => {
    vi.stubEnv("GRAFANA_URL", "https://grafana.example.com");
    const harness = createToolHarness();
    const ok = await harness.callTool("tellagen_build_source_link", {
      kind: "panel",
      dashboard_uid: "abc_123",
      panel_id: 4,
      from: "2026-06-18T08:40:00Z",
      to: "now",
    });
    expect(harness.json(ok).links[0]).toEqual({
      kind: "panel",
      label: "Panel 4 in Grafana",
      url: "https://grafana.example.com/d/abc_123?viewPanel=4&from=1781772000000&to=now",
    });
    const hostile = await harness.callTool("tellagen_build_source_link", {
      kind: "panel",
      dashboard_uid: 'abc"><script>',
    });
    expect(hostile.isError).toBe(true);
  });

  it("builds a Tempo trace link and requires the data source", async () => {
    vi.stubEnv("GRAFANA_URL", "https://grafana.example.com");
    const harness = createToolHarness();
    const ok = await harness.callTool("tellagen_build_source_link", {
      kind: "trace",
      datasource: "tempo-uid",
      query: "4bf92f3577b34da6a3ce929d0e0e4736",
    });
    const url = harness.json(ok).links[0].url as string;
    const pane = JSON.parse(decodeURIComponent(url.split("left=")[1]));
    expect(pane.queries).toEqual([
      { refId: "A", queryType: "traceql", query: "4bf92f3577b34da6a3ce929d0e0e4736" },
    ]);
    expect(pane.datasource).toBe("tempo-uid");
    const missing = await harness.callTool("tellagen_build_source_link", {
      kind: "trace",
      query: "4bf92f3577b34da6a3ce929d0e0e4736",
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("datasource");
  });

  it("builds GitHub commit, pull request and compare links", async () => {
    const harness = createToolHarness();
    const commit = await harness.callTool("tellagen_build_source_link", {
      kind: "commit",
      repo: "acme/checkout",
      sha: "ABCDEF1234567",
    });
    expect(harness.json(commit).links[0]).toEqual({
      kind: "commit",
      label: "Commit ABCDEF1 on GitHub",
      url: "https://github.com/acme/checkout/commit/abcdef1234567",
    });
    const pr = await harness.callTool("tellagen_build_source_link", {
      kind: "pr",
      repo: "acme/checkout",
      pr_number: 4412,
    });
    expect(harness.json(pr).links[0].url).toBe("https://github.com/acme/checkout/pull/4412");
    const diff = await harness.callTool("tellagen_build_source_link", {
      kind: "diff",
      repo: "acme/checkout",
      base: "v1.4.0",
      head: "release/1.5 hotfix".replace(" ", "-"),
    });
    expect(harness.json(diff).links[0].url).toBe(
      "https://github.com/acme/checkout/compare/v1.4.0...release/1.5-hotfix",
    );
    const enterprise = await harness.callTool("tellagen_build_source_link", {
      kind: "pr",
      repo: "acme/checkout",
      pr_number: 7,
      github_url: "https://git.example.com/gh/",
    });
    expect(harness.json(enterprise).links[0].url).toBe(
      "https://git.example.com/gh/acme/checkout/pull/7",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a kubectl command, never a link, for Kubernetes", async () => {
    const harness = createToolHarness();
    const fromUrl = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      source: "kubernetes-logs",
      k8s_url: "k8s://context/prod/namespace/checkout/deployments/api",
    });
    expect(harness.json(fromUrl)).toMatchObject({
      links: [],
      command: "kubectl --context prod -n checkout get deployments api",
    });
    const fromQuery = await harness.callTool("tellagen_build_source_link", {
      kind: "logs",
      source: "kubectl",
      query: "kubectl -n checkout logs deploy/api --since=1h",
    });
    expect(harness.json(fromQuery).command).toBe("kubectl -n checkout logs deploy/api --since=1h");
    const unknown = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      source: "k8s",
      k8s_url: "k8s://context/prod/namespace/checkout/secrets/db",
    });
    const body = harness.json(unknown);
    expect(body.links).toEqual([]);
    expect(body.command).toBeUndefined();
    expect(body.guidance).toContain("kubectl");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns guidance for sources without a browser link", async () => {
    const harness = createToolHarness();
    for (const source of ["postgres", "codebase", "intercom"]) {
      const result = await harness.callTool("tellagen_build_source_link", {
        kind: "explore",
        source,
        query: "select 1",
      });
      const body = harness.json(result);
      expect(body.links, source).toEqual([]);
      expect(body.guidance, source).toContain("command");
    }
  });

  it("rejects hostile input", async () => {
    const harness = createToolHarness();
    vi.stubEnv("GRAFANA_URL", "javascript:alert(1)");
    const badEnv = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      query: "up",
    });
    expect(badEnv.isError).toBe(true);

    vi.stubEnv("GRAFANA_URL", "https://me:secret@grafana.example.com:3000/grafana");
    const stripped = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      query: "up",
    });
    const url = harness.json(stripped).links[0].url as string;
    expect(url).not.toContain("secret");
    expect(url).not.toContain("me:");
    expect(url.startsWith("https://grafana.example.com:3000/grafana/explore?")).toBe(true);

    vi.stubEnv("GRAFANA_URL", "https://grafana.demo.invalid");
    const example = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      query: "up",
    });
    expect(example.isError).toBe(true);

    for (const input of [
      { kind: "commit", repo: "acme checkout", sha: "abcdef1" },
      { kind: "commit", repo: "../etc/passwd", sha: "abcdef1" },
      { kind: "commit", repo: "acme/checkout", sha: "not-hex!" },
      { kind: "pr", repo: "acme/checkout", pr_number: 0 },
      { kind: "diff", repo: "acme/checkout", base: "a b", head: "main" },
      { kind: "diff", repo: "acme/checkout", base: "a..b", head: "main" },
      { kind: "pr", repo: "acme/checkout", pr_number: 1, github_url: "javascript:alert(1)" },
    ]) {
      const result = await harness.callTool("tellagen_build_source_link", input);
      expect(result.isError, JSON.stringify(input)).toBe(true);
    }

    vi.stubEnv("GRAFANA_URL", "https://grafana.example.com");
    const quoted = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      query: `up{job="a b"} ' " javascript:alert(1)`,
    });
    const quotedUrl = harness.json(quoted).links[0].url as string;
    expect(quotedUrl.startsWith("https://grafana.example.com/explore?")).toBe(true);
    expect(quotedUrl).not.toMatch(/[\s"]/);
    const blank = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      query: "   ",
    });
    expect(blank.isError).toBe(true);
  });

  it("reports a Tellagen API failure as an error", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ code: "forbidden", message: "no access" }, 403),
    );
    const harness = createToolHarness();
    const result = await harness.callTool("tellagen_build_source_link", {
      kind: "explore",
      query: "up",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("403");
  });
});
