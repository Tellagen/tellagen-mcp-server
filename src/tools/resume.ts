import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { isRunId } from "../active-run.js";
import { formatError, TellagenAPIError } from "../errors.js";
import { rememberServerCapabilities } from "../diagnosis-structure.js";
import { pickUpWithConsent, withRunGuides } from "./investigations.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out", "cancelled"]);
const MAX_LISTED = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listOf(data: unknown, keys: readonly string[]): Record<string, unknown>[] {
  const list = Array.isArray(data)
    ? data
    : isRecord(data)
      ? keys.map((key) => data[key]).find((value) => Array.isArray(value))
      : undefined;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

const pick = (source: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((key) => source[key] !== undefined && source[key] !== "").map((key) => [key, source[key]]));

function text(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

/** One sentence on where the run stands, from what is already posted. */
export function standingLine(steps: Record<string, unknown>[], findings: Record<string, unknown>[]): string {
  const running = steps.filter((step) => step.status === "running").length;
  const done = steps.filter((step) => step.status === "done").length;
  const failed = steps.filter((step) => step.status === "error").length;
  const parts = [
    `${steps.length} trace step${steps.length === 1 ? "" : "s"} posted (${done} done, ${running} still running, ${failed} with an error)`,
    `${findings.length} finding${findings.length === 1 ? "" : "s"} posted`,
  ];
  const next =
    steps.length === 0 && findings.length === 0
      ? "Nothing is posted yet: start from the context."
      : running > 0
        ? "Finish or close the running steps first, with the same step_id, then go on. Do not repeat a check that is done."
        : "Go on from the last step. Do not repeat a check that is done.";
  return `${parts.join(", ")}. ${next}`;
}

export function registerResumeTools(server: McpServer, client: TellagenClient): void {
  server.registerTool(
    "tellagen_resume",
    {
      description:
        "Continue the diagnosis run this computer was working on, for example after the client was restarted. It reads the remembered run, picks it up again (which is safe to repeat), and returns the context with the trace steps and findings already posted, so you go on where the run stands and repeat nothing. If the run ended while the client was closed, it says so and forgets the run. If another session on this computer or another client holds the run, the answer is a question for the person; set takeover only after they agree. With no remembered run it says so.",
      inputSchema: {
        model: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe("Your own model name as you know it. Tellagen shows it on the run."),
        takeover: z
          .boolean()
          .optional()
          .describe(
            "Set true only after the person agreed that this session joins or takes over the run. Never set it on your own.",
          ),
      },
    },
    async ({ model, takeover }) => {
      const session = client.session;
      const remembered = session.state.read();
      const runId = session.activeRun()?.runId ?? remembered?.run_id;
      if (!runId || !isRunId(runId)) {
        return text({
          resumed: false,
          code: "no_remembered_run",
          message:
            "No diagnosis run is remembered on this computer. Pick a run up with tellagen_pick_up_investigation when you have a run ID.",
        });
      }
      try {
        // Read first: a run that ended must not be picked up again.
        let context: unknown;
        try {
          context = await client.get(`/api/v1/investigations/${encodeURIComponent(runId)}/context`);
        } catch (err) {
          if (err instanceof TellagenAPIError && err.status === 404) {
            session.clearActiveRun(runId);
            return text({
              resumed: false,
              code: "run_not_found",
              run_id: runId,
              message: "The remembered run no longer exists in Tellagen, so it was forgotten. There is nothing to continue.",
            });
          }
          throw err;
        }
        const run = isRecord(context) && isRecord(context.run) ? context.run : {};
        const status = typeof run.status === "string" ? run.status : "";
        if (TERMINAL_STATUSES.has(status)) {
          session.clearActiveRun(runId);
          return text({
            resumed: false,
            code: "run_ended",
            run_id: runId,
            status,
            message: `The run ended while this client was closed (status ${status}), so it was forgotten. Do not write to it. Tell the person, and start a follow-up run if they want one.`,
          });
        }

        const outcome = await pickUpWithConsent(client, runId, { model, takeover });
        if ("question" in outcome) return outcome.question;
        const data = outcome.data;
        rememberServerCapabilities(client, runId, data);
        const incidentId = session.activeRun()?.incidentId ?? remembered?.incident_id;

        const [trace, found] = await Promise.all([
          client.get(`/api/v1/investigation-runs/${encodeURIComponent(runId)}/trace`).catch(() => undefined),
          incidentId !== undefined
            ? client
                .get(`/api/v1/incidents/${incidentId}/findings?investigation_run_id=${encodeURIComponent(runId)}`)
                .catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
        const steps = listOf(trace, ["steps", "trace", "items"]);
        const findings = listOf(found, ["findings", "items"]);
        return text({
          resumed: true,
          run_id: runId,
          ...(incidentId !== undefined ? { incident_id: incidentId } : {}),
          standing: standingLine(steps, findings),
          trace_steps: steps
            .slice(0, MAX_LISTED)
            .map((step) => pick(step, ["step_id", "title", "status", "tool_name", "outcome", "cause_key", "result_summary"])),
          findings: findings
            .slice(0, MAX_LISTED)
            .map((finding) => pick(finding, ["id", "finding_type", "role", "claim", "status", "confidence"])),
          ...(trace === undefined ? { trace_unavailable: true } : {}),
          ...(found === undefined && incidentId !== undefined ? { findings_unavailable: true } : {}),
          context: withRunGuides(data),
        });
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
      }
    },
  );
}
