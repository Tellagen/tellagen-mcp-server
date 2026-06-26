import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TellagenClient } from "../src/client.js";
import { TellagenAPIError } from "../src/errors.js";
import { registerAllTools } from "../src/tools/index.js";

/**
 * Helper: create a server with tools registered and call a tool by name.
 * We access the internal tool handlers by re-registering and capturing them.
 */
function createTestSetup() {
  const client = new TellagenClient({
    apiUrl: "https://test.api.tellagen.com",
    apiKey: "tllg_test",
  });
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerAllTools(server, client);
  return { client, server };
}

type RegisteredTool = {
  config: { inputSchema?: Record<string, unknown> };
  handler: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
};

function createToolHarness() {
  const client = new TellagenClient({
    apiUrl: "https://test.api.tellagen.com",
    apiKey: "tllg_test",
  });
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool["config"],
      handler: RegisteredTool["handler"],
    ) => {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;

  registerAllTools(server, client);

  return {
    getTool(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool;
    },
    async callTool(name: string, input: Record<string, unknown>) {
      return this.getTool(name).handler(input);
    },
    toolNames() {
      return [...tools.keys()].sort();
    },
  };
}

// We test the tools by calling the client methods they use and verifying behavior.
// Since McpServer doesn't expose a simple "call tool" API outside of transport,
// we test the client integration directly with mocked fetch.

describe("Tool integration via client", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe("tellagen_get_incident", () => {
    it("calls GET /api/v1/incidents/{id}", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      const mockIncident = {
        incident: {
          id: 42,
          title: "Checkout 5xx spike",
          severity: "sev1",
          status: "active",
        },
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockIncident), { status: 200 }),
      );

      const result = await client.get("/api/v1/incidents/42");
      expect(result).toEqual(mockIncident);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42",
        expect.anything(),
      );
    });
  });

  describe("tellagen_list_incidents", () => {
    it("calls GET /api/v1/incidents", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ incidents: [] }), { status: 200 }),
      );

      const result = await client.get("/api/v1/incidents");
      expect(result).toEqual({ incidents: [] });
    });
  });

  describe("tellagen_get_incident_timeline", () => {
    it("calls GET /api/v1/incidents/{id}/timeline", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      const mockTimeline = {
        events: [
          { id: 1, title: "Incident opened", type: "status_change" },
        ],
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockTimeline), { status: 200 }),
      );

      const result = await client.get("/api/v1/incidents/42/timeline");
      expect(result).toEqual(mockTimeline);
    });
  });

  describe("timeline MCP tools", () => {
    it("tellagen_post_timeline_event calls POST /api/v1/incidents/{id}/timeline", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            event: { id: 200, title: "Rollback started", type: "mitigation" },
          }),
          { status: 201 },
        ),
      );

      const result = await harness.callTool("tellagen_post_timeline_event", {
        incident_id: 42,
        title: "Rollback started",
        body: "Started rollback of deploy abc123 after 502 spike.",
        type: "mitigation",
        source: "local-mcp",
        is_key: true,
        started_at: "2026-06-25T14:22:00Z",
        tags: ["rollback", "backend"],
        evidence_links: [
          {
            source: "github",
            url: "https://github.com/acme/api/commit/abc123",
            label: "Deploy abc123",
          },
        ],
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        event: { id: 200, title: "Rollback started", type: "mitigation" },
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42/timeline",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            title: "Rollback started",
            body: "Started rollback of deploy abc123 after 502 spike.",
            type: "mitigation",
            source: "local-mcp",
            is_key: true,
            started_at: "2026-06-25T14:22:00Z",
            tags: ["rollback", "backend"],
            evidence_links: [
              {
                source: "github",
                url: "https://github.com/acme/api/commit/abc123",
                label: "Deploy abc123",
              },
            ],
          }),
        }),
      );
    });

    it("tellagen_get_timeline_event calls GET /api/v1/timeline/{id}", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ event: { id: 200, title: "Rollback started" } }),
          { status: 200 },
        ),
      );

      const result = await harness.callTool("tellagen_get_timeline_event", {
        timeline_event_id: 200,
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        event: { id: 200, title: "Rollback started" },
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/timeline/200",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("tellagen_update_timeline_event calls PATCH /api/v1/timeline/{id}", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ event: { id: 200, title: "Rollback completed" } }),
          { status: 200 },
        ),
      );

      const result = await harness.callTool("tellagen_update_timeline_event", {
        timeline_event_id: 200,
        title: "Rollback completed",
        ended_at: "2026-06-25T14:37:00Z",
        is_ongoing: false,
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        event: { id: 200, title: "Rollback completed" },
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/timeline/200",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            title: "Rollback completed",
            ended_at: "2026-06-25T14:37:00Z",
            is_ongoing: false,
          }),
        }),
      );
    });

    it("tellagen_add_timeline_comment calls POST /api/v1/timeline/{id}/comments", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ comment: { id: 10, body: "Verified by logs." } }),
          { status: 201 },
        ),
      );

      const result = await harness.callTool("tellagen_add_timeline_comment", {
        timeline_event_id: 200,
        body: "Verified by logs.",
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        comment: { id: 10, body: "Verified by logs." },
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/timeline/200/comments",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ body: "Verified by logs." }),
        }),
      );
    });

    it("tellagen_list_timeline_comments calls GET /api/v1/timeline/{id}/comments", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ comments: [{ id: 10, body: "Verified by logs." }] }),
          { status: 200 },
        ),
      );

      const result = await harness.callTool("tellagen_list_timeline_comments", {
        timeline_event_id: 200,
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        comments: [{ id: 10, body: "Verified by logs." }],
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/timeline/200/comments",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("tellagen_start_investigation", () => {
    it("calls POST /api/v1/incidents/{id}/investigations", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      const mockRun = {
        run: {
          id: "run-abc",
          agent_name: "local-mcp",
          status: "awaiting_agent",
        },
        pickup: {
          investigation_run_id: "run-abc",
          incident_id: 42,
          incident_human_id: "INC-42",
          mcp_server_name: "tellagen",
        },
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockRun), { status: 201 }),
      );

      const result = await client.post(
        "/api/v1/incidents/42/investigations",
        {
          agent_name: "local-mcp",
          model_used: "local-llm",
          data_sources: ["codebase", "grafana-loki"],
          execution_mode: "local",
        },
      );

      expect(result).toEqual(mockRun);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42/investigations",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            agent_name: "local-mcp",
            model_used: "local-llm",
            data_sources: ["codebase", "grafana-loki"],
            execution_mode: "local",
          }),
        }),
      );
    });
  });

  describe("tellagen_get_incident_context", () => {
    it("calls GET /api/v1/investigations/{id}/context", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      const mockContext = {
        run: { id: "run-abc", status: "awaiting_agent" },
        incident: { id: 42, human_id: "INC-42" },
        request: { skills: [] },
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockContext), { status: 200 }),
      );

      const result = await client.get(
        "/api/v1/investigations/run-abc/context",
      );

      expect(result).toEqual(mockContext);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/investigations/run-abc/context",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("tellagen_pick_up_investigation", () => {
    it("calls POST /api/v1/investigations/{id}/pickup", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      const mockContext = {
        run: { id: "run-abc", status: "running" },
        incident: { id: 42, human_id: "INC-42" },
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockContext), { status: 200 }),
      );

      const result = await client.post(
        "/api/v1/investigations/run-abc/pickup",
        {},
      );

      expect(result).toEqual(mockContext);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/investigations/run-abc/pickup",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
    });
  });

  describe("tellagen_post_trace_step", () => {
    it("calls POST /api/v1/investigation-runs/{id}/trace", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            steps: [
              {
                investigation_run_id: "run-abc",
                step_id: "logs-1",
                status: "done",
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const body = {
        step_id: "logs-1",
        step_index: 1,
        status: "done",
        tool_name: "grafana-loki",
        title: "Queried checkout error logs",
        result_summary: "502 errors started at 14:32 UTC",
      };

      await client.post("/api/v1/investigation-runs/run-abc/trace", body);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/investigation-runs/run-abc/trace",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    });
  });

  describe("tellagen_list_trace_steps", () => {
    it("calls GET /api/v1/investigation-runs/{id}/trace", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            steps: [
              {
                investigation_run_id: "run-abc",
                step_id: "logs-1",
                status: "done",
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const result = await harness.callTool("tellagen_list_trace_steps", {
        investigation_run_id: "run-abc",
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        steps: [
          {
            investigation_run_id: "run-abc",
            step_id: "logs-1",
            status: "done",
          },
        ],
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/investigation-runs/run-abc/trace",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("tellagen_get_investigation_workspace", () => {
    it("calls GET /api/v1/incidents/{id}/investigations/workspace", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            incident: { id: 42 },
            investigation_runs: [{ id: "run-abc" }],
            findings: [],
            trace_steps: [],
          }),
          { status: 200 },
        ),
      );

      const result = await harness.callTool(
        "tellagen_get_investigation_workspace",
        {
          incident_id: 42,
        },
      );

      expect(JSON.parse(result.content[0].text)).toEqual({
        incident: { id: 42 },
        investigation_runs: [{ id: "run-abc" }],
        findings: [],
        trace_steps: [],
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42/investigations/workspace",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("tellagen_update_investigation_scope", () => {
    it("calls PATCH /api/v1/incidents/{id}/investigations/scope", async () => {
      const harness = createToolHarness();

      const scope = {
        services: [
          {
            name: "backend",
            observability_names: ["api", "tellagen-backend"],
          },
        ],
        time_range: {
          from: "2026-06-25T13:13:00Z",
          to: "2026-06-25T14:13:00Z",
        },
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ scope }), { status: 200 }),
      );

      const result = await harness.callTool(
        "tellagen_update_investigation_scope",
        {
          incident_id: 42,
          scope,
        },
      );

      expect(JSON.parse(result.content[0].text)).toEqual({ scope });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42/investigations/scope",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ scope }),
        }),
      );
    });
  });

  describe("tellagen_post_finding", () => {
    it("calls POST /api/v1/incidents/{id}/findings", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      const mockFinding = {
        finding: {
          id: 1,
          finding_type: "observation",
          claim: "Error rate spiked 5x",
          status: "draft",
        },
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockFinding), { status: 201 }),
      );

      const result = await client.post("/api/v1/incidents/42/findings", {
        investigation_run_id: "run-abc",
        finding_type: "observation",
        claim: "Error rate spiked 5x",
        evidence_summary: "Error rate increased from 0.1% to 0.5%",
        confidence: 0.85,
        confidence_reason: "Strong temporal correlation",
        evidence_refs: [
          {
            source: "grafana-loki",
            query: '{app="checkout"} |= "error"',
            result_summary: "Found 500 errors in last 30 minutes",
            url: "https://grafana.example.com/explore?...",
          },
        ],
      });

      expect(result).toEqual(mockFinding);
    });

    it("includes screenshots in evidence_refs and top-level", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ finding: { id: 2, status: "draft" } }),
          { status: 201 },
        ),
      );

      const body = {
        investigation_run_id: "run-abc",
        finding_type: "observation",
        claim: "HTTP 5xx rate spiked",
        evidence_summary: "5xx errors jumped from 0.1% to 5%",
        confidence: 0.95,
        confidence_reason: "Clear spike visible in Grafana",
        evidence_refs: [
          {
            source: "grafana",
            result_summary: "5xx panel shows spike at 14:32 UTC",
            url: "https://grafana.example.com/d/abc/checkout?panelId=4",
            screenshots: [
              {
                url: "https://grafana.example.com/render/d-solo/abc/checkout?panelId=4&from=now-1h",
                caption: "Grafana 5xx panel showing the spike",
              },
            ],
          },
        ],
        screenshots: [
          {
            base64: "iVBORw0KGgoAAAANSUhEUg==",
            media_type: "image/png",
            caption: "Error rate overview dashboard",
          },
        ],
      };

      await client.post("/api/v1/incidents/42/findings", body);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42/findings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    });
  });

  describe("tellagen_complete_investigation", () => {
    it("calls PATCH /api/v1/investigations/{id}", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ run: { id: "run-abc", status: "completed" } }),
          { status: 200 },
        ),
      );

      const resultSummary = {
        conclusion: {
          tone: "success",
          eyebrow: "Investigation complete",
          sentence: "Deploy abc123 introduced checkout 502s.",
          show_new_investigation_cta: true,
        },
        likely_cause_label: "Deploy abc123 changed checkout upstream routing.",
        customer_impact: {
          status: "degraded",
          verified: true,
          label: "Checkout degraded",
        },
        confidence_percent: 88,
        signals_checked: { checked: 3, total: 3, by_source: { github: 1 } },
        takeaways: [
          {
            id: "deploy-correlation",
            title: "Deploy abc123 preceded the 502 spike",
            severity: "high",
            finding_id: "7",
          },
        ],
        outcome_state: "successful",
      };

      const result = await client.patch("/api/v1/investigations/run-abc", {
        status: "completed",
        result_summary: resultSummary,
      });

      expect(result).toEqual({
        run: { id: "run-abc", status: "completed" },
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/investigations/run-abc",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            status: "completed",
            result_summary: resultSummary,
          }),
        }),
      );
    });

    it("includes failure_reason when status is failed", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ run: { id: "run-abc", status: "failed" } }),
          { status: 200 },
        ),
      );

      await client.patch("/api/v1/investigations/run-abc", {
        status: "failed",
        failure_reason: "Timed out waiting for Loki",
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: JSON.stringify({
            status: "failed",
            failure_reason: "Timed out waiting for Loki",
          }),
        }),
      );
    });
  });

  describe("tellagen_promote_finding", () => {
    it("calls POST /api/v1/findings/{id}/promote", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            finding: { id: 1, status: "promoted" },
            timeline_event: { id: 200 },
          }),
          { status: 200 },
        ),
      );

      const result = await client.post("/api/v1/findings/1/promote", {
        title: "Root cause identified",
        is_key: true,
      });

      expect(result).toEqual({
        finding: { id: 1, status: "promoted" },
        timeline_event: { id: 200 },
      });
    });

    it("includes screenshots when promoting to timeline", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            finding: { id: 3, status: "promoted" },
            timeline_event: { id: 201 },
          }),
          { status: 200 },
        ),
      );

      const body = {
        title: "5xx spike confirmed",
        is_key: true,
        screenshots: [
          {
            url: "https://grafana.example.com/render/d-solo/abc/checkout?panelId=4",
            caption: "Grafana 5xx panel at time of incident",
          },
          {
            base64: "iVBORw0KGgoAAAANSUhEUg==",
            media_type: "image/png",
            caption: "Error breakdown by endpoint",
          },
        ],
      };

      await client.post("/api/v1/findings/3/promote", body);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/findings/3/promote",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    });
  });

  describe("tellagen_promote_finding with duration and evidence fields", () => {
    it("forwards started_at, ended_at, is_ongoing, tags, and evidence_links", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            finding: { id: 5, status: "promoted" },
            timeline_event: { id: 300 },
            auto_tags: ["latency", "database"],
            suggested_workstream: "Database",
          }),
          { status: 200 },
        ),
      );

      const body = {
        title: "DB latency spike during deploy",
        is_key: true,
        started_at: "2026-03-08T23:06:00Z",
        ended_at: "2026-03-08T23:17:00Z",
        is_ongoing: false,
        tags: ["latency", "database"],
        evidence_links: [
          {
            source: "grafana-loki",
            url: "https://grafana.example.com/explore?query=db_latency",
            label: "Loki query",
          },
          {
            source: "github",
            url: "https://github.com/org/repo/commit/abc123",
          },
        ],
      };

      const result = await client.post("/api/v1/findings/5/promote", body);

      expect(result).toEqual({
        finding: { id: 5, status: "promoted" },
        timeline_event: { id: 300 },
        auto_tags: ["latency", "database"],
        suggested_workstream: "Database",
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/findings/5/promote",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    });
  });

  describe("tellagen_create_incident", () => {
    it("calls POST /api/v1/incidents", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      const mockIncident = {
        incident: {
          id: 99,
          service: "payments",
          severity: "sev2",
          status: "active",
        },
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockIncident), { status: 201 }),
      );

      const result = await client.post("/api/v1/incidents", {
        service: "payments",
        severity: "sev2",
      });

      expect(result).toEqual(mockIncident);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            service: "payments",
            severity: "sev2",
          }),
        }),
      );
    });

    it("maps gist alias to backend short_title", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ incident: { id: 99 } }), {
          status: 201,
        }),
      );

      expect(
        harness.getTool("tellagen_create_incident").config.inputSchema,
      ).toHaveProperty("short_title");

      await harness.callTool("tellagen_create_incident", {
        service: "payments",
        severity: "sev2",
        gist: "pay-lag",
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            service: "payments",
            severity: "sev2",
            short_title: "pay-lag",
          }),
        }),
      );
    });
  });

  describe("tellagen_update_incident", () => {
    it("calls PATCH /api/v1/incidents/{id}", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            incident: {
              id: 42,
              status: "monitoring",
              impact_summary: "Checkout latency degraded for EU users",
            },
          }),
          { status: 200 },
        ),
      );

      const result = await harness.callTool("tellagen_update_incident", {
        incident_id: 42,
        status: "monitoring",
        severity: "sev2",
        impact_summary: "Checkout latency degraded for EU users",
        recovered_at: "2026-06-25T14:55:00Z",
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        incident: {
          id: 42,
          status: "monitoring",
          impact_summary: "Checkout latency degraded for EU users",
        },
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            status: "monitoring",
            severity: "sev2",
            impact_summary: "Checkout latency degraded for EU users",
            recovered_at: "2026-06-25T14:55:00Z",
          }),
        }),
      );
    });
  });

  describe("context MCP tools", () => {
    it("tellagen_get_impact_summary calls GET /api/v1/incidents/{id}/impact-summary", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            summary: { total: 3, by_status: { affected: 2, monitoring: 1 } },
          }),
          { status: 200 },
        ),
      );

      const result = await harness.callTool("tellagen_get_impact_summary", {
        incident_id: 42,
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        summary: { total: 3, by_status: { affected: 2, monitoring: 1 } },
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42/impact-summary",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("tellagen_list_affected_customers forwards filters and pagination", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            customers: [{ id: 1, email: "ops@example.com" }],
            next_cursor: "cursor-2",
          }),
          { status: 200 },
        ),
      );

      const result = await harness.callTool("tellagen_list_affected_customers", {
        incident_id: 42,
        status: "affected",
        email: "ops@example.com",
        limit: 25,
        cursor: "cursor-1",
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        customers: [{ id: 1, email: "ops@example.com" }],
        next_cursor: "cursor-2",
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42/affected-customers?status=affected&email=ops%40example.com&limit=25&cursor=cursor-1",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("tellagen_search calls GET /api/v1/search with query params", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ type: "incident", id: "42", title: "Checkout lag" }],
          }),
          { status: 200 },
        ),
      );

      const result = await harness.callTool("tellagen_search", {
        q: "checkout",
        types: ["incident", "timeline"],
        incident_id: 42,
        limit: 5,
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        results: [{ type: "incident", id: "42", title: "Checkout lag" }],
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/search?q=checkout&types=incident%2Ctimeline&incident_id=42&limit=5",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("tellagen_list_services calls GET /api/v1/services", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ services: [{ id: 7, name: "backend" }] }),
          { status: 200 },
        ),
      );

      const result = await harness.callTool("tellagen_list_services", {
        include_archived: true,
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        services: [{ id: 7, name: "backend" }],
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/services?include_archived=true",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("tellagen_get_service calls GET /api/v1/services/{id}", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ service: { id: 7, name: "backend" } }), {
          status: 200,
        }),
      );

      const result = await harness.callTool("tellagen_get_service", {
        service_id: 7,
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        service: { id: 7, name: "backend" },
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/services/7",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("error handling", () => {
    it("returns structured error on API failure", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "bad_request",
            message: "evidence_summary is required",
          }),
          { status: 400 },
        ),
      );

      try {
        await client.post("/api/v1/incidents/42/findings", {});
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TellagenAPIError);
        const apiErr = err as TellagenAPIError;
        expect(apiErr.status).toBe(400);
        expect(apiErr.message).toBe("evidence_summary is required");
      }
    });
  });
});

describe("Tool registration", () => {
  it("registers all MCP tools on the server", () => {
    const { server } = createTestSetup();
    // McpServer doesn't expose a public tool list, but if registration
    // fails it throws. No error = all tools registered successfully.
    expect(server).toBeDefined();
  });
});
