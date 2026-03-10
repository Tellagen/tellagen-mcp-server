import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";

const screenshotSchema = z.object({
  url: z
    .string()
    .url()
    .optional()
    .describe(
      "URL to a hosted screenshot (e.g., Grafana render URL, uploaded image link)",
    ),
  base64: z
    .string()
    .optional()
    .describe("Base64-encoded image data (e.g., PNG screenshot captured by a tool)"),
  media_type: z
    .string()
    .optional()
    .describe('Image media type (e.g., "image/png", "image/jpeg"). Defaults to "image/png"'),
  caption: z
    .string()
    .optional()
    .describe("Description of what the screenshot shows"),
});

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
  screenshots: z
    .array(screenshotSchema)
    .optional()
    .describe(
      "Screenshots related to this evidence (e.g., Grafana dashboard panel showing the spike)",
    ),
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
        screenshots: z
          .array(screenshotSchema)
          .optional()
          .describe(
            "Standalone screenshots for this finding (e.g., Grafana dashboard panels, error traces). Use evidence_refs[].screenshots for source-specific screenshots.",
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
      screenshots,
    }) => {
      try {
        const reqBody: Record<string, unknown> = {
          investigation_run_id,
          finding_type,
          claim,
          evidence_summary,
          confidence,
          confidence_reason,
          evidence_refs: evidence_refs ?? [],
        };
        if (screenshots !== undefined) reqBody.screenshots = screenshots;
        const data = await client.post(
          `/api/v1/incidents/${incident_id}/findings`,
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
        started_at: z
          .string()
          .datetime()
          .optional()
          .describe(
            "ISO 8601 timestamp for when this event started on the timeline (defaults to now)",
          ),
        ended_at: z
          .string()
          .datetime()
          .optional()
          .describe(
            "ISO 8601 timestamp for when this event ended (omit for point events or ongoing)",
          ),
        is_ongoing: z
          .boolean()
          .optional()
          .describe(
            "Mark as an ongoing duration event (ended_at should be omitted)",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Tags for the timeline event (e.g., 'latency', 'database'). Auto-suggested if omitted.",
          ),
        evidence_links: z
          .array(
            z.object({
              source: z.string(),
              url: z.string().url(),
              label: z.string().optional(),
            }),
          )
          .optional()
          .describe(
            "Evidence source links. Auto-extracted from finding evidence_refs if omitted.",
          ),
        screenshots: z
          .array(screenshotSchema)
          .optional()
          .describe(
            "Screenshots to attach to the timeline event (e.g., Grafana panels, error dashboards)",
          ),
      },
    },
    async ({
      finding_id,
      title,
      body,
      is_key,
      started_at,
      ended_at,
      is_ongoing,
      tags,
      evidence_links,
      screenshots,
    }) => {
      try {
        const reqBody: Record<string, unknown> = {};
        if (title !== undefined) reqBody.title = title;
        if (body !== undefined) reqBody.body = body;
        if (is_key !== undefined) reqBody.is_key = is_key;
        if (started_at !== undefined) reqBody.started_at = started_at;
        if (ended_at !== undefined) reqBody.ended_at = ended_at;
        if (is_ongoing !== undefined) reqBody.is_ongoing = is_ongoing;
        if (tags !== undefined) reqBody.tags = tags;
        if (evidence_links !== undefined)
          reqBody.evidence_links = evidence_links;
        if (screenshots !== undefined) reqBody.screenshots = screenshots;
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
