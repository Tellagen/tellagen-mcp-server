import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalRunIdSchema, resolveRunId } from "../active-run.js";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";
import {
  DIAGNOSIS_STRUCTURE_CAPABILITY,
  supportsDiagnosisStructure,
} from "../diagnosis-structure.js";

/** The causes endpoint limits. */
export const CAUSE_STATES = ["leading", "open", "ruled_out"] as const;

export const updateCauseInputShape = {
  investigation_run_id: optionalRunIdSchema,
  cause_key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^\S+$/, "no spaces")
    .describe(
      "Short stable key for this cause, up to 64 characters, no spaces (for example deploy-4412). Use the same value as cause_key on tellagen_post_trace_step.",
    ),
  label: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .optional()
    .describe("Name of the cause, up to 160 characters. Required the first time you post a key."),
  state: z
    .enum(CAUSE_STATES)
    .optional()
    .describe(
      "leading (best supported so far), open (still being tested) or ruled_out. Keep one leading cause.",
    ),
  rationale: z
    .string()
    .max(1000)
    .optional()
    .describe("Why it is in this state, up to 1000 characters. Say what excluded it when ruled_out."),
  evidence_for: z
    .number()
    .int()
    .min(0)
    .max(999)
    .optional()
    .describe("Count of checks that support this cause"),
  evidence_against: z
    .number()
    .int()
    .min(0)
    .max(999)
    .optional()
    .describe("Count of checks that contradict this cause"),
  finding_ids: z
    .array(z.number().int().positive())
    .max(20)
    .optional()
    .describe(
      "Numeric ids returned by tellagen_post_finding for this run, up to 20. [] clears the list.",
    ),
  sources: z
    .array(z.string().trim().min(1).max(60))
    .max(8)
    .optional()
    .describe("Names of the sources consulted for this cause, up to 8 of 60 characters. [] clears the list."),
};

const updateCauseSchema = z.object(updateCauseInputShape).strict();
export type UpdateCauseInput = z.infer<typeof updateCauseSchema>;

export function registerCauseTools(
  server: McpServer,
  client: TellagenClient,
): void {
  server.registerTool(
    "tellagen_update_cause",
    {
      description:
        "Post or update one cause you are testing, so the Diagnosis tab shows it while the run is live. Call it when a cause starts (state open), when its state changes (leading, open, ruled_out) and when you rule it out (with a rationale and finding_ids). Do not call it for every check; link checks to a cause with cause_key on tellagen_post_trace_step. At most 8 causes per run. A field you leave out keeps its value, and label is required the first time. Causes are reconciled to the final result_summary when you complete the run. Needs diagnosis_structure_v1; otherwise nothing is sent and the result explains why.",
      inputSchema: updateCauseInputShape,
    },
    async (input) => {
      try {
        const { investigation_run_id: givenRunId, cause_key, ...fields } = input;
        const investigation_run_id = resolveRunId(client, givenRunId);
        if (!(await supportsDiagnosisStructure(client, investigation_run_id))) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  sent: false,
                  mcp_notice: `This Tellagen backend does not advertise ${DIAGNOSIS_STRUCTURE_CAPABILITY} for this run, so it does not support live causes and nothing was sent. Update Tellagen to post causes under test; keep investigating and put the cause chain in the completion result_summary.`,
                }),
              },
            ],
          };
        }
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined) body[key] = value;
        }
        const data = await client.put(
          `/api/v1/investigation-runs/${encodeURIComponent(investigation_run_id)}/causes/${encodeURIComponent(cause_key)}`,
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
