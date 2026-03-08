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
}
