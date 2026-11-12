import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatError, fieldErrorHint, TellagenAPIError } from "../src/errors.js";
import { protocolCapabilities } from "../src/version.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const guidance = { origin: "agent_judgment", refs: [], reason: "checking the deploy" };
const NEW = ["diagnosis_structure_v1", "recorded_steps_v1", "client_heartbeat_v1", "completion_repairs_v1"];
const pickupAnswer = (capabilities: string[]) => jsonResponse({ run: { id: "run-1" }, request: {}, server_capabilities: capabilities });

const repair = (code: string, field: string) => ({ code, field, missing: `${field} is missing`, example: "an example" });
const threeFaults = {
  dry_run: true,
  ready: false,
  repairs: [
    repair("diagnosis_structure_required", "result_summary.causal_paths"),
    repair("runbook_check_missing", "check-error-rate"),
    repair("mitigation_verification_missing", "mitigation_state"),
  ],
  warnings: [{ code: "headline_too_long", message: "x", path: "result_summary.conclusion.summary" }],
  coverage: { complete: false },
};

describe("completion with a dry run first", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());
  const body = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));
  const patches = () => fetchSpy.mock.calls.filter((call) => (call[1] as RequestInit).method === "PATCH");

  async function pickedUp(capabilities: string[]) {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(pickupAnswer(capabilities));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    fetchSpy.mockClear();
    return harness;
  }

  it("returns all three faults in one answer, and completes nothing", async () => {
    const harness = await pickedUp(NEW);
    fetchSpy.mockResolvedValueOnce(jsonResponse(threeFaults));
    const result = await harness.callTool("tellagen_complete_investigation", { status: "completed" });
    expect(result.isError).toBeUndefined();
    const answer = harness.lastJson(result);
    expect(answer.completed).toBe(false);
    expect(answer.repairs).toHaveLength(3);
    expect(answer.repairs[0]).toMatchObject({ code: "diagnosis_structure_required", field: "result_summary.causal_paths", example: "an example" });
    expect(answer.warnings).toHaveLength(1);
    expect(answer.coverage).toEqual({ complete: false });
    expect(answer.message).toContain("call this tool again");
    expect(patches()).toHaveLength(1);
    expect(body(0)).toEqual({ status: "completed", dry_run: true });
    // The run stays open: the model repairs it and calls again.
    expect(harness.client.session.activeRun()?.runId).toBe("run-1");
  });

  it("completes with the second call after one repair: a clean dry run, then the real completion", async () => {
    const harness = await pickedUp(NEW);
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ dry_run: true, ready: false, repairs: [repair("runbook_check_missing", "check-error-rate")], warnings: [] }))
      .mockResolvedValueOnce(jsonResponse({ dry_run: true, ready: true, repairs: [], warnings: [] }))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1", status: "completed" }, warnings: [] }));
    const first = await harness.callTool("tellagen_complete_investigation", { status: "completed" });
    expect(harness.lastJson(first).completed).toBe(false);
    const second = await harness.callTool("tellagen_complete_investigation", { status: "completed" });
    expect(harness.lastJson(second).run.status).toBe("completed");
    expect(patches()).toHaveLength(3);
    expect(body(1).dry_run).toBe(true);
    expect(body(2)).toEqual({ status: "completed" });
    expect(harness.client.session.activeRun()).toBeUndefined();
  });

  it("does not ask for a dry run from a Tellagen that does not list the capability", async () => {
    const harness = await pickedUp(["diagnosis_structure_v1"]);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1", status: "completed" } }));
    await harness.callTool("tellagen_complete_investigation", { status: "completed" });
    expect(patches()).toHaveLength(1);
    expect(body(0)).toEqual({ status: "completed" });
  });

  it("does not ask for a dry run from a Tellagen that lists recorded steps but not completion_repairs_v1", async () => {
    const harness = await pickedUp(["diagnosis_structure_v1", "recorded_steps_v1"]);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1", status: "completed" } }));
    await harness.callTool("tellagen_complete_investigation", { status: "completed" });
    expect(patches()).toHaveLength(1);
    expect(body(0)).toEqual({ status: "completed" });
  });

  it("does not ask for a dry run on a run it never picked up (nothing looked up)", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-9", status: "completed" } }));
    await harness.callTool("tellagen_complete_investigation", { run_id: "run-9", status: "completed" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body(0)).toEqual({ status: "completed" });
  });

  it("takes the answer as the completion when a Tellagen ignored the dry run", async () => {
    const harness = await pickedUp(NEW);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1", status: "completed" }, warnings: [] }));
    const result = await harness.callTool("tellagen_complete_investigation", { status: "completed" });
    expect(harness.lastJson(result).run.status).toBe("completed");
    expect(patches()).toHaveLength(1);
    expect(harness.client.session.activeRun()).toBeUndefined();
  });

  it("shows the repairs of a blocked completion beside the coverage", async () => {
    const harness = await pickedUp(NEW);
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ dry_run: true, ready: true, repairs: [], warnings: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          { code: "investigation_completion_blocked", message: "blocked", coverage: { missing: ["c1"] }, repairs: [repair("coverage_incomplete", "c1")] },
          422,
        ),
      );
    const result = await harness.callTool("tellagen_complete_investigation", { status: "completed" });
    expect(result.isError).toBe(true);
    const answer = harness.json(result);
    expect(answer.code).toBe("investigation_completion_blocked");
    expect(answer.repairs[0].code).toBe("coverage_incomplete");
    expect(answer.coverage).toEqual({ missing: ["c1"] });
  });

  it("drops the separate list of the pickup answer for a Tellagen with repairs, and keeps it for an older one", async () => {
    const withRepairs = createToolHarness();
    fetchSpy.mockResolvedValueOnce(pickupAnswer(NEW));
    expect(withRepairs.json(await withRepairs.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" }))).not.toHaveProperty("mcp_before_complete");
    const older = createToolHarness();
    fetchSpy.mockResolvedValueOnce(pickupAnswer(["diagnosis_structure_v1"]));
    expect(older.json(await older.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-2" }))).toHaveProperty("mcp_before_complete");
  });
});

describe("the guidance basis of a trace step", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());
  const sent = () => JSON.parse(String((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body));
  const step = { step_id: "s1", status: "done", title: "Check the error rate" };

  async function pickedUp(capabilities: string[]) {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(pickupAnswer(capabilities));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ steps: [{}] }));
    return harness;
  }

  it("leaves the basis out for a Tellagen that has a default", async () => {
    const harness = await pickedUp(NEW);
    const result = await harness.callTool("tellagen_post_trace_step", step);
    expect(result.isError).toBeUndefined();
    expect(sent()).not.toHaveProperty("guidance");
  });

  it("sends the same default itself to an older Tellagen, and to a run it did not pick up", async () => {
    const older = await pickedUp(["diagnosis_structure_v1"]);
    await older.callTool("tellagen_post_trace_step", step);
    expect(sent().guidance).toEqual({ origin: "agent_judgment", refs: [], reason: "Check the error rate" });
    const fresh = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ steps: [{}] }));
    await fresh.callTool("tellagen_post_trace_step", { ...step, investigation_run_id: "run-7" });
    expect(sent().guidance.origin).toBe("agent_judgment");
  });

  it("passes the basis the model gives, to every Tellagen", async () => {
    const harness = await pickedUp(NEW);
    await harness.callTool("tellagen_post_trace_step", { ...step, guidance });
    expect(sent().guidance).toEqual(guidance);
  });
});

describe("errors that name the field", () => {
  it("tells the model which field to correct, and says no value back", () => {
    const err = new TellagenAPIError(400, "invalid_field_type", "result_summary.causal_paths[0].steps[1].finding_ids: expected an array, got a string", {
      field: "result_summary.causal_paths[0].steps[1].finding_ids",
      request_id: "r1",
    });
    const out = JSON.parse(formatError(err));
    expect(out.field).toBe("result_summary.causal_paths[0].steps[1].finding_ids");
    expect(out.hint).toContain('Correct the field "result_summary.causal_paths[0].steps[1].finding_ids"');
    expect(out.message).toContain("expected an array");
    expect(out.error).toBe(true);
  });

  it("lists the unknown fields, at most 20, with no control characters", () => {
    const fields = Array.from({ length: 30 }, (_v, i) => `extra_${i}`);
    fields[0] = "bad\nfield";
    const err = new TellagenAPIError(400, "unknown_field", "unknown field", { field: "extra_0", details: { fields } });
    const hint = fieldErrorHint(err)!;
    expect(hint).toContain('"bad field"');
    expect(hint).toContain('"extra_19"');
    expect(hint).not.toContain("extra_20");
    expect(hint).not.toContain("\n");
  });

  it("adds no hint to other errors", () => {
    expect(fieldErrorHint(new TellagenAPIError(400, "bad_request", "x", { field: "a" }))).toBeUndefined();
    expect(JSON.parse(formatError(new TellagenAPIError(500, "internal", "x"))).hint).toBeUndefined();
  });

  it("reaches the model through a tool call, from the flat error body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ code: "unknown_field", message: "unknown fields", field: "colour", details: { fields: ["colour", "shape"] }, request_id: "r2" }, 400),
    );
    try {
      const harness = createToolHarness();
      const result = await harness.callTool("tellagen_post_trace_step", { step_id: "s1", status: "done", title: "t", investigation_run_id: "run-1" });
      expect(result.isError).toBe(true);
      const out = harness.json(result);
      expect(out.code).toBe("unknown_field");
      expect(out.field).toBe("colour");
      expect(out.details.fields).toEqual(["colour", "shape"]);
      expect(out.hint).toContain('"colour", "shape"');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("strict fields", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("advertises strict_fields_v1 and guidance_default_v1 at pickup", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(pickupAnswer(NEW));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const sent = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(sent.protocol_capabilities).toEqual(expect.arrayContaining(["strict_fields_v1", "guidance_default_v1"]));
  });

  it("sends the capability in a header when it starts a run, because no run is picked up yet", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-9" } }));
    await harness.callTool("tellagen_start_investigation", { incident_id: 12 });
    const headers = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("x-tellagen-capabilities")).toBe("strict_fields_v1");
  });

  it("is off when TELLAGEN_STRICT_FIELDS is 0", async () => {
    vi.stubEnv("TELLAGEN_STRICT_FIELDS", "0");
    expect(protocolCapabilities()).not.toContain("strict_fields_v1");
    expect(protocolCapabilities()).toContain("guidance_default_v1");
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-9" } }));
    await harness.callTool("tellagen_start_investigation", { incident_id: 12 });
    expect(new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers).get("x-tellagen-capabilities")).toBeNull();
  });
});
