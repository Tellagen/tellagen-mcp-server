import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";

const resultSummarySchema = z
  .object({
    conclusion: z
      .object({
        tone: z.enum(["success", "warning", "danger", "neutral"]),
        eyebrow: z.string(),
        sentence: z.string(),
        show_new_investigation_cta: z.boolean(),
      })
      .describe("Short human-readable conclusion for the RCA record"),
    likely_cause_label: z
      .string()
      .describe("One-line likely cause label, or empty if inconclusive"),
    customer_impact: z.object({
      status: z.enum(["none", "degraded", "outage", "unknown"]),
      verified: z.boolean(),
      label: z.string(),
      evidence_finding_key: z.string().optional(),
    }),
    confidence_percent: z.number().min(0).max(100),
    signals_checked: z.object({
      checked: z.number().int().min(0),
      total: z.number().int().min(0),
      by_source: z.record(z.number().int().min(0)).optional(),
    }),
    takeaways: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        body: z.string().optional(),
        description: z.string().optional(),
        severity: z.enum(["high", "medium", "low"]),
        finding_id: z.string().optional(),
        source_url: z.string().optional(),
      }),
    ),
    outcome_state: z
      .enum(["successful", "inconclusive", "partial-failure", ""])
      .optional(),
    headline: z.string().optional(),
  })
  .describe("Structured RCA summary shown in Tellagen when the run completes");

const traceJsonSchema = z
  .unknown()
  .optional()
  .describe("Optional JSON object captured as tool input or result metadata");

const investigationScopeSchema = z
  .object({
    services: z
      .array(
        z.object({
          name: z.string().min(1),
          observability_names: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    time_range: z
      .object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .optional(),
  })
  .describe("Incident-local scope used to guide local investigation tools");

function generatedStepId(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "step";
  return `${slug}-${Date.now()}`;
}

export function registerInvestigationTools(
  server: McpServer,
  client: TellagenClient,
): void {
  server.registerTool(
    "tellagen_start_investigation",
    {
      description:
        "Start a new local AI investigation run on a Tellagen incident when you were not given an investigation_run_id. If Tellagen UI already provided a run ID, use tellagen_pick_up_investigation instead.",
      inputSchema: {
        incident_id: z.number().int().positive().describe("Incident ID"),
        agent_name: z
          .string()
          .optional()
          .default("local-mcp")
          .describe(
            'Name of the local AI agent performing the investigation (defaults to "local-mcp")',
          ),
        model_used: z
          .string()
          .optional()
          .default("local-llm")
          .describe('Model identifier (defaults to "local-llm")'),
        question: z
          .string()
          .optional()
          .describe("Optional investigation focus or responder question"),
        data_sources: z
          .array(z.string())
          .optional()
          .describe(
            'List of data sources the agent will consult (e.g., ["codebase", "grafana-loki", "github"])',
          ),
        evidence_budget_preset: z
          .enum(["balanced", "expanded", "maximum"])
          .optional()
          .describe("How much evidence detail Tellagen should expect"),
      },
    },
    async ({
      incident_id,
      agent_name,
      model_used,
      question,
      data_sources,
      evidence_budget_preset,
    }) => {
      try {
        const body: Record<string, unknown> = {
          agent_name: agent_name ?? "local-mcp",
          model_used: model_used ?? "local-llm",
          data_sources: data_sources ?? [],
          execution_mode: "local",
        };
        if (question !== undefined) body.question = question;
        if (evidence_budget_preset !== undefined) {
          body.evidence_budget_preset = evidence_budget_preset;
        }
        const data = await client.post(
          `/api/v1/incidents/${incident_id}/investigations`,
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

  server.registerTool(
    "tellagen_get_incident_context",
    {
      description:
        "Get the full Tellagen investigation context bundle for an existing run: incident, scope, timeline, prior findings, connectors, matched runbooks/skills, and output schema guidance.",
      inputSchema: {
        investigation_run_id: z
          .string()
          .min(1)
          .describe("Investigation run ID from Tellagen"),
      },
    },
    async ({ investigation_run_id }) => {
      try {
        const data = await client.get(
          `/api/v1/investigations/${investigation_run_id}/context`,
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
    "tellagen_pick_up_investigation",
    {
      description:
        "Attach this local MCP agent to a Tellagen investigation run created by the UI. Call this first when the prompt includes an investigation_run_id; it moves the run from awaiting_agent to running and returns the full context bundle.",
      inputSchema: {
        investigation_run_id: z
          .string()
          .min(1)
          .describe("Investigation run ID from the Tellagen UI command"),
      },
    },
    async ({ investigation_run_id }) => {
      try {
        const data = await client.post(
          `/api/v1/investigations/${investigation_run_id}/pickup`,
          {},
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
    "tellagen_post_trace_step",
    {
      description:
        "Post or update a readable investigation trace step for the active run. Use this before and after meaningful tool calls so responders can watch progress live.",
      inputSchema: {
        investigation_run_id: z
          .string()
          .min(1)
          .describe("Active investigation run ID"),
        step_id: z
          .string()
          .optional()
          .describe("Stable ID for updating this same step; generated if omitted"),
        step_index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Display order for this step"),
        status: z
          .enum(["running", "done", "error"])
          .describe("Current step status"),
        tool_name: z
          .string()
          .optional()
          .describe('Source/tool name (e.g., "grafana-loki", "github", "kubectl")'),
        tool_use_id: z
          .string()
          .optional()
          .describe("Optional upstream LLM/tool-call identifier"),
        title: z.string().min(1).describe("Short human-readable step title"),
        result_summary: z
          .string()
          .optional()
          .describe("Short summary of the result or current progress"),
        input_json: traceJsonSchema,
        result_json: traceJsonSchema,
        artifact_id: z.string().optional(),
        artifact_digest: z.string().optional(),
        result_bytes: z.number().int().min(0).optional(),
        truncated: z.boolean().optional(),
        error: z.string().optional(),
        started_at: z
          .string()
          .datetime()
          .optional()
          .describe("ISO timestamp; defaults on the Tellagen server if omitted"),
        completed_at: z
          .string()
          .datetime()
          .optional()
          .describe("ISO timestamp when the step completed"),
        duration_ms: z.number().int().min(0).optional(),
      },
    },
    async ({
      investigation_run_id,
      step_id,
      step_index,
      status,
      tool_name,
      tool_use_id,
      title,
      result_summary,
      input_json,
      result_json,
      artifact_id,
      artifact_digest,
      result_bytes,
      truncated,
      error,
      started_at,
      completed_at,
      duration_ms,
    }) => {
      try {
        const body: Record<string, unknown> = {
          step_id: step_id ?? generatedStepId(title),
          step_index: step_index ?? 0,
          status,
          title,
        };
        if (tool_name !== undefined) body.tool_name = tool_name;
        if (tool_use_id !== undefined) body.tool_use_id = tool_use_id;
        if (result_summary !== undefined) body.result_summary = result_summary;
        if (input_json !== undefined) body.input_json = input_json;
        if (result_json !== undefined) body.result_json = result_json;
        if (artifact_id !== undefined) body.artifact_id = artifact_id;
        if (artifact_digest !== undefined)
          body.artifact_digest = artifact_digest;
        if (result_bytes !== undefined) body.result_bytes = result_bytes;
        if (truncated !== undefined) body.truncated = truncated;
        if (error !== undefined) body.error = error;
        if (started_at !== undefined) body.started_at = started_at;
        if (completed_at !== undefined) body.completed_at = completed_at;
        if (duration_ms !== undefined) body.duration_ms = duration_ms;
        const data = await client.post(
          `/api/v1/investigation-runs/${investigation_run_id}/trace`,
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

  server.registerTool(
    "tellagen_list_trace_steps",
    {
      description:
        "List trace steps already posted for an investigation run. Use this when resuming a run to avoid duplicate work.",
      inputSchema: {
        investigation_run_id: z
          .string()
          .min(1)
          .describe("Investigation run ID whose trace should be listed"),
      },
    },
    async ({ investigation_run_id }) => {
      try {
        const data = await client.get(
          `/api/v1/investigation-runs/${investigation_run_id}/trace`,
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
    "tellagen_get_investigation_workspace",
    {
      description:
        "Get the incident-level investigation workspace: runs, findings, trace, and review state for an incident.",
      inputSchema: {
        incident_id: z.number().int().positive().describe("Incident ID"),
      },
    },
    async ({ incident_id }) => {
      try {
        const data = await client.get(
          `/api/v1/incidents/${incident_id}/investigations/workspace`,
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
    "tellagen_update_investigation_scope",
    {
      description:
        "Update the investigation scope for an incident, including target services, observability aliases, and time range.",
      inputSchema: {
        incident_id: z.number().int().positive().describe("Incident ID"),
        scope: investigationScopeSchema,
      },
    },
    async ({ incident_id, scope }) => {
      try {
        const data = await client.patch(
          `/api/v1/incidents/${incident_id}/investigations/scope`,
          { scope },
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
    "tellagen_list_runbooks",
    {
      description:
        "List the runbooks/skills matched for an investigation run. Runbooks are guidance for the local agent, not executable code.",
      inputSchema: {
        investigation_run_id: z
          .string()
          .min(1)
          .describe("Investigation run ID whose matched runbooks should be listed"),
      },
    },
    async ({ investigation_run_id }) => {
      try {
        const data = await client.get(
          `/api/v1/investigations/${investigation_run_id}/context`,
        );
        const context = data as { request?: { skills?: unknown[] } };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ runbooks: context.request?.skills ?? [] }),
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
        'Complete or fail an investigation run. Set status to "completed" when done, or "failed" with a failure_reason if the investigation could not finish. Include result_summary for the shared RCA record whenever possible.',
      inputSchema: {
        run_id: z.string().min(1).describe("Investigation run ID"),
        status: z
          .enum(["completed", "failed"])
          .describe("Final status for the run"),
        failure_reason: z
          .string()
          .optional()
          .describe('Reason for failure (required when status is "failed")'),
        result_summary: resultSummarySchema.optional(),
      },
    },
    async ({ run_id, status, failure_reason, result_summary }) => {
      try {
        const body: Record<string, unknown> = { status };
        if (failure_reason) {
          body.failure_reason = failure_reason;
        }
        if (result_summary !== undefined) {
          body.result_summary = result_summary;
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
