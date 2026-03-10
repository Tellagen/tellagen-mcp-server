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
        "Get details of a Tellagen incident by ID. Returns severity, status, services, timestamps, and manager info.",
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
        "List all incidents for the current Tellagen workspace. Returns an array of incidents with summary info.",
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
        "Get the timeline of events for a Tellagen incident. Shows status changes, key decisions, findings, and notes.",
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
        "Create a new incident in Tellagen. Returns the created incident with its ID and details.",
      inputSchema: {
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
        gist: z
          .string()
          .max(12)
          .optional()
          .describe("Short slug summary"),
        doc_url: z
          .string()
          .url()
          .optional()
          .describe("Runbook or postmortem URL"),
        team_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Owning team ID"),
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
          if (value !== undefined) {
            body[key] = value;
          }
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
}
