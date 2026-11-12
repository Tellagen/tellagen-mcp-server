import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TellagenClient } from "../src/client.js";
import {
  cleanIdentityValue,
  identityFromClientInfo,
  legacyClientName,
  reportedClientName,
} from "../src/identity.js";
import { createServer } from "../src/server.js";
import { MCP_SERVER_VERSION } from "../src/version.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const sentHeaders = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>;
const sentBody = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

describe("the client identity from the handshake", () => {
  it("gives a known client its readable name and keeps the version", () => {
    expect(identityFromClientInfo({ name: "claude-code", version: "2.1.0" })).toEqual({ name: "claude-code", label: "Claude Code", version: "2.1.0" });
    expect(identityFromClientInfo({ name: "codex-mcp-client", version: "0.42.0" })).toEqual({ name: "codex", label: "Codex", version: "0.42.0" });
    expect(identityFromClientInfo({ name: "cursor-vscode", version: "1.0" })).toMatchObject({ name: "cursor", label: "Cursor" });
  });

  it("uses the title, then the name, of a client it does not know", () => {
    expect(identityFromClientInfo({ name: "zed", title: "Zed Editor", version: "0.9" })).toEqual({ name: "zed", label: "Zed Editor", version: "0.9" });
    expect(identityFromClientInfo({ name: "my-agent" })).toEqual({ name: "my-agent", label: "my-agent", version: "" });
    expect(identityFromClientInfo({ name: "n".repeat(200), version: "v".repeat(200) })).toMatchObject({ name: "n".repeat(64), version: "v".repeat(40) });
    expect(identityFromClientInfo({ name: "  " })).toBeUndefined();
    expect(identityFromClientInfo(undefined)).toBeUndefined();
  });

  it("cleans a name so it is safe in a header", () => {
    expect(cleanIdentityValue("Agent\r\nX-Evil: 1")).toBe("Agent X-Evil: 1");
    expect(cleanIdentityValue("naïve ✨ client")).toBe("na ve client");
    expect(cleanIdentityValue("x".repeat(500)).length).toBe(100);
    expect(cleanIdentityValue(42)).toBe("");
  });

  it("maps the name to codex or claude for an older Tellagen, and reads the deprecated setting last", () => {
    vi.stubEnv("TELLAGEN_MCP_CLIENT", "");
    const claude = identityFromClientInfo({ name: "claude-code", version: "2" });
    const cursor = identityFromClientInfo({ name: "cursor", version: "1" });
    expect(legacyClientName(claude)).toBe("claude");
    expect(legacyClientName(cursor)).toBe("codex");
    expect(legacyClientName(undefined)).toBe("codex");
    expect(reportedClientName(undefined)).toBe("mcp-client");
    vi.stubEnv("TELLAGEN_MCP_CLIENT", "claude");
    expect(legacyClientName(cursor)).toBe("claude");
    expect(reportedClientName(undefined)).toBe("claude");
    // The handshake name wins over the deprecated setting.
    expect(reportedClientName(cursor)).toBe("cursor");
    vi.stubEnv("TELLAGEN_MCP_CLIENT", "something-else");
    expect(legacyClientName(undefined)).toBe("codex");
    vi.unstubAllEnvs();
  });
});

describe("what Tellagen is told about the client", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("TELLAGEN_MCP_CLIENT", "");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  async function connected(clientInfo: { name: string; version: string }) {
    const api = new TellagenClient({ apiUrl: "https://test.api.tellagen.com", apiKey: "tllg_test" });
    const server = createServer(api);
    const mcp = new Client(clientInfo, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), mcp.connect(b)]);
    return { api, mcp, close: async () => { await mcp.close(); await server.close(); } };
  }

  it("sends the name, the version, the server version, the computer and the session on every call", async () => {
    const session = await connected({ name: "claude-code", version: "2.1.0" });
    try {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ incidents: [] }));
      await session.mcp.callTool({ name: "tellagen_list_incidents", arguments: {} });
      const headers = sentHeaders(fetchSpy.mock.calls[0]!);
      expect(headers["X-Tellagen-Client"]).toBe("claude-code");
      expect(headers["X-Tellagen-Client-Version"]).toBe("2.1.0");
      expect(headers["X-Tellagen-Server-Version"]).toBe(MCP_SERVER_VERSION);
      expect(headers["X-Tellagen-Client-Session"]).toBe(session.api.session.sessionId);
      if (session.api.session.computer) {
        expect(headers["X-Tellagen-Computer"]).toBe(session.api.session.computer);
      }
    } finally {
      await session.close();
    }
  });

  it("sends the client facts and the model at pickup with no environment variable set", async () => {
    const session = await connected({ name: "claude-code", version: "2.1.0" });
    try {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, incident: { id: 42 }, server_capabilities: [] }));
      const result = await session.mcp.callTool({
        name: "tellagen_pick_up_investigation",
        arguments: { investigation_run_id: "run-1", model: "Example Model 5" },
      });
      expect(result.isError).toBeFalsy();
      const body = sentBody(fetchSpy.mock.calls[0]!);
      expect(body.client).toMatchObject({
        name: "claude-code",
        version: "2.1.0",
        mcp_server_version: MCP_SERVER_VERSION,
        session_id: session.api.session.sessionId,
      });
      expect(body.model).toBe("Example Model 5");
    } finally {
      await session.close();
    }
  });

  // What the Tellagen that knows only codex and claude answers to another
  // client name: HTTP 500 with the generic message.
  const oldBackendFailure = () => jsonResponse({ code: "internal", message: "internal error" }, 500);
  const pickupText = (result: unknown) =>
    JSON.parse((result as { content: Array<{ text: string }> }).content.at(-1)!.text);

  it("sends the pickup again with the old short name when an older Tellagen fails on the client name", async () => {
    for (const [info, legacy] of [
      [{ name: "claude-code", version: "2.1.0" }, "claude"],
      [{ name: "cursor-vscode", version: "1.2.3" }, "codex"],
    ] as const) {
      const session = await connected(info);
      try {
        fetchSpy.mockReset();
        fetchSpy.mockResolvedValueOnce(oldBackendFailure()).mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, incident: { id: 42 } }));
        const result = await session.mcp.callTool({
          name: "tellagen_pick_up_investigation",
          arguments: { investigation_run_id: "run-1", model: "Example Model 5" },
        });
        expect(result.isError).toBeFalsy();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const first = sentBody(fetchSpy.mock.calls[0]!);
        const second = sentBody(fetchSpy.mock.calls[1]!);
        // Only the name changes: an older Tellagen ignores the other fields.
        expect(second).toEqual({ ...first, client: { ...first.client, name: legacy } });
        expect(pickupText(result).mcp_notice).toContain(`sent again with the name ${legacy}`);
        expect(session.api.session.activeRun()?.runId).toBe("run-1");
      } finally {
        await session.close();
      }
    }
  });

  it("does not repeat after a server error when the name is already codex or claude, or the error is a gateway error", async () => {
    const codex = await connected({ name: "codex-mcp-client", version: "0.42.0" });
    try {
      fetchSpy.mockResolvedValueOnce(oldBackendFailure());
      const result = await codex.mcp.callTool({ name: "tellagen_pick_up_investigation", arguments: { investigation_run_id: "run-1" } });
      expect(result.isError).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sentBody(fetchSpy.mock.calls[0]!).client.name).toBe("codex");
    } finally {
      await codex.close();
    }
  });

  it("returns the first error when the pickup with the old name fails too", async () => {
    const session = await connected({ name: "claude-code", version: "2.1.0" });
    try {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ code: "internal", message: "first failure" }, 500))
        .mockResolvedValueOnce(jsonResponse({ code: "not_found", message: "second failure" }, 404));
      const result = await session.mcp.callTool({ name: "tellagen_pick_up_investigation", arguments: { investigation_run_id: "run-1" } });
      expect(result.isError).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(pickupText(result)).toMatchObject({ status: 500, message: "first failure" });
      expect(session.api.session.activeRun()).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it("sends the old pickup body only when Tellagen names an unknown field, and says which fields were not sent", async () => {
    const session = await connected({ name: "claude-code", version: "2.1.0" });
    try {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ code: "unknown_field", message: "request body contains an unknown field", field: "model" }, 400))
        .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, incident: { id: 42 } }));
      const result = await session.mcp.callTool({
        name: "tellagen_pick_up_investigation",
        arguments: { investigation_run_id: "run-1", model: "Example Model 5", takeover: true },
      });
      expect(result.isError).toBeFalsy();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(sentBody(fetchSpy.mock.calls[1]!)).toEqual({
        client: { name: "claude", mcp_server_version: MCP_SERVER_VERSION },
        protocol_capabilities: sentBody(fetchSpy.mock.calls[0]!).protocol_capabilities,
      });
      const notice = pickupText(result).mcp_notice as string;
      expect(notice).toContain("these were not sent: client.version, client.computer, client.session_id, model, takeover");
      expect(notice).toContain("sent as claude");
    } finally {
      await session.close();
    }
  });

  it.each([
    [400, "bad_request", "cannot pick up a terminal investigation run"],
    [400, "invalid_request", "profile is not valid"],
    [404, "not_found", "investigation run not found"],
    [409, "client_upgrade_required", "Update your Tellagen server."],
    [503, "unavailable", "try later"],
  ])("keeps a real error (%d %s) and sends no second pickup in another shape", async (status, code, message) => {
    const session = await connected({ name: "claude-code", version: "2.1.0" });
    const { httpDefaults } = await import("../src/client.js");
    const saved = { retries: httpDefaults.retries };
    httpDefaults.retries = 0;
    try {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ code, message }, status));
      const result = await session.mcp.callTool({
        name: "tellagen_pick_up_investigation",
        arguments: { investigation_run_id: "run-1", takeover: true },
      });
      expect(result.isError).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(pickupText(result)).toMatchObject({ status, code, message });
    } finally {
      httpDefaults.retries = saved.retries;
      await session.close();
    }
  });

  it("keeps the old short name for a run that an earlier pickup froze for it", async () => {
    const session = await connected({ name: "claude-code", version: "2.1.0" });
    try {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ code: "pickup_client_context_mismatch", message: "the run was frozen for another client" }, 409))
        .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, incident: { id: 42 } }));
      const result = await session.mcp.callTool({
        name: "tellagen_pick_up_investigation",
        arguments: { investigation_run_id: "run-1" },
      });
      expect(result.isError).toBeFalsy();
      const retry = sentBody(fetchSpy.mock.calls[1]!);
      expect(retry.client.name).toBe("claude");
      // The other facts are still sent.
      expect(retry.client.version).toBe("2.1.0");
    } finally {
      await session.close();
    }
  });

  it("limits the model name", () => {
    const harness = createToolHarness();
    const schema = harness.getTool("tellagen_pick_up_investigation").config.inputSchema!.model as import("zod").ZodTypeAny;
    expect(schema.safeParse("x".repeat(101)).success).toBe(false);
    expect(schema.safeParse("  Example Model 5 ").data).toBe("Example Model 5");
  });
});
