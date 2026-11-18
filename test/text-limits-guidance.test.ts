import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildFigure } from "../src/figures.js";
import { FIGURE_GUIDE } from "../src/tools/figures.js";
import {
  stripResultActionAnswer,
  stripResultFigureLimits,
  stripResultNotNeeded,
  summarizeWarnings,
  unsupportedNotice,
} from "../src/diagnosis-structure.js";
import { z } from "zod";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";
import { structuredSummary } from "./helpers/diagnosis-fixtures.js";

const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");

const diff = { type: "diff", path: "pool.yaml", hunks: [[{ op: "-", text: "size: 5" }, { op: "+", text: "size: 20" }]] };
const limitRows = { type: "compare", unit: "px", better: "lower", rows: [{ label: "Checkout bundle", after: 7908, limit: 7500 }] };

describe("a compare row with a limit", () => {
  it("is kept, with no before, for a server that lists figure_limits_v1", () => {
    const result = buildFigure({ placement: "step_figure", figure: limitRows }, { figureLimits: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.block.rows as Array<Record<string, unknown>>)[0]).toEqual({ label: "Checkout bundle", after: 7908, limit: 7500 });
    expect(result.notes).toEqual([]);
  });

  it("needs a before otherwise, and says why", () => {
    const result = buildFigure({ placement: "step_figure", figure: limitRows }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toContain("figure_limits_v1");
  });

  it("is cut down to before and after for an older server when the row has both", () => {
    const figure = { ...limitRows, rows: [{ label: "Checkout bundle", before: 7000, after: 7908, limit: 7500 }] };
    const result = buildFigure({ placement: "step_figure", figure }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.block.rows as Array<Record<string, unknown>>)[0]).toEqual({ label: "Checkout bundle", before: 7000, after: 7908 });
    expect(result.notes.join(" ")).toContain("figure_limits_v1");
  });

  it("is refused when a row has neither before nor limit", () => {
    const figure = { ...limitRows, rows: [{ label: "x", after: 1 }] };
    expect(buildFigure({ placement: "step_figure", figure }, { figureLimits: true }).ok).toBe(false);
  });

  it("is taught in the figure guide: never a limit in before", () => {
    expect(FIGURE_GUIDE).toContain("figure_limits_v1");
    expect(FIGURE_GUIDE).toMatch(/Never put a limit or a budget in before/);
  });
});

describe("what an older Tellagen does not get", () => {
  const summary = () => ({
    ...structuredSummary(),
    answer: "The pool size of 5 ran out.",
    coverage: [
      { source: "Grafana", state: "checked" },
      { source: "Kubernetes", state: "not_needed", summary: "The alert names a database." },
    ],
    recommended_actions: [{ title: "Raise the pool", category: "mitigation", priority: "high", figure: diff }],
  });

  it("drops the answer and the action figure", () => {
    const result = stripResultActionAnswer(summary());
    expect(result.removed).toEqual(["answer", "recommended_actions[0].figure"]);
    const next = result.summary as Record<string, any>;
    expect(next.answer).toBeUndefined();
    expect(next.recommended_actions[0].figure).toBeUndefined();
    expect(stripResultActionAnswer(structuredSummary()).removed).toEqual([]);
  });

  it("leaves a not_needed entry out instead of sending checked", () => {
    const result = stripResultNotNeeded(summary());
    expect(result.removed).toEqual(["coverage[1]"]);
    expect((result.summary as any).coverage).toEqual([{ source: "Grafana", state: "checked" }]);
  });

  it("drops a row limit, and a figure that needs it", () => {
    const withLimits = {
      ...structuredSummary(),
      causal_paths: [{ id: "primary", kind: "primary", steps: [{ id: "a", claim: "c", figure: limitRows }, { id: "b", claim: "d", figure: { ...limitRows, rows: [{ label: "x", before: 1, after: 2, limit: 3 }] } }] }],
    };
    const result = stripResultFigureLimits(withLimits);
    expect(result.removed).toEqual(["causal_paths[0].steps[0].figure", "causal_paths[0].steps[1].figure"]);
    const steps = (result.summary as any).causal_paths[0].steps;
    expect(steps[0].figure).toBeUndefined();
    expect(steps[1].figure.rows[0]).toEqual({ label: "x", before: 1, after: 2 });
    expect(unsupportedNotice(result.removed, "figure_limits_v1")).toContain("never in before");
  });

  it("names the three text warnings with advice", () => {
    const line = summarizeWarnings([{ code: "text_too_long" }, { code: "filler_phrase" }, { code: "raw_id_in_text" }, { code: "coverage_not_needed_without_reason" }])!;
    for (const code of ["text_too_long", "filler_phrase", "raw_id_in_text", "coverage_not_needed_without_reason"]) expect(line).toContain(code);
    expect(line).toContain("links");
  });
});

describe("completion with the new capabilities", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());
  const body = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));
  const BASE = ["diagnosis_structure_v1", "completion_repairs_v1"];

  let runCounter = 0;
  async function pickedUp(capabilities: string[]) {
    const runId = `run-${++runCounter}`;
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: runId }, request: {}, server_capabilities: capabilities }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: runId });
    fetchSpy.mockClear();
    return harness;
  }
  const result = (extra: Record<string, unknown>) => ({ ...structuredSummary(), ...extra });

  it("sends the answer, the action diff and not_needed when the pickup lists the capabilities", async () => {
    const harness = await pickedUp([...BASE, "action_answer_v1", "coverage_not_needed_v1", "figure_limits_v1"]);
    fetchSpy.mockImplementation(async () => jsonResponse({ dry_run: true, ready: true, repairs: [], warnings: [] }));
    const summary = result({
      answer: "The pool size of 5 ran out.",
      coverage: [{ source: "Kubernetes", state: "not_needed", summary: "The alert names a database." }],
      recommended_actions: [{ title: "Raise the pool", category: "mitigation", priority: "high", figure: diff }],
    });
    await harness.callTool("tellagen_complete_investigation", { status: "completed", result_summary: summary });
    const sent = body(0).result_summary;
    expect(sent.answer).toBe("The pool size of 5 ran out.");
    expect(sent.coverage[0].state).toBe("not_needed");
    expect(sent.recommended_actions[0].figure.type).toBe("diff");
  });

  it("accepts only a diff or a checks figure on an action", () => {
    const harness = createToolHarness();
    const schema = harness.getTool("tellagen_complete_investigation").config.inputSchema!.result_summary as z.ZodTypeAny;
    const withFigure = (figure: unknown) => ({ ...structuredSummary(), recommended_actions: [{ title: "t", category: "mitigation", priority: "high", figure }] });
    const wrong = schema.safeParse(withFigure({ type: "stats", items: [{ label: "a", value: "1" }] }));
    expect(wrong.success).toBe(false);
    const paths = (r: ReturnType<typeof schema.safeParse>) => (r.success ? [] : r.error.issues.map((i) => i.path.join(".")));
    expect(paths(wrong).some((p) => p.includes("recommended_actions.0.figure"))).toBe(true);
    expect(paths(schema.safeParse(withFigure({ type: "checks", items: [{ label: "lint", state: "pass" }] }))).some((p) => p.includes("recommended_actions.0.figure"))).toBe(false);
  });

  it("leaves them out, and says so, when the pickup does not list them", async () => {
    const harness = await pickedUp(BASE);
    fetchSpy.mockImplementation(async () => jsonResponse({ dry_run: true, ready: true, repairs: [], warnings: [] }));
    const summary = result({
      answer: "The pool size of 5 ran out.",
      coverage: [{ source: "Kubernetes", state: "not_needed", summary: "x" }],
      recommended_actions: [{ title: "Raise the pool", category: "mitigation", priority: "high", figure: diff }],
    });
    const out = await harness.callTool("tellagen_complete_investigation", { status: "completed", result_summary: summary });
    const sent = body(0).result_summary;
    expect(sent.answer).toBeUndefined();
    expect(sent.coverage).toEqual([]);
    expect(sent.recommended_actions[0].figure).toBeUndefined();
    const notice = String(harness.lastJson(out).mcp_notice);
    expect(notice).toContain("action_answer_v1");
    expect(notice).toContain("coverage_not_needed_v1");
  });

  it("shows text advice once, then completes the same result as it is", async () => {
    const harness = await pickedUp(BASE);
    const advice = { code: "text_too_long", field: "result_summary.answer", missing: "20 words, limit 15", example: "Cut it.", advice: true };
    fetchSpy.mockImplementation(async () => jsonResponse({ dry_run: true, ready: true, repairs: [advice], warnings: [{ code: "text_too_long" }] }));
    const first = await harness.callTool("tellagen_complete_investigation", { status: "completed", result_summary: structuredSummary() });
    const answer = harness.lastJson(first);
    expect(answer.completed).toBe(false);
    expect(answer.ready).toBe(true);
    expect(answer.repairs).toEqual([advice]);
    expect(answer.message).toContain("advice about the text");
    const patches = () => fetchSpy.mock.calls.filter((call) => (call[1] as RequestInit).method === "PATCH");
    expect(patches()).toHaveLength(1);

    // A changed result does not stop the run again: the next call completes it.
    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ dry_run: true, ready: true, repairs: [advice], warnings: [] }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", warnings: [{ code: "text_too_long" }] }));
    const changed = { ...structuredSummary(), likely_cause_label: "Pool size of 5 ran out" };
    const second = await harness.callTool("tellagen_complete_investigation", { status: "completed", result_summary: changed });
    expect(harness.lastJson(second).status).toBe("completed");
  });

  it("stops a run once only: later calls complete even when the result changes each time", async () => {
    const harness = await pickedUp(BASE);
    const advice = { code: "filler_phrase", field: "findings[1].claim", missing: "stock phrase", example: "x", advice: true };
    let completions = 0;
    fetchSpy.mockImplementation(async (_url, init) => {
      const sent = JSON.parse(String((init as RequestInit).body));
      if (sent.dry_run) return jsonResponse({ dry_run: true, ready: true, repairs: [advice], warnings: [] });
      completions++;
      return jsonResponse({ status: "completed", warnings: [] });
    });
    const first = await harness.callTool("tellagen_complete_investigation", { status: "completed", result_summary: structuredSummary() });
    expect(harness.lastJson(first).completed).toBe(false);
    const again = await harness.callTool("tellagen_complete_investigation", { status: "completed", result_summary: { ...structuredSummary(), likely_cause_label: "A" } });
    expect(harness.lastJson(again).status).toBe("completed");
    expect(completions).toBe(1);
  });
});

describe("the guides", () => {
  it("give the word limits, the stock phrases, ids in links, units and the figure rule", () => {
    for (const text of [
      "claim` 20 words",
      "`evidence_summary` 60 words",
      "`answer` 15",
      "action `title` 12",
      "`text_too_long`",
      "`filler_phrase`",
      "`raw_id_in_text`",
      "never in a sentence",
      "A figure shows the fact its step or finding states",
      "Never put a limit or a budget in a `before`",
      "`not_needed`",
      "action_answer_v1",
      "coverage_not_needed_v1",
      "figure_limits_v1",
      "Do not repeat a rule of this protocol in your text. The page shows who decides.",
    ]) {
      expect(skill, text).toContain(text);
    }
    for (const phrase of ["A person decides", "Based on the", "It is worth noting", "Please note", "Investigation complete"]) expect(skill).toContain(phrase);
  });
});
