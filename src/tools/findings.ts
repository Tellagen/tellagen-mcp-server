import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";

const evidenceRefSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      'System name (e.g., "grafana-loki", "github", "pagerduty", "codebase")',
    ),
  query: z
    .string()
    .optional()
    .describe("Query or command used to gather this evidence"),
  result_summary: z
    .string()
    .min(1)
    .describe("What the query returned — summarize the key data"),
  url: z
    .string()
    .optional()
    .describe("Deep link to the source (e.g., Grafana explore URL, GitHub commit)"),
});

export function registerFindingTools(
  server: McpServer,
  client: TellagenClient,
): void {
  server.registerTool(
    "tellagen_post_finding",
    {
      description:
        "Post a structured finding to an active investigation run on a Tellagen incident. Post findings incrementally as you discover them — do not batch.",
      inputSchema: {
        incident_id: z.number().int().positive().describe("Incident ID"),
        investigation_run_id: z
          .string()
          .min(1)
          .describe("Active investigation run ID"),
        finding_type: z
          .enum([
            "observation",
            "correlation",
            "hypothesis",
            "evidence",
            "recommendation",
            "negative",
          ])
          .describe(
            "Type of finding: observation (notable data), correlation (two related things), hypothesis (proposed cause), evidence (proof), recommendation (suggested action), negative (ruled out)",
          ),
        claim: z
          .string()
          .min(1)
          .describe("One-sentence finding statement"),
        evidence_summary: z
          .string()
          .min(1)
          .describe(
            "Detailed explanation with supporting data — this is the body of the finding",
          ),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe(
            "Confidence score from 0.0 to 1.0: 0.9+ near-certain, 0.5-0.7 plausible, <0.5 speculative",
          ),
        confidence_reason: z
          .string()
          .min(1)
          .describe("Why you have this confidence level"),
        evidence_refs: z
          .array(evidenceRefSchema)
          .optional()
          .describe(
            "References to evidence sources consulted. Include deep links in url where possible.",
          ),
      },
    },
    async ({
      incident_id,
      investigation_run_id,
      finding_type,
      claim,
      evidence_summary,
      confidence,
      confidence_reason,
      evidence_refs,
    }) => {
      try {
        const data = await client.post(
          `/api/v1/incidents/${incident_id}/findings`,
          {
            investigation_run_id,
            finding_type,
            claim,
            evidence_summary,
            confidence,
            confidence_reason,
            evidence_refs: evidence_refs ?? [],
          },
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "tellagen_list_findings",
    {
      description:
        "List all findings for a Tellagen incident. Returns findings with type, confidence, status, and evidence.",
      inputSchema: {
        incident_id: z.number().int().positive().describe("Incident ID"),
        run_id: z
          .string()
          .optional()
          .describe("Filter by investigation run ID"),
      },
    },
    async ({ incident_id, run_id }) => {
      try {
        const query = run_id ? `?run_id=${run_id}` : "";
        const data = await client.get(
          `/api/v1/incidents/${incident_id}/findings${query}`,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "tellagen_get_finding",
    {
      description:
        "Get a single finding by ID. Returns full finding details including evidence refs.",
      inputSchema: {
        finding_id: z.number().int().positive().describe("Finding ID"),
      },
    },
    async ({ finding_id }) => {
      try {
        const data = await client.get(`/api/v1/findings/${finding_id}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "tellagen_update_finding",
    {
      description:
        "Update a finding's status (dismiss or restore to draft). Promoted findings are immutable.",
      inputSchema: {
        finding_id: z.number().int().positive().describe("Finding ID"),
        status: z
          .enum(["draft", "dismissed"])
          .describe("New status for the finding"),
      },
    },
    async ({ finding_id, status }) => {
      try {
        const data = await client.patch(`/api/v1/findings/${finding_id}`, {
          status,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "tellagen_promote_finding",
    {
      description:
        "Promote a finding to the incident timeline. Creates a timeline event visible in the war room. Optionally override the title and body for the timeline entry.",
      inputSchema: {
        finding_id: z.number().int().positive().describe("Finding ID"),
        title: z
          .string()
          .optional()
          .describe("Custom title for the timeline event (defaults to finding claim)"),
        body: z
          .string()
          .optional()
          .describe("Custom body for the timeline event (defaults to evidence_summary)"),
        is_key: z
          .boolean()
          .optional()
          .describe("Mark as a key event on the timeline"),
      },
    },
    async ({ finding_id, title, body, is_key }) => {
      try {
        const reqBody: Record<string, unknown> = {};
        if (title !== undefined) reqBody.title = title;
        if (body !== undefined) reqBody.body = body;
        if (is_key !== undefined) reqBody.is_key = is_key;
        const data = await client.post(
          `/api/v1/findings/${finding_id}/promote`,
          reqBody,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );
}
