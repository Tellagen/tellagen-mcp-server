import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ALERT_VERDICT_CAPABILITY,
  stripResultAlertVerdict,
  summarizeWarnings,
  unsupportedNotice,
} from "../src/diagnosis-structure.js";
import { guideSection } from "../src/guide-resources.js";
import { INSTRUCTIONS } from "../src/server.js";
import { structuredSummary } from "./helpers/diagnosis-fixtures.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");

const verdict = {
  verdict: "false_alarm",
  reason: "rule_needs_tuning",
  onset: { state: "standing", since: "2026-11-14T09:00:00Z" },
  would_change_mind: {
    text: "Checkout 5xx above 0.5%.",
    check: { command_id: "cmd-4", op: "above", value: 0.5, unit: "%" },
  },
  proof: [
    { id: "rule_read", done: true, finding_ids: [11] },
    { id: "baseline", done: true, finding_ids: [13] },
  ],
};

describe("the alert verdict", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());
  const body = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));
  const BASE = ["diagnosis_structure_v1", "completion_repairs_v1"];

  let runCounter = 0;
  async function pickedUp(capabilities: string[]) {
    const runId = `verdict-run-${++runCounter}`;
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: runId }, request: {}, server_capabilities: capabilities }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: runId });
    fetchSpy.mockClear();
    return harness;
  }
  const complete = (harness: Awaited<ReturnType<typeof pickedUp>>, extra: Record<string, unknown>) =>
    harness.callTool("tellagen_complete_investigation", {
      status: "completed",
      result_summary: { ...structuredSummary(), ...extra },
    });

  it("is sent when the pickup lists alert_verdict_v1", async () => {
    const harness = await pickedUp([...BASE, ALERT_VERDICT_CAPABILITY]);
    fetchSpy.mockImplementation(async () => jsonResponse({ dry_run: true, ready: true, repairs: [], warnings: [] }));
    const out = await complete(harness, { alert_verdict: verdict });
    expect(body(0).result_summary.alert_verdict).toEqual(verdict);
    expect(String(harness.lastJson(out).mcp_notice ?? "")).not.toContain(ALERT_VERDICT_CAPABILITY);
  });

  it("is left out, and says so, against an older Tellagen", async () => {
    const harness = await pickedUp(BASE);
    fetchSpy.mockImplementation(async () => jsonResponse({ dry_run: true, ready: true, repairs: [], warnings: [] }));
    const out = await complete(harness, { alert_verdict: verdict });
    const sent = body(0).result_summary;
    expect(sent.alert_verdict).toBeUndefined();
    expect(sent.conclusion).toBeDefined();
    const notice = String(harness.lastJson(out).mcp_notice);
    expect(notice).toContain(ALERT_VERDICT_CAPABILITY);
    expect(notice).toContain("alert verdict was not sent");
  });

  it("is left out of the real call too, for a Tellagen that has no dry run", async () => {
    const harness = await pickedUp(["diagnosis_structure_v1"]);
    fetchSpy.mockImplementation(async () => jsonResponse({ id: "x", status: "completed", warnings: [] }));
    await complete(harness, { alert_verdict: verdict });
    expect(body(0).result_summary.alert_verdict).toBeUndefined();
  });

  it("sends nothing about a verdict when the result has none", async () => {
    const harness = await pickedUp(BASE);
    fetchSpy.mockImplementation(async () => jsonResponse({ dry_run: true, ready: true, repairs: [], warnings: [] }));
    const out = await complete(harness, {});
    expect("alert_verdict" in body(0).result_summary).toBe(false);
    expect(String(harness.lastJson(out).mcp_notice ?? "")).not.toContain(ALERT_VERDICT_CAPABILITY);
  });

  it("strips only the verdict", () => {
    const summary = { ...structuredSummary(), alert_verdict: verdict };
    const result = stripResultAlertVerdict(summary);
    expect(result.removed).toEqual(["alert_verdict"]);
    expect((result.summary as Record<string, unknown>).conclusion).toBeDefined();
    expect(stripResultAlertVerdict(structuredSummary()).removed).toEqual([]);
    expect(stripResultAlertVerdict("text").removed).toEqual([]);
  });

  it("is checked by the tool schema, and the server-set fields are not accepted", () => {
    const harness = createToolHarness();
    const schema = harness.getTool("tellagen_complete_investigation").config.inputSchema!.result_summary as z.ZodTypeAny;
    const parse = (alert_verdict: unknown) => schema.safeParse({ ...structuredSummary(), alert_verdict });
    expect(parse(verdict).success).toBe(true);
    expect(parse({ verdict: "not_sure" }).success).toBe(true);
    expect(parse({ verdict: "maybe" }).success).toBe(false);
    expect(parse({ verdict: "false_alarm", onset: { state: "new", since: "yesterday" } }).success).toBe(false);
    expect(parse({ verdict: "already_handled", incident_id: "INC 123" }).success).toBe(false);
    expect(parse({ verdict: "already_handled", reason: "known_incident", incident_id: "INC-123" }).success).toBe(true);
    expect(parse({ verdict: "false_alarm", reason: "because" }).success).toBe(false);
    expect(parse({ verdict: "real_problem", proof: [{ id: "guess", done: true }] }).success).toBe(false);
    expect(parse({ verdict: "false_alarm", would_change_mind: { text: "x".repeat(201) } }).success).toBe(false);
    expect(parse({ verdict: "false_alarm", would_change_mind: { text: "x", check: { command_id: "c", op: "equals", value: 1 } } }).success).toBe(false);
    expect(parse({ verdict: "real_problem", proof: Array.from({ length: 10 }, () => ({ id: "onset", done: true })) }).success).toBe(false);
    const stripped = schema.parse({ ...structuredSummary(), alert_verdict: { verdict: "not_sure", downgraded_from: "false_alarm", missing: ["onset"] } }) as {
      alert_verdict: Record<string, unknown>;
    };
    expect(stripped.alert_verdict.downgraded_from).toBeUndefined();
    expect(stripped.alert_verdict.missing).toBeUndefined();
  });

  it("explains the warnings of the verdict and the evidence rules", () => {
    const codes = [
      "verdict_downgraded",
      "verdict_proof_missing",
      "verdict_without_onset",
      "verdict_without_change_mind",
      "verdict_real_without_impact_check",
      "cause_without_runtime_evidence",
      "empty_result_link_dropped",
      "step_names_fix_not_cause",
      "false_alarm_without_rule",
    ];
    const line = summarizeWarnings(codes.map((code) => ({ code }))) ?? "";
    for (const code of codes) expect(line).toMatch(new RegExp(`1 ${code} \\(`));
  });

  it("names the capability and the way out in the notice", () => {
    const notice = unsupportedNotice(["alert_verdict"], ALERT_VERDICT_CAPABILITY);
    expect(notice).toContain("alert_verdict_v1");
    expect(notice).toContain("headline");
  });
});

describe("the guide of the alert verdict", () => {
  it("is in the completion guide, with the method, the proof and the evidence rules", () => {
    const section = guideSection(skill, "## Diagnosis structure");
    for (const text of [
      "alert_verdict_v1",
      "Judge the alert first",
      "not_sure",
      "would_change_mind",
      "rule_read",
      "never a percentage",
      "cause_without_runtime_evidence",
      "empty_result_link_dropped",
      "step_names_fix_not_cause",
      "false_alarm_without_rule",
      "verdict_downgraded",
    ]) {
      expect(section, text).toContain(text);
    }
  });

  it("is in the server instructions in one line", () => {
    expect(INSTRUCTIONS).toContain("alert_verdict_v1");
    expect(INSTRUCTIONS).toContain("judge the alert first");
  });
});
