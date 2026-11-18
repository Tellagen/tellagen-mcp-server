import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError, TellagenAPIError } from "../errors.js";
import {
  KUBERNETES_SAFETY_CHECK_IDS,
  KUBERNETES_SAFETY_PROTOCOL,
  KUBERNETES_SAFETY_STATUSES,
} from "../k8s-safety.js";
import { kubernetesReadOnlyOfClient } from "../doctor/k8s-read-only.js";
import { realDoctorFs } from "../doctor/real-fs.js";
import { TOOL_REPORT_PATH } from "../tool-report.js";
import { AVAILABLE_SOURCE_KEYS, availableSourceSchema } from "./investigations.js";

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
        "Read an MCP diagnostic session by its diag_* ID. Use it only for diag_* IDs; investigation-run tools reject them. To send the result of your check, call tellagen_report_diagnostic_tools. It changes nothing.",
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

  registerReportAvailableSources(server, client);

  server.registerTool(
    "tellagen_report_diagnostic_tools",
    {
      description:
        "Report which MCP tools are visible and usable to a diagnostic session (diag_* ID), after you have checked them. Send only sanitized names and access results, never credentials. It does not start or change an investigation run. For the kubernetes tool, add the safety check as checks. " +
        KUBERNETES_SAFETY_PROTOCOL,
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
        const path = `/api/v1/settings/agent/diagnostic-sessions/${diagnostic_session_id}/reports`;
        const plain = reports.map(normalizeDiagnosticReport);
        // Whether the Kubernetes server runs read-only is read from its client config entry, like
        // in the tool report, and only for the kubernetes report of a tool that was found.
        const found = reports.some((r) => r.tool_id === "kubernetes" && r.installed);
        const readOnly = found ? kubernetesReadOnlyOfClient(client.session.identity?.name, realDoctorFs()) : undefined;
        let data: unknown;
        if (readOnly === undefined) {
          data = await client.post(path, { reports: plain });
        } else {
          const withFlag = plain.map((r) => (r.tool_id === "kubernetes" ? { ...r, kubernetes_read_only_tools: readOnly } : r));
          try {
            data = await client.post(path, { reports: withFlag });
          } catch (err) {
            // An older Tellagen refuses a field it does not know: send the report without it.
            if (!(err instanceof TellagenAPIError && err.status === 400 && err.code === "unknown_field")) throw err;
            data = await client.post(path, { reports: plain });
          }
        }
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

const safetyCheckSchema = z
  .object({
    id: z.enum(KUBERNETES_SAFETY_CHECK_IDS).describe("Stable id of the kubectl auth can-i check"),
    status: z.enum(KUBERNETES_SAFETY_STATUSES),
  })
  .strict();

function registerReportAvailableSources(server: McpServer, client: TellagenClient): void {
  server.registerTool(
    "tellagen_report_available_sources",
    {
      description: `Tell Tellagen which data sources this client can reach, with no run and no diagnostic session ID, so the tools table in Settings shows the current state of this client. Look at the MCP servers and shell tools you have and map them to ${AVAILABLE_SOURCE_KEYS.join(", ")}, as tellagen_pick_up_investigation does: one entry for each key, found or not_found, with an optional short detail that holds no token, no password and no path with a user name (for docs, the name of the source, such as Confluence, Notion or repository folder). Safe to repeat. ${KUBERNETES_SAFETY_PROTOCOL} Pass those results as kubernetes_checks only when you ran them.`,
      inputSchema: {
        available_sources: z
          .array(availableSourceSchema)
          .min(1)
          .max(20)
          .describe("The data sources this client can reach, one entry per catalog key, each found or not_found."),
        profile_id: z
          .string()
          .trim()
          .max(128)
          .optional()
          .describe("The exact MCP profile ID of the client, when it has one. Left out, TELLAGEN_MCP_PROFILE_ID is used."),
        kubernetes_checks: z
          .array(safetyCheckSchema)
          .max(4)
          .optional()
          .describe("The four kubectl auth can-i results of the Kubernetes safety check. Leave out when you did not run them."),
      },
    },
    async (input) => {
      try {
        const profileId = (input.profile_id ?? process.env.TELLAGEN_MCP_PROFILE_ID ?? "").trim();
        const body: Record<string, unknown> = {
          available_sources: input.available_sources,
          ...(profileId ? { profile_id: profileId } : {}),
        };
        const checks = input.kubernetes_checks ?? [];
        // Whether the Kubernetes server of this client runs read-only is read from its own
        // config entry, only when the report says Kubernetes was found. Only the one fact leaves.
        const kubernetesFound = input.available_sources.some((source) => source.key === "kubernetes" && source.state === "found");
        const readOnly = kubernetesFound ? kubernetesReadOnlyOfClient(client.session.identity?.name, realDoctorFs()) : undefined;
        const extras: Record<string, unknown> = {
          ...(checks.length > 0 ? { kubernetes_checks: checks } : {}),
          ...(readOnly !== undefined ? { kubernetes_read_only_tools: readOnly } : {}),
        };
        // An older Tellagen refuses a field it does not know. Try the fields it may know first
        // (the checks), and the plain sources last.
        const attempts: Record<string, unknown>[] = [{ ...body, ...extras }];
        if (readOnly !== undefined && checks.length > 0) attempts.push({ ...body, kubernetes_checks: checks });
        if (Object.keys(extras).length > 0) attempts.push(body);
        let data: Record<string, unknown> | undefined;
        let note: string | undefined;
        for (let i = 0; i < attempts.length && !data; i++) {
          try {
            data = await client.post<Record<string, unknown>>(TOOL_REPORT_PATH, attempts[i], { safeToRepeat: true });
          } catch (err) {
            const last = i === attempts.length - 1;
            if (last || !(err instanceof TellagenAPIError && err.status === 400 && err.code === "unknown_field")) throw err;
          }
          if (data && i > 0) {
            const sent = attempts[i]!;
            note = "kubernetes_checks" in sent
              ? "This Tellagen stored the sources and checks but not whether the Kubernetes tools are read-only yet."
              : checks.length > 0
                ? "This Tellagen stored the sources but not the Kubernetes safety checks yet."
                : "This Tellagen stored the sources but not whether the Kubernetes tools are read-only yet.";
          }
        }
        if (!data) throw new Error("tool report was not sent");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(note ? { ...data, note } : data) }],
        };
      } catch (err) {
        if (err instanceof TellagenAPIError && (err.status === 404 || err.status === 405)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  status: err.status,
                  code: "tool_report_not_supported",
                  message:
                    "This Tellagen does not take a tool report without a check yet. Ask an admin to update Tellagen, or start the check from Settings > Local diagnosis and use tellagen_report_diagnostic_tools with its diag_ ID.",
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );
}
