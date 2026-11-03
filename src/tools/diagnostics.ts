import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";

const accessStatusSchema = z.enum([
  "ok",
  "missing_tool",
  "auth_missing",
  "access_denied",
  "unreachable",
  "partial",
  "unknown",
]);

const checkStatusSchema = z.enum(["ok", "failed", "warning", "not_checked"]);

const diagnosticCheckSchema = z.object({
  id: z.string().min(1).describe("Stable check identifier"),
  label: z.string().min(1).describe("Human-readable check label"),
  status: checkStatusSchema,
  summary: z
    .string()
    .optional()
    .describe("Sanitized result summary without secrets or raw output"),
});

const diagnosticReportSchema = z.object({
  tool_id: z
    .string()
    .min(1)
    .describe("MCP tool ID from Tellagen, for example grafana, kubernetes, github"),
  client: z.enum(["codex", "claude"]).optional(),
  profile_id: z
    .string()
    .max(128)
    .optional()
    .describe("Exact opaque MCP profile ID from the diagnostic session, when present"),
  mcp_server_name: z
    .string()
    .optional()
    .describe("Local MCP server name, for example grafana"),
  installed: z.boolean().describe("Whether the local LLM client exposes the MCP tool"),
  access_status: accessStatusSchema.describe(
    "Connectivity status after safe read-only checks",
  ),
  capabilities: z
    .array(z.string())
    .optional()
    .describe("Sanitized capabilities that were checked"),
  checks: z
    .array(diagnosticCheckSchema)
    .optional()
    .describe("Sanitized per-capability check results"),
  error_summary: z
    .string()
    .optional()
    .describe("Short sanitized error summary when access is not ok"),
  reported_by: z.string().optional(),
  checked_at: z.string().datetime().optional(),
});

type DiagnosticReportInput = z.infer<typeof diagnosticReportSchema>;

export function registerDiagnosticTools(
  server: McpServer,
  client: TellagenClient,
): void {
  server.registerTool(
    "tellagen_get_diagnostic_session",
    {
      description:
        "Read a Tellagen MCP diagnostic session. Use this for diag_* IDs; do not pass diag_* IDs to investigation-run tools.",
      inputSchema: {
        diagnostic_session_id: z
          .string()
          .min(1)
          .describe("Diagnostic session ID from Tellagen, usually starting with diag_"),
      },
    },
    async ({ diagnostic_session_id }) => {
      try {
        const data = await client.get(
          `/api/v1/settings/agent/diagnostic-sessions/${diagnostic_session_id}`,
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
    "tellagen_report_diagnostic_tools",
    {
      description:
        "Post sanitized MCP tool availability and access reports to a Tellagen diagnostic session after the local LLM checks visible MCP tools.",
      inputSchema: {
        diagnostic_session_id: z
          .string()
          .min(1)
          .describe("Diagnostic session ID from Tellagen, usually starting with diag_"),
        reports: z
          .array(diagnosticReportSchema)
          .min(1)
          .describe("One sanitized report per requested MCP tool"),
      },
    },
    async ({ diagnostic_session_id, reports }) => {
      try {
        const data = await client.post(
          `/api/v1/settings/agent/diagnostic-sessions/${diagnostic_session_id}/reports`,
          { reports: reports.map(normalizeDiagnosticReport) },
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

function normalizeDiagnosticReport(report: DiagnosticReportInput): DiagnosticReportInput {
  const reportedBy = report.reported_by?.trim() || "tellagen-mcp-server";
  return {
    ...report,
    capabilities: report.capabilities ?? [],
    checks: report.checks ?? [],
    reported_by: reportedBy,
  };
}
