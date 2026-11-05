import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";
import {
  commitLink,
  compareFigure,
  exploreLink,
  statsFigure,
  structuredSummary,
  trendFigure,
} from "./helpers/diagnosis-fixtures.js";
import {
  stepFigureSchema,
  stripResultStructure,
  summarizeWarnings,
} from "../src/diagnosis-structure.js";

const guidance = { origin: "agent_judgment", refs: [], reason: "checking the deploy" };

const withCapability = () =>
  jsonResponse({ run: { id: "run-1" }, request: {}, server_capabilities: ["diagnosis_structure_v1"] });
const withoutCapability = () => jsonResponse({ run: { id: "run-1" }, request: {} });

describe("step figure schema", () => {
  const ok = (figure: unknown) => stepFigureSchema.safeParse(figure);
  const message = (figure: unknown) => {
    const result = ok(figure);
    if (result.success) return "";
    return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  };

  it.each([
    ["compare", compareFigure],
    ["trend", trendFigure],
    ["stats", statsFigure],
  ])("accepts a %s block", (_name, figure) => {
    expect(ok(figure).success).toBe(true);
  });

  it("keeps every field of the block", () => {
    const parsed = ok(trendFigure);
    expect(parsed.success && parsed.data).toEqual(trendFigure);
  });

  it("rejects other block types with a clear message", () => {
    expect(ok({ type: "table", columns: [], rows: [] }).success).toBe(false);
    expect(message({ type: "table", columns: [], rows: [] })).toContain("stats");
    expect(ok({}).success).toBe(false);
    expect(ok([compareFigure]).success).toBe(false);
  });

  it("rejects stats with 0 or 5 items, long text and unknown tones", () => {
    expect(ok({ type: "stats", items: [] }).success).toBe(false);
    expect(
      ok({ type: "stats", items: Array(5).fill({ label: "a", value: "1" }) }).success,
    ).toBe(false);
    expect(ok({ type: "stats", items: [{ label: "a", value: "x".repeat(33) }] }).success).toBe(false);
    expect(ok({ type: "stats", items: [{ label: "a", value: "1", tone: "loud" }] }).success).toBe(false);
    expect(ok({ type: "stats", items: [{ label: "a", value: "1", extra: true }] }).success).toBe(false);
  });

  it("checks compare rows, numbers and threshold", () => {
    expect(ok({ ...compareFigure, rows: [] }).success).toBe(false);
    expect(
      ok({ ...compareFigure, rows: Array(9).fill({ label: "r", before: 1, after: 2 }) }).success,
    ).toBe(false);
    expect(
      ok({ ...compareFigure, rows: [{ label: "r", before: "1", after: 2 }] }).success,
    ).toBe(false);
    expect(
      ok({ ...compareFigure, rows: [{ label: "r", before: 1e13, after: 2 }] }).success,
    ).toBe(false);
    expect(ok({ ...compareFigure, threshold: { label: "SLO" } }).success).toBe(false);
    expect(ok({ ...compareFigure, better: "sideways" }).success).toBe(false);
    expect(ok({ ...compareFigure, max: 0 }).success).toBe(false);
  });

  it("checks trend series, start/step pairing and mark indexes", () => {
    expect(ok({ ...trendFigure, series: [1] }).success).toBe(false);
    expect(ok({ ...trendFigure, series: Array(501).fill(1), marks: [] }).success).toBe(false);
    expect(ok({ ...trendFigure, step_seconds: undefined }).success).toBe(false);
    expect(message({ ...trendFigure, step_seconds: undefined })).toContain("start and step_seconds");
    expect(ok({ ...trendFigure, start: undefined }).success).toBe(false);
    expect(ok({ ...trendFigure, marks: [{ i: 6, label: "late" }] }).success).toBe(false);
    expect(message({ ...trendFigure, marks: [{ i: 6, label: "late" }] })).toContain("point index");
    expect(ok({ ...trendFigure, marks: Array(4).fill({ i: 0, label: "m" }) }).success).toBe(false);
    expect(ok({ ...trendFigure, start: "yesterday" }).success).toBe(false);
    expect(ok({ ...trendFigure, series: [1, Number.NaN] }).success).toBe(false);
  });

  it("rejects control characters except in source.query, and slot with anchor", () => {
    expect(ok({ ...statsFigure, items: [{ label: "a\nb", value: "1" }] }).success).toBe(false);
    expect(
      ok({ ...trendFigure, source: { ...trendFigure.source, query: "a\nb" } }).success,
    ).toBe(true);
    expect(ok({ ...statsFigure, slot: "summary", anchor: "Verified outcome" }).success).toBe(false);
    expect(ok({ ...statsFigure, slot: "summary" }).success).toBe(true);
  });

  it("accepts the largest legal trend (500 long numbers) under the 16 KB cap", () => {
    // The caps in the schema keep every legal block under the byte limit; the
    // byte check is a backstop that mirrors the backend.
    const big = {
      ...trendFigure,
      series: Array(500).fill(123456789012.345678),
      marks: [],
      source: { query: "q".repeat(2000) },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(big)).length;
    expect(bytes).toBeGreaterThan(10 * 1024);
    expect(bytes).toBeLessThan(16 * 1024);
    expect(ok(big).success).toBe(true);
  });
});

describe("tellagen_complete_investigation schema", () => {
  const harness = createToolHarness();
  const schema = z.object(
    harness.getTool("tellagen_complete_investigation").config.inputSchema as Record<string, z.ZodTypeAny>,
  );
  const parse = (result_summary: unknown) =>
    schema.safeParse({ run_id: "run-1", status: "completed", result_summary });

  it("keeps the whole structure instead of stripping unknown-to-zod fields", () => {
    const summary = structuredSummary();
    const parsed = parse(summary);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const out = parsed.data.result_summary as ReturnType<typeof structuredSummary>;
    expect(out.causal_paths[0].steps[1].finding_ids).toEqual([12, 13]);
    expect(out.causal_paths[0].steps[1].figure).toEqual(compareFigure);
    expect(out.causal_paths[0].steps[0].links).toEqual([commitLink]);
    expect(out.causal_paths[0].steps[1].evidence_refs[0]).toMatchObject({
      links: [exploreLink],
      command: "kubectl -n checkout get pods",
      datasource: "prom-uid-1",
    });
    expect(out.ruled_out).toEqual(summary.ruled_out);
    expect(out.coverage).toEqual(summary.coverage);
    expect(out.unknowns).toEqual(summary.unknowns);
    expect(out.recommended_actions[0].evidence_refs[0]).toMatchObject({ links: [commitLink] });
    expect(out.question_verification.evidence_refs[0]).toMatchObject({ command: "git log -1" });
  });

  it("still accepts a summary without any of the new fields", () => {
    const { causal_paths, ruled_out, coverage, unknowns, ...legacy } = structuredSummary();
    void causal_paths; void ruled_out; void coverage; void unknowns;
    expect(parse(legacy).success).toBe(true);
  });

  const mutate = (change: (summary: ReturnType<typeof structuredSummary>) => void) => {
    const summary = structuredSummary();
    change(summary);
    return parse(summary).success;
  };

  it("uses numeric finding ids, not keys", () => {
    expect(mutate((s) => ((s.causal_paths[0].steps[0] as any).finding_ids = ["f-1"]))).toBe(false);
    expect(mutate((s) => ((s.causal_paths[0].steps[0] as any).finding_ids = [0]))).toBe(false);
    expect(mutate((s) => ((s.causal_paths[0].steps[0] as any).finding_ids = Array(13).fill(1)))).toBe(false);
    expect(mutate((s) => ((s.causal_paths[0].steps[0] as any).finding_keys = ["a"]))).toBe(true); // stripped, not an error
  });

  it("bounds ruled_out, coverage and unknowns and their fields", () => {
    expect(mutate((s) => (s.ruled_out = Array(6).fill(s.ruled_out[0])))).toBe(false);
    expect(mutate((s) => (s.coverage = Array(9).fill(s.coverage[0])))).toBe(false);
    expect(mutate((s) => (s.unknowns = Array(6).fill(s.unknowns[0])))).toBe(false);
    expect(mutate((s) => ((s.coverage[0] as any).state = "skipped"))).toBe(false);
    expect(mutate((s) => ((s.ruled_out[0] as any).label = ""))).toBe(false);
    expect(mutate((s) => ((s.ruled_out[0] as any).confidence_percent = 101))).toBe(false);
    expect(mutate((s) => ((s.ruled_out[0] as any).links = [{ ...exploreLink, url: "javascript:alert(1)" }]))).toBe(false);
  });

  it("checks a run_history figure in full although the listing shows only its type", () => {
    const summary = structuredSummary();
    (summary.causal_paths[0].steps[1] as any).figure = {
      type: "run_history",
      runs: [
        { ref: "1", result: "success" },
        { ref: "2", result: "failure" },
        { ref: "3", result: "failure" },
      ],
      marks: [{ between: ["1", "3"], change_ref: "regression" }],
    };
    const parsed = parse(summary);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join("."))).toContain(
        "result_summary.causal_paths.0.steps.1.figure.marks.0.between",
      );
    }
    (summary.causal_paths[0].steps[1] as any).figure = { type: "checks", items: [{ label: "E2E", state: "fail", owner: "x" }] };
    expect(parse(summary).success).toBe(false);
    (summary.causal_paths[0].steps[1] as any).figure = { type: "checks", items: [{ label: "E2E", state: "fail" }] };
    expect(parse(summary).success).toBe(true);
  });

  it("fails a bad figure with a message that names it, before any request", () => {
    const summary = structuredSummary();
    (summary.causal_paths[0].steps[1] as any).figure = { type: "trend", series: [1] };
    const parsed = parse(summary);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path.join(".")).toContain("figure");
    }
  });
});

describe("tellagen_post_trace_step outcome and cause_key", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const step = (extra: Record<string, unknown> = {}) => ({
    investigation_run_id: "run-1",
    step_id: "deploys-1",
    status: "done",
    title: "List deploys in the window",
    guidance,
    ...extra,
  });
  const body = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index][1] as RequestInit).body));

  it("validates the outcome enum and cause_key length", () => {
    const harness = createToolHarness();
    const schema = z.object(
      harness.getTool("tellagen_post_trace_step").config.inputSchema as Record<string, z.ZodTypeAny>,
    );
    for (const outcome of ["supports", "rules_out", "nothing_notable", "inconclusive", "unavailable"]) {
      expect(schema.safeParse(step({ outcome })).success, outcome).toBe(true);
    }
    expect(schema.safeParse(step({ outcome: "confirmed" })).success).toBe(false);
    expect(schema.safeParse(step({ cause_key: "k".repeat(64) })).success).toBe(true);
    expect(schema.safeParse(step({ cause_key: "k".repeat(65) })).success).toBe(false);
    expect(schema.safeParse(step({ cause_key: "  " })).success).toBe(false);
    const parsed = schema.parse(step({ outcome: "supports", cause_key: "deploy-4412" }));
    expect(parsed).toMatchObject({ outcome: "supports", cause_key: "deploy-4412" });
  });

  it("sends outcome and cause_key to a backend that advertises the capability", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(withCapability())
      .mockResolvedValueOnce(jsonResponse({ steps: [{ step_id: "deploys-1" }] }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool(
      "tellagen_post_trace_step",
      step({ outcome: "supports", cause_key: "deploy-4412" }),
    );
    expect(body(1)).toMatchObject({ outcome: "supports", cause_key: "deploy-4412" });
    expect(harness.json(result).mcp_notice).toBeUndefined();
  });

  it("drops them for an older backend, keeps the rest and says so", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(withoutCapability())
      .mockResolvedValueOnce(jsonResponse({ steps: [{ step_id: "deploys-1" }] }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool(
      "tellagen_post_trace_step",
      step({ outcome: "supports", cause_key: "deploy-4412", result_summary: "1 deploy" }),
    );
    const sent = body(1);
    expect(sent.outcome).toBeUndefined();
    expect(sent.cause_key).toBeUndefined();
    expect(sent).toMatchObject({ step_id: "deploys-1", status: "done", result_summary: "1 deploy", guidance });
    expect(harness.json(result).mcp_notice).toContain("outcome, cause_key");
  });

  it("makes no lookup when neither field is used", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ steps: [] }));
    await harness.callTool("tellagen_post_trace_step", step());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body(0).outcome).toBeUndefined();
  });
});

describe("tellagen_complete_investigation request and response", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });
  const sent = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index][1] as RequestInit).body));
  const run = { run: { id: "run-1", status: "completed" }, warnings: [] };

  it("sends the whole structure to a backend that advertises the capability", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(withCapability())
      .mockResolvedValueOnce(jsonResponse(run));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const summary = structuredSummary();
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: summary,
    });
    expect(sent(1)).toEqual({ status: "completed", result_summary: summary });
    expect(harness.json(result)).toEqual(run);
  });

  it("removes every new field, nested ones included, for an older backend", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(withoutCapability())
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1", status: "completed" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: structuredSummary(),
    });
    const text = JSON.stringify(sent(1));
    for (const field of [
      "finding_ids",
      "figure",
      "\"links\"",
      "\"command\"",
      "\"datasource\"",
      "ruled_out",
      "coverage",
      "unknowns",
    ]) {
      expect(text, field).not.toContain(field);
    }
    const summary = sent(1).result_summary;
    expect(summary.causal_paths[0].steps).toHaveLength(2);
    expect(summary.causal_paths[0].steps[1].evidence_refs[0]).toEqual({
      source: "grafana-prometheus",
      query: 'sum(rate(http_requests_total{code=~"5.."}[5m]))',
      result_summary: "5xx 8.1%",
    });
    expect(summary.recommended_actions[0].evidence_refs[0]).toEqual({ source: "github", result_summary: "diff" });
    expect(summary.conclusion.tone).toBe("danger");
    // The old payload shape stays valid and the response, which has no
    // warnings field on an old backend, comes back untouched plus a notice.
    const out = harness.json(result);
    expect(out.run.status).toBe("completed");
    expect(out.warnings).toBeUndefined();
    expect(out.warnings_summary).toBeUndefined();
    expect(out.mcp_notice).toContain("causal_paths[0].steps[0].finding_ids");
  });

  it("sends a legacy summary unchanged and looks nothing up", async () => {
    const harness = createToolHarness();
    const { causal_paths, ruled_out, coverage, unknowns, recommended_actions, question_verification, ...legacy } =
      structuredSummary();
    void causal_paths; void ruled_out; void coverage; void unknowns; void recommended_actions; void question_verification;
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: legacy,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sent(0)).toEqual({ status: "completed", result_summary: legacy });
    expect(harness.json(result)).toEqual({ run: { id: "run-1" } });
  });

  it("passes the backend warnings through verbatim with a one-line summary", async () => {
    const harness = createToolHarness();
    const warnings = [
      { code: "evidence_without_link", message: "Grafana evidence has no link", path: "causal_paths[0].steps[1].evidence_refs[0]" },
      { code: "evidence_without_link", message: "Grafana evidence has no link", path: "causal_paths[0].steps[1].evidence_refs[1]" },
      { code: "negative_not_ruled_out", message: "negative finding 14 is not in ruled_out", path: "ruled_out" },
    ];
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ run: { id: "run-1", status: "completed" }, coverage: { ok: true }, warnings }),
    );
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
    });
    const out = harness.json(result);
    expect(out.warnings).toEqual(warnings);
    expect(out.coverage).toEqual({ ok: true });
    expect(out.warnings_summary).toBe(
      "3 warnings: 2 evidence_without_link (evidence refs have no link: call tellagen_build_source_link or add a command); 1 negative_not_ruled_out (add a ruled_out entry for each negative finding that matters). The run is already complete, so name anything you could not fix in your report and apply the fixes on the next run.",
    );
    expect(out.warnings_summary).not.toContain("\n");
  });

  it("returns the backend 400 for a missing chain as the tool error", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        { code: "bad_request", message: "causal_paths is required when the diagnosis is confirmed or likely" },
        400,
      ),
    );
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: { assessment: { diagnosis_state: "confirmed" } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: 400,
      message: expect.stringContaining("causal_paths is required"),
    });
  });
});

describe("summarizeWarnings and stripResultStructure", () => {
  it("returns nothing without warnings and names unknown codes", () => {
    expect(summarizeWarnings(undefined)).toBeUndefined();
    expect(summarizeWarnings([])).toBeUndefined();
    expect(summarizeWarnings([{ code: "brand_new", message: "x" }])).toMatch(/^1 warning: 1 brand_new\./);
    expect(summarizeWarnings([{ message: "no code" }])).toContain("1 warning");
  });

  it("does not mutate its input and ignores non-objects", () => {
    const summary = structuredSummary();
    const before = JSON.stringify(summary);
    const { removed } = stripResultStructure(summary);
    expect(JSON.stringify(summary)).toBe(before);
    expect(removed).toContain("ruled_out");
    expect(removed).toContain("recommended_actions[0].evidence_refs[0].links");
    expect(removed).toContain("question_verification.evidence_refs[0].command");
    expect(stripResultStructure(undefined)).toEqual({ summary: undefined, removed: [] });
    expect(stripResultStructure("text")).toEqual({ summary: "text", removed: [] });
  });
});
