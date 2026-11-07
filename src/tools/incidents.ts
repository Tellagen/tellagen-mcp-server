import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";

export function registerIncidentTools(
  server: McpServer,
  client: TellagenClient,
): void {
  server.registerTool(
    "tellagen_get_incident",
    {
      description:
        "Read one incident by ID. Use it to get the current severity, status, services, timestamps and manager. Returns the incident record. It changes nothing.",
      inputSchema: {
        incident_id: z
          .number()
          .int()
          .positive()
          .describe("Incident ID"),
      },
    },
    async ({ incident_id }) => {
      try {
        const data = await client.get(
          `/api/v1/incidents/${incident_id}`,
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
    "tellagen_list_incidents",
    {
      description:
        "List the incidents of the workspace, optionally by status (active, resolved or all). Use it to find an incident ID. Returns an array of summary records; call tellagen_get_incident for full details. It changes nothing.",
      inputSchema: {
        status: z
          .enum(["active", "resolved", "all"])
          .optional()
          .describe("Filter by incident status"),
      },
    },
    async ({ status }) => {
      try {
        const query = status && status !== "all" ? `?status=${status}` : "";
        const data = await client.get(`/api/v1/incidents${query}`);
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
    "tellagen_get_incident_timeline",
    {
      description:
        "Read the timeline of one incident: status changes, key decisions, findings and notes. Use it to learn what has already happened. To read a single event, use tellagen_get_timeline_event. It changes nothing.",
      inputSchema: {
        incident_id: z
          .number()
          .int()
          .positive()
          .describe("Incident ID"),
      },
    },
    async ({ incident_id }) => {
      try {
        const data = await client.get(
          `/api/v1/incidents/${incident_id}/timeline`,
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
    "tellagen_create_incident",
    {
      description:
        "Create a new incident. Use it only when the user asks for one. Use title for the editable display title, short_title only for the ID and Slack slug, and impact_summary for the separate impact narrative. Returns the created incident with its ID. It does not start an investigation: call tellagen_start_investigation for that.",
      inputSchema: {
        title: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .optional()
          .describe(
            "Canonical editable incident display title. Recommended for every new incident",
          ),
        service: z
          .string()
          .max(128)
          .optional()
          .describe("Service name"),
        regions: z
          .array(z.string())
          .optional()
          .describe("Affected regions"),
        severity: z
          .string()
          .optional()
          .describe('Severity key (e.g. "sev1", "sev2")'),
        short_title: z
          .string()
          .max(12)
          .optional()
          .describe(
            "Short slug used in the Tellagen human ID and Slack channel name; not the display title",
          ),
        gist: z
          .string()
          .max(12)
          .optional()
          .describe("Deprecated alias for short_title"),
        doc_url: z
          .string()
          .url()
          .optional()
          .describe("Runbook or postmortem URL"),
        impact_summary: z
          .string()
          .optional()
          .describe(
            "Customer or operational impact narrative, distinct from the incident title",
          ),
        team_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Owning team ID"),
        issue_type: z
          .string()
          .optional()
          .describe(
            "Lifecycle classification, for example incident, ticket, or postmortem",
          ),
        status: z
          .string()
          .optional()
          .describe("Initial configured workflow status"),
        severity_mode: z
          .enum(["auto", "manual"])
          .optional()
          .describe("Whether severity is automatic or manually selected"),
        create_slack_channel: z
          .boolean()
          .optional()
          .describe("Whether to create a Slack channel"),
        invite_usergroups: z
          .array(z.string())
          .optional()
          .describe("Slack usergroup handles to invite"),
      },
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || key === "gist") {
            continue;
          }
          if (key === "title" && typeof value === "string") {
            body.title = value.trim();
          } else if (key === "short_title") {
            body.short_title = value;
          } else {
            body[key] = value;
          }
        }
        if (body.short_title === undefined && params.gist !== undefined) {
          body.short_title = params.gist;
        }
        const data = await client.post("/api/v1/incidents", body);
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
    "tellagen_update_incident",
    {
      description:
        "Change fields of an existing incident: display title, service, regions, severity, status, owning team, impact summary, links and key timestamps. Send only the fields to change. Returns the updated incident. It cannot delete an incident or record a root cause.",
      inputSchema: {
        incident_id: z.number().int().positive().describe("Incident ID"),
        title: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .optional()
          .describe("Editable incident display title"),
        service: z.string().optional(),
        regions: z.array(z.string()).optional(),
        severity: z.string().optional(),
        slack_channel_id: z.string().optional(),
        meet_url: z.string().url().optional(),
        doc_url: z.string().url().optional(),
        status: z.string().optional(),
        issue_type: z.string().optional(),
        team_id: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe("Owning team ID, or null to remove the assignment"),
        severity_mode: z.string().optional(),
        impact_summary: z.string().optional(),
        impact_started_at: z
          .string()
          .datetime()
          .optional()
          .describe("ISO timestamp when customer impact started"),
        first_reported_at: z
          .string()
          .datetime()
          .optional()
          .describe("ISO timestamp when the incident was first reported"),
        first_responded_at: z
          .string()
          .datetime()
          .optional()
          .describe("ISO timestamp when response began"),
        recovered_at: z
          .string()
          .datetime()
          .optional()
          .describe("ISO timestamp when impact recovered"),
      },
    },
    async ({ incident_id, ...params }) => {
      try {
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) {
            body[key] = value;
          }
        }
        const data = await client.patch(`/api/v1/incidents/${incident_id}`, body);
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
