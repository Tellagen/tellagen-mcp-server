/**
 * Diagnosis structure (diagnosis_structure_v1, CORE-776 / CORE-777).
 *
 * A newer Tellagen backend accepts richer evidence refs (links, command,
 * datasource), a causal chain with finding ids and a figure per step, ruled
 * out / coverage / unknowns, and a trace step outcome. An older backend
 * decodes request bodies leniently and silently drops fields it does not know,
 * so the agent could not tell. The rule is therefore:
 *
 *   - the MCP always advertises the capability in `protocol_capabilities`
 *     (src/version.ts), and
 *   - it sends the new fields only for a run whose pickup / context response
 *     lists the capability in the top-level `server_capabilities`.
 *
 * Zod objects below are not strict, so every new field needs an explicit
 * entry or it is stripped before the request leaves.
 */
import { z } from "zod";
import type { TellagenClient } from "./client.js";

export const DIAGNOSIS_STRUCTURE_CAPABILITY = "diagnosis_structure_v1";

/* ------------------------------------------------------------------ */
/* Capability negotiation                                             */
/* ------------------------------------------------------------------ */

const capabilityByClient = new WeakMap<TellagenClient, Map<string, boolean>>();

function capabilityMap(client: TellagenClient): Map<string, boolean> {
  let map = capabilityByClient.get(client);
  if (!map) {
    map = new Map();
    capabilityByClient.set(client, map);
  }
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remembers whether the backend that answered a pickup or context call for
 * `runId` advertises the capability. A missing `server_capabilities` is a
 * definite "no": the backend predates the field.
 */
export function rememberServerCapabilities(
  client: TellagenClient,
  runId: string,
  response: unknown,
): void {
  if (!isRecord(response)) return;
  const list = response.server_capabilities;
  const supported =
    Array.isArray(list) && list.includes(DIAGNOSIS_STRUCTURE_CAPABILITY);
  capabilityMap(client).set(runId, supported);
}

/**
 * Whether the backend accepts the diagnosis structure for this run. Uses what
 * pickup or context told us in this process; otherwise reads the run context
 * once (a resumed run picked up by another process). A failed lookup counts as
 * "not supported" for this call and is retried on the next one.
 */
export async function supportsDiagnosisStructure(
  client: TellagenClient,
  runId: string,
): Promise<boolean> {
  const map = capabilityMap(client);
  const known = map.get(runId);
  if (known !== undefined) return known;
  try {
    const context = await client.get<unknown>(
      `/api/v1/investigations/${encodeURIComponent(runId)}/context`,
    );
    rememberServerCapabilities(client, runId, context);
    return map.get(runId) ?? false;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Evidence ref additions                                             */
/* ------------------------------------------------------------------ */

export const EVIDENCE_LINK_KINDS = [
  "explore",
  "panel",
  "diff",
  "commit",
  "pr",
  "logs",
  "trace",
] as const;

export const evidenceLinkSchema = z.object({
  kind: z
    .enum(EVIDENCE_LINK_KINDS)
    .describe("What the link opens: explore, panel, diff, commit, pr, logs or trace"),
  label: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe("Short text for the link, up to 60 characters"),
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(
      (value) => {
        try {
          const protocol = new URL(value).protocol;
          return protocol === "http:" || protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "must be an http or https address" },
    )
    .describe("http or https address, without credentials"),
});

export const evidenceLinksSchema = z
  .array(evidenceLinkSchema)
  .max(4)
  .describe(
    "Clickable sources for this evidence, at most 4. Build Grafana and GitHub links with tellagen_build_source_link and copy its links[] here unchanged. Leave it out when you have no real address.",
  );

/** Fields added to every evidence ref by diagnosis_structure_v1. */
export const evidenceRefStructureShape = {
  links: evidenceLinksSchema.optional(),
  command: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "A copyable, read-only command that reproduces this evidence (for example a kubectl get or logs command), up to 1000 characters. Use it for Kubernetes and other local sources that have no browser link. Never include credentials; Tellagen redacts them and drops a longer command.",
    ),
  datasource: z
    .string()
    .max(120)
    .optional()
    .describe(
      "Name of the data source the evidence came from (for example the Grafana data source name or uid)",
    ),
};

const EVIDENCE_REF_STRUCTURE_FIELDS = ["links", "command", "datasource"] as const;

/* ------------------------------------------------------------------ */
/* Step figure: one timeline block (stats, compare, trend)            */
/* ------------------------------------------------------------------ */

const control = /[\u0000-\u001f\u007f]/;

function line(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !control.test(value), {
      message: "must be one line without control characters",
    });
}

const blockNumber = z.number().finite().min(-1e12).max(1e12);

const positiveBlockNumber = z.number().finite().gt(0).max(1e12);

const blockCommon = {
  slot: z.literal("summary").optional(),
  anchor: line(0, 80).optional(),
  postmortem: z.boolean().optional(),
};

const blockThreshold = z
  .object({ value: blockNumber, label: line(0, 80).optional() })
  .strict();

const statsFigure = z
  .object({
    type: z.literal("stats"),
    ...blockCommon,
    items: z
      .array(
        z
          .object({
            label: line(1, 48),
            value: line(1, 32),
            caption: line(0, 64).optional(),
            tone: z.enum(["good", "warn", "bad", "neutral"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();

const compareFigure = z
  .object({
    type: z.literal("compare"),
    ...blockCommon,
    title: line(0, 80).optional(),
    metric: line(0, 32).optional(),
    unit: line(0, 12).optional(),
    better: z.enum(["lower", "higher"]).optional(),
    delta: z.enum(["rel", "abs"]).optional(),
    max: positiveBlockNumber.optional(),
    threshold: blockThreshold.optional(),
    rows: z
      .array(
        z
          .object({
            label: line(1, 80),
            mono: z.boolean().optional(),
            before: blockNumber,
            after: blockNumber,
            details: z
              .array(
                z
                  .object({
                    label: line(1, 32),
                    before: line(1, 32),
                    after: line(1, 32),
                  })
                  .strict(),
              )
              .max(3)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

const trendFigure = z
  .object({
    type: z.literal("trend"),
    ...blockCommon,
    title: line(0, 80).optional(),
    unit: line(0, 12).optional(),
    series: z.array(blockNumber).min(2).max(500),
    start: z.string().datetime({ offset: true }).optional(),
    step_seconds: z.number().int().min(1).max(86400).optional(),
    max: positiveBlockNumber.optional(),
    threshold: blockThreshold.optional(),
    marks: z
      .array(
        z
          .object({ i: z.number().int().min(0), label: line(1, 48) })
          .strict(),
      )
      .max(3)
      .optional(),
    source: z
      .object({
        kind: line(0, 80).optional(),
        datasource: line(0, 80).optional(),
        // Only source.query may hold line breaks.
        query: z.string().max(2000).optional(),
        from: line(0, 80).optional(),
        to: line(0, 80).optional(),
        step: line(0, 80).optional(),
        artifact_id: line(0, 80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Same size cap as the backend: canonical block JSON, 16 KB. */
export const MAX_FIGURE_BYTES = 16 * 1024;

export const stepFigureSchema = z
  .discriminatedUnion("type", [statsFigure, compareFigure, trendFigure])
  .superRefine((figure, ctx) => {
    if (figure.slot !== undefined && figure.anchor !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anchor"],
        message: "send slot or anchor, not both",
      });
    }
    if (figure.type === "trend") {
      if ((figure.start === undefined) !== (figure.step_seconds === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [figure.start === undefined ? "start" : "step_seconds"],
          message: "send start and step_seconds together",
        });
      }
      figure.marks?.forEach((mark, index) => {
        if (mark.i >= figure.series.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["marks", index, "i"],
            message: `must be a point index from 0 to ${figure.series.length - 1}`,
          });
        }
      });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(figure)).length;
    if (bytes > MAX_FIGURE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `figure is ${bytes} bytes; the limit is ${MAX_FIGURE_BYTES}. Reduce a trend to at most 500 points`,
      });
    }
  })
  .describe(
    "ONE timeline block object that shows the step's key numbers, validated like a timeline event block. type compare = a before and after with an optional threshold; type trend = a series over time (give source with the query that produced it); type stats = 2 to 4 key numbers. Never invent a number: every value must come from a tool result.",
  );

/* ------------------------------------------------------------------ */
/* Result summary additions                                           */
/* ------------------------------------------------------------------ */

const findingIdsSchema = z
  .array(z.number().int().positive())
  .max(12)
  .describe(
    "Numeric ids of this run's findings that prove it, as returned by tellagen_post_finding (up to 12)",
  );

export const stepStructureShape = {
  finding_ids: findingIdsSchema.optional(),
  figure: stepFigureSchema.optional(),
  links: evidenceLinksSchema.optional(),
};

export const ruledOutSchema = z.object({
  id: line(0, 64).optional(),
  label: line(1, 200).describe("The cause that was ruled out, in a few words"),
  explanation: z
    .string()
    .max(600)
    .optional()
    .describe("Why the evidence rules it out"),
  finding_ids: findingIdsSchema.optional(),
  links: evidenceLinksSchema.optional(),
  confidence_percent: z.number().int().min(0).max(100).optional(),
});

export const coverageEntrySchema = z.object({
  id: line(0, 64).optional(),
  source: line(1, 80).describe("The data source, for example Grafana, GitHub or Kubernetes"),
  state: z
    .enum(["checked", "gap", "not_configured"])
    .describe(
      "checked = read and used; gap = configured but could not be read or satisfied; not_configured = no such source in this workspace",
    ),
  summary: z.string().max(600).optional(),
  links: evidenceLinksSchema.optional(),
  step_ids: z
    .array(z.string().min(1).max(64))
    .max(12)
    .optional()
    .describe("Ids of the causal_paths steps this source proved"),
  integration_id: z.string().max(64).optional(),
  finding_ids: findingIdsSchema.optional(),
});

export const unknownSchema = z.object({
  id: line(0, 64).optional(),
  label: line(1, 200).describe("What could not be established"),
  why: z.string().max(600).optional().describe("Why it is unknown"),
  finding_ids: findingIdsSchema.optional(),
});

export const resultStructureShape = {
  ruled_out: z
    .array(ruledOutSchema)
    .max(5)
    .optional()
    .describe(
      "Causes the run checked and ruled out, at most 5. One entry per negative finding that matters.",
    ),
  coverage: z
    .array(coverageEntrySchema)
    .max(8)
    .optional()
    .describe(
      "One entry per data source the run used or could not use, at most 8. Use state gap for a source that could not be read.",
    ),
  unknowns: z
    .array(unknownSchema)
    .max(5)
    .optional()
    .describe("What the run could not establish, at most 5"),
};

/* ------------------------------------------------------------------ */
/* Trace step additions                                               */
/* ------------------------------------------------------------------ */

export const TRACE_OUTCOMES = [
  "supports",
  "rules_out",
  "nothing_notable",
  "inconclusive",
  "unavailable",
] as const;

export const traceStructureShape = {
  outcome: z
    .enum(TRACE_OUTCOMES)
    .optional()
    .describe(
      "What this finished check did to the cause it tested: supports, rules_out, nothing_notable, inconclusive, or unavailable (the source could not be read). Send it with status done or error.",
    ),
  cause_key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Your short key for the cause this check belongs to (for example deploy-4412); reuse it on every check of that cause",
    ),
};

/* ------------------------------------------------------------------ */
/* Gating: drop the new fields for a backend that does not know them  */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function stripEvidenceRefs(
  refs: unknown,
  path: string,
  removed: string[],
): unknown {
  if (!Array.isArray(refs)) return refs;
  return refs.map((ref, index) => {
    if (!isRecord(ref)) return ref;
    const next: Json = { ...ref };
    for (const field of EVIDENCE_REF_STRUCTURE_FIELDS) {
      if (field in next) {
        delete next[field];
        removed.push(`${path}[${index}].${field}`);
      }
    }
    return next;
  });
}

/** An evidence ref list without links, command and datasource. */
export function stripFindingEvidenceStructure(refs: unknown): {
  refs: unknown;
  removed: string[];
} {
  const removed: string[] = [];
  return { refs: stripEvidenceRefs(refs, "evidence_refs", removed), removed };
}

/** A result summary without any diagnosis_structure_v1 field. */
export function stripResultStructure(summary: unknown): {
  summary: unknown;
  removed: string[];
} {
  const removed: string[] = [];
  if (!isRecord(summary)) return { summary, removed };
  const next: Json = { ...summary };

  if (Array.isArray(next.causal_paths)) {
    next.causal_paths = next.causal_paths.map((path, pathIndex) => {
      if (!isRecord(path) || !Array.isArray(path.steps)) return path;
      return {
        ...path,
        steps: path.steps.map((step, stepIndex) => {
          if (!isRecord(step)) return step;
          const at = `causal_paths[${pathIndex}].steps[${stepIndex}]`;
          const copy: Json = { ...step };
          for (const field of ["finding_ids", "figure", "links"]) {
            if (field in copy) {
              delete copy[field];
              removed.push(`${at}.${field}`);
            }
          }
          if ("evidence_refs" in copy) {
            copy.evidence_refs = stripEvidenceRefs(
              copy.evidence_refs,
              `${at}.evidence_refs`,
              removed,
            );
          }
          return copy;
        }),
      };
    });
  }
  if (Array.isArray(next.recommended_actions)) {
    next.recommended_actions = next.recommended_actions.map((action, index) => {
      if (!isRecord(action) || !("evidence_refs" in action)) return action;
      return {
        ...action,
        evidence_refs: stripEvidenceRefs(
          action.evidence_refs,
          `recommended_actions[${index}].evidence_refs`,
          removed,
        ),
      };
    });
  }
  if (
    isRecord(next.question_verification) &&
    "evidence_refs" in next.question_verification
  ) {
    next.question_verification = {
      ...next.question_verification,
      evidence_refs: stripEvidenceRefs(
        next.question_verification.evidence_refs,
        "question_verification.evidence_refs",
        removed,
      ),
    };
  }
  for (const field of ["ruled_out", "coverage", "unknowns"]) {
    if (field in next) {
      delete next[field];
      removed.push(field);
    }
  }
  return { summary: next, removed };
}

/** The trace body without outcome and cause_key. */
export function stripTraceStructure(body: Json): {
  body: Json;
  removed: string[];
} {
  const next: Json = { ...body };
  const removed: string[] = [];
  for (const field of ["outcome", "cause_key"]) {
    if (field in next) {
      delete next[field];
      removed.push(field);
    }
  }
  return { body: next, removed };
}

/** The sentence the tool adds when it dropped fields for an older backend. */
export function unsupportedNotice(removed: string[]): string {
  const shown = removed.slice(0, 6).join(", ");
  const more = removed.length > 6 ? `, and ${removed.length - 6} more` : "";
  return `This Tellagen backend does not advertise ${DIAGNOSIS_STRUCTURE_CAPABILITY} for this run, so ${shown}${more} were not sent. Update Tellagen to use the diagnosis structure; the rest of the call went through.`;
}

/* ------------------------------------------------------------------ */
/* Completion warnings                                                */
/* ------------------------------------------------------------------ */

export type QualityWarning = { code?: string; message?: string; path?: string };

const WARNING_ADVICE: Record<string, string> = {
  no_causal_path: "send causal_paths with 2 to 4 steps",
  step_without_proof: "cite finding_ids from tellagen_post_finding on each step",
  finding_ids_dropped: "use numeric ids that tellagen_post_finding returned for this run",
  step_ids_dropped: "coverage step_ids must be ids of causal_paths steps",
  evidence_without_link:
    "evidence refs have no link: call tellagen_build_source_link or add a command",
  links_dropped: "links must be http(s) addresses, at most 4 per ref, labels up to 60 characters",
  commands_dropped: "keep command under 1000 characters",
  figure_invalid: "fix the figure to match a stats, compare or trend block",
  structure_truncated: "keep ruled_out to 5, coverage to 8 and unknowns to 5",
  negative_not_ruled_out: "add a ruled_out entry for each negative finding that matters",
  gap_without_coverage: "add a coverage entry with state gap for each gap finding",
  single_source_high_confidence: "confirm the cause from a second source or lower the confidence",
};

/**
 * One line the agent can act on, from the backend's warnings. The warnings
 * themselves stay verbatim in the response; this only groups them by code.
 */
export function summarizeWarnings(warnings: unknown): string | undefined {
  if (!Array.isArray(warnings) || warnings.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const warning of warnings) {
    const code =
      isRecord(warning) && typeof warning.code === "string" ? warning.code : "warning";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([code, count]) => {
    const advice = WARNING_ADVICE[code];
    return advice ? `${count} ${code} (${advice})` : `${count} ${code}`;
  });
  return `${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${parts.join("; ")}. The run is already complete, so name anything you could not fix in your report and apply the fixes on the next run.`;
}
