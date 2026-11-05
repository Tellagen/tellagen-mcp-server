/**
 * Diagnosis structure (diagnosis_structure_v1).
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
import {
  checksBlockSchema,
  diffBlockSchema,
  figureRuleIssues,
  histogramBlockSchema,
  MAX_STEP_FIGURE_BYTES,
  rangeOverlapBlockSchema,
  runHistoryBlockSchema,
} from "./figures.js";

export const DIAGNOSIS_STRUCTURE_CAPABILITY = "diagnosis_structure_v1";
/** change_refs on the result and the ci_run, deployment and release link kinds. */
export const DIAGNOSIS_CHANGES_CAPABILITY = "diagnosis_changes_v1";
/** The client reads a run's screenshots with tellagen_get_context_attachment. */
export const RUN_IMAGES_CAPABILITY = "run_images_v1";

/* ------------------------------------------------------------------ */
/* Capability negotiation                                             */
/* ------------------------------------------------------------------ */

const capabilityByClient = new WeakMap<TellagenClient, Map<string, ReadonlySet<string>>>();

function capabilityMap(client: TellagenClient): Map<string, ReadonlySet<string>> {
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
 * Remembers the capabilities the backend that answered a pickup or context
 * call for `runId` advertises. A missing `server_capabilities` is a definite
 * "none": the backend predates the field.
 */
export function rememberServerCapabilities(
  client: TellagenClient,
  runId: string,
  response: unknown,
): void {
  if (!isRecord(response)) return;
  const list = response.server_capabilities;
  const advertised = new Set(
    Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [],
  );
  capabilityMap(client).set(runId, advertised);
}

/**
 * Whether the backend accepts a capability for this run. Uses what pickup or
 * context told us in this process; otherwise reads the run context once (a
 * resumed run picked up by another process). A failed lookup counts as "not
 * supported" for this call and is retried on the next one.
 */
export async function supportsCapability(
  client: TellagenClient,
  runId: string,
  capability: string,
): Promise<boolean> {
  const map = capabilityMap(client);
  const known = map.get(runId);
  if (known !== undefined) return known.has(capability);
  try {
    const context = await client.get<unknown>(
      `/api/v1/investigations/${encodeURIComponent(runId)}/context`,
    );
    rememberServerCapabilities(client, runId, context);
    return map.get(runId)?.has(capability) ?? false;
  } catch {
    return false;
  }
}

/** Whether the backend accepts the diagnosis structure for this run. */
export async function supportsDiagnosisStructure(
  client: TellagenClient,
  runId: string,
): Promise<boolean> {
  return supportsCapability(client, runId, DIAGNOSIS_STRUCTURE_CAPABILITY);
}

/** Whether the backend accepts change_refs and the change link kinds for this run. */
export async function supportsDiagnosisChanges(
  client: TellagenClient,
  runId: string,
): Promise<boolean> {
  return supportsCapability(client, runId, DIAGNOSIS_CHANGES_CAPABILITY);
}

/* ------------------------------------------------------------------ */
/* Evidence ref additions                                             */
/* ------------------------------------------------------------------ */

/** Link kinds a backend without diagnosis_changes_v1 does not know. */
export const CHANGE_LINK_KINDS = ["ci_run", "deployment", "release"] as const;

export const EVIDENCE_LINK_KINDS = [
  "explore",
  "panel",
  "diff",
  "commit",
  "pr",
  "logs",
  "trace",
  ...CHANGE_LINK_KINDS,
] as const;

export const evidenceLinkSchema = z.object({
  kind: z
    .enum(EVIDENCE_LINK_KINDS)
    .describe(
      "What the link opens: explore, panel, diff, commit, pr, logs, trace, ci_run (a CI run or job page), deployment or release",
    ),
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
/* Step figure: one timeline block of a figure type                  */
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
export const MAX_FIGURE_BYTES = MAX_STEP_FIGURE_BYTES;

/** Figure types the tool listing shows by type only; they are checked in full below. */
const LISTED_BY_TYPE = ["checks", "range_overlap", "histogram", "run_history", "diff"] as const;

const fullListedByType = z.discriminatedUnion("type", [
  checksBlockSchema.extend(blockCommon),
  rangeOverlapBlockSchema.extend(blockCommon),
  histogramBlockSchema.extend(blockCommon),
  runHistoryBlockSchema.extend(blockCommon),
  diffBlockSchema.extend(blockCommon),
]);

export const stepFigureSchema = z
  .discriminatedUnion("type", [
    statsFigure,
    compareFigure,
    trendFigure,
    // The listing stays small: these carry only their type there, and the
    // refinement below checks every field before the request leaves.
    z
      .object({ type: z.enum(LISTED_BY_TYPE) })
      .passthrough()
      .describe("checks, range_overlap, histogram, run_history or diff: build it with tellagen_build_figure"),
  ])
  .superRefine((figure, ctx) => {
    if ((LISTED_BY_TYPE as readonly string[]).includes(figure.type)) {
      const full = fullListedByType.safeParse(figure);
      if (!full.success) {
        for (const issue of full.error.issues) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
        }
        return;
      }
    }
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
    for (const issue of figureRuleIssues(figure)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(figure)).length;
    if (bytes > MAX_FIGURE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `figure is ${bytes} bytes; the limit is ${MAX_FIGURE_BYTES}. Reduce a trend to at most 500 points, or send fewer runs or rows`,
      });
    }
  })
  .describe(
    "ONE timeline block object that shows the step's key numbers, validated like a timeline event block. compare = a before and after with an optional threshold; trend = a series over time (give source with the query that produced it); stats = 2 to 4 key numbers; checks = pass or fail per check; range_overlap = two to four ranges that meet; histogram = bucket counts before and after; run_history = CI or deploy runs oldest first with the regression and fix marks; diff = up to 12 changed lines of the change. Build it with tellagen_build_figure (placement step_figure). Never invent a number: every value must come from a tool result.",
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

/* ------------------------------------------------------------------ */
/* Change refs (diagnosis_changes_v1)                                 */
/* ------------------------------------------------------------------ */

export const CHANGE_ROLES = [
  "regression_source",
  "fix",
  "rollback",
  "last_good",
  "first_bad",
  "verified_by",
  "context",
] as const;

export const CHANGE_KINDS = [
  "commit",
  "pull_request",
  "deployment",
  "release",
  "ci_run",
  "config_change",
] as const;

export const CHANGE_RESULTS = ["success", "failure", "cancelled", "skipped", "pending", "unknown"] as const;

export const CHANGE_STATES = ["open", "merged", "closed", "reverted", "deployed", "rolled_back"] as const;

/** The backend keeps at most this many change refs. */
export const MAX_CHANGE_REFS = 6;

export const changeRefSchema = z
  .object({
    id: line(0, 64).optional().describe("Your id for the change; Tellagen derives change-N when it is missing or used twice"),
    role: z
      .enum(CHANGE_ROLES)
      .describe(
        "regression_source = the commit or pull request that introduced the failure; first_bad = the first failed run or deploy; last_good = the last good one before it; fix = the change that fixed it; rollback = a rollback that removed the change; verified_by = a run after the fix, with its result; context = a related change that is not the cause",
      ),
    kind: z.enum(CHANGE_KINDS).describe("commit, pull_request, deployment, release, ci_run or config_change"),
    title: line(0, 200).optional().describe("One line: the commit subject, pull request title or run name"),
    repo: z
      .string()
      .trim()
      .max(200)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be owner/name")
      .optional()
      .describe("GitHub repository as owner/name; with ref or sha Tellagen builds the link"),
    ref: line(0, 120)
      .optional()
      .describe("The pull request number, release tag, CI run id, branch or deployment id"),
    sha: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{7,64}$/, "must be 7 to 64 hex characters")
      .optional()
      .describe("The commit sha"),
    occurred_at: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("When it merged, deployed or ran (RFC 3339)"),
    author: line(0, 120).optional(),
    result: z
      .enum(CHANGE_RESULTS)
      .optional()
      .describe("How a CI run or deployment ended. A fact; a green run never confirms the cause by itself."),
    state: z.enum(CHANGE_STATES).optional(),
    verification: z.enum(["confirmed", "likely", "unknown"]).optional(),
    confidence_percent: z.number().int().min(0).max(100).optional(),
    step_ids: z
      .array(z.string().min(1).max(64))
      .max(12)
      .optional()
      .describe("Ids of the causal_paths steps this change belongs to"),
    finding_ids: findingIdsSchema.optional(),
    links: evidenceLinksSchema.optional(),
  })
  .refine(
    (change) =>
      Boolean(change.ref?.trim() || change.sha?.trim() || change.title?.trim() || change.links?.length),
    { message: "a change ref needs ref, sha, title or links" },
  );

export const resultChangeShape = {
  change_refs: z
    .array(changeRefSchema)
    .max(MAX_CHANGE_REFS)
    .optional()
    .describe(
      "The changes tied to the incident, at most 6: the regression_source that introduced it, first_bad and last_good runs or deploys, the fix, and one verified_by ci_run per run after the fix with its result. Give each a link (tellagen_build_source_link) or repo with ref or sha, and finding_ids or step_ids. Needs diagnosis_changes_v1.",
    ),
};

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

const CHANGE_LINK_KIND_SET: ReadonlySet<string> = new Set(CHANGE_LINK_KINDS);

/** A copy of value without links of the change kinds, at any depth. */
function dropChangeLinks(value: unknown, path: string, removed: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => dropChangeLinks(item, `${path}[${index}]`, removed));
  }
  if (!isRecord(value)) return value;
  const next: Json = {};
  for (const [key, child] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (key === "links" && Array.isArray(child)) {
      next[key] = child.filter((link, index) => {
        if (isRecord(link) && typeof link.kind === "string" && CHANGE_LINK_KIND_SET.has(link.kind)) {
          removed.push(`${at}[${index}]`);
          return false;
        }
        return true;
      });
      continue;
    }
    next[key] = dropChangeLinks(child, at, removed);
  }
  return next;
}

/** A result summary without change_refs and without ci_run, deployment and release links. */
export function stripResultChanges(summary: unknown): {
  summary: unknown;
  removed: string[];
} {
  const removed: string[] = [];
  if (!isRecord(summary)) return { summary, removed };
  const rest: Json = { ...summary };
  if ("change_refs" in rest) {
    delete rest.change_refs;
    removed.push("change_refs");
  }
  return { summary: dropChangeLinks(rest, "", removed), removed };
}

/** Evidence refs without ci_run, deployment and release links. */
export function stripFindingChangeLinks(refs: unknown): {
  refs: unknown;
  removed: string[];
} {
  const removed: string[] = [];
  return { refs: dropChangeLinks(refs, "evidence_refs", removed), removed };
}

/** The sentence the tool adds when it dropped fields for an older backend. */
export function unsupportedNotice(
  removed: string[],
  capability: string = DIAGNOSIS_STRUCTURE_CAPABILITY,
): string {
  const shown = removed.slice(0, 6).join(", ");
  const more = removed.length > 6 ? `, and ${removed.length - 6} more` : "";
  const feature =
    capability === DIAGNOSIS_CHANGES_CAPABILITY
      ? "change refs and ci_run, deployment and release links"
      : "the diagnosis structure";
  return `This Tellagen backend does not advertise ${capability} for this run, so ${shown}${more} were not sent. Update Tellagen to use ${feature}; the rest of the call went through.`;
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
  figure_invalid:
    "fix the figure to match a stats, compare, trend, checks, range_overlap, histogram, run_history or diff block (tellagen_build_figure checks it)",
  structure_truncated: "keep ruled_out to 5, coverage to 8 and unknowns to 5",
  negative_not_ruled_out: "add a ruled_out entry for each negative finding that matters",
  gap_without_coverage: "add a coverage entry with state gap for each gap finding",
  single_source_high_confidence:
    "a step above 90% confidence rests on one source: cite a finding from a second source (a name that starts with grafana counts as one source) or send confidence_percent of 90 or less",
  change_without_link: "give each change ref a link, or repo with ref or sha so Tellagen can build one",
  change_without_proof: "cite finding_ids or step_ids on each change ref",
  regression_source_missing:
    "add the change that introduced it as a change ref with role regression_source, or say in unknowns why it is not known",
  change_refs_dropped: "use a known role and kind, give each ref a ref, sha, title or link, and send at most 6",
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
