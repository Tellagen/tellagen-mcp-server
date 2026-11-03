import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";
import { updateCauseInputShape } from "../src/tools/causes.js";

const CAUSE_URL = "https://test.api.tellagen.com/api/v1/investigation-runs/run-1/causes/deploy-4412";
const withCapability = () =>
  jsonResponse({ run: { id: "run-1" }, server_capabilities: ["diagnosis_structure_v1"] });
const withoutCapability = () => jsonResponse({ run: { id: "run-1" } });

const causeRow = {
  investigation_run_id: "run-1",
  key: "deploy-4412",
  label: "Deploy 4412",
  state: "leading",
  rationale: "",
  evidence_for: 2,
  evidence_against: 0,
  finding_ids: [11],
  sources: [],
  sort_order: 0,
};

describe("tellagen_update_cause (CORE-782)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.restoreAllMocks());

  const causeCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).includes("/causes/"));

  it("PUTs the cause to the run and returns the backend row", async () => {
    fetchSpy.mockImplementation(async (url) =>
      String(url).includes("/context") ? withCapability() : jsonResponse({ cause: causeRow }),
    );
    const h = createToolHarness();
    const result = await h.callTool("tellagen_update_cause", {
      investigation_run_id: "run-1",
      cause_key: "deploy-4412",
      label: "Deploy 4412",
      state: "leading",
      evidence_for: 2,
      finding_ids: [11],
    });
    expect(result.isError).toBeUndefined();
    expect(h.json(result).cause).toEqual(causeRow);
    const [url, init] = causeCalls()[0];
    expect(String(url)).toBe(CAUSE_URL);
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      label: "Deploy 4412",
      state: "leading",
      evidence_for: 2,
      finding_ids: [11],
    });
  });

  it("a partial update sends only the given fields, and [] is kept to clear a list", async () => {
    fetchSpy.mockImplementation(async (url) =>
      String(url).includes("/context") ? withCapability() : jsonResponse({ cause: causeRow }),
    );
    const h = createToolHarness();
    await h.callTool("tellagen_update_cause", {
      investigation_run_id: "run-1",
      cause_key: "deploy-4412",
      state: "ruled_out",
      rationale: "Rolled back, errors stayed",
      sources: [],
    });
    const body = JSON.parse(String((causeCalls()[0][1] as RequestInit).body));
    expect(body).toEqual({ state: "ruled_out", rationale: "Rolled back, errors stayed", sources: [] });
    expect("label" in body).toBe(false);
  });

  it("passes a backend validation error through", async () => {
    fetchSpy.mockImplementation(async (url) =>
      String(url).includes("/context")
        ? withCapability()
        : jsonResponse({ code: "validation_failed", message: "finding 99 is not part of this run" }, 400),
    );
    const h = createToolHarness();
    const result = await h.callTool("tellagen_update_cause", {
      investigation_run_id: "run-1",
      cause_key: "deploy-4412",
      label: "Deploy 4412",
      finding_ids: [99],
    });
    expect(result.isError).toBe(true);
    const out = h.json(result);
    expect(out.status).toBe(400);
    expect(out.code).toBe("validation_failed");
    expect(out.message).toContain("finding 99");
  });

  it("sends nothing and says so when the backend lacks diagnosis_structure_v1", async () => {
    fetchSpy.mockImplementation(async () => withoutCapability());
    const h = createToolHarness();
    const result = await h.callTool("tellagen_update_cause", {
      investigation_run_id: "run-1",
      cause_key: "deploy-4412",
      label: "Deploy 4412",
    });
    expect(result.isError).toBeUndefined();
    const out = h.json(result);
    expect(out.sent).toBe(false);
    expect(out.mcp_notice).toContain("does not support live causes");
    expect(out.mcp_notice).toContain("nothing was sent");
    expect(causeCalls()).toHaveLength(0);
  });

  it("uses the capability remembered from pickup without another lookup", async () => {
    fetchSpy.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/pickup")) return withCapability();
      return jsonResponse({ cause: causeRow });
    });
    const h = createToolHarness();
    await h.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    await h.callTool("tellagen_update_cause", {
      investigation_run_id: "run-1",
      cause_key: "deploy-4412",
      label: "Deploy 4412",
    });
    expect(causeCalls()).toHaveLength(1);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).endsWith("/context"))).toBe(false);
  });

  describe("input schema", () => {
    const schema = z.object(updateCauseInputShape).strict();
    const base = { investigation_run_id: "run-1", cause_key: "deploy-4412", label: "Deploy 4412" };
    const ok = (extra: Record<string, unknown>) => schema.safeParse({ ...base, ...extra }).success;

    it("accepts a valid call", () => {
      expect(ok({ state: "ruled_out", rationale: "x", finding_ids: [1, 2], sources: ["grafana"], evidence_for: 0 })).toBe(true);
    });
    it("rejects a bad state", () => {
      expect(ok({ state: "confirmed" })).toBe(false);
    });
    it("rejects oversized and malformed values", () => {
      expect(ok({ finding_ids: Array.from({ length: 21 }, (_, i) => i + 1) })).toBe(false);
      expect(ok({ finding_ids: [0] })).toBe(false);
      expect(ok({ sources: Array(9).fill("a") })).toBe(false);
      expect(ok({ sources: ["x".repeat(61)] })).toBe(false);
      expect(ok({ label: "x".repeat(161) })).toBe(false);
      expect(ok({ rationale: "x".repeat(1001) })).toBe(false);
      expect(ok({ evidence_for: 1000 })).toBe(false);
      expect(ok({ evidence_against: -1 })).toBe(false);
      expect(ok({ cause_key: "has space" })).toBe(false);
      expect(ok({ cause_key: "k".repeat(65) })).toBe(false);
      expect(ok({ unknown_field: 1 })).toBe(false);
    });
  });
});
