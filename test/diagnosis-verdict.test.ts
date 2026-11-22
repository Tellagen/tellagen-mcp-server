import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  DIAGNOSIS_VERDICT_CAPABILITY,
  ALERT_VERDICT_CAPABILITY,
  summarizeWarnings,
  unsupportedNotice,
} from "../src/diagnosis-structure.js";
import { stripVerdictExtras } from "../src/fix-options.js";
import { guideSection } from "../src/guide-resources.js";
import { structuredSummary } from "./helpers/diagnosis-fixtures.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");

const expected = {
  verdict: "expected_behavior",
  reason: "third_party_behavior",
  owner: "third_party",
  would_change_mind: { text: "The browser accepts the test cookie." },
};

describe("a verdict for every diagnosis", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());
  const body = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));
  const BASE = ["diagnosis_structure_v1", "completion_repairs_v1"];

  let runCounter = 0;
  async function pickedUp(capabilities: string[]) {
    const runId = `any-verdict-run-${++runCounter}`;
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: runId }, request: {}, server_capabilities: capabilities }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: runId });
    fetchSpy.mockClear();
    fetchSpy.mockImplementation(async () => jsonResponse({ dry_run: true, ready: true, repairs: [], warnings: [] }));
    return harness;
  }
  const complete = (harness: Awaited<ReturnType<typeof pickedUp>>, extra: Record<string, unknown>) =>
    harness.callTool("tellagen_complete_investigation", { status: "completed", result_summary: { ...structuredSummary(), ...extra } });

  it("sends expected_behavior and the owner when the pickup lists diagnosis_verdict_v1", async () => {
    const harness = await pickedUp([...BASE, DIAGNOSIS_VERDICT_CAPABILITY]);
    const out = await complete(harness, { alert_verdict: expected });
    expect(body(0).result_summary.alert_verdict).toEqual(expected);
    expect(String(harness.lastJson(out).mcp_notice ?? "")).not.toContain(DIAGNOSIS_VERDICT_CAPABILITY);
  });

  it("sends a verdict on a run with no alert only with diagnosis_verdict_v1", async () => {
    const harness = await pickedUp(BASE);
    const out = await complete(harness, { alert_verdict: { verdict: "real_problem", reason: "customer_impact" } });
    expect(body(0).result_summary.alert_verdict).toBeUndefined();
    expect(String(harness.lastJson(out).mcp_notice)).toContain(ALERT_VERDICT_CAPABILITY);
  });

  it("drops expected_behavior and says so when only alert_verdict_v1 is listed", async () => {
    const harness = await pickedUp([...BASE, ALERT_VERDICT_CAPABILITY]);
    const out = await complete(harness, { alert_verdict: expected });
    expect(body(0).result_summary.alert_verdict).toBeUndefined();
    expect(body(0).result_summary.conclusion).toBeDefined();
    expect(String(harness.lastJson(out).mcp_notice)).toContain(DIAGNOSIS_VERDICT_CAPABILITY);
  });

  it("drops only the owner of a verdict that an alert run may send", async () => {
    const harness = await pickedUp([...BASE, ALERT_VERDICT_CAPABILITY]);
    await complete(harness, { alert_verdict: { verdict: "real_problem", reason: "customer_impact", owner: "ours" } });
    expect(body(0).result_summary.alert_verdict).toEqual({ verdict: "real_problem", reason: "customer_impact" });
  });

  it("strips nothing from a verdict that needs nothing extra", () => {
    const summary = { ...structuredSummary(), alert_verdict: { verdict: "false_alarm", reason: "rule_wrong" } };
    expect(stripVerdictExtras(summary).removed).toEqual([]);
    expect(stripVerdictExtras(structuredSummary()).removed).toEqual([]);
    expect(stripVerdictExtras("text").removed).toEqual([]);
  });

  it("checks the verdict, the reasons and the owner in the tool schema", () => {
    const harness = createToolHarness();
    const schema = harness.getTool("tellagen_complete_investigation").config.inputSchema!.result_summary as z.ZodTypeAny;
    const parse = (alert_verdict: unknown) => schema.safeParse({ ...structuredSummary(), alert_verdict });
    expect(parse(expected).success).toBe(true);
    expect(parse({ verdict: "expected_behavior", reason: "works_as_designed", owner: "ours" }).success).toBe(true);
    expect(parse({ verdict: "expected_behavior", owner: "vendor" }).success).toBe(false);
    expect(parse({ verdict: "expected_behavior", reason: "whatever" }).success).toBe(false);
    const stripped = schema.parse({ ...structuredSummary(), alert_verdict: { verdict: "expected_behavior", standing: "clear", held_items: [] } }) as {
      alert_verdict: Record<string, unknown>;
    };
    expect(stripped.alert_verdict.standing).toBeUndefined();
    expect(stripped.alert_verdict.held_items).toBeUndefined();
  });

  it("explains the held verdict and the server-owned fields", () => {
    const line = summarizeWarnings(["verdict_held", "server_owned_field_ignored"].map((code) => ({ code }))) ?? "";
    expect(line).toMatch(/1 verdict_held \(/);
    expect(line).toMatch(/1 server_owned_field_ignored \(/);
    expect(unsupportedNotice(["alert_verdict (expected_behavior)"], DIAGNOSIS_VERDICT_CAPABILITY)).toContain("diagnosis_verdict_v1");
  });

  it("is taught in the completion guide", () => {
    const section = guideSection(skill, "## Diagnosis structure");
    for (const text of ["diagnosis_verdict_v1", "expected_behavior", "held_items", "`owner`", "verdict_held", "server_owned_field_ignored"]) {
      expect(section, text).toContain(text);
    }
  });
});
