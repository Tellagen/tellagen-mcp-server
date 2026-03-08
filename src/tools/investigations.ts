import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";

export function registerInvestigationTools(
  server: McpServer,
  client: TellagenClient,
): void {
  server.registerTool(
    "tellagen_start_investigation",
    {
      description:
        "Start a new AI investigation run on a Tellagen incident. Returns the created run with its ID for posting findings.",
      inputSchema: {
        incident_id: z.number().int().positive().describe("Incident ID"),
        agent_name: z
          .string()
          .min(1)
          .describe(
            'Name of the AI agent performing the investigation (e.g., "Claude Code")',
          ),
        model_used: z
          .string()
          .min(1)
          .describe(
            'Model identifier (e.g., "claude-opus-4-6")',
          ),
        data_sources: z
          .array(z.string())
          .optional()
          .describe(
            'List of data sources the agent will consult (e.g., ["codebase", "grafana-loki", "github"])',
          ),
      },
    },
    async ({ incident_id, agent_name, model_used, data_sources }) => {
      try {
        const data = await client.post(
          `/api/v1/incidents/${incident_id}/investigations`,
          {
            agent_name,
            model_used,
            data_sources: data_sources ?? [],
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
    "tellagen_list_investigation_runs",
    {
      description:
        "List all investigation runs for a Tellagen incident. Shows run status, agent info, and finding counts.",
      inputSchema: {
        incident_id: z.number().int().positive().describe("Incident ID"),
      },
    },
    async ({ incident_id }) => {
      try {
        const data = await client.get(
          `/api/v1/incidents/${incident_id}/investigations`,
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
    "tellagen_complete_investigation",
    {
      description:
        'Complete or fail an investigation run. Set status to "completed" when done, or "failed" with a failure_reason if the investigation could not finish.',
      inputSchema: {
        run_id: z.string().min(1).describe("Investigation run ID"),
        status: z
          .enum(["completed", "failed"])
          .describe("Final status for the run"),
        failure_reason: z
          .string()
          .optional()
          .describe('Reason for failure (required when status is "failed")'),
      },
    },
    async ({ run_id, status, failure_reason }) => {
      try {
        const body: Record<string, string> = { status };
        if (failure_reason) {
          body.failure_reason = failure_reason;
        }
        const data = await client.patch(
          `/api/v1/investigations/${run_id}`,
          body,
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
