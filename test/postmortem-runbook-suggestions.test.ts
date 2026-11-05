import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TellagenClient } from "../src/client.js";
import { TellagenAPIError } from "../src/errors.js";
import { createServer } from "../src/server.js";
import {
  postmortemRunbookCandidatesInputSchema,
  registerPostmortemRunbookTools,
} from "../src/tools/postmortem-runbooks.js";

type RegisteredTool = {
  handler: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
};

function createHarness() {
  const post = vi.fn();
  const get = vi.fn();
  const client = { post, get } as unknown as TellagenClient;
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      handler: RegisteredTool["handler"],
    ) => tools.set(name, { handler }),
  } as unknown as McpServer;

  registerPostmortemRunbookTools(server, client);
  const tool = tools.get("tellagen_submit_postmortem_runbook_candidates");
  if (!tool) throw new Error("postmortem runbook candidate tool not registered");
  return { post, get, tool, tools };
}

const baseCandidate = {
  name: "Diagnose checkout failures after a deploy",
  description:
    "Checks deploy correlation, customer-facing error rate, and workload health for checkout-api.",
  rationale:
    "The investigation used the same bounded sequence to isolate the incident cause and verify recovery.",
  reuse_case:
    "Use when checkout-api error rate rises within 30 minutes of a deployment.",
  trigger_summary: "checkout-api 5xx or latency regression after deploy",
  limitations: [
    "Does not prove causation when deployment metadata is unavailable.",
  ],
  relation: "new" as const,
  definition_json: {
    schema_version: "v2" as const,
    checks: [
      { id: "check-error-rate" },
      { id: "check-workload-health" },
    ],
  },
  supporting_evidence: [
    {
      check_id: "check-error-rate",
      investigation_run_id: "run-incident-42",
      finding_ids: [701],
      trace_step_ids: ["trace-prometheus-error-rate"],
    },
    {
      check_id: "check-workload-health",
      investigation_run_id: "run-incident-42",
      finding_ids: [702],
      trace_step_ids: ["trace-kubernetes-workload"],
    },
  ],
};

const baseInput = {
  incident_id: 42,
  submission_id: "11111111-1111-4111-8111-111111111111",
  source_bundle_id: "pm-src-42-a1b2",
  postmortem_version_id: 9,
  analysis_summary:
    "Reviewed the final postmortem, persisted investigation evidence, and matched runbooks.",
  candidates: [baseCandidate],
};

const zeroReasonCodes = [
  "no_completed_investigation",
  "insufficient_check_evidence",
  "unsupported_source_capability",
  "not_repeatable",
  "remediation_only",
  "existing_runbook_covers_pattern",
  "validation_failed",
  "tool_unavailable",
] as const;

describe("postmortem runbook candidate contract", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a bounded candidate with check-by-check persisted evidence", () => {
    expect(postmortemRunbookCandidatesInputSchema.safeParse(baseInput).success).toBe(
      true,
    );
  });

  it("requires exactly one postmortem anchor", () => {
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        postmortem_timeline_event_id: 300,
      }).success,
    ).toBe(false);
    const { postmortem_version_id: _omitted, ...withoutAnchor } = baseInput;
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse(withoutAnchor).success,
    ).toBe(false);
  });

  it.each(zeroReasonCodes)("accepts classified zero outcome %s", (code) => {
    const input = {
      ...baseInput,
      candidates: [],
      no_candidates_reason_code: code,
      no_candidates_reason: "Sanitized technical detail.",
      ...(code === "existing_runbook_covers_pattern"
        ? { covering_runbook: { runbook_id: 17, version: 4 } }
        : {}),
    };
    expect(postmortemRunbookCandidatesInputSchema.safeParse(input).success).toBe(
      true,
    );
  });

  it("rejects unclassified and invalidly covered zero outcomes", () => {
    const cases = [
      {
        ...baseInput,
        candidates: [],
        no_candidates_reason: "Missing code.",
      },
      {
        ...baseInput,
        candidates: [],
        no_candidates_reason_code: "invented",
        no_candidates_reason: "Unknown code.",
      },
      {
        ...baseInput,
        candidates: [],
        no_candidates_reason_code: "existing_runbook_covers_pattern",
        no_candidates_reason: "Missing exact covering reference.",
      },
      {
        ...baseInput,
        candidates: [],
        no_candidates_reason_code: "not_repeatable",
        no_candidates_reason: "Cover is forbidden for this code.",
        covering_runbook: { runbook_id: 17, version: 4 },
      },
      {
        ...baseInput,
        candidates: [baseCandidate],
        no_candidates_reason_code: "not_repeatable",
        no_candidates_reason: "Zero fields cannot accompany candidates.",
      },
      {
        ...baseInput,
        candidates: [],
        no_candidates_reason_code: "not_repeatable",
        no_candidates_reason: "Client actions are forbidden.",
        action: "restart_database",
      },
      {
        ...baseInput,
        candidates: [],
        no_candidates_reason_code: "not_repeatable",
        no_candidates_reason: "Client URLs are forbidden.",
        url: "https://example.invalid/action",
      },
      {
        ...baseInput,
        candidates: [],
        no_candidates_reason_code: "not_repeatable",
        no_candidates_reason: "Client commands are forbidden.",
        command: "restart database",
      },
    ];
    for (const input of cases) {
      expect(postmortemRunbookCandidatesInputSchema.safeParse(input).success).toBe(
        false,
      );
    }
  });

  it.each([
    ["zero runbook ID", { runbook_id: 0, version: 4 }],
    ["zero version", { runbook_id: 17, version: 0 }],
    ["negative runbook ID", { runbook_id: -17, version: 4 }],
    ["negative version", { runbook_id: 17, version: -4 }],
    ["fractional runbook ID", { runbook_id: 17.5, version: 4 }],
    ["fractional version", { runbook_id: 17, version: 4.5 }],
    ["missing runbook ID", { version: 4 }],
    ["missing version", { runbook_id: 17 }],
    [
      "extra property",
      { runbook_id: 17, version: 4, action: "open_runbook" },
    ],
  ])("rejects an existing cover with %s", (_case, coveringRunbook) => {
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        candidates: [],
        no_candidates_reason_code: "existing_runbook_covers_pattern",
        no_candidates_reason: "An exact published runbook already covers this.",
        covering_runbook: coveringRunbook,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["action", { action: "restart_database" }],
    ["URL", { url: "https://example.invalid/action" }],
    ["href", { href: "https://example.invalid/action" }],
    ["command", { command: "restart database" }],
  ])(
    "rejects a client-provided %s field at the MCP transport boundary",
    async (_field, forbiddenField) => {
      const post = vi.fn().mockResolvedValue({
        evaluation: { id: 88, candidates: [] },
      });
      const server = new McpServer(
        { name: "postmortem-zero-transport-test", version: "1.0.0" },
        { capabilities: {} },
      );
      registerPostmortemRunbookTools(
        server,
        { post } as unknown as TellagenClient,
      );
      const mcpClient = new Client(
        { name: "postmortem-zero-transport-client", version: "1.0.0" },
        { capabilities: {} },
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();

      try {
        await server.connect(serverTransport);
        await mcpClient.connect(clientTransport);

        const result = await mcpClient.callTool({
          name: "tellagen_submit_postmortem_runbook_candidates",
          arguments: {
            ...baseInput,
            candidates: [],
            no_candidates_reason_code: "not_repeatable",
            no_candidates_reason:
              "The incident did not produce a repeatable diagnostic sequence.",
            ...forbiddenField,
          },
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(
          "Input validation error",
        );
        expect(post).not.toHaveBeenCalled();
      } finally {
        await mcpClient.close();
        await server.close();
      }
    },
  );

  it("forwards classified zero outcome unchanged", async () => {
    const input = {
      ...baseInput,
      candidates: [],
      no_candidates_reason_code: "unsupported_source_capability" as const,
      no_candidates_reason: "Node status is not a typed source capability.",
    };
    const { post, tool } = createHarness();
    post.mockResolvedValue({ evaluation: { id: 88, candidates: [] } });

    await tool.handler(input);

    expect(post).toHaveBeenCalledWith(
      "/api/v1/incidents/42/postmortem/runbook-suggestions",
      expect.objectContaining({
        no_candidates_reason_code: "unsupported_source_capability",
        no_candidates_reason: input.no_candidates_reason,
        candidates: [],
      }),
    );
  });

  it("allows only new or exact-version extension candidates", () => {
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        candidates: [
          {
            ...baseCandidate,
            relation: "extends",
            existing_runbook: { runbook_id: 17, version: 4 },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        candidates: [{ ...baseCandidate, relation: "extends" }],
      }).success,
    ).toBe(false);
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        candidates: [
          {
            ...baseCandidate,
            existing_runbook: { runbook_id: 17, version: 4 },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        candidates: [{ ...baseCandidate, relation: "replaces" }],
      }).success,
    ).toBe(false);
  });

  it("rejects ungrounded, unknown, or uncovered definition checks", () => {
    const missingEvidence = {
      ...baseCandidate,
      supporting_evidence: [baseCandidate.supporting_evidence[0]],
    };
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        candidates: [missingEvidence],
      }).success,
    ).toBe(false);

    const unknownCheck = {
      ...baseCandidate,
      supporting_evidence: [
        ...baseCandidate.supporting_evidence,
        {
          check_id: "check-invented",
          investigation_run_id: "run-incident-42",
          finding_ids: [999],
          trace_step_ids: [],
        },
      ],
    };
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        candidates: [unknownCheck],
      }).success,
    ).toBe(false);

    const emptyEvidence = {
      ...baseCandidate,
      supporting_evidence: [
        {
          check_id: "check-error-rate",
          investigation_run_id: "run-incident-42",
          finding_ids: [],
          trace_step_ids: [],
        },
      ],
    };
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        candidates: [emptyEvidence],
      }).success,
    ).toBe(false);
  });

  it("caps submissions at three and exposes no publish or activate fields", () => {
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        candidates: [
          baseCandidate,
          { ...baseCandidate, name: "Candidate two" },
          { ...baseCandidate, name: "Candidate three" },
          { ...baseCandidate, name: "Candidate four" },
        ],
      }).success,
    ).toBe(false);
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        publish: true,
        activate: true,
      }).success,
    ).toBe(false);
    expect(
      postmortemRunbookCandidatesInputSchema.safeParse({
        ...baseInput,
        candidates: [
          {
            ...baseCandidate,
            limitations: Array.from(
              { length: 9 },
              (_, index) => `Limitation ${index + 1}`,
            ),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("posts exact provenance and derives the local client profile", async () => {
    vi.stubEnv("TELLAGEN_MCP_CLIENT", "claude");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", " work-laptop ");
    const { post, tool } = createHarness();
    post.mockResolvedValue({
      evaluation: { id: 88, status: "ready_for_review", candidates: [] },
    });

    const result = await tool.handler(baseInput);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      evaluation: { id: 88, status: "ready_for_review", candidates: [] },
    });
    expect(post).toHaveBeenCalledWith(
      "/api/v1/incidents/42/postmortem/runbook-suggestions",
      {
        submission_id: baseInput.submission_id,
        source_bundle_id: baseInput.source_bundle_id,
        postmortem_version_id: 9,
        analysis_summary: baseInput.analysis_summary,
        candidates: [baseCandidate],
        client: {
          name: "claude",
          profile_id: "work-laptop",
          mcp_server_version: "0.4.1",
        },
      },
    );
  });

  it("preserves structured 422 candidate repair details", async () => {
    const { post, tool } = createHarness();
    post.mockRejectedValue(
      new TellagenAPIError(
        422,
        "runbook_candidate_validation_failed",
        "Candidate 0 did not compile",
        {
          code: "runbook_candidate_validation_failed",
          message: "Candidate 0 did not compile",
          candidate_index: 0,
          validation: {
            field: "definition_json.checks[1].evidence_contract",
            reason: "missing required time_range evidence",
          },
        },
      ),
    );

    const result = await tool.handler(baseInput);
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      error: true,
      status: 422,
      code: "runbook_candidate_validation_failed",
      candidate_index: 0,
      validation: {
        field: "definition_json.checks[1].evidence_contract",
        reason: "missing required time_range evidence",
      },
    });
  });

  it("publishes the tool and authoritative Structured v2 contract resource", async () => {
    const server = createServer(
      new TellagenClient({
        apiUrl: "https://test.api.tellagen.com",
        apiKey: "tllg_test",
      }),
    );
    const mcpClient = new Client(
      { name: "postmortem-runbook-contract-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await mcpClient.connect(clientTransport);

      expect(mcpClient.getServerCapabilities()?.experimental).toMatchObject({ "tellagen/postmortem-analysis": { protocol_version: 2 } });
      const tools = await mcpClient.listTools();
      expect(tools.tools).toHaveLength(46);
      const candidateTool = tools.tools.find(
        (tool) =>
          tool.name === "tellagen_submit_postmortem_runbook_candidates",
      );
      expect(candidateTool?.description).toContain("review suggestions only");
      expect(candidateTool?.description).toContain("incident-specific literals");
      expect(candidateTool?.description).toContain("stays an action item");
      expect(candidateTool?.description).not.toContain("deduplicates");
      expect(candidateTool?.inputSchema.required).toEqual(
        expect.arrayContaining([
          "incident_id",
          "submission_id",
          "candidates",
        ]),
      );
      expect(candidateTool?.inputSchema.properties).not.toHaveProperty(
        "publish",
      );
      expect(candidateTool?.inputSchema.properties).not.toHaveProperty(
        "activate",
      );

      const resource = await mcpClient.readResource({
        uri: "resource://tellagen/contracts/runbooks/v2/runbook-definition.schema.json",
      });
      const contract = JSON.parse(String(resource.contents[0].text));
      expect(contract).toMatchObject({
        title: "Tellagen structured investigation runbook definition",
        properties: { schema_version: { const: "v2" } },
      });
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});


describe("standalone postmortem analysis", () => {
  it("reads the exact request without writing a postmortem", async () => {
    const { get, post, tools } = createHarness();
    const requestID = "22222222-2222-4222-8222-222222222222";
    get.mockResolvedValue({ id: requestID, context: { protocol_version: 2 } });
    const reader = tools.get("tellagen_get_postmortem_analysis_request");
    expect(reader).toBeDefined();
    const result = await reader!.handler({ incident_id: 42, analysis_request_id: requestID });
    expect(get).toHaveBeenCalledWith(`/api/v1/incidents/42/postmortem/runbook-analysis-requests/${requestID}`);
    expect(post).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).id).toBe(requestID);
  });

  it("forwards strict request identity without requiring legacy anchors", async () => {
    const { tool, post } = createHarness();
    const requestID = "22222222-2222-4222-8222-222222222222";
    const { source_bundle_id, postmortem_version_id, ...input } = baseInput;
    post.mockResolvedValue({ id: 1 });
    const result = await tool.handler({ ...input, analysis_request_id: requestID });
    expect(result.isError).not.toBe(true);
    expect(post).toHaveBeenCalledWith(
      "/api/v1/incidents/42/postmortem/runbook-suggestions",
      expect.objectContaining({ analysis_request_id: requestID }),
    );
  });
});
