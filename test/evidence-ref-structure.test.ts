import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const link = {
  kind: "explore",
  label: "Query in Grafana Explore",
  url: "https://grafana.example.com/explore?left=%7B%7D",
};

function findingInput(refOverrides: Record<string, unknown> = {}) {
  return {
    incident_id: 42,
    investigation_run_id: "run-1",
    finding_type: "evidence",
    claim: "5xx rate rose after the deploy",
    evidence_summary: "checkout 5xx went from 0.2% to 8%",
    confidence: 0.8,
    confidence_reason: "two sources agree",
    evidence_refs: [
      {
        source: "grafana-prometheus",
        query: "up",
        result_summary: "5xx rate 8%",
        ...refOverrides,
      },
    ],
  };
}

const pickup = (extra: Record<string, unknown> = {}) =>
  jsonResponse({ run: { id: "run-1" }, request: {}, ...extra });

describe("evidence ref links, command and datasource (CORE-776)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  describe("schema", () => {
    const harness = createToolHarness();
    const shape = harness.getTool("tellagen_post_finding").config
      .inputSchema as Record<string, z.ZodTypeAny>;
    const schema = z.object(shape);
    const parse = (ref: Record<string, unknown>) =>
      schema.safeParse(findingInput(ref));

    it("keeps links, command and datasource instead of stripping them", () => {
      const parsed = parse({
        links: [link],
        command: "kubectl -n checkout get pods",
        datasource: "prometheus-prod",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.evidence_refs?.[0]).toMatchObject({
          links: [link],
          command: "kubectl -n checkout get pods",
          datasource: "prometheus-prod",
        });
      }
    });

    it("accepts every link kind and exactly 4 links", () => {
      for (const kind of ["explore", "panel", "diff", "commit", "pr", "logs", "trace"]) {
        expect(parse({ links: [{ ...link, kind }] }).success, kind).toBe(true);
      }
      expect(parse({ links: Array(4).fill(link) }).success).toBe(true);
    });

    it("rejects hostile or oversized links", () => {
      expect(parse({ links: Array(5).fill(link) }).success).toBe(false);
      expect(parse({ links: [{ ...link, kind: "docs" }] }).success).toBe(false);
      expect(parse({ links: [{ ...link, label: "x".repeat(61) }] }).success).toBe(false);
      expect(parse({ links: [{ ...link, label: "  " }] }).success).toBe(false);
      for (const url of [
        "javascript:alert(1)",
        "data:text/html;base64,AAAA",
        "file:///etc/passwd",
        "not a url",
        `https://a.example/${"x".repeat(2100)}`,
      ]) {
        expect(parse({ links: [{ ...link, url }] }).success, url).toBe(false);
      }
    });

    it("bounds command and datasource", () => {
      expect(parse({ command: "x".repeat(1000) }).success).toBe(true);
      expect(parse({ command: "x".repeat(1001) }).success).toBe(false);
      expect(parse({ datasource: "d".repeat(120) }).success).toBe(true);
      expect(parse({ datasource: "d".repeat(121) }).success).toBe(false);
    });

    it("tells the agent when to use each field", () => {
      const refs = JSON.stringify(
        (shape.evidence_refs as z.ZodTypeAny).description ?? "",
      );
      expect(refs).toContain("tellagen_build_source_link");
      const evidenceRef = (shape.evidence_refs as z.ZodOptional<z.ZodArray<z.ZodTypeAny>>)
        .unwrap()
        .element as z.ZodEffects<z.ZodObject<Record<string, z.ZodTypeAny>>>;
      const fields = evidenceRef.innerType().shape;
      expect(fields.command.description).toContain("kubectl");
      expect(fields.links.unwrap().description).toContain("tellagen_build_source_link");
      expect(fields.datasource.description).toContain("data source");
    });
  });

  describe("capability gating", () => {
    const postedBody = (index = 0) => {
      const call = fetchSpy.mock.calls[index];
      return JSON.parse(String((call[1] as RequestInit).body));
    };

    it("sends the new fields after a pickup that advertises the capability", async () => {
      const harness = createToolHarness();
      fetchSpy
        .mockResolvedValueOnce(pickup({ server_capabilities: ["diagnosis_structure_v1"] }))
        .mockResolvedValueOnce(jsonResponse({ finding: { id: 7 } }, 201));
      await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
      const result = await harness.callTool(
        "tellagen_post_finding",
        findingInput({ links: [link], command: "kubectl get pods", datasource: "prom" }),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(postedBody(1).evidence_refs[0]).toMatchObject({
        links: [link],
        command: "kubectl get pods",
        datasource: "prom",
      });
      expect(harness.json(result)).toEqual({ finding: { id: 7 } });
    });

    it("drops the new fields for a backend without server_capabilities and says so", async () => {
      const harness = createToolHarness();
      fetchSpy
        .mockResolvedValueOnce(pickup())
        .mockResolvedValueOnce(jsonResponse({ finding: { id: 7 } }, 201));
      await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
      const result = await harness.callTool(
        "tellagen_post_finding",
        findingInput({ links: [link], command: "kubectl get pods", url: "https://x.example/a" }),
      );
      const body = postedBody(1);
      expect(body.evidence_refs[0]).toEqual({
        source: "grafana-prometheus",
        query: "up",
        result_summary: "5xx rate 8%",
        url: "https://x.example/a",
      });
      const out = harness.json(result);
      expect(out.finding).toEqual({ id: 7 });
      expect(out.mcp_notice).toContain("diagnosis_structure_v1");
      expect(out.mcp_notice).toContain("evidence_refs[0].links");
    });

    it("treats a capability list without the name as unsupported", async () => {
      const harness = createToolHarness();
      fetchSpy
        .mockResolvedValueOnce(pickup({ server_capabilities: ["something_else"] }))
        .mockResolvedValueOnce(jsonResponse({ finding: { id: 7 } }, 201));
      await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
      await harness.callTool("tellagen_post_finding", findingInput({ links: [link] }));
      expect(postedBody(1).evidence_refs[0].links).toBeUndefined();
    });

    it("reads the run context once when this process never saw the pickup", async () => {
      const harness = createToolHarness();
      fetchSpy
        .mockResolvedValueOnce(pickup({ server_capabilities: ["diagnosis_structure_v1"] }))
        .mockResolvedValueOnce(jsonResponse({ finding: { id: 1 } }, 201))
        .mockResolvedValueOnce(jsonResponse({ finding: { id: 2 } }, 201));
      await harness.callTool("tellagen_post_finding", findingInput({ links: [link] }));
      await harness.callTool("tellagen_post_finding", findingInput({ links: [link] }));
      expect(fetchSpy.mock.calls.map((c) => `${(c[1] as RequestInit).method} ${String(c[0])}`)).toEqual([
        "GET https://test.api.tellagen.com/api/v1/investigations/run-1/context",
        "POST https://test.api.tellagen.com/api/v1/incidents/42/findings",
        "POST https://test.api.tellagen.com/api/v1/incidents/42/findings",
      ]);
      expect(postedBody(1).evidence_refs[0].links).toEqual([link]);
    });

    it("learns from tellagen_get_incident_context too", async () => {
      const harness = createToolHarness();
      fetchSpy
        .mockResolvedValueOnce(pickup({ server_capabilities: ["diagnosis_structure_v1"] }))
        .mockResolvedValueOnce(jsonResponse({ finding: { id: 1 } }, 201));
      await harness.callTool("tellagen_get_incident_context", { investigation_run_id: "run-1" });
      await harness.callTool("tellagen_post_finding", findingInput({ links: [link] }));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(postedBody(1).evidence_refs[0].links).toEqual([link]);
    });

    it("falls back to the old payload when the context lookup fails, and retries next time", async () => {
      const harness = createToolHarness();
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500))
        .mockResolvedValueOnce(jsonResponse({ finding: { id: 1 } }, 201))
        .mockResolvedValueOnce(pickup({ server_capabilities: ["diagnosis_structure_v1"] }))
        .mockResolvedValueOnce(jsonResponse({ finding: { id: 2 } }, 201));
      const first = await harness.callTool("tellagen_post_finding", findingInput({ links: [link] }));
      expect(postedBody(1).evidence_refs[0].links).toBeUndefined();
      expect(harness.json(first).mcp_notice).toBeDefined();
      await harness.callTool("tellagen_post_finding", findingInput({ links: [link] }));
      expect(postedBody(3).evidence_refs[0].links).toEqual([link]);
    });

    it("does not look anything up when no new field is used", async () => {
      const harness = createToolHarness();
      fetchSpy.mockResolvedValueOnce(jsonResponse({ finding: { id: 1 } }, 201));
      const result = await harness.callTool("tellagen_post_finding", findingInput());
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(harness.json(result)).toEqual({ finding: { id: 1 } });
    });

    it("keeps capability per run", async () => {
      const harness = createToolHarness();
      fetchSpy
        .mockResolvedValueOnce(pickup({ server_capabilities: ["diagnosis_structure_v1"] }))
        .mockResolvedValueOnce(pickup())
        .mockResolvedValueOnce(jsonResponse({ finding: { id: 1 } }, 201))
        .mockResolvedValueOnce(jsonResponse({ finding: { id: 2 } }, 201));
      await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
      await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-2" });
      await harness.callTool("tellagen_post_finding", findingInput({ links: [link] }));
      await harness.callTool("tellagen_post_finding", {
        ...findingInput({ links: [link] }),
        investigation_run_id: "run-2",
      });
      expect(postedBody(2).evidence_refs[0].links).toEqual([link]);
      expect(postedBody(3).evidence_refs[0].links).toBeUndefined();
    });
  });
});
