import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stepFigureSchema, stripResultStatSparklines, unsupportedNotice } from "../src/diagnosis-structure.js";
import { buildFigure, withoutStatSparklinesInBlock } from "../src/figures.js";
import { FIGURE_GUIDE } from "../src/tools/figures.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";
import { structuredSummary } from "./helpers/diagnosis-fixtures.js";

const START = Date.parse("2026-11-02T14:00:00Z") / 1000;

/** The samples of a range query: `count` values, `step` seconds apart, rising from 0. */
const samples = (count: number, step = 30) =>
  Array.from({ length: count }, (_, i) => ({ t: new Date((START + i * step) * 1000).toISOString(), v: i }));

const stats = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "stats",
  ...extra,
  items: [{ label: "5xx share", value: "8.1%", caption: "SLO 1%", tone: "bad", ...item }],
});

const build = (figure: Record<string, unknown>, statSparklines: boolean, placement: "step_figure" | "timeline_block" = "step_figure") =>
  buildFigure({ placement, figure }, { statSparklines, figureExtras: true });

const sparkOf = (result: ReturnType<typeof build>) => {
  if (!result.ok) throw new Error(result.issues.join("; "));
  return (result.block.items as Array<Record<string, any>>)[0]!.spark as { values: number[]; window_seconds?: number } | undefined;
};

describe("a stats item built from a range result", () => {
  it("gets a spark with every sample and the time they span, for a server that lists stat_sparklines_v1", () => {
    const result = build(stats({ points: samples(5, 60) }), true);
    expect(sparkOf(result)).toEqual({ values: [0, 1, 2, 3, 4], window_seconds: 240 });
    if (!result.ok) return;
    expect((result.block.items as Array<Record<string, unknown>>)[0]).not.toHaveProperty("points");
    expect(result.summary).toBe("stats with 1 number, 1 with a sparkline");
    expect(result.notes).toEqual([]);
  });

  it("cuts a long range to 60 values at an even step, with the first and the last kept", () => {
    // 80 minutes at 30 s: 161 samples.
    const result = build(stats({ points: samples(161) }), true);
    const spark = sparkOf(result)!;
    expect(spark.values).toHaveLength(60);
    expect(spark.values[0]).toBe(0);
    expect(spark.values[59]).toBe(160);
    expect(spark.window_seconds).toBe(4800);
    const steps = spark.values.slice(1).map((v, i) => v - spark.values[i]!);
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...steps)).toBeLessThanOrEqual(3);
    if (result.ok) expect(result.notes.join(" ")).toContain("60 of its 161 samples");
  });

  it("puts the samples oldest first, reads numeric strings and skips a sample with no value", () => {
    const points = [
      { t: START + 180, v: "4" },
      { t: START, v: "1" },
      { t: START + 60, v: null },
      { t: START + 120, v: "3" },
      { t: (START + 240) * 1000, v: 5 },
      { t: START + 60, v: "2.25001" },
    ];
    expect(sparkOf(build(stats({ points }), true))).toEqual({ values: [1, 2.25, 3, 4, 5], window_seconds: 240 });
  });

  it("skips a sample with a blank or unreadable value, never reads it as 0, and says how many it skipped", () => {
    const at = (i: number) => START + i * 60;
    const points = [
      { t: at(0), v: "" },
      { t: at(1), v: "1" },
      { t: at(2), v: "NaN" },
      { t: at(3), v: "2" },
      { t: at(4), v: "abc" },
      { t: at(5), v: "3" },
      { t: at(6), v: "   " },
      { t: at(7), v: "4" },
      { t: "not a time", v: "9" },
    ];
    const result = build(stats({ points }), true);
    expect(sparkOf(result)).toEqual({ values: [1, 2, 3, 4], window_seconds: 360 });
    if (!result.ok) return;
    const notes = result.notes.join(" ");
    expect(notes).toContain('5 samples of "5xx share" had no usable time or value and were skipped');
    expect(notes).toContain("does not show the gap");
    // A real zero stays a value.
    expect(sparkOf(build(stats({ points: [0, 1, 2, 3].map((i) => ({ t: at(i), v: i === 0 ? "0" : String(i) })) }), true))!.values).toEqual([0, 1, 2, 3]);
    // With too few samples left there is one note, the one that says why there is no sparkline.
    const few = build(stats({ points: [{ t: at(0), v: "" }, { t: at(1), v: "1" }, { t: at(2), v: "2" }, { t: at(3), v: "3" }] }), true);
    expect(sparkOf(few)).toBeUndefined();
    if (few.ok) expect(few.notes).toHaveLength(1);
  });

  it("skips a blank value in a trend too", () => {
    const result = buildFigure(
      { placement: "step_figure", figure: { type: "trend", points: [{ t: START, v: "1" }, { t: START + 60, v: "" }, { t: START + 120, v: "3" }] } },
      {},
    );
    expect(result.ok).toBe(true);
    // Before, the blank value was a third point with the value 0.
    if (result.ok) expect(result.block.series).toEqual([1, 3]);
  });

  it("leaves the window out when the samples span less than a minute", () => {
    expect(sparkOf(build(stats({ points: samples(4, 15) }), true))).toEqual({ values: [0, 1, 2, 3] });
  });

  it("gives no spark, and says why, for fewer than 4 usable samples", () => {
    const result = build(stats({ points: samples(3) }), true);
    expect(sparkOf(result)).toBeUndefined();
    if (result.ok) expect(result.notes.join(" ")).toContain("a sparkline needs at least 4");
  });

  it("leaves the spark out without the capability, and says so", () => {
    const result = build(stats({ points: samples(5, 60) }), false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block).toEqual(stats({}));
    expect(result.notes.join(" ")).toContain("stat_sparklines_v1");
    expect(result.summary).toBe("stats with 1 number");
  });

  it("sends a plain stats figure unchanged, with no note, whatever the server lists", () => {
    for (const capability of [true, false]) {
      const result = build(stats({}), capability);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.block).toEqual(stats({}));
      expect(result.notes).toEqual([]);
    }
  });

  it("refuses points together with a spark, and a spark outside the limits", () => {
    const both = build(stats({ points: samples(5), spark: { values: [1, 2, 3, 4] } }), true);
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.issues.join(" ")).toContain("points or spark, not both");
    const sixtyOne = Array.from({ length: 61 }, (_, i) => i);
    for (const spark of [{ values: [1, 2, 3] }, { values: sixtyOne }, { values: [1, 2, 3, 4], window_seconds: 59 }, { values: [1, 2, 3, 4], window_seconds: 2_592_001 }, { values: [1, 2, 3, 4], extra: 1 }]) {
      expect(build(stats({ spark }), true).ok, JSON.stringify(spark).slice(0, 60)).toBe(false);
    }
    expect(sparkOf(build(stats({ spark: { values: [1, 2, 3, 4], window_seconds: 60 } }), true))).toEqual({ values: [1, 2, 3, 4], window_seconds: 60 });
  });

  it("takes a spark off every item of a stats block and leaves other blocks alone", () => {
    const block = { type: "stats", items: [{ label: "a", value: "1", spark: { values: [1, 2, 3, 4] } }, { label: "b", value: "2" }] };
    expect(withoutStatSparklinesInBlock(block)).toEqual({
      block: { type: "stats", items: [{ label: "a", value: "1" }, { label: "b", value: "2" }] },
      what: ["the sparkline of 1 number"],
    });
    const checks = { type: "checks", items: [] };
    expect(withoutStatSparklinesInBlock(checks)).toEqual({ block: checks, what: [] });
    expect(withoutStatSparklinesInBlock("text")).toEqual({ block: "text", what: [] });
  });
});

describe("what the senders do with a spark", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });
  const sent = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));
  const pickup = (capabilities: string[]) => jsonResponse({ run: { id: "run-1" }, request: {}, server_capabilities: capabilities });
  const withSpark = stats({ spark: { values: [1, 2, 3, 8.1], window_seconds: 180 } }, { title: "Checkout errors" });
  const summaryWith = (figure: unknown) => {
    const summary = structuredSummary();
    (summary.causal_paths[0]!.steps[0] as Record<string, unknown>).figure = figure;
    return summary;
  };
  const figureSent = (index: number) => sent(index).result_summary.causal_paths[0].steps[0].figure;

  it("completes with the spark when the pickup lists stat_sparklines_v1", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1", "figure_extras_v1", "stat_sparklines_v1"]))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", { run_id: "run-1", status: "completed", result_summary: summaryWith(withSpark) });
    expect(figureSent(1)).toEqual(withSpark);
    expect(harness.json(result).mcp_notice).toBeUndefined();
  });

  it("completes without the spark, with a notice, when the pickup does not list it", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1", "figure_extras_v1"]))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", { run_id: "run-1", status: "completed", result_summary: summaryWith(withSpark) });
    expect(figureSent(1)).toEqual(stats({}, { title: "Checkout errors" }));
    const notice = String(harness.json(result).mcp_notice);
    expect(notice).toContain("stat_sparklines_v1");
    expect(notice).toContain("causal_paths[0].steps[0].figure");
  });

  it("strips a timeline block unless the latest pickup listed stat_sparklines_v1", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(pickup(["stat_sparklines_v1", "figure_extras_v1"]))
      .mockResolvedValueOnce(jsonResponse({ id: 2 }));
    const block = stats({ spark: { values: [1, 2, 3, 8.1] } });
    const before = await harness.callTool("tellagen_post_timeline_event", { incident_id: 7, title: "t", body: "b", blocks: [block] });
    expect(sent(0).blocks[0]).toEqual(stats({}));
    expect(harness.json(before).mcp_notice).toContain("stat_sparklines_v1");
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const after = await harness.callTool("tellagen_post_timeline_event", { incident_id: 7, title: "t", body: "b", blocks: [block] });
    expect(sent(2).blocks[0]).toEqual(block);
    expect(harness.json(after).mcp_notice).toBeUndefined();
  });

  it("builds a spark only for a run whose context lists stat_sparklines_v1", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["stat_sparklines_v1"]))
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1"]))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const call = async (run_id: string) =>
      harness.json(await harness.callTool("tellagen_build_figure", { placement: "step_figure", run_id, figure: stats({ points: samples(5, 60) }) }));
    const listed = await call("run-new");
    expect(listed.block.items[0].spark).toEqual({ values: [0, 1, 2, 3, 4], window_seconds: 240 });
    const older = await call("run-old");
    expect(older.block.items[0].spark).toBeUndefined();
    expect(older.notes.join(" ")).toContain("stat_sparklines_v1");
    // A lookup that fails counts as not supported, so an older Tellagen never gets the field.
    const unknown = await call("run-unknown");
    expect(unknown.block.items[0].spark).toBeUndefined();
    // A plain stats figure asks Tellagen nothing.
    await harness.callTool("tellagen_build_figure", { placement: "step_figure", run_id: "run-other", figure: stats({}) });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("names the capability and the figure in the notice", () => {
    const result = stripResultStatSparklines(summaryWith(withSpark));
    expect(result.removed).toEqual(["causal_paths[0].steps[0].figure"]);
    expect(unsupportedNotice(result.removed, "stat_sparklines_v1")).toContain("the sparklines of causal_paths[0].steps[0].figure");
    expect(stripResultStatSparklines(structuredSummary()).removed).toEqual([]);
  });
});

describe("the step figure the completion tool accepts", () => {
  it("takes a stats figure with a spark, a title and eight items", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ label: `Item ${i + 1}`, value: String(i + 1) }));
    const figure = { type: "stats", title: "Tests of the run", items: [{ ...items[0]!, spark: { values: [1, 2, 3, 4], window_seconds: 3600 } }, ...items.slice(1)] };
    expect(stepFigureSchema.safeParse(figure).success).toBe(true);
    expect(stepFigureSchema.safeParse({ type: "stats", items: [...items, items[0]] }).success).toBe(false);
    expect(stepFigureSchema.safeParse({ type: "stats", items: [{ label: "a", value: "1", spark: { values: [1, 2, 3] } }] }).success).toBe(false);
    expect(stepFigureSchema.safeParse({ type: "stats", items: [{ label: "a", value: "1", points: [] }] }).success).toBe(false);
  });
});

describe("the figure guide", () => {
  it("teaches titles that are names, the claim, the caption and the threshold", () => {
    expect(FIGURE_GUIDE).toContain("A title is a name of what the figure shows, not a sentence and not a conclusion");
    expect(FIGURE_GUIDE).toContain("The step claim says the conclusion. Never repeat it in the figure");
    expect(FIGURE_GUIDE).toMatch(/A stats caption is one short fact, for example "SLO 1%"/);
    expect(FIGURE_GUIDE).toContain("It never says how to read the figure.");
    expect(FIGURE_GUIDE).toContain("Send the threshold when there is one");
    expect(FIGURE_GUIDE).toContain("The figure marks what is over it.");
  });

  it("explains the sparkline and its capability", () => {
    expect(FIGURE_GUIDE).toContain("stat_sparklines_v1");
    expect(FIGURE_GUIDE).toContain("at most 60 values");
    expect(FIGURE_GUIDE).toContain("Never write the values of a spark yourself");
    expect(FIGURE_GUIDE).toContain("A sparkline shows the samples side by side, not equal time");
  });

  it("builds its own stats example with a sparkline", () => {
    const example = /\{ "type": "stats", "title": "Checkout errors"[\s\S]*?\] \} \] \}/.exec(FIGURE_GUIDE);
    expect(example).not.toBeNull();
    const result = build(JSON.parse(example![0]), true);
    expect(sparkOf(result)).toEqual({ values: [0.24, 0.27, 3.9, 8.1], window_seconds: 180 });
  });
});
