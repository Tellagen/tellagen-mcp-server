import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";
import {
  DIAGNOSIS_CHANGES_CAPABILITY,
  evidenceRefStructureShape,
  stripFindingChangeLinks,
  stripFindingEvidenceStructure,
  supportsDiagnosisChanges,
  supportsDiagnosisStructure,
  unsupportedNotice,
} from "../diagnosis-structure.js";

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

const hasStableId = (ref: {
  artifact_id?: string;
  artifact_digest?: string;
  tool_use_id?: string;
}): boolean =>
  [ref.artifact_id, ref.artifact_digest, ref.tool_use_id].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );

const factKeyAloneNotice =
  "evidence_fact_key was sent without artifact_id, artifact_digest or tool_use_id. Tellagen works out the key itself and replaces yours, so it may not join this finding to its trace step. Send the same tool_use_id on the trace step and on the evidence ref.";

const evidenceRefSchema = z
  .object({
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
    result_sample: z
      .string()
      .optional()
      .describe(
        "Short redacted sample output or log lines that support the summary; keep it safe to show inline in Tellagen",
      ),
    url: z
      .string()
      .optional()
      .describe(
        "Deep link to the source (e.g., Grafana explore URL, GitHub commit)",
      ),
    tool_use_id: z
      .string()
      .optional()
      .describe(
        "The tool_use_id you sent on the trace step for this check. Send the same value here: it is the most reliable way to join the finding to that step",
      ),
    artifact_id: z
      .string()
      .optional()
      .describe("The artifact_id of the completed trace step, when it has one"),
    artifact_digest: z
      .string()
      .optional()
      .describe("The artifact_digest of the completed trace step, when it has one"),
    evidence_fact_key: z
      .string()
      .optional()
      .describe(
        "Optional. Tellagen works out this key itself from the other fields of the ref and replaces any value you send, so you do not need it. A summary key from a trace step (run:summary:hash) is accepted and changes nothing. To join the finding to a trace step, send the same tool_use_id (or artifact_id or artifact_digest) on both",
      ),
    captured_at: z
      .string()
      .datetime()
      .optional()
      .describe("ISO timestamp when the evidence was captured"),
    result_bytes: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Size in bytes of the underlying result"),
    truncated: z
      .boolean()
      .optional()
      .describe("Whether the evidence result was truncated"),
    verified: z
      .boolean()
      .optional()
      .describe("Whether the evidence was independently verified"),
    ...evidenceRefStructureShape,
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
        "Post a structured finding to an active investigation run on a Tellagen incident. Post findings incrementally as you discover them — do not batch. The response is {finding:{id,...}}: keep the numeric id, because causal_paths steps, ruled_out, coverage and unknowns cite findings by finding_ids when you complete the run.",
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
            "gap",
          ])
          .describe(
            "Type of finding: observation (notable data), correlation (two related things), hypothesis (proposed cause), evidence (proof), recommendation (suggested action), negative (ruled out), gap (required evidence or source was unavailable)",
          ),
        role: z
          .enum(["confirms", "supports", "contradicts", "gap"])
          .optional()
          .describe(
            "How this finding relates to the current diagnosis. Send contradicts on a negative finding and gap on a gap finding (a required source, check, or evidence contract could not be satisfied). Without a role Tellagen stores supports.",
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
            "References to evidence sources consulted. To join a finding to its trace step, send on the ref the same tool_use_id you sent on that step (or its artifact_id or artifact_digest); Tellagen derives the runbook lineage from the step. evidence_fact_key is optional because Tellagen works it out itself. Add links (from tellagen_build_source_link) for Grafana and GitHub sources and a command for kubectl and other local sources, so every ref opens its source.",
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
      role,
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
        if (role !== undefined) reqBody.role = role;
        if (screenshots !== undefined) reqBody.screenshots = screenshots;
        // links, command and datasource go only to a backend that advertises
        // diagnosis_structure_v1; an older one would drop them silently.
        let notice: string | undefined;
        if ((evidence_refs ?? []).some((ref) => ref.evidence_fact_key && !hasStableId(ref))) {
          notice = factKeyAloneNotice;
        }
        const stripped = stripFindingEvidenceStructure(reqBody.evidence_refs);
        if (
          stripped.removed.length > 0 &&
          !(await supportsDiagnosisStructure(client, investigation_run_id))
        ) {
          reqBody.evidence_refs = stripped.refs;
          const structureNotice = unsupportedNotice(stripped.removed);
          notice = notice ? `${notice} ${structureNotice}` : structureNotice;
        }
        // ci_run, deployment and release links need diagnosis_changes_v1.
        const changeLinks = stripFindingChangeLinks(reqBody.evidence_refs);
        if (
          changeLinks.removed.length > 0 &&
          !(await supportsDiagnosisChanges(client, investigation_run_id))
        ) {
          reqBody.evidence_refs = changeLinks.refs;
          const changesNotice = unsupportedNotice(changeLinks.removed, DIAGNOSIS_CHANGES_CAPABILITY);
          notice = notice ? `${notice} ${changesNotice}` : changesNotice;
        }
        const data = await client.post(
          `/api/v1/incidents/${incident_id}/findings`,
          reqBody,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                notice && data && typeof data === "object" && !Array.isArray(data)
                  ? { ...(data as Record<string, unknown>), mcp_notice: notice }
                  : data,
              ),
            },
          ],
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
        "Promote a finding to the incident timeline. Creates a timeline event visible in the war room. Optionally override the title and body for the timeline entry. Tellagen refuses this while the run has an open gap finding. In that case, post the fact with tellagen_post_timeline_event.",
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
