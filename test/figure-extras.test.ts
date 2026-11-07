import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFigure, withoutFigureExtrasInBlock } from "../src/figures.js";
import { FIGURE_GUIDE } from "../src/tools/figures.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";
import { structuredSummary } from "./helpers/diagnosis-fixtures.js";

const item = (label: string, value = "1") => ({ label, value });
const stats = (count: number, extra: Record<string, unknown> = {}) => ({
  type: "stats",
  ...extra,
  items: Array.from({ length: count }, (_, i) => item(`Item ${i + 1}`, String(i + 1))),
});
const runs = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ ref: `#${i + 1}`, result: i === 3 ? "failure" : "success" }));
const history = (extra: Record<string, unknown> = {}) => ({ type: "run_history", runs: runs(30), ...extra });

const build = (figure: Record<string, unknown>, figureExtras: boolean, placement: "step_figure" | "timeline_block" = "step_figure") =>
  buildFigure({ placement, figure }, { figureExtras });

describe("the figure extras in the builder", () => {
  it("keeps a stats title and eight items for a server that lists figure_extras_v1", () => {
    const result = build(stats(8, { title: "Tests of the run" }), true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.title).toBe("Tests of the run");
    expect((result.block.items as unknown[]).length).toBe(8);
    expect(result.summary).toBe("stats with 8 numbers");
    expect(result.notes).toEqual([]);
  });

  it("cuts stats to the first four and drops the title otherwise, and says so", () => {
    const result = build(stats(6, { title: "Tests of the run" }), false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.title).toBeUndefined();
    expect((result.block.items as Array<{ label: string }>).map((i) => i.label)).toEqual(["Item 1", "Item 2", "Item 3", "Item 4"]);
    expect(result.notes.join(" ")).toContain("the title and 2 figures after the fourth");
    expect(result.notes.join(" ")).toContain("figure_extras_v1");
  });

  it("sends nothing to remove and no note for a plain stats figure on an older server", () => {
    const result = build(stats(4), false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block).toEqual(stats(4));
    expect(result.notes).toEqual([]);
  });

  it("rejects nine stats and a title that is too long even with the capability", () => {
    expect(build(stats(9), true).ok).toBe(false);
    const long = build(stats(2, { title: "x".repeat(81) }), true);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.issues.join(" ")).toContain("title");
  });

  it("keeps runs_not_shown for a server that lists figure_extras_v1", () => {
    const result = build(history({ runs_not_shown: 70 }), true, "timeline_block");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.runs_not_shown).toBe(70);
    expect(result.notes).toEqual([]);
  });

  it("drops runs_not_shown otherwise, and says so", () => {
    const result = build(history({ runs_not_shown: 70 }), false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.runs_not_shown).toBeUndefined();
    expect(result.notes.join(" ")).toContain("runs_not_shown");
  });

  it("rejects a negative or fractional runs_not_shown and one over the limit", () => {
    for (const value of [-1, 1.5, 1_000_001]) {
      expect(build(history({ runs_not_shown: value }), true).ok, String(value)).toBe(false);
    }
    expect(build(history({ runs_not_shown: 0 }), true).ok).toBe(true);
  });

  it("takes runs_not_shown with github_runs", () => {
    const github_runs = Array.from({ length: 3 }, (_, i) => ({
      run_number: i + 1,
      head_sha: `abc${i}`,
      conclusion: "success",
      created_at: `2026-10-30T0${i}:00:00Z`,
    }));
    const result = build({ type: "run_history", github_runs, runs_not_shown: 12 }, true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.block.runs_not_shown).toBe(12);
  });

  it("leaves other blocks alone", () => {
    const block = { type: "checks", items: [] };
    expect(withoutFigureExtrasInBlock(block)).toEqual({ block, what: [] });
    expect(withoutFigureExtrasInBlock("text")).toEqual({ block: "text", what: [] });
  });

  it("explains the extras in the figure guide", () => {
    expect(FIGURE_GUIDE).toContain("figure_extras_v1");
    expect(FIGURE_GUIDE).toContain("runs_not_shown");
    expect(FIGURE_GUIDE).toContain("1 to 8 items");
  });
});

describe("what the senders do against an older server", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });
  const sent = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));
  const pickup = (capabilities: string[]) => jsonResponse({ run: { id: "run-1" }, request: {}, server_capabilities: capabilities });
  const summaryWith = (figure: unknown) => {
    const summary = structuredSummary();
    (summary.causal_paths[0]!.steps[0] as Record<string, unknown>).figure = figure;
    return summary;
  };
  const figureSent = (index: number) => sent(index).result_summary.causal_paths[0].steps[0].figure;
  const titled = stats(6, { title: "Tests of the run" });

  it("completes with the extras when the pickup lists figure_extras_v1", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1", "figure_extras_v1"]))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: summaryWith(titled),
    });
    expect(figureSent(1)).toEqual(titled);
    expect(harness.json(result).mcp_notice).toBeUndefined();
  });

  it("completes with four stats, no title and a notice when the pickup does not list it", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1", "diff_lines_v1"]))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: summaryWith(titled),
    });
    expect(figureSent(1)).toEqual(stats(4));
    const notice = String(harness.json(result).mcp_notice);
    expect(notice).toContain("figure_extras_v1");
    expect(notice).toContain("causal_paths[0].steps[0].figure");
  });

  it("drops runs_not_shown from a step figure for an older server", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(pickup(["diagnosis_structure_v1"])).mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: summaryWith(history({ runs_not_shown: 5 })),
    });
    expect(figureSent(1)).toEqual(history());
  });

  it("sends a plain stats figure with no notice and no extra request", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(pickup(["diagnosis_structure_v1"])).mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: summaryWith(stats(3)),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(figureSent(1)).toEqual(stats(3));
    expect(harness.json(result).mcp_notice).toBeUndefined();
  });

  it("strips a timeline block unless the latest pickup listed figure_extras_v1", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(pickup(["figure_extras_v1"]))
      .mockResolvedValueOnce(jsonResponse({ id: 2 }));
    const block = history({ runs_not_shown: 9 });
    const before = await harness.callTool("tellagen_post_timeline_event", { incident_id: 7, title: "t", body: "b", blocks: [block] });
    expect(sent(0).blocks[0]).toEqual(history());
    expect(harness.json(before).mcp_notice).toContain("blocks[0]");
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const after = await harness.callTool("tellagen_post_timeline_event", { incident_id: 7, title: "t", body: "b", blocks: [block] });
    expect(sent(2).blocks[0]).toEqual(block);
    expect(harness.json(after).mcp_notice).toBeUndefined();
  });

  it("builds stats with the extras only for a run whose context lists figure_extras_v1", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(pickup(["figure_extras_v1"])).mockResolvedValueOnce(pickup(["diagnosis_structure_v1"])).mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const call = async (run_id: string) =>
      harness.json(await harness.callTool("tellagen_build_figure", { placement: "step_figure", run_id, figure: titled }));
    expect((await call("run-1")).block).toEqual(titled);
    expect((await call("run-2")).block).toEqual(stats(4));
    expect((await call("run-3")).block).toEqual(stats(4));
  });

  it("builds a figure that uses no extras without asking the server", async () => {
    const harness = createToolHarness();
    const out = harness.json(await harness.callTool("tellagen_build_figure", { placement: "step_figure", run_id: "run-9", figure: stats(2) }));
    expect(out.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
