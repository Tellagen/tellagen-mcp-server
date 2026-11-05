import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { stripResultChanges, summarizeWarnings, unsupportedNotice } from "../src/diagnosis-structure.js";
import { buildSourceLinks } from "../src/tools/source-links.js";
import { TellagenClient } from "../src/client.js";
import { commitLink, structuredSummary } from "./helpers/diagnosis-fixtures.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const runLink = {
  kind: "ci_run",
  label: "CI run 41289327533 on GitHub",
  url: "https://github.com/acme/checkout/actions/runs/41289327533",
};

/** A regression and its fix, as SKILL.md "Regression and CI failures" asks for. */
const changeRefs = () => [
  {
    id: "regression",
    role: "regression_source",
    kind: "pull_request",
    title: "Move the header to a sticky layout",
    repo: "acme/checkout",
    ref: "4412",
    sha: "4B7A2D1",
    occurred_at: "2026-10-30T08:40:00Z",
    state: "merged",
    verification: "confirmed",
    confidence_percent: 90,
    step_ids: ["step-1"],
    finding_ids: [12],
    links: [commitLink],
  },
  { role: "last_good", kind: "ci_run", repo: "acme/checkout", ref: "41289320001", result: "success", finding_ids: [12] },
  { role: "first_bad", kind: "ci_run", repo: "acme/checkout", ref: "41289327533", result: "failure", links: [runLink], finding_ids: [12] },
  { role: "fix", kind: "commit", repo: "acme/checkout", sha: "c0ffee1", title: "Restore the static header", finding_ids: [13] },
  { role: "verified_by", kind: "ci_run", repo: "acme/checkout", ref: "41289400002", result: "success", finding_ids: [13] },
];

const summaryWithChanges = () => {
  const summary = structuredSummary() as Record<string, any>;
  summary.change_refs = changeRefs();
  summary.causal_paths[0].steps[0].links = [commitLink, runLink];
  return summary;
};

describe("change_refs on tellagen_complete_investigation", () => {
  const harness = createToolHarness();
  const schema = z.object(
    harness.getTool("tellagen_complete_investigation").config.inputSchema as Record<string, z.ZodTypeAny>,
  );
  const parse = (result_summary: unknown) => schema.safeParse({ run_id: "run-1", status: "completed", result_summary });
  const withRefs = (refs: unknown[]) => ({ ...structuredSummary(), change_refs: refs });

  it("keeps every change ref field", () => {
    const parsed = parse(summaryWithChanges());
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    const out = parsed.data.result_summary as Record<string, any>;
    expect(out.change_refs).toHaveLength(5);
    expect(out.change_refs[0]).toEqual(changeRefs()[0]);
    expect(out.causal_paths[0].steps[0].links).toEqual([commitLink, runLink]);
  });

  it("accepts every role, kind, result and state of the contract", () => {
    for (const role of ["regression_source", "fix", "rollback", "last_good", "first_bad", "verified_by", "context"]) {
      expect(parse(withRefs([{ role, kind: "commit", sha: "abcdef1" }])).success, role).toBe(true);
    }
    for (const kind of ["commit", "pull_request", "deployment", "release", "ci_run", "config_change"]) {
      expect(parse(withRefs([{ role: "context", kind, title: "t" }])).success, kind).toBe(true);
    }
    for (const result of ["success", "failure", "cancelled", "skipped", "pending", "unknown"]) {
      expect(parse(withRefs([{ role: "verified_by", kind: "ci_run", ref: "1", result }])).success, result).toBe(true);
    }
    for (const state of ["open", "merged", "closed", "reverted", "deployed", "rolled_back"]) {
      expect(parse(withRefs([{ role: "fix", kind: "pull_request", ref: "1", state }])).success, state).toBe(true);
    }
    for (const kind of ["ci_run", "deployment", "release"]) {
      expect(parse(withRefs([{ role: "fix", kind: "deployment", links: [{ ...runLink, kind }] }])).success, kind).toBe(true);
    }
  });

  it("rejects what the backend would drop, naming the field", () => {
    const fails = (refs: unknown[], field: string) => {
      const parsed = parse(withRefs(refs));
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.map((i) => i.path.join(".")).join(" ")).toContain(field);
    };
    fails([{ role: "cause", kind: "commit", sha: "abcdef1" }], "change_refs.0.role");
    fails([{ role: "fix", kind: "merge", sha: "abcdef1" }], "change_refs.0.kind");
    fails([{ role: "fix", kind: "commit" }], "change_refs.0");
    fails([{ role: "fix", kind: "commit", sha: "xyz" }], "change_refs.0.sha");
    fails([{ role: "fix", kind: "commit", sha: "abcdef1", repo: "acme" }], "change_refs.0.repo");
    fails([{ role: "fix", kind: "ci_run", ref: "1", result: "green" }], "change_refs.0.result");
    fails([{ role: "fix", kind: "ci_run", ref: "1", occurred_at: "yesterday" }], "change_refs.0.occurred_at");
    fails([{ role: "fix", kind: "ci_run", ref: "1", confidence_percent: 101 }], "change_refs.0.confidence_percent");
    fails([{ role: "fix", kind: "ci_run", ref: "x".repeat(121) }], "change_refs.0.ref");
    fails(Array(7).fill({ role: "context", kind: "commit", sha: "abcdef1" }), "change_refs");
  });
});

describe("change_refs reach only a backend that advertises diagnosis_changes_v1", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });
  const body = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index][1] as RequestInit).body));
  const pickup = (capabilities: string[]) =>
    jsonResponse({ run: { id: "run-1" }, request: {}, server_capabilities: capabilities });

  it("sends change_refs and ci_run links when the run advertises it", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1", "diagnosis_changes_v1"]))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, warnings: [] }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: summaryWithChanges(),
    });
    const sent = body(1).result_summary;
    expect(sent.change_refs).toEqual(changeRefs());
    expect(sent.causal_paths[0].steps[0].links).toEqual([commitLink, runLink]);
    expect(harness.json(result).mcp_notice).toBeUndefined();
  });

  it("drops change_refs and the change link kinds for a backend without it, and says so", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1"]))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: summaryWithChanges(),
    });
    const sent = body(1).result_summary;
    expect(sent.change_refs).toBeUndefined();
    expect(sent.causal_paths[0].steps[0].links).toEqual([commitLink]);
    // The diagnosis structure itself still goes.
    expect(sent.ruled_out).toBeDefined();
    const notice = harness.json(result).mcp_notice as string;
    expect(notice).toContain("diagnosis_changes_v1");
    expect(notice).toContain("change_refs");
    expect(notice).toContain("causal_paths[0].steps[0].links[1]");
  });

  it("drops a ci_run link from a finding for a backend without it", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1"]))
      .mockResolvedValueOnce(jsonResponse({ finding: { id: 12 } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_post_finding", {
      incident_id: 42,
      investigation_run_id: "run-1",
      finding_type: "evidence",
      claim: "E2E failed first on run 41289327533",
      evidence_summary: "Frontend Tests failed after the merge of PR 4412",
      confidence: 0.8,
      confidence_reason: "run logs",
      evidence_refs: [{ source: "github", result_summary: "1 failed of 13516", links: [commitLink, runLink] }],
    });
    expect(body(1).evidence_refs[0].links).toEqual([commitLink]);
    expect(harness.json(result).mcp_notice).toContain("evidence_refs[0].links[1]");
  });

  it("sends the finding's ci_run link when the run advertises it", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1", "diagnosis_changes_v1"]))
      .mockResolvedValueOnce(jsonResponse({ finding: { id: 12 } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    await harness.callTool("tellagen_post_finding", {
      incident_id: 42,
      investigation_run_id: "run-1",
      finding_type: "evidence",
      claim: "c",
      evidence_summary: "e",
      confidence: 0.8,
      confidence_reason: "r",
      evidence_refs: [{ source: "github", result_summary: "s", links: [runLink] }],
    });
    expect(body(1).evidence_refs[0].links).toEqual([runLink]);
  });
});

describe("change helpers", () => {
  it("strips only change refs and change link kinds", () => {
    const { summary, removed } = stripResultChanges(summaryWithChanges());
    expect(removed).toEqual(["change_refs", "causal_paths[0].steps[0].links[1]"]);
    expect((summary as Record<string, any>).causal_paths[0].steps[0].links).toEqual([commitLink]);
    expect(stripResultChanges(structuredSummary()).removed).toEqual([]);
  });

  it("names the capability and the feature in the notice", () => {
    expect(unsupportedNotice(["change_refs"], "diagnosis_changes_v1")).toContain(
      "does not advertise diagnosis_changes_v1 for this run, so change_refs were not sent. Update Tellagen to use change refs",
    );
    expect(unsupportedNotice(["ruled_out"])).toContain("diagnosis_structure_v1");
  });

  it("gives advice for the change warnings", () => {
    const line = summarizeWarnings([
      { code: "change_without_link" },
      { code: "change_without_proof" },
      { code: "regression_source_missing" },
      { code: "change_refs_dropped" },
    ]);
    expect(line).toContain("1 change_without_link (give each change ref a link");
    expect(line).toContain("1 regression_source_missing (add the change that introduced it");
  });
});

describe("tellagen_build_source_link for CI runs and releases", () => {
  const client = new TellagenClient({ apiUrl: "https://test.api.tellagen.com", apiKey: "tllg_test" });

  it("builds a run, a job and a release link", async () => {
    expect(await buildSourceLinks(client, { kind: "ci_run", repo: "acme/checkout", run_id: 41289327533 })).toEqual({
      links: [{ kind: "ci_run", label: "CI run 41289327533 on GitHub", url: "https://github.com/acme/checkout/actions/runs/41289327533" }],
    });
    expect(
      await buildSourceLinks(client, { kind: "ci_run", repo: "acme/checkout", run_id: 41289327533, job_id: 115 }),
    ).toEqual({
      links: [
        { kind: "ci_run", label: "Job 115 of run 41289327533 on GitHub", url: "https://github.com/acme/checkout/actions/runs/41289327533/job/115" },
      ],
    });
    expect(await buildSourceLinks(client, { kind: "release", repo: "acme/checkout", tag: "v2.4.0" })).toEqual({
      links: [{ kind: "release", label: "Release v2.4.0 on GitHub", url: "https://github.com/acme/checkout/releases/tag/v2.4.0" }],
    });
    expect(
      (await buildSourceLinks(client, { kind: "ci_run", repo: "acme/checkout", run_id: 7, github_url: "https://ghe.example.com" })).links[0]!.url,
    ).toBe("https://ghe.example.com/acme/checkout/actions/runs/7");
  });

  it("refuses what it cannot build", async () => {
    await expect(buildSourceLinks(client, { kind: "ci_run", repo: "acme/checkout" })).rejects.toThrow("run_id");
    await expect(buildSourceLinks(client, { kind: "ci_run", repo: "acme" , run_id: 1 })).rejects.toThrow("owner/name");
    await expect(buildSourceLinks(client, { kind: "release", repo: "acme/checkout", tag: "../x" })).rejects.toThrow("tag");
    await expect(buildSourceLinks(client, { kind: "release", repo: "acme/checkout" })).rejects.toThrow("tag");
  });
});

describe("the SKILL.md example", () => {
  it("is a change_refs list the completion tool accepts", async () => {
    const { readFileSync } = await import("node:fs");
    const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
    const section = skill.slice(skill.indexOf("## Regression and CI failures"));
    const json = /```json\n([\s\S]*?)\n```/.exec(section)![1]!;
    const { change_refs } = JSON.parse(`{${json}}`) as { change_refs: unknown[] };
    expect(change_refs.length).toBeGreaterThanOrEqual(4);
    const harness = createToolHarness();
    const schema = z.object(
      harness.getTool("tellagen_complete_investigation").config.inputSchema as Record<string, z.ZodTypeAny>,
    );
    const parsed = schema.safeParse({ run_id: "run-1", status: "completed", result_summary: { ...structuredSummary(), change_refs } });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });
});
