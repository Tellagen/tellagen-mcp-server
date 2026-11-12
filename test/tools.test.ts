import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { TellagenClient } from "../src/client.js";
import { TellagenAPIError } from "../src/errors.js";
import { registerAllTools } from "../src/tools/index.js";
import { MCP_SERVER_VERSION } from "../src/version.js";

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
    client,
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
    vi.unstubAllEnvs();
  });

  describe("postmortem revision proposals", () => {
    it("matches backend proposal media and Unicode text bounds", () => {
      const tool = createToolHarness().getTool("tellagen_submit_postmortem_revision_proposal");
      const schema = z.object(tool.config.inputSchema as Record<string, z.ZodTypeAny>);
      const input = { incident_id: 42, request_id: "11111111-1111-4111-8111-111111111111", submission_id: "22222222-2222-4222-8222-222222222222", title: "😀".repeat(512), document_markdown: "😀".repeat(200000), media_ids: [] };
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.parse({ ...input, title: "  Exact title  " }).title).toBe("  Exact title  ");
      expect(schema.safeParse({ ...input, title: "   " }).success).toBe(false);
      expect(schema.safeParse({...input,title:"a".repeat(513)}).success).toBe(false);
      expect(schema.safeParse({...input,document_markdown:"a".repeat(200001)}).success).toBe(false);
      expect(schema.safeParse({...input,media_ids:Array(5).fill("33333333-3333-4333-8333-333333333333")}).success).toBe(false);
    });
    it("reads the exact revision request and submits a proposal without importing a version", async () => {
      const harness = createToolHarness();
      const requestID = "11111111-1111-4111-8111-111111111111";
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: requestID }), { status: 200 }));
      await harness.callTool("tellagen_get_postmortem_revision_request", {
        incident_id: 42, revision_request_id: requestID,
      });
      expect(fetchSpy).toHaveBeenNthCalledWith(1,
        `https://test.api.tellagen.com/api/v1/incidents/42/postmortem/revision-requests/${requestID}`,
        expect.objectContaining({ method: "GET" }),
      );
      const proposal = {
        request_id: requestID,
        submission_id: "22222222-2222-4222-8222-222222222222",
        title: "Reviewed incident summary",
        document_markdown: "# Summary\n\nProposed correction.",
        media_ids: [],
      };
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: "proposal-1" }), { status: 201 }));
      await harness.callTool("tellagen_submit_postmortem_revision_proposal", { incident_id: 42, ...proposal });
      expect(fetchSpy).toHaveBeenNthCalledWith(2,
        "https://test.api.tellagen.com/api/v1/incidents/42/postmortem/revision-proposals",
        expect.objectContaining({ method: "POST" }),
      );
      expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual(proposal);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
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
    it("tellagen_post_postmortem imports an immutable LLM version with source metadata", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: {
              id: 300,
              version_label: "1",
              version_kind: "llm",
              title: "Postmortem: INC-42",
            },
            created: true,
          }),
          { status: 201 },
        ),
      );

      const result = await harness.callTool("tellagen_post_postmortem", {
        incident_id: 42,
        submission_id: "11111111-1111-4111-8111-111111111111",
        title: "Postmortem: INC-42",
        markdown: "# Postmortem: INC-42\n\n## Summary\nClean body.",
        source_bundle_id: "pm-src-42-a1b2",
        included_evidence_ids: ["incident:42", "timeline:200"],
        excluded_evidence_ids: ["timeline:201"],
        reviewer_comments: "Tighten impact wording.",
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        version: {
          id: 300,
          version_label: "1",
          version_kind: "llm",
          title: "Postmortem: INC-42",
        },
        created: true,
      });

      const request = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(String(request.body));

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42/postmortem/versions/import",
        expect.objectContaining({ method: "POST" }),
      );
      expect(body).toEqual({
        submission_id: "11111111-1111-4111-8111-111111111111",
        title: "Postmortem: INC-42",
        markdown: "# Postmortem: INC-42\n\n## Summary\nClean body.",
        source_bundle_id: "pm-src-42-a1b2",
        included_evidence_ids: ["incident:42", "timeline:200"],
        excluded_evidence_ids: ["timeline:201"],
        reviewer_comments: "Tighten impact wording.",
      });
    });

    it("tellagen_update_postmortem imports the next LLM version and anchors candidates to it", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            draft_version: {
              id: 301,
              version_label: "4.1",
              version_kind: "draft",
            },
            version: {
              id: 302,
              version_label: "5",
              version_kind: "llm",
              title: "Postmortem: INC-42",
            },
            created: true,
          }),
          { status: 201 },
        ),
      );

      const result = await harness.callTool("tellagen_update_postmortem", {
        incident_id: 42,
        postmortem_version_id: 300,
        submission_id: "22222222-2222-4222-8222-222222222222",
        title: "Postmortem: INC-42",
        markdown: "# Postmortem: INC-42\n\n## Summary\nRevised body.",
        source_bundle_id: "pm-src-42-a1b2",
        included_evidence_ids: ["incident:42", "timeline:200"],
        excluded_evidence_ids: [],
        reviewer_comments: "Clarify root cause.",
        expected_draft_fingerprint:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        draft_version: {
          id: 301,
          version_label: "4.1",
          version_kind: "draft",
        },
        version: {
          id: 302,
          version_label: "5",
          version_kind: "llm",
          title: "Postmortem: INC-42",
        },
        created: true,
      });

      const request = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(String(request.body));

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42/postmortem/versions/import",
        expect.objectContaining({ method: "POST" }),
      );
      expect(body).toEqual({
        submission_id: "22222222-2222-4222-8222-222222222222",
        expected_version_id: 300,
        title: "Postmortem: INC-42",
        markdown: "# Postmortem: INC-42\n\n## Summary\nRevised body.",
        source_bundle_id: "pm-src-42-a1b2",
        included_evidence_ids: ["incident:42", "timeline:200"],
        excluded_evidence_ids: [],
        reviewer_comments: "Clarify root cause.",
        expected_draft_fingerprint:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            evaluation: { id: 88, status: "no_candidates", candidates: [] },
          }),
          { status: 201 },
        ),
      );
      const revised = JSON.parse(result.content[0].text) as {
        version: { id: number };
      };
      const candidateResult = await harness.callTool(
        "tellagen_submit_postmortem_runbook_candidates",
        {
          incident_id: 42,
          submission_id: "11111111-1111-4111-8111-111111111111",
          source_bundle_id: "pm-src-42-a1b2",
          postmortem_version_id: revised.version.id,
          no_candidates_reason_code: "not_repeatable",
          no_candidates_reason:
            "The revision contains no reusable read-only diagnostic sequence.",
          candidates: [],
        },
      );

      expect(candidateResult.isError).toBeUndefined();
      const candidateRequest = fetchSpy.mock.calls[1][1] as RequestInit;
      expect(JSON.parse(String(candidateRequest.body))).toMatchObject({
        source_bundle_id: "pm-src-42-a1b2",
        postmortem_version_id: 302,
        no_candidates_reason_code: "not_repeatable",
        candidates: [],
      });
    });

    it("derives a stable postmortem submission ID for transport retries", async () => {
      const harness = createToolHarness();
      const response = () =>
        new Response(
          JSON.stringify({
            version: { id: 303, version_label: "5", version_kind: "llm" },
            created: true,
          }),
          { status: 201 },
        );
      fetchSpy.mockResolvedValueOnce(response()).mockResolvedValueOnce(response());

      const input = {
        incident_id: 42,
        postmortem_version_id: 302,
        title: "Postmortem: INC-42",
        markdown: "# Postmortem: INC-42\n\nRetry-safe body.",
        source_bundle_id: "pm-src-42-a1b2",
      };
      await harness.callTool("tellagen_update_postmortem", input);
      await harness.callTool("tellagen_update_postmortem", input);

      const first = JSON.parse(
        String((fetchSpy.mock.calls[0][1] as RequestInit).body),
      );
      const second = JSON.parse(
        String((fetchSpy.mock.calls[1][1] as RequestInit).body),
      );
      expect(first.submission_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(second.submission_id).toBe(first.submission_id);
    });

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
        is_key: true,
        started_at: "2026-06-25T14:22:00Z",
        tags: ["rollback", "backend"],
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
            is_key: true,
            started_at: "2026-06-25T14:22:00Z",
            tags: ["rollback", "backend"],
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
    it("preserves frozen runbook attribution metadata from the context", async () => {
      const harness = createToolHarness();
      const mockContext = {
        run: { id: "run-abc", status: "awaiting_agent" },
        incident: { id: 42, human_id: "INC-42" },
        request: {
          attribution_policy: "optional_v1",
          skills: [
            {
              id: 42,
              name: "Checkout failures",
              version: 3,
              content_sha256: "sha256:frozen-runbook",
              sections: [
                { id: "safe_checks", title: "Safe checks" },
                { id: "verification", title: "Verification" },
              ],
            },
          ],
        },
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockContext), { status: 200 }),
      );

      const result = await harness.callTool("tellagen_get_incident_context", {
        investigation_run_id: "run-abc",
      });

      expect(JSON.parse(result.content[0].text)).toEqual(mockContext);
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

    it("rejects diagnostic session IDs before calling investigation pickup", async () => {
      const harness = createToolHarness();

      const result = await harness.callTool("tellagen_pick_up_investigation", {
        investigation_run_id: "diag_abc123",
      });
      const payload = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(payload).toMatchObject({
        error: "diagnostic_session_id_not_investigation_run",
        diagnostic_session_id: "diag_abc123",
        next_tool: "tellagen_report_diagnostic_tools",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("advertises the atomic v2 protocol capability bundle", async () => {
      const harness = createToolHarness();
      vi.stubEnv("TELLAGEN_MCP_CLIENT", "claude");
      vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", " work-cluster ");
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ request: { protocol_version: "runbook_plan_v2" } }), {
          status: 200,
        }),
      );

      await harness.callTool("tellagen_pick_up_investigation", {
        investigation_run_id: "run-v2",
      });

      const request = fetchSpy.mock.calls[0][1] as RequestInit;
      // No handshake in this harness: the deprecated setting names the client.
      expect(JSON.parse(String(request.body))).toEqual({
        client: {
          name: "claude",
          mcp_server_version: MCP_SERVER_VERSION,
          ...(harness.client.session.computer ? { computer: harness.client.session.computer } : {}),
          profile_id: "work-cluster",
          session_id: harness.client.session.sessionId,
        },
        protocol_capabilities: [
          "runbook_plan_v2",
          "trace_check_id_v2",
          "finding_roles_v2",
          "gap_findings_v2",
          "completion_coverage_v2",
          "diagnosis_structure_v1",
          "diagnosis_changes_v1",
          "run_images_v1",
          "guidance_default_v1",
          "strict_fields_v1",
          "cause_lead_v1",
          "responder_notes_v1",
        ],
      });
    });
  });

  describe("tellagen_post_runbook_check_attempt", () => {
    describe("reuse hint", () => {
      const validReuseHint = {
        diagnostic_intent: "Determine whether the database pool closed.",
        trigger_summary: "Logs contain database-closed errors.",
        observed_outcome: "confirmed",
        parameter_names: ["service", "database", "lookback"],
      };

      const validCheckAttempt = {
        investigation_run_id: "run-v2",
        runbook_id: 42,
        runbook_version: 3,
        check_id: "check-database-pool",
        source_resolution_id: "srcres_42_3_logs-primary",
        step_id: "check-database-pool-1",
        status: "done",
        title: "Check database pool errors",
        result_summary: "The pool closed during the error window.",
        artifact_id: "artifact-database-pool-1",
      };

      function checkAttemptInputSchema(harness: ReturnType<typeof createToolHarness>) {
        return z.object(
          harness.getTool("tellagen_post_runbook_check_attempt").config
            .inputSchema as Record<string, z.ZodTypeAny>,
        );
      }

      it("exposes a strict reuse hint schema on the registered tool", () => {
        const harness = createToolHarness();
        const schema = checkAttemptInputSchema(harness);

        expect(() =>
          schema.parse({ ...validCheckAttempt, reuse_hint: validReuseHint }),
        ).not.toThrow();

        const invalidHints = [
          { ...validReuseHint, command: "restart database" },
          { ...validReuseHint, parameter_names: [{ service: "payments" }] },
          { ...validReuseHint, parameter_names: ["Service"] },
          { ...validReuseHint, parameter_names: ["service", "service"] },
          {
            ...validReuseHint,
            parameter_names: [
              "one",
              "two",
              "three",
              "four",
              "five",
              "six",
              "seven",
              "eight",
              "nine",
            ],
          },
          { ...validReuseHint, diagnostic_intent: "   " },
          { ...validReuseHint, diagnostic_intent: "x".repeat(513) },
          { ...validReuseHint, diagnostic_intent: "界".repeat(300) },
          { ...validReuseHint, trigger_summary: "   " },
          { ...validReuseHint, trigger_summary: "x".repeat(513) },
          { ...validReuseHint, trigger_summary: "界".repeat(300) },
          { ...validReuseHint, observed_outcome: "skipped" },
        ];
        for (const reuse_hint of invalidHints) {
          expect(() =>
            schema.parse({ ...validCheckAttempt, reuse_hint }),
          ).toThrow();
        }
      });

      it("rejects a reuse hint without terminal evidence before any HTTP request", async () => {
        const harness = createToolHarness();
        const invalidInputs = [
          { ...validCheckAttempt, status: "running" },
          { ...validCheckAttempt, status: "error" },
          { ...validCheckAttempt, result_summary: "   " },
          { ...validCheckAttempt, artifact_id: undefined },
        ];

        for (const input of invalidInputs) {
          const result = await harness.callTool(
            "tellagen_post_runbook_check_attempt",
            { ...input, reuse_hint: validReuseHint },
          );
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain("reuse_hint requires");
        }
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it("forwards and verifies a submitted reuse hint", async () => {
        const harness = createToolHarness();
        fetchSpy.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              trace: { ...validCheckAttempt, reuse_hint: validReuseHint },
            }),
            { status: 200 },
          ),
        );

        const result = await harness.callTool(
          "tellagen_post_runbook_check_attempt",
          { ...validCheckAttempt, reuse_hint: validReuseHint },
        );

        expect(result.isError).toBeUndefined();
        const request = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(JSON.parse(String(request.body))).toMatchObject({
          reuse_hint: validReuseHint,
        });
      });

      it("rejects a missing or mismatched reuse hint echo", async () => {
        const harness = createToolHarness();
        fetchSpy
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ trace: {} }), { status: 200 }),
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                trace: {
                  reuse_hint: {
                    ...validReuseHint,
                    observed_outcome: "falsified",
                  },
                },
              }),
              { status: 200 },
            ),
          );

        for (let i = 0; i < 2; i += 1) {
          const result = await harness.callTool(
            "tellagen_post_runbook_check_attempt",
            { ...validCheckAttempt, reuse_hint: validReuseHint },
          );
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain(
            "Tellagen did not persist the submitted reuse_hint",
          );
        }
      });

      it("accepts a normalized reuse hint echo and preserves legacy success", async () => {
        const harness = createToolHarness();
        fetchSpy
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                trace: {
                  reuse_hint: {
                    ...validReuseHint,
                    diagnostic_intent:
                      "Determine whether the database pool closed.",
                    trigger_summary:
                      "Logs contain database-closed errors.",
                  },
                },
              }),
              { status: 200 },
            ),
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({ attempt: { attempt_number: 1 } }), {
                status: 200,
              },
            ),
          );

        const normalized = await harness.callTool(
          "tellagen_post_runbook_check_attempt",
          {
            ...validCheckAttempt,
            reuse_hint: {
              ...validReuseHint,
              diagnostic_intent: "  Determine whether the database  pool closed. ",
              trigger_summary: " Logs contain  database-closed errors. ",
            },
          },
        );
        expect(normalized.isError).toBeUndefined();

        const legacy = await harness.callTool(
          "tellagen_post_runbook_check_attempt",
          validCheckAttempt,
        );
        expect(legacy.isError).toBeUndefined();
      });
    });

    it("forwards exact frozen runbook, check, and source identities", async () => {
      const harness = createToolHarness();
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            attempt: { attempt_number: 1, final_outcome: "confirmed" },
            execution: { outcome: "confirmed" },
          }),
          { status: 200 },
        ),
      );

      const result = await harness.callTool(
        "tellagen_post_runbook_check_attempt",
        {
          investigation_run_id: "run-v2",
          runbook_id: 42,
          runbook_version: 3,
          check_id: "check-error-rate",
          source_resolution_id: "srcres_42_3_grafana-primary",
          step_id: "check-error-rate-1",
          status: "done",
          title: "Check checkout error rate",
          tool_name: "grafana",
          target_reference: "dashboard:checkout-api",
          proposed_outcome: "confirmed",
          result_summary: "Error rate exceeded the runbook threshold",
        },
      );

      expect(JSON.parse(result.content[0].text).execution.outcome).toBe(
        "confirmed",
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/investigation-runs/run-v2/check-attempts",
        expect.objectContaining({ method: "POST" }),
      );
      const request = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({
        runbook_id: 42,
        runbook_version: 3,
        check_id: "check-error-rate",
        source_resolution_id: "srcres_42_3_grafana-primary",
        step_id: "check-error-rate-1",
        step_index: 0,
        mcp_server_version: MCP_SERVER_VERSION,
      });
    });

    it("forwards a gap finding on a direct terminal skipped attempt", async () => {
      const harness = createToolHarness();
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            attempt: { attempt_number: 1, final_outcome: "skipped" },
            execution: { outcome: "skipped", gap_finding_id: 73 },
          }),
          { status: 200 },
        ),
      );

      await harness.callTool("tellagen_post_runbook_check_attempt", {
        investigation_run_id: "run-v2",
        runbook_id: 42,
        runbook_version: 3,
        check_id: "check-cluster-events",
        source_resolution_id: "srcres_42_3_kubernetes-primary",
        step_id: "check-cluster-events-gap",
        status: "done",
        title: "Account for unavailable Kubernetes events",
        proposed_outcome: "skipped",
        gap_finding_id: 73,
      });

      const request = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({
        proposed_outcome: "skipped",
        gap_finding_id: 73,
        status: "done",
      });
    });
  });

  describe("runbook completion repair tools", () => {
    it("preflights coverage with the explicit mitigation state", async () => {
      const harness = createToolHarness();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ coverage: { decision: "blocked" } }), {
          status: 200,
        }),
      );

      await harness.callTool("tellagen_get_investigation_coverage", {
        investigation_run_id: "run-v2",
        mitigation_state: "recovered",
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/investigations/run-v2/coverage?mitigation_state=recovered",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("lists responder-created runbook waivers", async () => {
      const harness = createToolHarness();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ waivers: [{ id: 91 }] }), {
          status: 200,
        }),
      );

      const result = await harness.callTool(
        "tellagen_list_investigation_runbook_waivers",
        { investigation_run_id: "run-v2" },
      );

      expect(JSON.parse(result.content[0].text)).toEqual({
        waivers: [{ id: 91 }],
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/investigations/run-v2/runbook-waivers",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("tellagen_post_trace_step", () => {
    describe("reuse hint", () => {
      const validReuseHint = {
        diagnostic_intent: "Determine whether the database pool closed.",
        trigger_summary: "Logs contain database-closed errors.",
        observed_outcome: "confirmed",
        parameter_names: ["service", "database", "lookback"],
      };

      const validGuidance = {
        origin: "agent_judgment",
        refs: [],
        reason: "A bounded read-only diagnostic check",
      };

      const validTraceStep = {
        investigation_run_id: "run-abc",
        step_id: "database-pool-1",
        status: "done",
        title: "Check database pool errors",
        result_summary: "The pool closed during the error window.",
        artifact_id: "artifact-database-pool-1",
        guidance: validGuidance,
      };

      function traceStepInputSchema(harness: ReturnType<typeof createToolHarness>) {
        return z.object(
          harness.getTool("tellagen_post_trace_step").config.inputSchema as Record<
            string,
            z.ZodTypeAny
          >,
        );
      }

      it("exposes a strict reuse hint schema on the registered tool", () => {
        const harness = createToolHarness();
        const schema = traceStepInputSchema(harness);

        expect(() =>
          schema.parse({ ...validTraceStep, reuse_hint: validReuseHint }),
        ).not.toThrow();

        const invalidHints = [
          { ...validReuseHint, command: "restart database" },
          { ...validReuseHint, parameter_names: [{ service: "payments" }] },
          { ...validReuseHint, parameter_names: ["Service"] },
          { ...validReuseHint, parameter_names: ["service", "service"] },
          {
            ...validReuseHint,
            parameter_names: [
              "one",
              "two",
              "three",
              "four",
              "five",
              "six",
              "seven",
              "eight",
              "nine",
            ],
          },
          { ...validReuseHint, diagnostic_intent: "   " },
          { ...validReuseHint, diagnostic_intent: "x".repeat(513) },
          { ...validReuseHint, diagnostic_intent: "界".repeat(300) },
          { ...validReuseHint, trigger_summary: "   " },
          { ...validReuseHint, trigger_summary: "x".repeat(513) },
          { ...validReuseHint, trigger_summary: "界".repeat(300) },
          { ...validReuseHint, observed_outcome: "skipped" },
        ];
        for (const reuse_hint of invalidHints) {
          expect(() =>
            schema.parse({ ...validTraceStep, reuse_hint }),
          ).toThrow();
        }
      });

      it("rejects a reuse hint without terminal evidence before any HTTP request", async () => {
        const harness = createToolHarness();
        const invalidInputs = [
          { ...validTraceStep, status: "running" },
          { ...validTraceStep, status: "error" },
          { ...validTraceStep, result_summary: "   " },
          { ...validTraceStep, artifact_id: undefined },
        ];

        for (const input of invalidInputs) {
          const result = await harness.callTool("tellagen_post_trace_step", {
            ...input,
            reuse_hint: validReuseHint,
          });
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain("reuse_hint requires");
        }
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it("forwards and verifies a submitted reuse hint", async () => {
        const harness = createToolHarness();
        fetchSpy.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              steps: [{ ...validTraceStep, reuse_hint: validReuseHint }],
            }),
            { status: 200 },
          ),
        );

        const result = await harness.callTool("tellagen_post_trace_step", {
          ...validTraceStep,
          reuse_hint: validReuseHint,
        });

        expect(result.isError).toBeUndefined();
        const request = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(JSON.parse(String(request.body))).toMatchObject({
          reuse_hint: validReuseHint,
        });
      });

      it("rejects a missing or malformed reuse hint echo", async () => {
        const harness = createToolHarness();
        fetchSpy
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ steps: [{}] }), { status: 200 }),
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                steps: [
                  {
                    reuse_hint: {
                      ...validReuseHint,
                      parameter_names: ["Not_a_parameter"],
                    },
                  },
                ],
              }),
              { status: 200 },
            ),
          );

        for (let i = 0; i < 2; i += 1) {
          const result = await harness.callTool("tellagen_post_trace_step", {
            ...validTraceStep,
            reuse_hint: validReuseHint,
          });
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain(
            "Tellagen did not persist the submitted reuse_hint",
          );
        }
      });

      it("accepts a normalized reuse hint echo and preserves legacy success", async () => {
        const harness = createToolHarness();
        fetchSpy
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                steps: [
                  {
                    reuse_hint: {
                      ...validReuseHint,
                      diagnostic_intent:
                        "Determine whether the database pool closed.",
                      trigger_summary:
                        "Logs contain database-closed errors.",
                    },
                  },
                ],
              }),
              { status: 200 },
            ),
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ steps: [validTraceStep] }), {
              status: 200,
            }),
          );

        const normalized = await harness.callTool("tellagen_post_trace_step", {
          ...validTraceStep,
          reuse_hint: {
            ...validReuseHint,
            diagnostic_intent: "  Determine whether the database  pool closed. ",
            trigger_summary: " Logs contain  database-closed errors. ",
          },
        });
        expect(normalized.isError).toBeUndefined();

        const legacy = await harness.callTool(
          "tellagen_post_trace_step",
          validTraceStep,
        );
        expect(legacy.isError).toBeUndefined();
      });
    });

    it("requires one valid runbook or non-runbook guidance basis", () => {
      const harness = createToolHarness();
      const tool = harness.getTool("tellagen_post_trace_step");
      const guidanceSchema = tool.config.inputSchema?.guidance as
        | { parse: (value: unknown) => unknown }
        | undefined;
      const traceInputSchema = z.object(
        tool.config.inputSchema as Record<string, z.ZodTypeAny>,
      );

      expect(guidanceSchema).toBeDefined();

      const validGuidance = [
        {
          origin: "runbook",
          refs: [
            {
              runbook_id: 42,
              version: 3,
              check_id: "check-error-rate",
              source_resolution_id: "srcres_42_3_grafana-primary",
              relation: "directed",
            },
          ],
        },
        {
          origin: "runbook",
          refs: [
            {
              runbook_id: 42,
              version: 3,
              section_id: "safe_checks",
              relation: "directed",
            },
          ],
        },
        {
          origin: "agent_judgment",
          refs: [],
          reason: "Baseline health check selected by the investigator",
        },
        {
          origin: "responder_request",
          refs: [],
          reason: "Responder asked to compare the latest deployment",
        },
        { origin: "system_required", refs: [] },
      ];
      for (const guidance of validGuidance) {
        expect(() => guidanceSchema?.parse(guidance)).not.toThrow();
      }

      const minimumTraceInput = {
        investigation_run_id: "run-abc",
        step_id: "health-1",
        status: "running",
        title: "Check service health",
        guidance: validGuidance[0],
      };
      expect(() => traceInputSchema.parse(minimumTraceInput)).not.toThrow();
      // The basis is optional: Tellagen records the model's own judgment by default.
      expect(() =>
        traceInputSchema.parse({
          ...minimumTraceInput,
          guidance: undefined,
        }),
      ).not.toThrow();
      expect(() =>
        traceInputSchema.parse({
          ...minimumTraceInput,
          step_id: undefined,
        }),
      ).toThrow();
      expect(() =>
        traceInputSchema.parse({
          ...minimumTraceInput,
          step_id: "   ",
        }),
      ).toThrow();

      const invalidGuidance = [
        { origin: "runbook", refs: [] },
        {
          origin: "runbook",
          refs: [{ runbook_id: 0, version: 3, relation: "directed" }],
        },
        {
          origin: "runbook",
          refs: [{ runbook_id: 42, version: -1, relation: "directed" }],
        },
        {
          origin: "runbook",
          refs: [{ runbook_id: 42, version: 3, relation: "followed" }],
        },
        { origin: "agent_judgment", refs: [], reason: "   " },
        { origin: "responder_request", refs: [] },
        {
          origin: "system_required",
          refs: [
            { runbook_id: 42, version: 3, relation: "directed" },
          ],
        },
        { origin: "legacy_unattributed", refs: [] },
        {
          origin: "runbook",
          refs: [
            {
              runbook_id: 42,
              version: 3,
              check_id: "check-error-rate",
              relation: "directed",
            },
          ],
        },
        {
          origin: "runbook",
          refs: [
            {
              runbook_id: 42,
              version: 3,
              source_resolution_id: "srcres_42_3_grafana-primary",
              relation: "directed",
            },
          ],
        },
        {
          origin: "runbook",
          refs: [
            {
              runbook_id: 42,
              version: 3,
              relation: "directed",
              section_title: "Safe checks",
              reference_status: "valid",
              invalid_reason: "server-only fields must not be submitted",
            },
          ],
        },
      ];
      for (const guidance of invalidGuidance) {
        expect(() => guidanceSchema?.parse(guidance)).toThrow();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("forwards exact runbook refs and preserves them across step updates", async () => {
      const harness = createToolHarness();
      const guidance = {
        origin: "runbook",
        refs: [
          {
            runbook_id: 42,
            version: 3,
            section_id: "safe_checks",
            relation: "directed",
          },
          {
            runbook_id: 99,
            version: 1,
            section_id: "verification",
            relation: "informed",
          },
        ],
        reason: "Cross-checked the safe-check and verification sections",
      };
      const runningStep = {
        investigation_run_id: "run-abc",
        step_id: "logs-1",
        step_index: 1,
        status: "running",
        tool_name: "grafana-loki",
        tool_use_id: "tool-logs-1",
        title: "Query checkout error logs",
        artifact_id: "artifact-logs-1",
        guidance,
      };
      const doneStep = {
        ...runningStep,
        status: "done",
        result_summary: "502 errors started at 14:32 UTC",
        artifact_digest: "sha256:abc123",
        result_bytes: 2048,
        truncated: false,
      };

      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ steps: [runningStep] }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              steps: [
                {
                  ...doneStep,
                  evidence_fact_key: "run-abc:artifact:artifact-logs-1",
                },
              ],
            }),
            { status: 200 },
          ),
        );

      await harness.callTool("tellagen_post_trace_step", runningStep);
      const result = await harness.callTool("tellagen_post_trace_step", doneStep);

      expect(JSON.parse(result.content[0].text).steps[0].evidence_fact_key).toBe(
        "run-abc:artifact:artifact-logs-1",
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      for (const request of fetchSpy.mock.calls) {
        const body = JSON.parse(String((request[1] as RequestInit).body));
        expect(body.guidance).toEqual(guidance);
      }
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "https://test.api.tellagen.com/api/v1/investigation-runs/run-abc/trace",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("surfaces backend rejection of a runbook version outside the frozen snapshot", async () => {
      const harness = createToolHarness();
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "validation_error",
            message:
              "runbook guidance reference does not match this investigation snapshot",
          }),
          { status: 400 },
        ),
      );

      const result = await harness.callTool("tellagen_post_trace_step", {
        investigation_run_id: "run-abc",
        step_id: "logs-1",
        status: "done",
        title: "Query checkout error logs",
        guidance: {
          origin: "runbook",
          refs: [{ runbook_id: 42, version: 999, relation: "directed" }],
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        error: true,
        status: 400,
        code: "validation_error",
        message:
          "runbook guidance reference does not match this investigation snapshot",
      });
    });

    it("surfaces backend rejection when a step's guidance basis changes", async () => {
      const harness = createToolHarness();
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "validation_error",
            message:
              "guidance attribution cannot change after a trace step is created",
          }),
          { status: 400 },
        ),
      );

      const result = await harness.callTool("tellagen_post_trace_step", {
        investigation_run_id: "run-abc",
        step_id: "logs-1",
        status: "done",
        title: "Query checkout error logs",
        guidance: {
          origin: "agent_judgment",
          refs: [],
          reason: "A different basis than the running step used",
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        error: true,
        status: 400,
        code: "validation_error",
        message:
          "guidance attribution cannot change after a trace step is created",
      });
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
    it("supports explicit finding roles and gap findings", async () => {
      const harness = createToolHarness();
      const tool = harness.getTool("tellagen_post_finding");
      const inputSchema = z.object(
        tool.config.inputSchema as Record<string, z.ZodTypeAny>,
      );
      expect(() =>
        inputSchema.parse({
          incident_id: 42,
          investigation_run_id: "run-v2",
          finding_type: "gap",
          role: "gap",
          claim: "Kubernetes events were unavailable",
          evidence_summary: "The required source could not be authenticated.",
          confidence: 1,
          confidence_reason: "The provider returned access denied.",
        }),
      ).not.toThrow();

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ finding: { id: 7, role: "gap" } }), {
          status: 201,
        }),
      );
      await harness.callTool("tellagen_post_finding", {
        incident_id: 42,
        investigation_run_id: "run-v2",
        finding_type: "gap",
        role: "gap",
        claim: "Kubernetes events were unavailable",
        evidence_summary: "The required source could not be authenticated.",
        confidence: 1,
        confidence_reason: "The provider returned access denied.",
      });
      const request = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({
        finding_type: "gap",
        role: "gap",
      });
    });

    it("calls tellagen_post_finding and forwards evidence result samples", async () => {
      const harness = createToolHarness();
      const resultSample =
        "2026-06-26T18:20:21Z GET /wp-load.php status=404 client_ip=20.214.144.20";
      const input = {
        incident_id: 42,
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
            result_sample: resultSample,
            url: "https://grafana.example.com/explore?left=abc",
            tool_use_id: "tool-logs-1",
            artifact_id: "artifact-logs-1",
            artifact_digest: "sha256:abc123",
            evidence_fact_key: "run-abc:artifact:artifact-logs-1",
            captured_at: "2026-06-26T18:20:21Z",
            result_bytes: 2048,
            truncated: false,
            verified: true,
          },
        ],
      };
      const expectedBody = {
        investigation_run_id: input.investigation_run_id,
        finding_type: input.finding_type,
        claim: input.claim,
        evidence_summary: input.evidence_summary,
        confidence: input.confidence,
        confidence_reason: input.confidence_reason,
        evidence_refs: input.evidence_refs,
      };
      const tool = harness.getTool("tellagen_post_finding");
      const evidenceRefsSchema = tool.config.inputSchema?.evidence_refs as
        | { parse: (value: unknown) => unknown }
        | undefined;

      expect(evidenceRefsSchema).toBeDefined();
      expect(() => evidenceRefsSchema?.parse(input.evidence_refs)).not.toThrow();
      expect(() =>
        evidenceRefsSchema?.parse([
          {
            source: "grafana-loki",
            result_summary: "Found errors",
            evidence_fact_key: "run-abc:summary:client-only",
          },
        ]),
      ).not.toThrow();
      expect(tool.config.inputSchema?.guidance).toBeUndefined();

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

      const result = await harness.callTool("tellagen_post_finding", input);

      expect(JSON.parse(result.content[0].text)).toEqual(mockFinding);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents/42/findings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(expectedBody),
        }),
      );
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

    it("forwards mitigation state from the MCP completion tool", async () => {
      const harness = createToolHarness();
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ run: { id: "run-v2", status: "completed" } }),
          { status: 200 },
        ),
      );

      await harness.callTool("tellagen_complete_investigation", {
        run_id: "run-v2",
        status: "completed",
        mitigation_state: "recovered",
      });

      const request = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({
        status: "completed",
        mitigation_state: "recovered",
      });
    });

    it("validates and forwards structured causal paths and recommended actions", async () => {
      const apiClient = new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      });
      const server = new McpServer({ name: "structured-result-test", version: "0.0.1" });
      registerAllTools(server, apiClient);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: "structured-result-client", version: "1.0.0" },
        { capabilities: {} },
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ run: { id: "run-structured", status: "completed" } }), { status: 200 }),
      );

      await server.connect(serverTransport);
      await mcpClient.connect(clientTransport);
      try {
        const rootEvidenceRef = {
          source: "local-host",
          query: "filesystem topology",
          result_summary: "Prometheus is on /dev/sdb while root is /dev/sda1.",
          result_sample: "/dev/sda1 /; /dev/sdb /var/lib/docker",
          url: "https://monitoring.example.invalid/evidence/root-topology",
          source_url: "https://monitoring.example.invalid/evidence/root-topology?view=sanitized",
          captured_at: "2026-08-29T18:00:00Z",
          artifact_id: "artifact-topology",
          artifact_digest: "sha256:topology",
          tool_use_id: "tool-topology",
          evidence_fact_key: "run-structured:artifact:artifact-topology",
          result_bytes: 512,
          truncated: false,
          verified: true,
        };
        const walEvidenceRef = {
          source: "grafana",
          query: "prometheus WAL failures",
          result_summary: "Prometheus WAL recovery failed on /dev/sdb after an earlier ENOSPC event.",
          source_url: "https://grafana.example.invalid/explore?left=wal",
          evidence_fact_key: "run-structured:source_url:wal",
          verified: true,
        };
        const resultSummary = {
          conclusion: {
            tone: "warning",
            eyebrow: "Investigation complete",
            sentence: "Root pressure and the Prometheus WAL failure are separate causal paths.",
            show_new_investigation_cta: true,
          },
          likely_cause_label: "CI and runtime data exhausted the root filesystem.",
          customer_impact: {
            status: "unknown",
            verified: false,
            label: "Not assessed",
          },
          confidence_percent: 96,
          signals_checked: { checked: 5, total: 5, by_source: { local_host: 2 } },
          takeaways: [],
          outcome_state: "successful",
          assessment: { diagnosis_state: "confirmed", exposure_state: "elevated" },
          impact: {
            state: "active",
            summary: "Root headroom remains low.",
            scope: [{ kind: "filesystem", label: "/dev/sda1 mounted at /", state: "affected" }],
          },
          causal_paths: [
            {
              id: "root-pressure",
              label: "Root filesystem pressure",
              kind: "primary",
              steps: [
                {
                  id: "topology",
                  claim: "CI/runtime data consumed root capacity.",
                  verification: "confirmed",
                  confidence_percent: 96,
                  evidence_refs: [rootEvidenceRef],
                },
              ],
            },
            {
              id: "prometheus-wal",
              label: "Prometheus WAL recovery",
              kind: "contributing",
              steps: [
                {
                  id: "wal-recovery",
                  claim: "Prometheus has a separate WAL recovery failure on /dev/sdb.",
                  relation_to_previous: "correlates_with",
                  verification: "confirmed",
                  confidence_percent: 91,
                  evidence_refs: [walEvidenceRef],
                },
              ],
            },
          ],
          recommended_actions: [
            {
              key: "root-cleanup",
              title: "Recover root filesystem headroom",
              summary: "Clean the evidence-linked CI/runtime paths after responder approval.",
              category: "mitigate",
              priority: "high",
              operational_caveat: "Do not delete active runner or container data.",
              recommended_owner: "infrastructure owner",
              recommendation_reason: "These paths are on the alerted filesystem.",
              evidence_refs: [rootEvidenceRef],
            },
            {
              key: "wal-recovery",
              title: "Recover the Prometheus WAL separately",
              summary: "Follow the reviewed WAL recovery procedure for /dev/sdb after root headroom is stable.",
              category: "recover",
              priority: "medium",
              operational_caveat: "Do not treat WAL recovery as remediation for /dev/sda1 pressure.",
              recommended_owner: "observability owner",
              recommendation_reason: "The WAL failure is evidence-linked to a different filesystem.",
              evidence_refs: [walEvidenceRef],
            },
          ],
          question_verification: {
            finding_id: 42,
            verdict: "resolved",
            summary: "Runtime topology disproved Prometheus as the root consumer.",
            evidence_refs: [rootEvidenceRef, walEvidenceRef],
          },
        };

        const result = await mcpClient.callTool({
          name: "tellagen_complete_investigation",
          arguments: {
            run_id: "run-structured",
            status: "completed",
            mitigation_state: "none",
            result_summary: resultSummary,
          },
        });

        expect(result.isError).not.toBe(true);
        const request = fetchSpy.mock.calls[0][1] as RequestInit;
        const requestBody = JSON.parse(String(request.body));
        expect(requestBody).toEqual({
          status: "completed",
          mitigation_state: "none",
          result_summary: resultSummary,
        });
        expect(requestBody.result_summary.causal_paths).toHaveLength(2);
        expect(requestBody.result_summary.recommended_actions).toHaveLength(2);
      } finally {
        await mcpClient.close();
        await server.close();
      }
    });

    it("preserves structured coverage when completion is blocked", async () => {
      const harness = createToolHarness();
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "investigation_completion_blocked",
            message: "Investigation completion is blocked by frozen runbook coverage.",
            coverage: {
              decision: "blocked",
              missing_check_ids: ["runbook:42:v3:check:check-error-rate"],
            },
          }),
          { status: 422 },
        ),
      );

      const result = await harness.callTool(
        "tellagen_complete_investigation",
        { run_id: "run-v2", status: "completed", mitigation_state: "none" },
      );

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        error: true,
        status: 422,
        code: "investigation_completion_blocked",
        coverage: {
          decision: "blocked",
          missing_check_ids: ["runbook:42:v3:check:check-error-rate"],
        },
      });
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

    it("exposes the canonical API fields and maps gist to short_title", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ incident: { id: 99 } }), {
          status: 201,
        }),
      );

      expect(
        Object.keys(
          harness.getTool("tellagen_create_incident").config.inputSchema,
        ).sort(),
      ).toEqual(
        [
          "title",
          "service",
          "regions",
          "severity",
          "short_title",
          "gist",
          "doc_url",
          "impact_summary",
          "team_id",
          "issue_type",
          "status",
          "severity_mode",
          "create_slack_channel",
          "invite_usergroups",
        ].sort(),
      );

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

    it("keeps title, short_title, and impact_summary distinct", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ incident: { id: 99 } }), {
          status: 201,
        }),
      );

      await harness.callTool("tellagen_create_incident", {
        title: "  Payments API requests timing out  ",
        short_title: "pay-lag",
        impact_summary: "EU customers cannot complete authorization",
        service: "payments",
        severity: "sev2",
        severity_mode: "manual",
        issue_type: "incident",
        status: "active",
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/incidents",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            title: "Payments API requests timing out",
            short_title: "pay-lag",
            impact_summary: "EU customers cannot complete authorization",
            service: "payments",
            severity: "sev2",
            severity_mode: "manual",
            issue_type: "incident",
            status: "active",
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
        title: "Checkout recovered; monitoring latency",
        status: "monitoring",
        severity: "sev2",
        issue_type: "incident",
        team_id: 7,
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
            title: "Checkout recovered; monitoring latency",
            status: "monitoring",
            severity: "sev2",
            issue_type: "incident",
            team_id: 7,
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

  describe("datasource MCP tools", () => {
    const grafanaDatasource = {
      id: 7,
      name: "tellagen-grafana",
      type: "grafana",
      custody_mode: "metadata_only",
      enabled: true,
      config: {
        base_url: "https://grafana.example.com",
        required_env_vars: [
          "GRAFANA_URL",
          "GRAFANA_SERVICE_ACCOUNT_TOKEN",
        ],
        datasource_names: ["prometheus-prod"],
        mcp_server: "grafana",
      },
      status: { healthy: true },
    };

    it("probes Grafana health using local env without returning secrets", async () => {
      const harness = createToolHarness();
      vi.stubEnv("GRAFANA_URL", "https://grafana.example.com/");
      vi.stubEnv("GRAFANA_SERVICE_ACCOUNT_TOKEN", "secret-token");

      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ datasources: [grafanaDatasource] }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ database: "ok", version: "11.2.0" }),
            { status: 200 },
          ),
        );

      const result = await harness.callTool("tellagen_probe_datasource", {
        name: "tellagen-grafana",
      });
      const payload = JSON.parse(result.content[0].text);

      expect(payload).toMatchObject({
        ok: true,
        datasource: {
          id: 7,
          name: "tellagen-grafana",
          type: "grafana",
          base_url: "https://grafana.example.com",
          mcp_server: "grafana",
          datasource_names: ["prometheus-prod"],
          required_env_vars: [
            "GRAFANA_URL",
            "GRAFANA_SERVICE_ACCOUNT_TOKEN",
          ],
        },
        missing_env_vars: [],
      });
      expect(payload.checks).toContainEqual(
        expect.objectContaining({
          name: "grafana_health",
          status: "ok",
          http_status: 200,
        }),
      );
      expect(JSON.stringify(payload)).not.toContain("secret-token");
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        "https://test.api.tellagen.com/api/v1/datasources",
        expect.objectContaining({ method: "GET" }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "https://grafana.example.com/api/health",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer secret-token",
          }),
        }),
      );
    });

    it("reports missing local env vars and does not call Grafana", async () => {
      const harness = createToolHarness();

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ datasources: [grafanaDatasource] }), {
          status: 200,
        }),
      );

      const result = await harness.callTool("tellagen_probe_datasource", {
        datasource_id: 7,
      });
      const payload = JSON.parse(result.content[0].text);

      expect(payload).toMatchObject({
        ok: false,
        missing_env_vars: [
          "GRAFANA_URL",
          "GRAFANA_SERVICE_ACCOUNT_TOKEN",
        ],
      });
      expect(payload.checks).toContainEqual(
        expect.objectContaining({
          name: "required_env",
          status: "error",
        }),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(payload)).not.toContain("Bearer");
    });

    it("strips URL credentials and sensitive query params from Grafana diagnostics", async () => {
      const harness = createToolHarness();
      vi.stubEnv(
        "GRAFANA_URL",
        "https://admin:secret@grafana.example.com/dashboards?token=must-not-leak",
      );
      vi.stubEnv("GRAFANA_SERVICE_ACCOUNT_TOKEN", "service-token");

      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ datasources: [grafanaDatasource] }), {
            status: 200,
          }),
        )
        .mockRejectedValueOnce(
          new Error(
            "connect https://admin:secret@grafana.example.com?token=must-not-leak",
          ),
        );

      const result = await harness.callTool("tellagen_probe_datasource", {
        name: "tellagen-grafana",
      });
      const payload = JSON.parse(result.content[0].text);
      const serialized = JSON.stringify(payload);

      expect(payload.ok).toBe(false);
      expect(payload.checks).toContainEqual(
        expect.objectContaining({
          name: "grafana_health",
          status: "error",
        }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "https://grafana.example.com/dashboards/api/health",
        expect.objectContaining({ method: "GET" }),
      );
      expect(serialized).not.toContain("admin");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("must-not-leak");
      expect(serialized).not.toContain("service-token");
    });
  });

  describe("diagnostic session MCP tools", () => {
    it("fetches a diagnostic session by id", async () => {
      const harness = createToolHarness();
      const response = {
        session: {
          id: "diag_abc123",
          client: "codex",
          status: "waiting",
          requested_tools: ["grafana", "github"],
          created_at: "2026-07-07T12:00:00Z",
          expires_at: "2026-07-07T12:05:00Z",
        },
        tools: [],
        reports: [],
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(response), { status: 200 }),
      );

      const result = await harness.callTool("tellagen_get_diagnostic_session", {
        diagnostic_session_id: "diag_abc123",
      });

      expect(JSON.parse(result.content[0].text)).toEqual(response);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/settings/agent/diagnostic-sessions/diag_abc123",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("posts sanitized MCP diagnostic reports to the diagnostic session", async () => {
      const harness = createToolHarness();
      const report = {
        tool_id: "grafana",
        client: "codex",
        profile_id: "work-cluster",
        mcp_server_name: "grafana",
        installed: true,
        access_status: "ok",
        capabilities: ["dashboards:list", "prometheus:query"],
        checks: [
          {
            id: "dashboards_list",
            label: "Dashboards list",
            status: "ok",
            summary: "safe read-only dashboard listing succeeded",
          },
        ],
      };
      const response = {
        reports: [
          {
            id: 1,
            session_id: "diag_abc123",
            client: "codex",
            checked_at: "2026-07-07T12:00:00Z",
            created_at: "2026-07-07T12:00:00Z",
            ...report,
          },
        ],
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(response), { status: 200 }),
      );

      const result = await harness.callTool(
        "tellagen_report_diagnostic_tools",
        {
          diagnostic_session_id: "diag_abc123",
          reports: [report],
        },
      );

      expect(JSON.parse(result.content[0].text)).toEqual(response);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.api.tellagen.com/api/v1/settings/agent/diagnostic-sessions/diag_abc123/reports",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            reports: [
              {
                ...report,
                reported_by: "tellagen-mcp-server",
              },
            ],
          }),
        }),
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

  it("publishes required guidance and append-only postmortem inputs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { server } = createTestSetup();
    const mcpClient = new Client(
      { name: "tool-schema-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await mcpClient.connect(clientTransport);

      const tools = await mcpClient.listTools();
      const traceTool = tools.tools.find(
        (tool) => tool.name === "tellagen_post_trace_step",
      );
      // The run id is optional: the session remembers the run it picked up.
      expect(traceTool?.inputSchema.required).not.toContain("investigation_run_id");
      expect(traceTool?.inputSchema.required).toEqual(
        expect.arrayContaining(["step_id", "status", "title"]),
      );
      expect(traceTool?.inputSchema.required).not.toContain("guidance");
      expect(traceTool?.inputSchema.properties).toHaveProperty("guidance");

      const postmortemUpdateTool = tools.tools.find(
        (tool) => tool.name === "tellagen_update_postmortem",
      );
      expect(postmortemUpdateTool?.inputSchema.required).toEqual(
        expect.arrayContaining([
          "incident_id",
          "postmortem_version_id",
          "title",
          "markdown",
          "source_bundle_id",
        ]),
      );
      expect(postmortemUpdateTool?.description).toContain(
        "snapshots a changed shared draft as a minor version first",
      );

      const completeTool = tools.tools.find(
        (tool) => tool.name === "tellagen_complete_investigation",
      );
      const completeInput = completeTool?.inputSchema as {
        properties?: Record<string, any>;
      };
      const resultSummaryInput = completeInput.properties?.result_summary;
      expect(resultSummaryInput.properties.confidence_percent.type).toBe("integer");

      const invalid = await mcpClient.callTool({
        name: "tellagen_post_trace_step",
        arguments: {
          investigation_run_id: "run-abc",
          step_id: "health-1",
          status: "running",
          title: "Check service health",
          // The basis may be left out, but a wrong one is refused before any request.
          guidance: { origin: "legacy_unattributed", refs: [] },
        },
      });
      expect(invalid.isError).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await mcpClient.close();
      await server.close();
      fetchSpy.mockRestore();
    }
  });
});
