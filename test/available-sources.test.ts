import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createToolHarness, jsonResponse } from "./helpers/harness.js";

describe("the client reports its data sources at pickup", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });
  const sentBody = () => JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));

  it("sends the report with the pickup and passes the ignored keys back", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ run: { id: "run-1" }, incident: { id: 42 }, server_capabilities: [], ignored_sources: ["docs"] }),
    );
    const sources = [
      { key: "grafana", state: "found", detail: "grafana.example.com" },
      { key: "kubernetes", state: "not_found" },
      { key: "docs", state: "found" },
    ];
    const result = await harness.callTool("tellagen_pick_up_investigation", {
      investigation_run_id: "run-1",
      available_sources: sources,
    });
    expect(result.isError).toBeUndefined();
    expect(sentBody().available_sources).toEqual(sources);
    expect(harness.json(result).ignored_sources).toEqual(["docs"]);
  });

  it("sends no report field when the model gave none, so the last report stays", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    expect(sentBody()).not.toHaveProperty("available_sources");
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1", available_sources: [] });
    expect(sentBody()).not.toHaveProperty("available_sources");
  });

  it("accepts only catalog keys, the two states and a short detail", () => {
    const harness = createToolHarness();
    const schema = harness.getTool("tellagen_pick_up_investigation").config.inputSchema!.available_sources as z.ZodTypeAny;
    for (const key of ["grafana", "kubernetes", "github", "docs", "local_host"]) {
      expect(schema.safeParse([{ key, state: "found" }]).success, key).toBe(true);
    }
    expect(schema.safeParse([{ key: "made_up", state: "found" }]).success).toBe(false);
    expect(schema.safeParse([{ key: "grafana", state: "maybe" }]).success).toBe(false);
    expect(schema.safeParse([{ key: "grafana", state: "found", detail: "x".repeat(201) }]).success).toBe(false);
    expect(schema.safeParse([{ key: "grafana", state: "found", token: "secret" }]).success).toBe(false);
    expect(schema.safeParse(Array.from({ length: 21 }, () => ({ key: "grafana", state: "found" }))).success).toBe(false);
  });

  it("tells the model to map its MCP servers and shell tools to the catalog keys", () => {
    const harness = createToolHarness();
    const description = String((harness.getTool("tellagen_pick_up_investigation").config as { description?: string }).description);
    expect(description).toContain("available_sources");
    expect(description).toContain("MCP servers and shell tools");
    for (const key of ["grafana", "kubernetes", "github", "docs", "local_host"]) expect(description).toContain(key);
  });

  it("drops the report for an older Tellagen that refuses the field, and the pickup still works", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ code: "unknown_field", message: "request body contains an unknown field", field: "available_sources" }, 400))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    const result = await harness.callTool("tellagen_pick_up_investigation", {
      investigation_run_id: "run-1",
      available_sources: [{ key: "grafana", state: "found" }],
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body))).not.toHaveProperty("available_sources");
    // The model is told that the report was not sent.
    expect(harness.json(result).mcp_notice).toContain("available_sources");
  });

  it("keeps the tool check flow: a diag ID is refused as a run and points to the report tool", async () => {
    const harness = createToolHarness();
    const result = await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "diag_abc123" });
    expect(result.isError).toBe(true);
    expect(harness.json(result).next_tool).toBe("tellagen_report_diagnostic_tools");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
