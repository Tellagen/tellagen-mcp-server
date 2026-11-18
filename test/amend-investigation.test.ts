import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_AMEND_FINDINGS, amendRetries } from "../src/tools/amendments.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const API = "https://acme.api.tellagen.com";
const AMEND = `${API}/api/v1/investigation-runs/run-1/amendments`;
const until = new Date(Date.now() + 3 * 3_600_000).toISOString();

const finding = {
  finding_type: "evidence",
  claim: "The Slack thread says the deploy was rolled back at 14:09.",
  evidence_summary: "Read after the connector was fixed.",
  confidence: 0.8,
  confidence_reason: "A person wrote it in the incident thread.",
};

describe("tellagen_amend_investigation", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const amendCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/amendments"));
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
    amendRetries.delayMs = 1;
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    amendRetries.delayMs = 1000;
  });

  const pickedUp = async (capabilities: string[] = ["run_amendments_v1", "diagnosis_structure_v1"]) => {
    const harness = createToolHarness(API);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, incident: { id: 42 }, server_capabilities: capabilities }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    // As after a completion: the run is finished, and the session remembers it.
    harness.client.session.rememberAmendable("run-1");
    return harness;
  };
  const answer = { run: { id: "run-1", version: 2, amend_until: until }, amendment: { version: 2 }, findings: [], warnings: [] };

  it("posts the addition with an Idempotency-Key and keeps the run for a later call", async () => {
    const harness = await pickedUp();
    fetchSpy.mockResolvedValueOnce(jsonResponse(answer));
    const result = await harness.callTool("tellagen_amend_investigation", {
      reason: "Read the Slack thread after the token was fixed.",
      findings: [finding],
      coverage: [{ source: "Slack", state: "checked" }],
    });
    expect(result.isError).toBeUndefined();
    const [url, init] = amendCalls()[0]!;
    expect(String(url)).toBe(AMEND);
    expect((init as RequestInit).method).toBe("POST");
    expect(((init as RequestInit).headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^mcp-amend-[0-9a-f]{48}$/);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.reason).toBe("Read the Slack thread after the token was fixed.");
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].evidence_refs).toEqual([]);
    expect(body.coverage).toEqual([{ source: "Slack", state: "checked" }]);
    expect(body.result_summary).toBeUndefined();
    expect(harness.json(result).amendment.version).toBe(2);
    expect(harness.client.session.latestAmendable()?.runId).toBe("run-1");
  });

  it("sends the same key for the same call, and another key for another call", async () => {
    const harness = await pickedUp();
    fetchSpy.mockResolvedValue(jsonResponse(answer));
    const input = { reason: "Same", findings: [finding] };
    await harness.callTool("tellagen_amend_investigation", input);
    await harness.callTool("tellagen_amend_investigation", input);
    await harness.callTool("tellagen_amend_investigation", { ...input, reason: "Other" });
    const keys = amendCalls().map(([, init]) => ((init as RequestInit).headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("sends a conflict again with the same key", async () => {
    const harness = await pickedUp();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ code: "run_amendment_conflict", message: "Another amendment is being written." }, 409))
      .mockResolvedValueOnce(jsonResponse({ code: "run_amendment_conflict", message: "Another amendment is being written." }, 409))
      .mockResolvedValueOnce(jsonResponse(answer));
    const result = await harness.callTool("tellagen_amend_investigation", { reason: "Add", findings: [finding] });
    expect(result.isError).toBeUndefined();
    const calls = amendCalls();
    expect(calls).toHaveLength(3);
    const keys = new Set(calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>)["Idempotency-Key"]));
    expect(keys.size).toBe(1);
  });

  it("gives up after the attempts and shows the conflict", async () => {
    const harness = await pickedUp();
    fetchSpy.mockImplementation(async (url) =>
      String(url).endsWith("/amendments") ? jsonResponse({ code: "run_amendment_conflict", message: "Another amendment is being written." }, 409) : jsonResponse({}),
    );
    const result = await harness.callTool("tellagen_amend_investigation", { reason: "Add" });
    expect(result.isError).toBe(true);
    expect(harness.json(result).code).toBe("run_amendment_conflict");
    expect(amendCalls()).toHaveLength(amendRetries.attempts);
  });

  it("does not repeat another refusal, and forgets a run that takes no more additions", async () => {
    const harness = await pickedUp();
    harness.client.session.rememberAmendable("run-1", until);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ code: "run_not_amendable", message: "The window closed.", details: { reason: "window_closed" } }, 409),
    );
    const result = await harness.callTool("tellagen_amend_investigation", { investigation_run_id: "run-1", reason: "Late" });
    expect(result.isError).toBe(true);
    expect(amendCalls()).toHaveLength(1);
    expect(harness.client.session.amendableUntil("run-1")).toBeUndefined();
  });

  it("refuses on a Tellagen without run_amendments_v1 and sends nothing", async () => {
    const harness = await pickedUp(["diagnosis_structure_v1"]);
    const result = await harness.callTool("tellagen_amend_investigation", { reason: "More", findings: [finding] });
    expect(result.isError).toBe(true);
    const body = harness.json(result);
    expect(body.code).toBe("amendments_not_supported");
    expect(body.message).toContain("too old");
    expect(amendCalls()).toHaveLength(0);
  });

  it("needs a run: none remembered and none given is a clear error", async () => {
    const harness = createToolHarness(API);
    const result = await harness.callTool("tellagen_amend_investigation", { reason: "More" });
    expect(result.isError).toBe(true);
    expect(amendCalls()).toHaveLength(0);
  });

  it("sends an amendment with a result_summary, adapted to the server, and says what was left out", async () => {
    const harness = await pickedUp(["run_amendments_v1"]);
    fetchSpy.mockResolvedValueOnce(jsonResponse(answer));
    const summary = { ...completeSummary([{ source: "Slack", state: "checked" }]), ruled_out: [{ label: "Pool", explanation: "Fine." }] };
    const result = await harness.callTool("tellagen_amend_investigation", { reason: "New headline", result_summary: summary });
    const body = JSON.parse(String((amendCalls()[0]![1] as RequestInit).body));
    expect(body.result_summary.conclusion.sentence).toBe(summary.conclusion.sentence);
    expect(body.result_summary.ruled_out).toBeUndefined();
    expect(harness.json(result).mcp_notice).toContain("diagnosis_structure_v1");
  });

  it("sends a proposed cause on the finding that carries it", async () => {
    const harness = await pickedUp();
    fetchSpy.mockResolvedValueOnce(jsonResponse(answer));
    await harness.callTool("tellagen_amend_investigation", { reason: "Cause", findings: [{ ...finding, potential_root_cause: true, root_cause_status: "proposed" }] });
    const body = JSON.parse(String((amendCalls()[0]![1] as RequestInit).body));
    expect(body.findings[0]).toMatchObject({ potential_root_cause: true, root_cause_status: "proposed" });
  });

  it("sends a 400 once", async () => {
    const harness = await pickedUp();
    fetchSpy.mockImplementation(async (url) =>
      String(url).endsWith("/amendments") ? jsonResponse({ code: "validation", message: "Bad." }, 400) : jsonResponse({}),
    );
    const result = await harness.callTool("tellagen_amend_investigation", { reason: "Add" });
    expect(result.isError).toBe(true);
    expect(amendCalls()).toHaveLength(1);
  });

  it("takes at most 10 findings", async () => {
    const harness = await pickedUp();
    const schema = z.object(harness.getTool("tellagen_amend_investigation").config.inputSchema as Record<string, z.ZodTypeAny>);
    expect(schema.safeParse({ reason: "x", findings: Array(MAX_AMEND_FINDINGS).fill(finding) }).success).toBe(true);
    expect(schema.safeParse({ reason: "x", findings: Array(MAX_AMEND_FINDINGS + 1).fill(finding) }).success).toBe(false);
  });

  it("refuses more than 20 screenshots in all, before any request", async () => {
    const harness = await pickedUp();
    const shot = { base64: "aGk=", media_type: "image/png" };
    const result = await harness.callTool("tellagen_amend_investigation", {
      reason: "x",
      findings: [{ ...finding, screenshots: Array(11).fill(shot) }, { ...finding, screenshots: Array(10).fill(shot) }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("at most 20 screenshots");
    expect(amendCalls()).toHaveLength(0);
  });

  it("goes to the finished run, not to the open one, when no id is given", async () => {
    const harness = await pickedUp();
    harness.client.session.rememberAmendable("run-0", until);
    fetchSpy.mockImplementation(async (url) =>
      String(url).includes("/context") ? jsonResponse({ run: { id: "x" }, server_capabilities: ["run_amendments_v1"] }) : jsonResponse(answer),
    );
    await harness.callTool("tellagen_amend_investigation", { reason: "Add" });
    expect(String(amendCalls()[0]![0])).toBe(`${API}/api/v1/investigation-runs/run-0/amendments`);
  });

  it("forgets only the run that was refused", async () => {
    const harness = await pickedUp();
    harness.client.session.rememberAmendable("run-0", until);
    harness.client.session.rememberAmendable("run-9", until);
    fetchSpy.mockImplementation(async (url) =>
      String(url).includes("/context") ? jsonResponse({ run: { id: "x" }, server_capabilities: ["run_amendments_v1"] }) : jsonResponse({ code: "run_not_amendable", message: "Closed.", details: { reason: "window_closed" } }, 409),
    );

    await harness.callTool("tellagen_amend_investigation", { investigation_run_id: "run-0", reason: "Late" });
    expect(harness.client.session.amendableUntil("run-0")).toBeUndefined();
    expect(harness.client.session.amendableUntil("run-9")).toBe(until);
  });

  it("explains run_taken_over on an amendment without the stop line of a taken-over run", async () => {
    const harness = await pickedUp();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ code: "run_taken_over", message: "Another session holds it." }, 409));
    const result = await harness.callTool("tellagen_amend_investigation", { investigation_run_id: "run-1", reason: "Add" });
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("only from the client session that ran it");
    expect(text).not.toContain("Another client took this run over");
    expect(amendCalls()).toHaveLength(1);
  });

  it("refuses a checks field on a finding that is not a gap, before any request", async () => {
    const harness = await pickedUp();
    const result = await harness.callTool("tellagen_amend_investigation", {
      reason: "Add",
      findings: [{ ...finding, checks: [{ source: "Slack", question: "Was it rolled back?" }] }],
    });
    expect(result.isError).toBe(true);
    expect(amendCalls()).toHaveLength(0);
  });

  it("leaves the coverage reason out for a Tellagen that does not list run_amendments_v1, and says so", async () => {
    // The tool refuses first, so test the shared step through the completion tool.
    const harness = createToolHarness(API);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, incident: { id: 42 }, server_capabilities: ["diagnosis_structure_v1"] }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1", status: "completed" } }));
    const result = await harness.callTool("tellagen_complete_investigation", {
      status: "completed",
      result_summary: completeSummary([{ source: "Slack", state: "gap", reason: "wrong_account", retryable: true, detail: "Reads another workspace." }]),
    });
    const patch = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PATCH")!;
    const sent = JSON.parse(String((patch[1] as RequestInit).body));
    expect(sent.result_summary.coverage).toEqual([{ source: "Slack", state: "gap" }]);
    expect(harness.lastJson(result).mcp_notice).toContain("run_amendments_v1");
  });

  it("sends the coverage reason when Tellagen lists run_amendments_v1, and remembers the finished run", async () => {
    const harness = await pickedUp();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1", status: "completed", amend_until: until } }));
    await harness.callTool("tellagen_complete_investigation", {
      status: "completed",
      result_summary: completeSummary([{ source: "Slack", state: "gap", reason: "wrong_account", retryable: true, detail: "Reads another workspace." }]),
    });
    const patch = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PATCH")!;
    const sent = JSON.parse(String((patch[1] as RequestInit).body));
    expect(sent.result_summary.coverage[0]).toMatchObject({ reason: "wrong_account", retryable: true, detail: "Reads another workspace." });
    expect(harness.client.session.latestAmendable()).toEqual({ runId: "run-1", until });
  });
});

describe("a write to a finished run that takes additions", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  const ended = (amendable: boolean) =>
    jsonResponse(
      {
        code: "investigation_run_ended",
        message: "The run is finished.",
        details: { reason: "completed", amendable, ...(amendable ? { amend_until: until } : {}) },
      },
      409,
    );
  const step = { step_id: "s1", status: "running", title: "Read the logs", guidance: { origin: "agent_judgment", refs: [], reason: "first look" } };

  it("says the run takes additions, names the tool and the time, and remembers the run", async () => {
    const harness = createToolHarness(API);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, incident: { id: 42 }, server_capabilities: ["run_amendments_v1"] }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    fetchSpy.mockResolvedValueOnce(ended(true));
    const result = await harness.callTool("tellagen_post_trace_step", step);
    const first = result.content[0]!.text;
    expect(first).toContain("The run is finished but takes additions until");
    expect(first).toContain(until);
    expect(first).toContain("tellagen_amend_investigation");
    expect(first).not.toContain("Stop: do not write to this run again. Tell the person");
    expect(harness.client.session.activeRun()).toBeUndefined();
    expect(harness.client.session.latestAmendable()?.runId).toBe("run-1");
  });

  it("keeps the old stop line for a run that does not take additions", async () => {
    const harness = createToolHarness(API);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, incident: { id: 42 }, server_capabilities: [] }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    fetchSpy.mockResolvedValueOnce(ended(false));
    const result = await harness.callTool("tellagen_post_trace_step", step);
    expect(result.content[0]!.text).toContain("Stop: do not write to this run again");
    expect(harness.client.session.latestAmendable()).toBeUndefined();
  });

  it("tellagen_resume does not pick the finished run up again and points to the amend tool", async () => {
    const harness = createToolHarness(API);
    harness.client.session.rememberAmendable("run-1", until);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1", status: "completed", amend_until: until } }));
    const result = await harness.callTool("tellagen_resume", {});
    const body = harness.lastJson(result);
    expect(body.resumed).toBe(false);
    expect(body.code).toBe("run_amendable");
    expect(body.message).toContain("tellagen_amend_investigation");
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith("/pickup"))).toBe(false);
  });

  it("forgets a finished run whose time ran out", () => {
    const harness = createToolHarness(API);
    harness.client.session.rememberAmendable("run-1", new Date(Date.now() - 1000).toISOString());
    expect(harness.client.session.latestAmendable()).toBeUndefined();
  });
});

function completeSummary(coverage: unknown[]) {
  return {
    conclusion: { tone: "warning", eyebrow: "Inconclusive", sentence: "Slack could not be read, so the rollback is unconfirmed.", show_new_investigation_cta: false },
    likely_cause_label: "",
    customer_impact: { status: "unknown", verified: false, label: "Impact unknown" },
    confidence_percent: 30,
    signals_checked: { checked: 1, total: 2 },
    takeaways: [],
    coverage,
  };
}
