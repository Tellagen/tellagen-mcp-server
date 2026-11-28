import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { currentStateSchema, ruledOutSchema, stripResultPlainStatus, unsupportedNotice } from "../src/diagnosis-structure.js";
import { GUIDE_RESOURCES, guideResourceText } from "../src/guide-resources.js";
import { resultSummarySchema } from "../src/tools/investigations.js";
import { INVESTIGATION_PROTOCOL_CAPABILITIES } from "../src/version.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";
import { structuredSummary } from "./helpers/diagnosis-fixtures.js";

const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");

const currentState = { state: "ongoing", text: "On the panel, yes. It reads 10 s while listeners poll. Users are not affected." };
const stillPossible = "One failure at 11:37, such as a single 401.";

/** A result with both plain status fields. */
const summary = () => ({
  ...structuredSummary(),
  current_state: currentState,
  ruled_out: [
    { label: "Database saturation", explanation: "Connections stayed under 40% of the pool.", still_possible: stillPossible },
    { label: "Traffic spike", explanation: "Requests stayed flat." },
  ],
});

describe("the plain status in the result schema", () => {
  it("keeps current_state and still_possible through the input check", () => {
    const parsed = resultSummarySchema.parse(summary());
    expect(parsed.current_state).toEqual(currentState);
    expect(parsed.ruled_out?.[0]?.still_possible).toBe(stillPossible);
    expect(parsed.ruled_out?.[1]).not.toHaveProperty("still_possible");
  });

  it("takes the three states and no other, and needs a text", () => {
    for (const state of ["ongoing", "stopped", "unknown"]) {
      expect(currentStateSchema.safeParse({ state, text: "No query shows it." }).success, state).toBe(true);
    }
    expect(currentStateSchema.safeParse({ state: "resolved", text: "All good." }).success).toBe(false);
    expect(currentStateSchema.safeParse({ state: "ongoing" }).success).toBe(false);
    expect(currentStateSchema.safeParse({ state: "ongoing", text: "" }).success).toBe(false);
    expect(ruledOutSchema.safeParse({ label: "x", still_possible: "y".repeat(301) }).success).toBe(false);
  });

  it("takes both fields off a result, and names each one", () => {
    const result = stripResultPlainStatus(summary());
    expect(result.removed).toEqual(["current_state", "ruled_out[0].still_possible"]);
    const next = result.summary as Record<string, any>;
    expect(next.current_state).toBeUndefined();
    expect(next.ruled_out).toEqual([
      { label: "Database saturation", explanation: "Connections stayed under 40% of the pool." },
      { label: "Traffic spike", explanation: "Requests stayed flat." },
    ]);
    expect(stripResultPlainStatus(structuredSummary()).removed).toEqual([]);
    expect(unsupportedNotice(result.removed, "plain_status_v1")).toContain("plain_status_v1");
  });
});

describe("what the senders do with the plain status", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });
  const sent = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));
  const pickup = (capabilities: string[]) =>
    jsonResponse({ run: { id: "run-1" }, incident: { id: 42 }, request: {}, server_capabilities: capabilities });

  it("advertises plain_status_v1 at pickup", async () => {
    expect(INVESTIGATION_PROTOCOL_CAPABILITIES).toContain("plain_status_v1");
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(pickup(["diagnosis_structure_v1"]));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    expect(sent(0).protocol_capabilities).toContain("plain_status_v1");
  });

  it("completes with both fields when the pickup lists plain_status_v1", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1", "plain_status_v1"]))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", { run_id: "run-1", status: "completed", result_summary: summary() });
    expect(sent(1).result_summary.current_state).toEqual(currentState);
    expect(sent(1).result_summary.ruled_out[0].still_possible).toBe(stillPossible);
    expect(harness.json(result).mcp_notice).toBeUndefined();
  });

  it("sends a Tellagen that does not list it exactly the body of a result without the fields", async () => {
    const bodyFor = async (result: unknown) => {
      fetchSpy.mockReset();
      const harness = createToolHarness();
      fetchSpy
        .mockResolvedValueOnce(pickup(["diagnosis_structure_v1"]))
        .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
      await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
      await harness.callTool("tellagen_complete_investigation", { run_id: "run-1", status: "completed", result_summary: result });
      return sent(1);
    };
    const withFields = await bodyFor(summary());
    const { current_state: _state, ...rest } = summary();
    const today = await bodyFor({
      ...rest,
      ruled_out: rest.ruled_out.map(({ still_possible: _still, ...entry }: Record<string, unknown>) => entry),
    });
    expect(withFields).toEqual(today);
  });

  it("leaves both fields out, with a notice, for a Tellagen that does not list it", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1"]))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", { run_id: "run-1", status: "completed", result_summary: summary() });
    const body = sent(1).result_summary;
    expect(body).not.toHaveProperty("current_state");
    expect(body.ruled_out).toHaveLength(2);
    expect(body.ruled_out[0]).not.toHaveProperty("still_possible");
    expect(body.ruled_out[0].explanation).toBe("Connections stayed under 40% of the pool.");
    const notice = String(harness.json(result).mcp_notice);
    expect(notice).toContain("plain_status_v1");
    expect(notice).toContain("current_state");
    expect(notice).toContain("ruled_out[0].still_possible");
  });

  it("sends a dry run with the fields too, so Tellagen can check them before the run completes", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1", "plain_status_v1", "completion_repairs_v1"]))
      .mockResolvedValueOnce(jsonResponse({ dry_run: true, ready: true, repairs: [] }))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    await harness.callTool("tellagen_complete_investigation", { run_id: "run-1", status: "completed", result_summary: summary() });
    expect(sent(1).dry_run).toBe(true);
    expect(sent(1).result_summary.current_state).toEqual(currentState);
    expect(sent(2).result_summary.current_state).toEqual(currentState);
  });

  it("applies the same rule to an addition to a finished run", async () => {
    for (const [capabilities, kept] of [
      [["run_amendments_v1", "diagnosis_structure_v1", "plain_status_v1"], true],
      [["run_amendments_v1", "diagnosis_structure_v1"], false],
    ] as const) {
      fetchSpy.mockReset();
      const harness = createToolHarness();
      fetchSpy
        .mockResolvedValueOnce(pickup([...capabilities]))
        .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1", version: 2 }, amendment: { version: 2 }, findings: [], warnings: [] }));
      await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
      harness.client.session.rememberAmendable("run-1");
      const result = await harness.callTool("tellagen_amend_investigation", { reason: "The panel is back to normal.", result_summary: summary() });
      const body = sent(1).result_summary;
      expect("current_state" in body, String(kept)).toBe(kept);
      expect("still_possible" in body.ruled_out[0], String(kept)).toBe(kept);
      expect(String(harness.json(result).mcp_notice ?? "").includes("plain_status_v1")).toBe(!kept);
    }
  });
});

describe("the guides teach the plain writing rules", () => {
  const completion = guideResourceText(skill, GUIDE_RESOURCES.find((resource) => resource.name === "guide-completion")!);

  it("in the skill guide and in the completion guide", () => {
    for (const text of [skill, completion]) {
      for (const rule of [
        "**One fact in each sentence.**",
        "**A time is HH:MM UTC**",
        "**No raw id in a sentence.**",
        "**The headline matches the stored values.**",
        "**A real question.**",
        "names the host or the system it is about",
        "**An instruction that names where.**",
        "starts with a verb and names the dashboard, the file or the host",
      ]) {
        expect(text, rule).toContain(rule);
      }
    }
  });

  it("with current_state and still_possible, their limits and their capability", () => {
    for (const text of [skill, completion]) {
      expect(text).toContain("`plain_status_v1`");
      expect(text).toContain("`result_summary.current_state`");
      expect(text).toContain("`still_possible`");
      expect(text).toContain("Send `unknown` when no query shows it. Never guess.");
      expect(text).toMatch(/`ruled_out` `still_possible` 20, `current_state` `text` 20/);
    }
  });

  it("with examples that keep their own limits", () => {
    const words = (text: string) => text.trim().split(/\s+/).length;
    expect(words(currentState.text)).toBeLessThanOrEqual(20);
    expect(words(stillPossible)).toBeLessThanOrEqual(20);
    expect(skill).toContain(currentState.text);
    expect(skill).toContain(stillPossible);
  });

  it("and the tool says when to send the fields", () => {
    const harness = createToolHarness();
    const schema = harness.getTool("tellagen_complete_investigation").config.inputSchema!.result_summary as z.ZodTypeAny;
    const description = JSON.stringify((schema as any)._def.innerType.shape.current_state._def);
    expect(description).toContain("plain_status_v1");
  });
});
