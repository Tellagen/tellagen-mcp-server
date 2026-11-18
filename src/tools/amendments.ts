import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { resolveAmendRunId } from "../active-run.js";
import { TellagenClient, httpDefaults } from "../client.js";
import { TellagenAPIError, formatError } from "../errors.js";
import {
  DIAGNOSIS_CHANGES_CAPABILITY,
  RUN_AMENDMENTS_CAPABILITY,
  coverageEntrySchema,
  gapQuestionNotice,
  stripCoverageReasons,
  stripFindingChangeLinks,
  stripFindingEvidenceStructure,
  supportsCapability,
  supportsDiagnosisChanges,
  supportsDiagnosisStructure,
  supportsRunAmendments,
  unsupportedNotice,
} from "../diagnosis-structure.js";
import { QUESTION_CHECKS_CAPABILITY } from "../run-window.js";
import {
  checkScreenshotSizes,
  evidenceRefSchema,
  findingCheckSchema,
  findingChecksProblem,
  hasScreenshots,
  MAX_FINDING_CHECKS,
  screenshotSchema,
} from "./findings.js";
import { adaptResultSummary, resultSummarySchema } from "./investigations.js";

/** What Tellagen takes in one amendment. */
export const MAX_AMEND_FINDINGS = 10;
export const MAX_AMEND_SCREENSHOTS = 20;

/** How often a conflicting amendment is sent again with the same key. */
export const amendRetries = { attempts: 4, delayMs: 1000 };

const amendFindingSchema = z.object({
  finding_type: z
    .enum(["observation", "correlation", "hypothesis", "evidence", "recommendation", "negative", "gap"])
    .describe("Type of finding, as in tellagen_post_finding."),
  role: z.enum(["confirms", "supports", "contradicts", "gap"]).optional(),
  claim: z.string().min(1).describe("One-sentence finding statement. For a gap finding, one real question that ends with a question mark."),
  evidence_summary: z.string().min(1).describe("Detailed explanation with supporting data: the body of the finding."),
  checks: z
    .array(findingCheckSchema)
    .min(1)
    .max(MAX_FINDING_CHECKS)
    .optional()
    .describe("Gap findings only: one to three yes or no checks, each {source, question}. Sent only when this Tellagen lists question_checks_v1."),
  confidence: z.number().min(0).max(1),
  confidence_reason: z.string().min(1),
  evidence_refs: z.array(evidenceRefSchema).optional(),
  screenshots: z.array(screenshotSchema).optional(),
  potential_root_cause: z.boolean().optional().describe("True on the finding that carries a new cause, with root_cause_status proposed."),
  root_cause_status: z.literal("proposed").optional().describe("Only proposed: a person accepts or rejects a cause in Tellagen."),
});

/** The key of an amendment: a hash of what is sent, so a repeat of the same call is the same amendment. */
export function amendmentIdempotencyKey(runId: string, body: Record<string, unknown>): string {
  const hash = createHash("sha256").update(JSON.stringify([runId, body])).digest("hex");
  return `mcp-amend-${hash.slice(0, 48)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function registerAmendmentTools(server: McpServer, client: TellagenClient): void {
  server.registerTool(
    "tellagen_amend_investigation",
    {
      description:
        "Add proof to a finished diagnosis as a new version of it. Use it when a run is finished and you have more: a source that was not read became readable (the person fixed a connector, granted access or pasted the file), or you found proof after you completed. Read the source, then send reason (one line, at most 200 characters), the new findings, and the coverage entries that changed (the source that is now checked, or a source that still could not be read with its reason). Send result_summary only when the headline or the causal path changes: it is the whole new result, and a changed headline is a new version. The earlier version stays. The run is the finished run this session remembers; pass investigation_run_id for a run this session completed, because Tellagen takes additions only from the client session that ran it. A run takes additions for a limited time after it completes; the answer of a write to a finished run says until when. A repeat of the same call returns the first answer and stores nothing twice. A new cause is a finding with potential_root_cause true and root_cause_status proposed; a person accepts or rejects it in Tellagen. Only when this Tellagen lists run_amendments_v1.",
      inputSchema: {
        investigation_run_id: z
          .string()
          .min(1)
          .optional()
          .describe("The finished run. Leave it out to use the run this session completed."),
        request_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Only when you answer a request of a responder that you took (tellagen_pick_up_run_request, or a heartbeat gave it to you): its id. The request then ends with this version."),
        reason: z.string().trim().min(1).max(200).describe("One line that says what the amendment adds, for example: Read the Slack thread after the token was fixed."),
        findings: z.array(amendFindingSchema).max(MAX_AMEND_FINDINGS).optional().describe("New findings. They cannot cite each other or the amendment in result_summary yet; send a second amendment for that."),
        coverage: z
          .array(coverageEntrySchema)
          .max(8)
          .optional()
          .describe("The sources whose state changes: send its id and its source for an entry you change, or a new entry with its source. A source you read is checked; one you could not read stays gap or not_configured with a reason."),
        result_summary: resultSummarySchema
          .optional()
          .describe("The whole new result, only when the headline or the causal path changes. Without it the result on show stays, with the coverage changes applied."),
      },
    },
    async ({ investigation_run_id: givenRunId, request_id, reason, findings, coverage, result_summary }) => {
      let runId: string | undefined;
      try {
        runId = resolveAmendRunId(client, givenRunId ?? (request_id ? client.session.takenRequest(request_id)?.runId : undefined));
        if (!(await supportsRunAmendments(client, runId))) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  code: "amendments_not_supported",
                  message: `This Tellagen is too old to take additions to a finished run (it does not list ${RUN_AMENDMENTS_CAPABILITY}). Nothing was sent. Tell the person what you found in your own answer, and ask them to update Tellagen.`,
                }),
              },
            ],
            isError: true,
          };
        }
        const screenshotCount = (findings ?? []).reduce(
          (n, f) => n + (f.screenshots?.length ?? 0) + (f.evidence_refs ?? []).reduce((m, r) => m + (r.screenshots?.length ?? 0), 0),
          0,
        );
        if (screenshotCount > MAX_AMEND_SCREENSHOTS) {
          return {
            content: [{ type: "text" as const, text: `An amendment takes at most ${MAX_AMEND_SCREENSHOTS} screenshots in all; this one has ${screenshotCount}. Nothing was sent. Send fewer, or split it into two amendments.` }],
            isError: true,
          };
        }
        const notices: string[] = [];
        const sentFindings: Record<string, unknown>[] = [];
        for (const [index, finding] of (findings ?? []).entries()) {
          const problem = findingChecksProblem(finding.finding_type, finding.role, finding.checks);
          if (problem) {
            return { content: [{ type: "text" as const, text: `findings[${index}]: ${problem}` }], isError: true };
          }
          checkScreenshotSizes(finding.screenshots, finding.evidence_refs);
          const out: Record<string, unknown> = {
            finding_type: finding.finding_type,
            claim: finding.claim,
            evidence_summary: finding.evidence_summary,
            confidence: finding.confidence,
            confidence_reason: finding.confidence_reason,
            evidence_refs: finding.evidence_refs ?? [],
          };
          if (finding.role !== undefined) out.role = finding.role;
          if (finding.screenshots !== undefined) out.screenshots = finding.screenshots;
          if (finding.potential_root_cause !== undefined) out.potential_root_cause = finding.potential_root_cause;
          if (finding.root_cause_status !== undefined) out.root_cause_status = finding.root_cause_status;
          if (finding.checks !== undefined) {
            if (await supportsCapability(client, runId, QUESTION_CHECKS_CAPABILITY)) out.checks = finding.checks;
            else notices.push(`findings[${index}]: this Tellagen does not list ${QUESTION_CHECKS_CAPABILITY}, so the checks were not sent.`);
          }
          const question = gapQuestionNotice(finding.finding_type, finding.role, finding.claim);
          if (question) notices.push(`findings[${index}]: ${question}`);
          const structure = stripFindingEvidenceStructure(out.evidence_refs);
          if (structure.removed.length > 0 && !(await supportsDiagnosisStructure(client, runId))) {
            out.evidence_refs = structure.refs;
            notices.push(unsupportedNotice(structure.removed));
          }
          const links = stripFindingChangeLinks(out.evidence_refs);
          if (links.removed.length > 0 && !(await supportsDiagnosisChanges(client, runId))) {
            out.evidence_refs = links.refs;
            notices.push(unsupportedNotice(links.removed, DIAGNOSIS_CHANGES_CAPABILITY));
          }
          sentFindings.push(out);
        }
        const body: Record<string, unknown> = { reason };
        if (request_id !== undefined) body.request_id = request_id;
        if (sentFindings.length > 0) body.findings = sentFindings;
        if (coverage !== undefined) body.coverage = coverage;
        if (result_summary !== undefined) {
          const adapted = await adaptResultSummary(client, runId, result_summary);
          body.result_summary = adapted.summary;
          notices.push(...adapted.notices);
        }
        const screenshots = (findings ?? []).some((f) => hasScreenshots(f.screenshots, f.evidence_refs));
        const key = amendmentIdempotencyKey(runId, body);
        const path = `/api/v1/investigation-runs/${encodeURIComponent(runId)}/amendments`;
        const data = await postAmendment(client, path, body, key, screenshots);
        const run = typeof data.run === "object" && data.run !== null ? (data.run as Record<string, unknown>) : undefined;
        const until = typeof run?.amend_until === "string" ? run.amend_until : undefined;
        client.session.rememberAmendable(runId, until);
        if (request_id !== undefined) client.session.forgetRequest(request_id);
        const out: Record<string, unknown> = { ...data };
        if (notices.length > 0) out.mcp_notice = notices.join(" ");
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        if (err instanceof TellagenAPIError) {
          // A window that closed, or a run that never completed, takes no more additions: forget that run only.
          if (err.code === "run_not_amendable" && runId) client.session.forgetAmendable(runId);
          if (err.code === "run_request_not_available" && request_id) {
            client.session.forgetRequest(request_id);
            return {
              content: [{ type: "text" as const, text: formatError(new TellagenAPIError(err.status, err.code, "That request is not yours any more: another client took it, or its time is over. Drop it. Nothing was added.", err.payload)) }],
              isError: true,
            };
          }
          if (err.code === "run_taken_over") {
            return {
              content: [{ type: "text" as const, text: formatError(new TellagenAPIError(err.status, err.code, "Tellagen takes additions to a run only from the client session that ran it, and this session did not. Do not retry. Tell the person what you found in your answer, and that the client that ran it, or a person in Tellagen, can add it.", { ...(err.payload ?? {}), amendment: true })) }],
              isError: true,
            };
          }
        }
        return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
      }
    },
  );
}

/**
 * Sends the amendment. A conflict (another amendment is being written) is sent
 * again with the same key, so the run never gets two versions of one request.
 */
async function postAmendment(
  client: TellagenClient,
  path: string,
  body: Record<string, unknown>,
  key: string,
  screenshots: boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.post<Record<string, unknown>>(path, body, {
        idempotencyKey: key,
        timeoutMs: screenshots ? httpDefaults.uploadTimeoutMs : undefined,
      });
    } catch (err) {
      if (!(err instanceof TellagenAPIError) || err.code !== "run_amendment_conflict" || attempt >= amendRetries.attempts) throw err;
      await sleep(amendRetries.delayMs * 2 ** (attempt - 1));
    }
  }
}
