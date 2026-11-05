import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { summarizeWarnings } from "../src/diagnosis-structure.js";
import { buildFigure } from "../src/figures.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");

/** The text between a heading line and the next heading of the same or higher level. */
function section(heading: string): string {
  const start = skill.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`SKILL.md has no section ${heading}`);
  const level = heading.match(/^#+/)![0].length;
  const rest = skill.slice(start + heading.length + 2);
  const next = new RegExp(`\\n#{1,${level}} `).exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

const jsonBlocks = (text: string): unknown[] =>
  [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!));

const summaryRef = {
  source: "grafana-loki",
  result_summary: "847 errors in 30 minutes",
  evidence_fact_key: "run-1:summary:0a1b2c3d4e5f6071",
};

describe("evidence_fact_key on a finding", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const finding = (evidence_refs: unknown[]) => ({
    incident_id: 42,
    investigation_run_id: "run-1",
    finding_type: "observation",
    claim: "Errors rose after the deploy",
    evidence_summary: "847 errors in 30 minutes",
    confidence: 0.8,
    confidence_reason: "Direct log count",
    evidence_refs,
  });

  it("accepts the summary key of a trace step with no identifier, which is what SKILL.md says to copy", () => {
    const harness = createToolHarness();
    const schema = harness.getTool("tellagen_post_finding").config.inputSchema!
      .evidence_refs as z.ZodTypeAny;
    expect(schema.safeParse([summaryRef]).success).toBe(true);
  });

  it("sends the key unchanged and says it may not join the trace step", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ finding: { id: 5 } }, 201));
    const result = await harness.callTool("tellagen_post_finding", finding([summaryRef]));
    expect(result.isError).toBeUndefined();
    const sent = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(sent.evidence_refs).toEqual([summaryRef]);
    expect(harness.json(result).finding.id).toBe(5);
    expect(harness.json(result).mcp_notice).toContain("tool_use_id");
  });

  it("adds no notice when the ref carries an identifier, or no key at all", async () => {
    const harness = createToolHarness();
    for (const ref of [
      { ...summaryRef, tool_use_id: "check-1-loki" },
      { ...summaryRef, artifact_id: "artifact-1" },
      { ...summaryRef, artifact_digest: "sha256:abc" },
      { source: "grafana-loki", result_summary: "847 errors in 30 minutes" },
    ]) {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ finding: { id: 6 } }, 201));
      const result = await harness.callTool("tellagen_post_finding", finding([ref]));
      expect(harness.json(result).mcp_notice, JSON.stringify(ref)).toBeUndefined();
    }
  });

  it("keeps the notice when the same call also loses structure fields on an older backend", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ server_capabilities: [] }))
      .mockResolvedValueOnce(jsonResponse({ finding: { id: 7 } }, 201));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool(
      "tellagen_post_finding",
      finding([{ ...summaryRef, command: "kubectl get pods" }]),
    );
    const notice = String(harness.json(result).mcp_notice);
    expect(notice).toContain("tool_use_id");
    expect(notice).toContain("command");
  });
});

describe("SKILL.md result_summary example", () => {
  const harness = createToolHarness();
  const schema = z.object(
    harness.getTool("tellagen_complete_investigation").config.inputSchema as Record<string, z.ZodTypeAny>,
  );
  const [minimal] = jsonBlocks(section("### Minimal result_summary")) as Array<Record<string, unknown>>;

  it("is a result_summary the completion tool accepts", () => {
    const parsed = schema.safeParse({ run_id: "run-1", status: "completed", result_summary: minimal });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("holds exactly the keys the guide calls required, and the tool refuses one without each of them", () => {
    const required = ["conclusion", "likely_cause_label", "customer_impact", "confidence_percent", "signals_checked", "takeaways"];
    for (const key of required) {
      expect(section("### Minimal result_summary"), key).toContain(`| \`${key}\``);
      const { [key]: _removed, ...without } = minimal!;
      const parsed = schema.safeParse({ run_id: "run-1", status: "completed", result_summary: without });
      expect(parsed.success, `without ${key}`).toBe(false);
    }
    const optional = { ...minimal! } as Record<string, unknown>;
    for (const key of required) delete optional[key];
    expect(Object.keys(optional).sort()).toEqual(["assessment", "causal_paths"]);
  });

  it("names the four keys of conclusion and the values of diagnosis_state that the tool accepts", () => {
    const conclusion = Object.keys((minimal!.conclusion as object)).sort();
    expect(conclusion).toEqual(["eyebrow", "sentence", "show_new_investigation_cta", "tone"]);
    for (const state of ["confirmed", "likely", "incomplete", "inconclusive", "unknown"]) {
      expect(section("### Minimal result_summary"), state).toContain(`\`${state}\``);
      const parsed = schema.safeParse({
        run_id: "run-1",
        status: "completed",
        result_summary: { ...minimal!, assessment: { diagnosis_state: state } },
      });
      expect(parsed.success, state).toBe(true);
    }
  });
});

describe("SKILL.md figure recipes", () => {
  const recipes = jsonBlocks(section("### Figures for a regression")) as Array<Record<string, unknown>>;

  it("covers run_history, checks, stats and diff", () => {
    expect(recipes.map((recipe) => recipe.type)).toEqual(["run_history", "checks", "stats", "diff"]);
  });

  it.each(["run_history", "checks", "stats", "diff"])("builds the %s example as a step figure", (type) => {
    const figure = recipes.find((recipe) => recipe.type === type)!;
    const result = buildFigure({ placement: "step_figure", figure });
    expect(result.ok, result.ok ? "" : result.issues.join("; ")).toBe(true);
  });

  it("maps a cancelled run to cancelled, not to a failure", () => {
    const run = (conclusion: string, number: number) => ({
      number,
      headSha: `abc${number}`,
      conclusion,
      startedAt: `2026-10-30T0${number % 10}:00:00Z`,
    });
    const result = buildFigure({
      placement: "step_figure",
      figure: { type: "run_history", github_runs: [run("success", 1), run("cancelled", 2)] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.block.runs as Array<{ result: string }>).map((r) => r.result)).toEqual(["success", "cancelled"]);
    }
  });
});

describe("SKILL.md guidance that the tool schemas back", () => {
  const harness = createToolHarness();

  it("lists the change ref results it names", () => {
    const schema = z.object(
      harness.getTool("tellagen_complete_investigation").config.inputSchema as Record<string, z.ZodTypeAny>,
    );
    const base = {
      conclusion: { tone: "neutral", eyebrow: "x", sentence: "x", show_new_investigation_cta: false },
      likely_cause_label: "",
      customer_impact: { status: "unknown", verified: false, label: "x" },
      confidence_percent: 0,
      signals_checked: { checked: 0, total: 0 },
      takeaways: [],
    };
    for (const result of ["success", "failure", "cancelled", "skipped", "pending", "unknown"]) {
      expect(skill, result).toContain(`\`${result}\``);
      const parsed = schema.safeParse({
        run_id: "run-1",
        status: "completed",
        result_summary: { ...base, change_refs: [{ role: "first_bad", kind: "ci_run", ref: "41289327533", result }] },
      });
      expect(parsed.success, result).toBe(true);
    }
  });

  it("gives finding roles for negative and gap findings that the tool accepts", () => {
    const schema = z.object(harness.getTool("tellagen_post_finding").config.inputSchema as Record<string, z.ZodTypeAny>);
    const base = {
      incident_id: 1,
      investigation_run_id: "run-1",
      claim: "c",
      evidence_summary: "e",
      confidence: 0.5,
      confidence_reason: "r",
    };
    expect(schema.safeParse({ ...base, finding_type: "negative", role: "contradicts" }).success).toBe(true);
    expect(schema.safeParse({ ...base, finding_type: "gap", role: "gap" }).success).toBe(true);
    expect(skill).toContain('`role: "contradicts"`');
    expect(skill).toContain('`role: "gap"`');
  });

  it("tells the agent how to avoid single_source_high_confidence, in the guide and in the summary line", () => {
    expect(skill).toContain("single_source_high_confidence");
    expect(skill).toContain("`confidence_percent` of 90 or less");
    const line = summarizeWarnings([{ code: "single_source_high_confidence" }]);
    expect(line).toContain("90 or less");
    expect(line).toContain("second source");
  });

  it("shows warnings_summary only when there are warnings", () => {
    expect(summarizeWarnings([])).toBeUndefined();
    expect(summarizeWarnings(undefined)).toBeUndefined();
    expect(skill).toContain("it is present only when `warnings` is not empty");
  });
});
