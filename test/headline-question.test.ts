import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEADLINE_MAX_WORDS,
  gapQuestionNotice,
  headlineNotice,
  summarizeWarnings,
} from "../src/diagnosis-structure.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";
import { structuredSummary } from "./helpers/diagnosis-fixtures.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(join(root, "SKILL.md"), "utf8");
const guidance = JSON.parse(
  readFileSync(join(root, "contracts", "runbooks", "v2", "result-summary.guidance.json"), "utf8"),
) as {
  "x-limits": { headline_max_words: number };
  "x-examples": Record<"headline" | "blocking_question", { good: string; bad: string }>;
};

const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(" ");
const withSentence = (sentence: string) => {
  const summary = structuredSummary();
  return { ...summary, conclusion: { ...summary.conclusion, sentence } };
};

describe("the headline and blocking question rule", () => {
  it("uses the limit of the vendored guidance file", () => {
    expect(HEADLINE_MAX_WORDS).toBe(guidance["x-limits"].headline_max_words);
  });

  it("accepts the good examples and flags the bad ones", () => {
    const { headline, blocking_question: question } = guidance["x-examples"];
    expect(headlineNotice(withSentence(headline.good))).toBeUndefined();
    expect(headlineNotice(withSentence(headline.bad))).toContain("words");
    expect(gapQuestionNotice("gap", "gap", question.good)).toBeUndefined();
    expect(gapQuestionNotice("gap", "gap", question.bad)).toContain("question mark");
  });

  it("counts words at the limit and one over", () => {
    expect(headlineNotice(withSentence(words(15)))).toBeUndefined();
    expect(headlineNotice(withSentence(words(16)))).toContain("16 words");
  });

  it("ignores a result with no headline text", () => {
    expect(headlineNotice(undefined)).toBeUndefined();
    expect(headlineNotice({})).toBeUndefined();
    expect(headlineNotice({ conclusion: { sentence: 3 } })).toBeUndefined();
  });

  it("checks only gap findings, past closing quotes and brackets, and accepts the wide mark", () => {
    expect(gapQuestionNotice("observation", undefined, "Errors rose.")).toBeUndefined();
    expect(gapQuestionNotice("observation", "gap", "Errors rose.")).toBeDefined();
    expect(gapQuestionNotice("gap", undefined, "Was it the deploy?)")).toBeUndefined();
    expect(gapQuestionNotice("gap", undefined, 'Was it "the deploy?" ')).toBeUndefined();
    expect(gapQuestionNotice("gap", undefined, "デプロイが原因ですか？")).toBeUndefined();
    expect(gapQuestionNotice("gap", undefined, "Kubernetes events were unavailable.")).toBeDefined();
  });

  it("gives the advice for both warning codes", () => {
    const line = summarizeWarnings([{ code: "headline_too_long" }, { code: "question_not_a_question" }]);
    expect(line).toContain("15 words or fewer");
    expect(line).toContain("question mark");
  });

  it("puts the rule and both examples in the skill guide and the tool descriptions", () => {
    const { headline, blocking_question: question } = guidance["x-examples"];
    for (const text of [headline.good, headline.bad, question.good, question.bad]) {
      expect(skill).toContain(text);
    }
    const harness = createToolHarness();
    expect(harness.getTool("tellagen_complete_investigation").config.description).toContain("15 words or fewer");
    expect(harness.getTool("tellagen_post_finding").config.description).toContain("ends with a question mark");
  });
});

describe("notices on the calls", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });
  const sentBody = (index: number) =>
    JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));

  const pickup = (capabilities: string[]) =>
    jsonResponse({ run: { id: "run-1" }, request: {}, server_capabilities: capabilities });
  const complete = async (capabilities: string[], sentence: string) => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(capabilities))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: withSentence(sentence),
    });
    expect(result.isError, JSON.stringify(result)).toBeUndefined();
    return harness.json(result);
  };

  it("completes a run with a long headline unchanged and adds a notice", async () => {
    const out = await complete(["diagnosis_structure_v1"], words(20));
    expect(sentBody(1).result_summary.conclusion.sentence).toBe(words(20));
    expect(out.mcp_notice).toContain("20 words");
  });

  it("adds the notice against an older Tellagen that lists no capability", async () => {
    const out = await complete([], words(16));
    expect(sentBody(1).result_summary.conclusion.sentence).toBe(words(16));
    expect(out.mcp_notice).toContain("16 words");
    expect(out.mcp_notice).toContain("diagnosis_structure_v1");
  });

  it("adds no headline notice for a short headline", async () => {
    const out = await complete(["diagnosis_structure_v1"], "Deploy 4412 broke checkout upstream routing.");
    expect(out.mcp_notice).toBeUndefined();
  });

  const gap = (claim: string) => ({
    incident_id: 42,
    investigation_run_id: "run-1",
    finding_type: "gap",
    role: "gap",
    claim,
    evidence_summary: "No cluster access in this profile",
    confidence: 0.5,
    confidence_reason: "Source not readable",
    evidence_refs: [],
  });

  it("posts a gap statement unchanged with a notice, and a gap question without one", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ finding: { id: 5 } }, 201))
      .mockResolvedValueOnce(jsonResponse({ finding: { id: 6 } }, 201));
    const statement = await harness.callTool("tellagen_post_finding", gap("The retry limit is unknown."));
    expect(sentBody(0).claim).toBe("The retry limit is unknown.");
    expect(harness.json(statement).mcp_notice).toContain("question mark");
    const question = await harness.callTool("tellagen_post_finding", gap("Was the retry limit lowered at 14:02?"));
    expect(harness.json(question).mcp_notice).toBeUndefined();
  });
});
