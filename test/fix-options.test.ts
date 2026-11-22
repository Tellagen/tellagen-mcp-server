import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { FIX_OPTIONS_CAPABILITY, summarizeWarnings, unsupportedNotice } from "../src/diagnosis-structure.js";
import { buildFixOption, changesASystem, FIX_LIMITS, stripResultFixOptions, type FixOptionInput } from "../src/fix-options.js";
import { guideSection } from "../src/guide-resources.js";
import { structuredSummary } from "./helpers/diagnosis-fixtures.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");

const guidance = JSON.parse(readFileSync(new URL("../contracts/runbooks/v2/fix-options.guidance.json", import.meta.url), "utf8")) as {
  "x-limits": Record<string, number>;
  "x-enums": Record<string, string[]>;
  "x-warnings": Record<string, string>;
  "x-examples": { good: { fix_options: Array<Record<string, unknown>> } };
};

const small = {
  id: "bump-pool",
  kind: "permanent_fix",
  where: "our_config",
  recommended: true,
  state: "offered",
  title: "Raise the pool size from 5 to 20",
  trade_offs: ["Uses 15 more connections"],
  effort: "small",
  risk: "low",
  verify: { text: "Checkout 5xx falls under 0.5 percent." },
  finding_ids: [11],
  read_refs: [{ repo: "example-org/checkout", path: "config/pool.yaml", ref_or_sha: "4b7a2d1", lines: "10-12" }],
  change: {
    repo: "example-org/checkout",
    path: "config/pool.yaml",
    line: 11,
    diff: { type: "diff", path: "config/pool.yaml", ref: "4b7a2d1", additions: 1, deletions: 1, hunks: [[{ op: "-", text: "size: 5" }, { op: "+", text: "size: 20" }]] },
  },
} as FixOptionInput;

describe("the limits of a fix option are the ones of the contract", () => {
  it("equals x-limits of the vendored guidance", () => {
    expect(FIX_LIMITS).toEqual(guidance["x-limits"]);
  });
  it("accepts the good example of the contract", () => {
    const harness = createToolHarness();
    const schema = harness.getTool("tellagen_complete_investigation").config.inputSchema!.result_summary as z.ZodTypeAny;
    const parsed = schema.safeParse({ ...structuredSummary(), fix_options: guidance["x-examples"].good.fix_options });
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
  });
  it("explains every warning of the contract", () => {
    const codes = Object.keys(guidance["x-warnings"]);
    const line = summarizeWarnings(codes.map((code) => ({ code }))) ?? "";
    for (const code of codes) expect(line, code).toMatch(new RegExp(`1 ${code} \\(`));
  });
  it("is taught for every warning in the guide", () => {
    const section = guideSection(skill, "## How to fix it");
    for (const code of Object.keys(guidance["x-warnings"])) expect(section, code).toContain(code);
  });
});

describe("tellagen_build_fix_option", () => {
  const harness = createToolHarness();
  const call = async (input: Record<string, unknown>) => harness.callTool("tellagen_build_fix_option", input);

  it("returns a good option unchanged, with notes", async () => {
    const result = await call(small as unknown as Record<string, unknown>);
    expect(result.isError).toBeUndefined();
    const out = JSON.parse(result.content[0].text);
    expect(out.ok).toBe(true);
    expect(out.fix_option).toEqual(small);
    expect(out.notes.join(" ")).toContain("at most one option");
  });

  it("never carries a label, an address, an action type or a handler", () => {
    const schema = z.object(harness.getTool("tellagen_build_fix_option").config.inputSchema as z.ZodRawShape).strict();
    for (const field of ["label", "handler", "url", "href", "action_type", "not_checked_against_code"]) {
      expect(schema.safeParse({ ...small, [field]: "x" }).success, field).toBe(false);
    }
    expect(Object.keys(harness.getTool("tellagen_build_fix_option").config.inputSchema as object)).not.toContain("label");
  });

  it("asks for a reason when the option is not offered", async () => {
    const out = JSON.parse((await call({ ...small, recommended: false, state: "not_recommended" })).content[0].text);
    expect(out.ok).toBe(false);
    expect(out.issues.join(" ")).toContain("state_reason");
    const ok = JSON.parse((await call({ ...small, recommended: false, state: "not_recommended", state_reason: "It would split the visitor identity." })).content[0].text);
    expect(ok.ok).toBe(true);
    expect(ok.notes.join(" ")).toContain("Keep the tempting wrong option");
  });

  it("recommends only an offered option", () => {
    const result = buildFixOption({ ...small, state: "no_effect", state_reason: "Harmless, and it fixes nothing." });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join(" ")).toContain("only an offered option can be recommended");
  });

  it("names at most one target", () => {
    const result = buildFixOption({ ...small, kind: "hand_off", where: "vendor", vendor: { key: "posthog" }, hand_off: { team_id: 4 } });
    expect(!result.ok && result.issues.join(" ")).toContain("at most one target");
  });

  it("refuses a rollback that is not a mitigation and says the method is unknown without a runbook step", () => {
    const bad = buildFixOption({ ...small, rollback: { change_ref_id: "last-good" } });
    expect(!bad.ok && bad.issues.join(" ")).toContain("a rollback is a mitigation");
    const ok = buildFixOption({ id: "roll", kind: "mitigation", where: "infra", state: "offered", title: "Roll back to the last good release", verify: { text: "Errors drop." }, rollback: { change_ref_id: "last-good" } });
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.notes.join(" ")).toContain("never write a deploy, rollback or restart command");
  });

  it("refuses a verify command that changes a system, and allows a read-only one", () => {
    for (const command of ["kubectl rollout restart deployment/web", "helm rollback web 3", "kubectl scale deploy web --replicas=2", "git push origin main"]) {
      expect(changesASystem(command), command).toBe(true);
      const result = buildFixOption({ ...small, verify: { text: "Pods are ready.", command } });
      expect(result.ok, command).toBe(false);
    }
    for (const command of ["curl -s -D - https://example.com/health", "psql -c \"select count(*) from jobs\"", "gcloud logging read 'protoPayload.methodName:create' --filter='severity>=ERROR'", "kubectl get deploy web -o wide", "kubectl rollout status deployment/web", "curl -s https://example.com/health"]) {
      expect(changesASystem(command), command).toBe(false);
    }
  });

  it("refuses a diff over 6 changed lines, and a diff that is not a diff figure", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => [{ op: "-", text: `old ${i}` }, { op: "+", text: `new ${i}` }]).flat();
    const big = buildFixOption({ ...small, change: { ...small.change, diff: { type: "diff", path: "a.yaml", ref: "4b7a2d1", additions: 4, deletions: 4, hunks: [lines(4)] } } as FixOptionInput["change"] });
    expect(!big.ok && big.issues.join(" ")).toContain("is more than 6");
    const exact = buildFixOption({ ...small, change: { ...small.change, diff: { type: "diff", path: "a.yaml", ref: "4b7a2d1", additions: 3, deletions: 3, hunks: [lines(3)] } } as FixOptionInput["change"] });
    expect(exact.ok).toBe(true);
  });

  it("counts the whole change, not only the lines shown", () => {
    const diff = { type: "diff", path: "a.yaml", ref: "4b7a2d1", additions: 5, deletions: 3, hunks: [[{ op: "-", text: "a" }, { op: "+", text: "b" }]] };
    const result = buildFixOption({ ...small, change: { ...small.change, diff } as FixOptionInput["change"] });
    expect(!result.ok && result.issues.join(" ")).toContain("8 changed lines is more than 6");
  });

  it("refuses a target on leave_as_is", () => {
    const result = buildFixOption({ id: "leave", kind: "leave_as_is", where: "vendor", state: "offered", title: "Leave it", verify: { text: "Events arrive." }, vendor: { key: "posthog" } });
    expect(!result.ok && result.issues.join(" ")).toContain("leave_as_is option has no target");
  });

  it("refuses more forms of a command that changes a system", () => {
    for (const command of ["curl --request POST https://x", "curl -d a=b https://x", "kubectl exec pod -- ls", "psql -c 'delete from t'", "aws ec2 terminate-instances --id i-1", "gcloud compute instances delete vm", "psql -c 'delete from t'", "curl -X DELETE https://x"]) {
      expect(changesASystem(command), command).toBe(true);
    }
  });

  it("notes a change to a file that read_refs does not list", () => {
    const result = buildFixOption({ ...small, read_refs: undefined });
    expect(result.ok).toBe(true);
    expect(result.ok && result.notes.join(" ")).toContain("fix_option_unread_file");
    const other = buildFixOption({ ...small, read_refs: [{ path: "somewhere/else.yaml" }] });
    expect(other.ok && other.notes.join(" ")).toContain("fix_option_unread_file");
  });

  it("says what a recommended leave_as_is needs", () => {
    const result = buildFixOption({ id: "leave", kind: "leave_as_is", where: "other_team", recommended: true, state: "offered", title: "Leave it", verify: { text: "Events keep arriving." } });
    expect(result.ok && result.notes.join(" ")).toContain("leave_as_is_with_exposure");
  });

  it("reports a field that breaks the schema by its path", async () => {
    const result = await call({ ...small, title: "" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).issues.join(" ")).toContain("title");
  });
});

describe("fix_options in a completion", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());
  const body = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));
  let runCounter = 0;
  async function pickedUp(capabilities: string[]) {
    const runId = `fix-run-${++runCounter}`;
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: runId }, request: {}, server_capabilities: capabilities }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: runId });
    fetchSpy.mockClear();
    fetchSpy.mockImplementation(async () => jsonResponse({ dry_run: true, ready: true, repairs: [], warnings: [] }));
    return harness;
  }
  const complete = (harness: Awaited<ReturnType<typeof pickedUp>>) =>
    harness.callTool("tellagen_complete_investigation", { status: "completed", result_summary: { ...structuredSummary(), fix_options: [small] } });

  it("is sent when the pickup lists fix_options_v1", async () => {
    const harness = await pickedUp(["diagnosis_structure_v1", "completion_repairs_v1", FIX_OPTIONS_CAPABILITY]);
    const out = await complete(harness);
    expect(body(0).result_summary.fix_options).toEqual([small]);
    expect(String(harness.lastJson(out).mcp_notice ?? "")).not.toContain(FIX_OPTIONS_CAPABILITY);
  });

  it("is left out, and says so, against an older Tellagen", async () => {
    const harness = await pickedUp(["diagnosis_structure_v1", "completion_repairs_v1"]);
    const out = await complete(harness);
    expect(body(0).result_summary.fix_options).toBeUndefined();
    expect(body(0).result_summary.conclusion).toBeDefined();
    expect(String(harness.lastJson(out).mcp_notice)).toContain(FIX_OPTIONS_CAPABILITY);
  });

  it("strips only the options", () => {
    const stripped = stripResultFixOptions({ ...structuredSummary(), fix_options: [small] });
    expect(stripped.removed).toEqual(["fix_options"]);
    expect((stripped.summary as Record<string, unknown>).conclusion).toBeDefined();
    expect(stripResultFixOptions(structuredSummary()).removed).toEqual([]);
    expect(unsupportedNotice(["fix_options"], FIX_OPTIONS_CAPABILITY)).toContain("recommended action");
  });

  it("refuses more than 5 options and a label in an option", () => {
    const harness = createToolHarness();
    const schema = harness.getTool("tellagen_complete_investigation").config.inputSchema!.result_summary as z.ZodTypeAny;
    const parse = (fix_options: unknown) => schema.safeParse({ ...structuredSummary(), fix_options });
    expect(parse([small]).success).toBe(true);
    expect(parse(Array.from({ length: 6 }, (_, i) => ({ ...small, id: `o${i}`, recommended: false }))).success).toBe(false);
    expect(parse([{ ...small, label: "Fix it now" }]).success).toBe(false);
  });
});
