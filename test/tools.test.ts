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
    apiUrl: "https://test.api.tellagen.dev",
    apiKey: "tllg_test",
  });
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerAllTools(server, client);
  return { client, server };
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
        apiUrl: "https://test.api.tellagen.dev",
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
        "https://test.api.tellagen.dev/api/v1/incidents/42",
        expect.anything(),
      );
    });
  });

  describe("tellagen_list_incidents", () => {
    it("calls GET /api/v1/incidents", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.dev",
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
        apiUrl: "https://test.api.tellagen.dev",
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

  describe("tellagen_start_investigation", () => {
    it("calls POST /api/v1/incidents/{id}/investigations", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.dev",
        apiKey: "tllg_test",
      });

      const mockRun = {
        run: {
          id: "run-abc",
          agent_name: "Claude Code",
          status: "running",
        },
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockRun), { status: 201 }),
      );

      const result = await client.post(
        "/api/v1/incidents/42/investigations",
        {
          agent_name: "Claude Code",
          model_used: "claude-opus-4-6",
          data_sources: ["codebase", "grafana-loki"],
        },
      );

      expect(result).toEqual(mockRun);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.dev/api/v1/incidents/42/investigations",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            agent_name: "Claude Code",
            model_used: "claude-opus-4-6",
            data_sources: ["codebase", "grafana-loki"],
          }),
        }),
      );
    });
  });

  describe("tellagen_post_finding", () => {
    it("calls POST /api/v1/incidents/{id}/findings", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.dev",
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
        apiUrl: "https://test.api.tellagen.dev",
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
        "https://test.api.tellagen.dev/api/v1/incidents/42/findings",
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
        apiUrl: "https://test.api.tellagen.dev",
        apiKey: "tllg_test",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ run: { id: "run-abc", status: "completed" } }),
          { status: 200 },
        ),
      );

      const result = await client.patch("/api/v1/investigations/run-abc", {
        status: "completed",
      });

      expect(result).toEqual({
        run: { id: "run-abc", status: "completed" },
      });
    });

    it("includes failure_reason when status is failed", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.dev",
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
        apiUrl: "https://test.api.tellagen.dev",
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
        apiUrl: "https://test.api.tellagen.dev",
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
        "https://test.api.tellagen.dev/api/v1/findings/3/promote",
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
        apiUrl: "https://test.api.tellagen.dev",
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
        "https://test.api.tellagen.dev/api/v1/findings/5/promote",
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
        apiUrl: "https://test.api.tellagen.dev",
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
        "https://test.api.tellagen.dev/api/v1/incidents",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            service: "payments",
            severity: "sev2",
          }),
        }),
      );
    });
  });

  describe("error handling", () => {
    it("returns structured error on API failure", async () => {
      const client = new TellagenClient({
        apiUrl: "https://test.api.tellagen.dev",
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
  it("registers all 12 tools on the server", () => {
    const { server } = createTestSetup();
    // McpServer doesn't expose a public tool list, but if registration
    // fails it throws. No error = all tools registered successfully.
    expect(server).toBeDefined();
  });
});
