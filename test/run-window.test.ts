import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stepFigureSchema } from "../src/diagnosis-structure.js";
import { findingChecksProblem } from "../src/tools/findings.js";
import {
  INVESTIGATION_WINDOW_CAPABILITY,
  QUESTION_CHECKS_CAPABILITY,
  WINDOW_RULES,
  suggestionProblem,
  windowNote,
  windowOf,
  withWindowNote,
} from "../src/run-window.js";
import { protocolCapabilities } from "../src/version.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";
import { structuredSummary } from "./helpers/diagnosis-fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const guidance = JSON.parse(
  readFileSync(join(root, "contracts", "runbooks", "v2", "investigation-window.guidance.json"), "utf8"),
) as {
  "x-limits": { window_max_days: number; suggestion_reason_max_chars: number };
  "x-examples": { window: Record<string, string>; good_suggestion: { from: string; to?: string; reason: string }; bad_suggestion: { from: string; to?: string; reason: string } };
};
const checksGuidance = JSON.parse(
  readFileSync(join(root, "contracts", "runbooks", "v2", "question-checks.guidance.json"), "utf8"),
) as { "x-limits": { checks_max: number; check_question_max_chars: number; check_source_max_chars: number } };
const skill = readFileSync(join(root, "SKILL.md"), "utf8");

const WINDOW = guidance["x-examples"].window;
const pickupBody = (capabilities: string[], window: Record<string, string> | null = WINDOW) => ({
  run: { id: "run-1" },
  incident: { id: 42 },
  request: { context: { title: "Checkout 502", time_range: { from: WINDOW.from, to: WINDOW.to }, ...(window ? { window } : {}) } },
  server_capabilities: capabilities,
});

describe("the capabilities", () => {
  it("advertises the window and the question checks at pickup", () => {
    expect(protocolCapabilities()).toEqual(expect.arrayContaining([INVESTIGATION_WINDOW_CAPABILITY, QUESTION_CHECKS_CAPABILITY]));
  });
  it("uses the limits of the vendored guidance", () => {
    expect(guidance["x-limits"].window_max_days).toBe(30);
    expect(guidance["x-limits"].suggestion_reason_max_chars).toBe(200);
    expect(checksGuidance["x-limits"]).toEqual({ checks_max: 3, check_question_max_chars: 200, check_source_max_chars: 120, answer_note_max_chars: 500 });
  });
});

describe("reading the window", () => {
  it("reads request.context.window and cleans it", () => {
    expect(windowOf(pickupBody([]))).toEqual({
      from: "2026-11-14T00:11:00.000Z",
      to: "2026-11-14T01:26:00.000Z",
      basis: "first_signal_ongoing",
      baseline_from: "2026-11-07T00:11:00.000Z",
      first_signal_at: "2026-11-14T00:41:00.000Z",
    });
  });
  it("reads an open window and ignores an answer with no usable start", () => {
    expect(windowOf(pickupBody([], { from: "2026-11-14T00:11:00Z", basis: "person" }))).toEqual({ from: "2026-11-14T00:11:00.000Z", basis: "person" });
    expect(windowOf(pickupBody([], { from: "0001-01-01T00:00:00Z" }))).toBeUndefined();
    expect(windowOf(pickupBody([], null))).toBeUndefined();
    expect(windowOf("nope")).toBeUndefined();
    expect(windowOf({ request: { context: { window: { from: 5 } } } })).toBeUndefined();
  });
  it("puts the window first in a pickup answer, with the three rules, and leaves an answer with none alone", () => {
    const answer = withWindowNote(pickupBody([])) as Record<string, unknown>;
    expect(Object.keys(answer)[0]).toBe("mcp_window");
    const note = answer.mcp_window as Record<string, unknown>;
    expect(note).toMatchObject({ search_from: "2026-11-14T00:11:00.000Z", search_to: "2026-11-14T01:26:00.000Z", baseline_from: "2026-11-07T00:11:00.000Z", baseline_to: "2026-11-14T00:11:00.000Z" });
    expect(note.rules).toEqual(WINDOW_RULES);
    const bare = pickupBody([], null);
    expect(withWindowNote(bare)).toBe(bare);
  });
  it("says that an open window runs until the run ends, and that a run with no baseline has none", () => {
    const note = windowNote({ from: "2026-11-14T00:11:00.000Z" });
    expect(String(note.search_to)).toContain("now");
    expect(note.baseline).toBe("none");
    expect(note.baseline_from).toBeUndefined();
  });
});

describe("a window suggestion", () => {
  const { good_suggestion: good, bad_suggestion: bad } = guidance["x-examples"];
  const now = new Date("2026-11-14T02:00:00Z");
  it("accepts the good example and refuses the bad one", () => {
    expect(suggestionProblem(good, now)).toBeUndefined();
    expect(suggestionProblem(bad, new Date("2026-11-14T02:00:00Z"))).toContain("30 days");
  });
  it("refuses a start in the future, a start after the end and a text that is no time", () => {
    expect(suggestionProblem({ from: "2026-11-14T05:00:00Z", reason: "x" }, now)).toContain("future");
    expect(suggestionProblem({ from: "2026-11-14T01:00:00Z", to: "2026-11-14T00:00:00Z", reason: "x" }, now)).toContain("before");
    expect(suggestionProblem({ from: "later", reason: "x" }, now)).toContain("not a time");
  });
  it("is part of the result summary of the completion tool, with the reason limit", () => {
    const harness = createToolHarness();
    const schema = harness.getTool("tellagen_complete_investigation").config.inputSchema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    const summary = (suggestion: unknown) => ({ ...structuredSummary(), window_suggestion: suggestion });
    expect(schema.result_summary!.safeParse(summary(good)).success).toBe(true);
    expect(schema.result_summary!.safeParse(summary({ ...good, reason: "r".repeat(201) })).success).toBe(false);
    expect(schema.result_summary!.safeParse(summary({ ...good, reason: "" })).success).toBe(false);
    expect(schema.result_summary!.safeParse(summary(bad)).success).toBe(false);
    expect(schema.result_summary!.safeParse(summary({ from: good.from, reason: "Open incident", extra: 1 })).success).toBe(false);
  });
});

describe("checks of a gap finding", () => {
  const check = (question: string, source = "Slack") => ({ source, question });
  it("accepts one to three yes or no questions on a gap", () => {
    expect(findingChecksProblem("gap", "gap", [check("Is the bot a member of the channel?")])).toBeUndefined();
    expect(findingChecksProblem("observation", "gap", [check("Is it?")])).toBeUndefined();
    expect(findingChecksProblem("gap", undefined, undefined)).toBeUndefined();
  });
  it("refuses checks on another finding, a text with no question mark and a compound question", () => {
    expect(findingChecksProblem("observation", undefined, [check("Is it?")])).toContain("gap finding only");
    expect(findingChecksProblem("gap", "gap", [check("Check the channel.")])).toContain("checks[0].question");
    expect(findingChecksProblem("gap", "gap", [check("Is it ok?"), check("Is the bot a member? Is the channel linked?")])).toContain("checks[1].question holds more than one");
    expect(findingChecksProblem("gap", "gap", [check('Is it on?"')])).toContain("question mark");
  });
});

describe("the tools against a Tellagen that lists the capabilities", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });
  const sent = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));
  const url = (index: number) => String(fetchSpy.mock.calls[index]![0]);
  const pick = async (harness: ReturnType<typeof createToolHarness>, body: unknown) => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(body));
    return harness.json(await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" }));
  };

  it("puts the window at the top of the pickup answer", async () => {
    const harness = createToolHarness();
    const out = await pick(harness, pickupBody(["diagnosis_structure_v1"]));
    expect(Object.keys(out)[0]).toBe("mcp_window");
    expect(out.mcp_window.search_from).toBe("2026-11-14T00:11:00.000Z");
    expect(sent(0).protocol_capabilities).toContain("investigation_window_v1");
  });

  it("adds no window for an older Tellagen, and the answer is the one it always was", async () => {
    const harness = createToolHarness();
    const out = await pick(harness, pickupBody([], null));
    expect(out.mcp_window).toBeUndefined();
  });

  it("builds a log_lines figure with the window as its range, from the pickup, with no second call", async () => {
    const harness = createToolHarness();
    await pick(harness, pickupBody(["log_lines_v1"]));
    const result = await harness.callTool("tellagen_build_figure", {
      placement: "step_figure",
      run_id: "run-1",
      figure: {
        type: "log_lines",
        query: '{app="billing-worker"}',
        datasource: "loki",
        scanned: 900,
        streams: [],
      },
    });
    const out = harness.json(result);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.block.source).toMatchObject({ from: "2026-11-14T00:11:00.000Z", to: "2026-11-14T01:26:00.000Z", kind: "logql" });
    expect(out.notes.join(" ")).toContain("run window");
    expect(stepFigureSchema.safeParse(out.block).success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a log_lines figure for a Tellagen that does not list log_lines_v1", async () => {
    const harness = createToolHarness();
    await pick(harness, pickupBody(["diagnosis_structure_v1"]));
    const result = await harness.callTool("tellagen_build_figure", {
      placement: "step_figure",
      run_id: "run-1",
      figure: { type: "log_lines", scanned: 900, streams: [], from: "2026-11-14T00:11:00Z", to: "2026-11-14T01:26:00Z" },
    });
    expect(result.isError).toBe(true);
    expect(harness.json(result).issues[0]).toContain("log_lines_v1");
  });

  it("reads the window of a run it did not pick up from the context, once", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse(pickupBody(["log_lines_v1"])));
    const result = await harness.callTool("tellagen_build_figure", {
      placement: "timeline_block",
      run_id: "run-7",
      figure: { type: "log_lines", scanned: 10, streams: [] },
    });
    expect(harness.json(result).block.source.from).toBe("2026-11-14T00:11:00.000Z");
    expect(url(0)).toContain("/api/v1/investigations/run-7/context");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("defaults a source link to the run window, without asking again, and keeps a range the caller sent", async () => {
    const harness = createToolHarness();
    await pick(harness, pickupBody(["diagnosis_structure_v1"]));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ datasources: [{ name: "grafana", type: "grafana", enabled: true, metadata: { base_url: "https://grafana.example.com" } }] }));
    const result = await harness.callTool("tellagen_build_source_link", { kind: "logs", datasource: "loki-uid", query: '{app="api"}' });
    const out = harness.json(result);
    const decoded = decodeURIComponent(out.links[0].url);
    expect(decoded).toContain(`"from":"${Date.parse("2026-11-14T00:11:00Z")}"`);
    expect(decoded).toContain(`"to":"${Date.parse("2026-11-14T01:26:00Z")}"`);
    expect(out.range).toEqual({ from: "2026-11-14T00:11:00.000Z", to: "2026-11-14T01:26:00.000Z", from_default: "run_window", to_default: "run_window" });
    expect(fetchSpy.mock.calls.map((call) => String(call[0])).filter((u) => u.includes("/context"))).toHaveLength(0);

    fetchSpy.mockResolvedValueOnce(jsonResponse({ datasources: [{ name: "grafana", type: "grafana", enabled: true, metadata: { base_url: "https://grafana.example.com" } }] }));
    const own = harness.json(
      await harness.callTool("tellagen_build_source_link", { kind: "logs", datasource: "loki-uid", query: "{a=\"b\"}", from: "2026-11-14T00:30:00Z", to: "2026-11-14T00:50:00Z" }),
    );
    expect(own.range).toBeUndefined();
    expect(decodeURIComponent(own.links[0].url)).toContain(`"from":"${Date.parse("2026-11-14T00:30:00Z")}"`);
  });

  it("ends an open window at now in a source link", async () => {
    const harness = createToolHarness();
    await pick(harness, pickupBody(["diagnosis_structure_v1"], { from: "2026-11-14T00:11:00Z", basis: "first_signal_ongoing" }));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ datasources: [{ name: "grafana", type: "grafana", enabled: true, metadata: { base_url: "https://grafana.example.com" } }] }));
    const out = harness.json(await harness.callTool("tellagen_build_source_link", { kind: "explore", datasource: "prom", query: "up" }));
    expect(decodeURIComponent(out.links[0].url)).toContain('"to":"now"');
    expect(out.range.to).toBe("now");
    expect(out.range.to_default).toContain("open");
  });

  const logFigure = {
    type: "log_lines",
    matched: 1,
    scanned: 5,
    source: { from: "2026-11-14T00:11:00Z", to: "2026-11-14T01:26:00Z" },
    lines: [{ time: "2026-11-14T00:42:00Z", level: "error", text: "boom" }],
  };

  it("drops a log_lines step figure for a Tellagen without log_lines_v1 and keeps it for one with it", async () => {
    const complete = async (capabilities: string[]) => {
      const harness = createToolHarness();
      fetchSpy.mockReset();
      fetchSpy.mockResolvedValueOnce(jsonResponse(pickupBody(capabilities))).mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
      await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
      const summary = structuredSummary() as { causal_paths: Array<{ steps: Array<Record<string, unknown>> }> };
      summary.causal_paths[0]!.steps[0]!.figure = logFigure;
      const out = harness.json(await harness.callTool("tellagen_complete_investigation", { run_id: "run-1", status: "completed", result_summary: summary }));
      return { out, step: sent(1).result_summary.causal_paths[0].steps[0] };
    };
    const old = await complete(["diagnosis_structure_v1"]);
    expect(old.step.figure).toBeUndefined();
    expect(old.out.mcp_notice).toContain("log_lines_v1");
    const current = await complete(["diagnosis_structure_v1", "log_lines_v1"]);
    expect(current.step.figure).toEqual(logFigure);
    expect(current.out.mcp_notice ?? "").not.toContain("log_lines_v1");
  });

  it("leaves a window suggestion out for a run that has no window, and says so", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse(pickupBody(["diagnosis_structure_v1"], null))).mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const out = harness.json(await harness.callTool("tellagen_complete_investigation", { run_id: "run-1", status: "completed", result_summary: { ...structuredSummary(), window_suggestion: guidance["x-examples"].good_suggestion } }));
    expect(sent(1).result_summary.window_suggestion).toBeUndefined();
    expect(out.mcp_notice).toContain("window_suggestion was not sent");
  });

  it("sends a window suggestion with the result unchanged", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse(pickupBody(["diagnosis_structure_v1"]))).mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const suggestion = guidance["x-examples"].good_suggestion;
    await harness.callTool("tellagen_complete_investigation", { run_id: "run-1", status: "completed", result_summary: { ...structuredSummary(), window_suggestion: suggestion } });
    expect(sent(1).result_summary.window_suggestion).toEqual(suggestion);
  });

  it("leaves a log_lines block off a timeline event for a Tellagen without log_lines_v1", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse(pickupBody(["diagnosis_structure_v1"]))).mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const stats = { type: "stats", items: [{ label: "Errors", value: "1" }] };
    const out = harness.json(await harness.callTool("tellagen_post_timeline_event", { incident_id: 7, title: "t", body: "b", blocks: [logFigure, stats] }));
    expect(sent(1).blocks).toEqual([stats]);
    expect(out.mcp_notice).toContain("log_lines_v1");
  });

  const gap = (checks?: unknown) => ({
    incident_id: 42,
    investigation_run_id: "run-1",
    finding_type: "gap",
    role: "gap",
    claim: "Can the bot post in channel C0A8FBWB199?",
    evidence_summary: "The Slack connector could not read the channel.",
    confidence: 0.5,
    confidence_reason: "Source not readable",
    evidence_refs: [],
    ...(checks === undefined ? {} : { checks }),
  });
  const checks = [
    { source: "Slack", question: "Is the bot a member of channel C0A8FBWB199?" },
    { source: "Tellagen workspace", question: "Is that channel linked to an incident of company 5?" },
  ];

  it("sends the checks of a gap finding when the Tellagen lists question_checks_v1", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse(pickupBody(["question_checks_v1"]))).mockResolvedValueOnce(jsonResponse({ finding: { id: 5 } }, 201));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const out = harness.json(await harness.callTool("tellagen_post_finding", gap(checks)));
    expect(sent(1).checks).toEqual(checks);
    expect(out.mcp_notice).toBeUndefined();
  });

  it("leaves the checks off for a Tellagen that does not list it, and says so", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse(pickupBody(["diagnosis_structure_v1"]))).mockResolvedValueOnce(jsonResponse({ finding: { id: 5 } }, 201));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const out = harness.json(await harness.callTool("tellagen_post_finding", gap(checks)));
    expect(sent(1).checks).toBeUndefined();
    expect(out.mcp_notice).toContain("question_checks_v1");
  });

  it("refuses bad checks before anything is sent", async () => {
    const harness = createToolHarness();
    const result = await harness.callTool("tellagen_post_finding", gap([{ source: "Slack", question: "Check the channel." }]));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("question mark");
    expect(fetchSpy).not.toHaveBeenCalled();
    const input = harness.getTool("tellagen_post_finding").config.inputSchema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(input.checks!.safeParse([]).success).toBe(false);
    expect(input.checks!.safeParse([checks[0], checks[1], checks[0], checks[1]]).success).toBe(false);
    expect(input.checks!.safeParse([{ source: "x".repeat(121), question: "Is it?" }]).success).toBe(false);
    expect(input.checks!.safeParse([{ source: "x", question: `${"q".repeat(200)}?` }]).success).toBe(false);
    expect(input.checks!.safeParse(checks).success).toBe(true);
  });
});

describe("the skill", () => {
  it("teaches the window rules, the suggestion and the checks", () => {
    expect(skill).toContain("window_suggestion");
    expect(skill).toContain("baseline");
    expect(skill).toContain("tellagen_post_finding");
    for (const sentence of [guidance["x-examples"].good_suggestion.reason]) expect(skill).toContain(sentence);
    expect(skill).toContain("log_lines");
    expect(skill).toContain("unrelated");
  });
});
