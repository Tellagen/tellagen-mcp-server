import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { httpDefaults, TellagenClient } from "../src/client.js";
import { readConfig } from "../src/config.js";
import { startTellagenServer } from "../src/start.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const KEY = "tllg_secret_value_123";
const URL = "https://test.api.tellagen.com";

async function connect(config: { apiKey: string; apiUrl: string }) {
  const api = new TellagenClient(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "claude-code", version: "2.1.0" }, { capabilities: {} });
  const server = await startTellagenServer(api, serverTransport, { toolsets: "all" });
  await mcp.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await mcp.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { isError: result.isError === true, text: result.content.map((c) => c.text).join("\n"), json: () => JSON.parse(result.content.at(-1)!.text) };
  };
  return { api, mcp, call, close: async () => { await mcp.close(); await server.close(); } };
}

describe("the server with no key, a refused key or a paused seat", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const recheck = httpDefaults.authRecheckMs;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    httpDefaults.authRecheckMs = recheck;
  });

  it("starts with no key, lists its tools, and every tool call answers with the setup steps", async () => {
    const session = await connect({ apiKey: "", apiUrl: "" });
    try {
      expect((await session.mcp.listTools()).tools.length).toBeGreaterThan(40);
      expect(session.api.auth()).toBe("missing");
      for (const [name, args] of [
        ["tellagen_list_incidents", {}],
        ["tellagen_pick_up_investigation", { investigation_run_id: "run-1" }],
        ["tellagen_build_source_link", { kind: "commit", repo: "acme/api", sha: "abc1234" }],
      ] as const) {
        const result = await session.call(name, args);
        expect(result.isError, name).toBe(true);
        const body = result.json();
        expect(body.code, name).toBe("tellagen_not_set_up");
        expect(body.message).toContain("TELLAGEN_API_KEY and TELLAGEN_API_URL are not set");
        expect(body.setup_steps.join(" ")).toContain("Settings > API Keys");
        expect(body.setup_steps.join(" ")).toContain("TELLAGEN_API_KEY");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("names only the setting that is missing", async () => {
    const session = await connect({ apiKey: KEY, apiUrl: "" });
    try {
      const body = (await session.call("tellagen_list_incidents")).json();
      expect(body.message).toContain("TELLAGEN_API_URL is not set");
      expect(body.message).not.toContain("TELLAGEN_API_KEY and");
      expect(JSON.stringify(body)).not.toContain(KEY);
    } finally {
      await session.close();
    }
  });

  // The auth route answers 200 with no user for a key Tellagen does not
  // accept. Every other route answers 401.
  const anonymous = () => jsonResponse({ user: null, company: null });
  const refusing = async (url: unknown) =>
    String(url).endsWith("/api/v1/auth/me")
      ? anonymous()
      : jsonResponse({ code: "authentication_required", message: "authentication required" }, 401);

  it("tests the key once at the start and reports a wrong key on every tool call, with the fix", async () => {
    fetchSpy.mockImplementation(refusing);
    const session = await connect({ apiKey: KEY, apiUrl: URL });
    try {
      await vi.waitFor(() => expect(session.api.auth()).toBe("rejected"));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]![0])).toBe(`${URL}/api/v1/auth/me`);
      // The check runs after the handshake, so it already names the client.
      expect(((fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>)["X-Tellagen-Client"]).toBe("claude-code");
      // Tools are still listed.
      expect((await session.mcp.listTools()).tools.length).toBeGreaterThan(40);

      for (const name of ["tellagen_list_incidents", "tellagen_list_services"]) {
        const result = await session.call(name);
        expect(result.isError).toBe(true);
        const body = result.json();
        expect(body.status).toBe(401);
        expect(body.code).toBe("api_key_refused");
        expect(body.message).toContain("refused the API key");
        expect(body.message).toContain("wrong, was revoked or has expired");
        expect(body.setup_steps.join(" ")).toContain("create a new key");
        expect(result.text).not.toContain(KEY);
      }
      // A key known to be refused is not sent again with each call.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  });

  it("accepts the key at the start only when the auth route returns a user", async () => {
    const client = new TellagenClient({ apiKey: KEY, apiUrl: URL });
    for (const body of [{ user: null }, {}, { user: "x" }]) {
      fetchSpy.mockResolvedValueOnce(jsonResponse(body));
      expect(await client.checkAuth(), JSON.stringify(body)).toBe("rejected");
    }
    fetchSpy.mockResolvedValueOnce(jsonResponse({ user: { id: 7, email: "dev@example.com" } }));
    expect(await client.checkAuth()).toBe("ok");
  });

  it("keeps the refusal when the later check still finds no user", async () => {
    httpDefaults.authRecheckMs = 0;
    fetchSpy.mockImplementation(refusing);
    const harness = createToolHarness(URL, { apiKey: KEY });
    await harness.client.checkAuth();
    const result = await harness.callTool("tellagen_list_incidents", {});
    expect(result.isError).toBe(true);
    expect(harness.json(result).code).toBe("api_key_refused");
    // Only the auth route was asked: the refused key reached no other route.
    expect(fetchSpy.mock.calls.every((call) => String(call[0]).endsWith("/api/v1/auth/me"))).toBe(true);
    expect(harness.client.auth()).toBe("rejected");
  });

  it("says that an expired key has expired", async () => {
    const harness = createToolHarness(URL, { apiKey: KEY });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ code: "api_key_expired", message: "expired" }, 401));
    const body = harness.json(await harness.callTool("tellagen_list_incidents", {}));
    expect(body.code).toBe("api_key_expired");
    expect(body.message).toContain("it has expired");
    expect(body.setup_steps.join(" ")).toContain("TELLAGEN_API_KEY");
  });

  it("explains a paused seat and who can fix it, in both error shapes", async () => {
    for (const body of [
      { code: "seat_access_suspended", message: "This responder seat is paused because the workspace is over its Free plan limit." },
      { error: { code: "seat_access_suspended", message: "This responder seat is paused because the workspace is over its Free plan limit." } },
    ]) {
      const harness = createToolHarness(URL, { apiKey: KEY });
      fetchSpy.mockResolvedValueOnce(jsonResponse(body, 403));
      const answer = harness.json(await harness.callTool("tellagen_list_incidents", {}));
      expect(answer.code).toBe("seat_access_suspended");
      expect(answer.message).toContain("seat in this workspace is paused");
      expect(answer.setup_steps[0]).toContain("workspace admin");
      expect(harness.client.auth()).toBe("rejected");
    }
  });

  it("gives the clear message for a 401 that arrives in the middle of a session, and recovers when the key works again", async () => {
    const harness = createToolHarness(URL, { apiKey: KEY });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ incidents: [] }));
    expect((await harness.callTool("tellagen_list_incidents", {})).isError).toBeUndefined();
    expect(harness.client.auth()).toBe("ok");

    fetchSpy.mockResolvedValueOnce(jsonResponse({ code: "authentication_required", message: "authentication required" }, 401));
    const refused = await harness.callTool("tellagen_list_incidents", {});
    expect(refused.isError).toBe(true);
    expect(harness.json(refused).message).toContain("refused the API key");
    expect(harness.json(refused).setup_steps).toHaveLength(4);
    expect(harness.client.auth()).toBe("rejected");
    expect(refused.content[0].text).not.toContain(KEY);

    // The next call does not reach Tellagen while the refusal is fresh.
    const calls = fetchSpy.mock.calls.length;
    const again = await harness.callTool("tellagen_get_incident", { incident_id: 1 });
    expect(harness.json(again).status).toBe(401);
    expect(fetchSpy.mock.calls.length).toBe(calls);

    // After a while the key is asked about again; a yes clears the refusal.
    httpDefaults.authRecheckMs = 0;
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ user: { id: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ incident: { id: 1 } }));
    const ok = await harness.callTool("tellagen_get_incident", { incident_id: 1 });
    expect(ok.isError).toBeUndefined();
    expect(harness.client.auth()).toBe("ok");
  });

  it("leaves the answer open when the start check cannot reach Tellagen, and lets tools report their own error", async () => {
    fetchSpy.mockRejectedValue(new Error("network unavailable"));
    const client = new TellagenClient({ apiKey: KEY, apiUrl: URL });
    expect(await client.checkAuth()).toBe("unknown");
    expect(await client.accessProblem()).toBeUndefined();
  });

  it("never serialises the key", () => {
    const client = new TellagenClient({ apiKey: KEY, apiUrl: URL });
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(Object.values(client).join(" ")).not.toContain(KEY);
  });
});

describe("the settings a person can make", () => {
  it("reads the key, the address, the toolsets and the state folder without failing on a missing key", () => {
    const config = readConfig({}, []);
    expect(config.apiKey).toBe("");
    expect(config.apiUrl).toBe("");
    expect(config.toolsets).toEqual(["diagnosis", "incidents"]);
    expect(config.stateDir).toMatch(/\.tellagen[\\/]state$/);
    expect(config.warnings).toEqual([]);
  });

  it("takes toolsets from the variable and lets the argument win", () => {
    expect(readConfig({ TELLAGEN_TOOLSETS: "diagnosis, timeline" }, []).toolsets).toEqual(["diagnosis", "timeline"]);
    expect(readConfig({ TELLAGEN_TOOLSETS: "diagnosis" }, ["--toolsets", "all"]).toolsets).toBe("all");
    expect(readConfig({}, ["--toolsets=postmortem"]).toolsets).toEqual(["postmortem"]);
  });

  it("keeps the default toolsets and warns when a toolset name is unknown", () => {
    const config = readConfig({ TELLAGEN_TOOLSETS: "diagnosis,everything" }, []);
    expect(config.toolsets).toEqual(["diagnosis", "incidents"]);
    expect(config.warnings[0]).toContain('Unknown toolset "everything"');
    expect(config.warnings[0]).toContain("diagnosis, incidents, timeline, postmortem, settings");
  });
});
