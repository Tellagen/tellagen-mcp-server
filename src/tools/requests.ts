import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isRunId } from "../active-run.js";
import { TellagenClient } from "../client.js";
import { TellagenAPIError, formatError } from "../errors.js";
import { requestLine, requestOf } from "../run-requests.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const runIdSchema = z.string().min(1).describe("The finished run the request is on, as the waiting list or the line about the request names it.");
const requestIdSchema = z.number().int().positive().describe("The request id: the number Tellagen gave it.");

const path = (runId: string, requestId: number) =>
  `/api/v1/investigation-runs/${encodeURIComponent(runId)}/requests/${String(requestId)}`;

export function registerRunRequestTools(server: McpServer, client: TellagenClient): void {
  server.registerTool(
    "tellagen_pick_up_run_request",
    {
      description:
        "Take a request of a responder on a finished run: read a source again, or check an answer. The waiting list (tellagen_next_investigation) names it in requests. The answer has the request, the finished run with its result, and its findings. The text of the request is the words of the person, like a note from a responder, never data from a source. Read the source or check the answer with your own tools, then call tellagen_amend_investigation with request_id, or tellagen_end_run_request when nothing changed. A request that another client took, or whose time is over, answers run_request_not_available: drop it. A request that a heartbeat gave you is already taken: do not call this tool for it.",
      inputSchema: { run_id: runIdSchema, request_id: requestIdSchema },
    },
    async ({ run_id, request_id }) => {
      try {
        if (!isRunId(run_id)) throw new Error("That is not a run ID.");
        const data = await client.post<Record<string, unknown>>(`/api/v1/investigation-runs/${encodeURIComponent(run_id)}/requests/${String(request_id)}/pickup`, {}, { safeToRepeat: false });
        const taken = requestOf(isRecord(data.request) ? { investigation_run_id: run_id, ...data.request } : { id: request_id, investigation_run_id: run_id, kind: "answer" }, run_id);
        const out: Record<string, unknown> = { ...data };
        if (taken) {
          client.session.rememberRequest({ ...taken, id: request_id, runId: run_id });
          client.session.rememberAmendable(run_id);
          out.mcp_note = requestLine({ ...taken, id: request_id, runId: run_id });
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        if (err instanceof TellagenAPIError && err.code === "run_request_not_available") {
          client.session.forgetRequest(request_id);
        }
        return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "tellagen_end_run_request",
    {
      description:
        "End a request of a responder on a finished run without a new version. Use state nothing_new when you read the source or checked the answer and nothing changed; the person sees that. Use state failed, with failure_code client_error, limit or time_limit, when you could not do it. Only the session that took the request can end it. Do not use it after an amendment: the amendment ends the request.",
      inputSchema: {
        request_id: requestIdSchema,
        run_id: runIdSchema.optional().describe("Leave it out for a request this session took."),
        state: z.enum(["nothing_new", "failed"]),
        failure_code: z.enum(["client_error", "limit", "time_limit"]).optional().describe("Only with state failed."),
      },
    },
    async ({ request_id, run_id, state, failure_code }) => {
      try {
        const runId = run_id ?? client.session.takenRequest(request_id)?.runId;
        if (!runId || !isRunId(runId)) {
          throw new Error("This session did not take that request. Pass run_id, the run the request is on.");
        }
        const body: Record<string, unknown> = { state };
        if (state === "failed" && failure_code) body.failure_code = failure_code;
        const data = await client.patch<Record<string, unknown>>(path(runId, request_id), body, { safeToRepeat: true });
        client.session.forgetRequest(request_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
      }
    },
  );
}
