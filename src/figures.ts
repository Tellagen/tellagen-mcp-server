import { z } from "zod";
import {
  diffHunksFromPatch,
  diffShapeAdvice,
  hasDiffLineDetail,
  MAX_DIFF_CHANGED_LINES,
  MAX_DIFF_CONTEXT_EDGE,
  MAX_DIFF_CONTEXT_GAP,
  MAX_SELECTED_HUNKS,
  withoutDiffLineDetail,
  type DiffLine,
} from "./diff-figure.js";

/**
 * Figures are the typed widgets Tellagen draws in the Diagnosis tab, on the
 * timeline and in the postmortem. The agent sends data and Tellagen draws it.
 *
 * The limits below mirror the Tellagen API contract
 * (contracts/runbooks/v2/timeline-event-blocks.schema.json) and the API's own
 * figure validation, which stay the source of truth. A figure over a limit is
 * rejected with the field named. Nothing is trimmed, because a silently
 * shortened label or a dropped row would misstate the evidence.
 */

/**
 * Types a causal step may carry as its `figure`. table and changes are
 * timeline blocks only.
 */
export const STEP_FIGURE_TYPES = [
  "stats",
  "compare",
  "trend",
  "checks",
  "range_overlap",
  "histogram",
  "run_history",
  "diff",
] as const;

/** Types the API accepts in a timeline event's `blocks`. */
export const TIMELINE_BLOCK_TYPES = [
  "stats",
  "compare",
  "trend",
  "table",
  "checks",
  "changes",
  "range_overlap",
  "histogram",
  "run_history",
  "diff",
] as const;

/** The most JSON one step figure may take, as the backend measures it. */
export const MAX_STEP_FIGURE_BYTES = 16 * 1024;

export type FigurePlacement = "step_figure" | "timeline_block";

const MAX_ABS = 1_000_000_000_000;
const MAX_TREND_POINTS = 500;
/** Stats a server with figure_extras_v1 takes; the first MAX_STATS_TILES are tiles. */
export const MAX_STATS_ITEMS = 8;
export const MAX_STATS_TILES = 4;
const MAX_RUNS_NOT_SHOWN = 1_000_000;
/** The server takes a stats title, more than 4 stats and runs_not_shown. */
export const FIGURE_EXTRAS_CAPABILITY = "figure_extras_v1";

const number = z.number().finite().min(-MAX_ABS).max(MAX_ABS);
const positive = z.number().finite().gt(0).max(MAX_ABS);
const text = (min: number, max: number) => z.string().min(min).max(max);

const thresholdSchema = z
  .object({
    value: number.describe("Where the line is drawn, in the figure's unit"),
    label: z.string().max(80).optional().describe("Name of the line, for example SLO 500 ms"),
  })
  .strict();

const statsBase = z
  .object({
    type: z.literal("stats"),
    title: blockText(80).optional().describe("A name for the tiles, for example Tests of the run. Only when the server lists figure_extras_v1."),
    items: z
      .array(
        z
          .object({
            label: text(1, 48),
            value: text(1, 32).describe("The value as measured, with no unit inside a number you also chart"),
            caption: z.string().max(64).optional().describe("What the value is measured on"),
            tone: z
              .enum(["good", "warn", "bad", "neutral"])
              .optional()
              .describe("A meaning: good healthy or recovered, warn needs attention, bad failing. Never emphasis."),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_STATS_ITEMS)
      .describe("One to eight numbers; aim for four or fewer. The first four are tiles (the total first, colour only on the exception), the rest plain rows. More than four only when the server lists figure_extras_v1."),
  })
  .strict();

const compareBase = z
  .object({
    type: z.literal("compare"),
    title: z.string().max(80).optional(),
    metric: z.string().max(32).optional().describe("What is measured, for example p95 latency"),
    unit: z.string().max(12).optional().describe("The unit once for every row, for example ms"),
    better: z.enum(["lower", "higher"]).optional().describe("Which direction is an improvement"),
    delta: z.enum(["rel", "abs"]).optional().describe("Show the change as a percentage or an absolute amount"),
    max: positive.optional().describe("Top of the axis. Leave out to let Tellagen choose."),
    threshold: thresholdSchema.optional().describe("An SLO or alert line"),
    rows: z
      .array(
        z
          .object({
            label: text(1, 80).describe("One host, route, query or job"),
            mono: z.boolean().optional().describe("Draw the label in a monospace face"),
            before: number,
            after: number,
            details: z
              .array(
                z
                  .object({ label: text(1, 32), before: text(1, 32), after: text(1, 32) })
                  .strict(),
              )
              .max(3)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .describe("One row per host, route, query or job, biggest movers first"),
  })
  .strict();

const trendSourceSchema = z
  .object({
    kind: z.string().max(80).optional().describe("promql, logql, sql, trace_metrics"),
    datasource: z.string().max(80).optional(),
    query: z.string().max(2000).optional().describe("The query that produced the series"),
    from: z.string().max(80).optional(),
    to: z.string().max(80).optional(),
    step: z.string().max(80).optional(),
    artifact_id: z.string().max(80).optional(),
  })
  .strict();

const trendBase = z
  .object({
    type: z.literal("trend"),
    title: z.string().max(80).optional(),
    unit: z.string().max(12).optional(),
    series: z.array(number).min(2).max(MAX_TREND_POINTS),
    start: z.string().datetime().optional().describe("Time of the first value. Send with step_seconds."),
    step_seconds: z.number().int().min(1).max(86400).optional().describe("Seconds between values. Send with start."),
    max: positive.optional(),
    threshold: thresholdSchema.optional(),
    marks: z
      .array(z.object({ i: z.number().int().min(0).describe("An index into series"), label: text(1, 48) }).strict())
      .max(3)
      .optional()
      .describe("At most three events that explain the shape"),
    source: trendSourceSchema.optional().describe("Provenance only. The values stay in series."),
  })
  .strict();

const tableBase = z
  .object({
    type: z.literal("table"),
    title: z.string().max(80).optional(),
    columns: z.array(z.object({ label: text(1, 80) }).strict()).min(1).max(6),
    rows: z
      .array(z.object({ cells: z.array(z.string().max(64)) }).strict())
      .min(1)
      .max(12),
  })
  .strict();

const checksBase = z
  .object({
    type: z.literal("checks"),
    title: z.string().max(80).optional(),
    items: z
      .array(
        z
          .object({
            label: text(1, 80),
            state: z.enum(["pass", "fail", "pending", "skipped"]),
            detail: z.string().max(160).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

const changesBase = z
  .object({
    type: z.literal("changes"),
    title: z.string().max(80).optional(),
    rows: z
      .array(
        z
          .object({
            label: text(1, 80),
            from: z.string().max(80).optional(),
            to: z.string().max(80).optional(),
            note: z.string().max(160).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

/*
 * The four figure types range_overlap, histogram, run_history and diff.
 * Lengths count Unicode characters after trimming, as the API counts them,
 * and text is one line without control characters.
 */

/** Control characters, line and paragraph separators and bidirectional controls. */
const BLOCK_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** The same for a line of code, which may also hold tabs. */
const CODE_UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const charCount = (value: string): number => [...value].length;

/** One line of at most max characters after trimming; required needs a non-space character. */
function blockText(max: number, required = false) {
  return z.string().superRefine((value, ctx) => {
    const trimmed = value.trim();
    if (trimmed === "") {
      if (required) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "is required" });
      return;
    }
    if (BLOCK_UNSAFE.test(trimmed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be one line without control characters" });
      return;
    }
    const n = charCount(trimmed);
    if (n > max) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${max} characters (got ${n})` });
  });
}

/** A line of code: kept as sent (indentation too), may be empty, tabs allowed. */
function codeLine(max: number) {
  return z.string().superRefine((value, ctx) => {
    if (CODE_UNSAFE.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must not contain control characters other than tabs" });
      return;
    }
    const n = charCount(value);
    if (n > max) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${max} characters (got ${n})` });
  });
}

const rfc3339 = z
  .string()
  .datetime({ offset: true })
  .describe("RFC 3339 time, for example 2026-08-12T09:00:00Z");

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const repoField = blockText(80)
  .refine((value) => value.trim() === "" || REPO_PATTERN.test(value.trim()), {
    message: "must look like owner/name (letters, digits, dots, underscores and dashes)",
  })
  .describe("GitHub repository as owner/name, so each run or commit links to its page");

const httpsLink = blockText(500).refine(
  (value) => {
    const t = value.trim();
    return t === "" || (t.startsWith("https://") && t.length > "https://".length && !/\s/.test(t));
  },
  { message: "must be an https:// link without spaces" },
);

const wholeCount = z.number().int().min(0).max(1_000_000);

export const RUN_RESULTS = ["success", "failure", "cancelled", "pending"] as const;
export const RUN_MARK_CHANGES = ["regression", "fix", "change"] as const;

const rangeOverlapBase = z
  .object({
    type: z.literal("range_overlap"),
    title: blockText(80).optional(),
    unit: blockText(12).optional().describe("The one unit every row is in, for example px or MB"),
    min: number.optional().describe("Start of the whole range drawn in the overview. Send with max."),
    max: number.optional().describe("End of the whole range drawn in the overview. Send with min."),
    rows: z
      .array(
        z
          .object({
            label: blockText(80, true),
            from: number,
            to: number.describe("Not below from"),
          })
          .strict(),
      )
      .min(2)
      .max(4)
      .describe("Two to four ranges. Tellagen computes where they overlap; never send the overlap."),
    window: z
      .tuple([number, number])
      .optional()
      .describe("[from, to] to choose the zoom yourself. Leave out to zoom to the overlap."),
  })
  .strict();

const histogramBase = z
  .object({
    type: z.literal("histogram"),
    title: blockText(80).optional(),
    unit: blockText(12).optional(),
    edges: z
      .array(number)
      .min(3)
      .max(61)
      .describe("Bucket edges, 3 to 61, none negative, each greater than the one before: 2 to 60 buckets"),
    before: z.array(number).max(60).describe("One count per bucket before the change"),
    after: z.array(number).max(60).describe("One count per bucket after the change"),
    threshold: thresholdSchema.optional().describe("The SLO line. Tellagen computes the share over it."),
    source: trendSourceSchema.optional().describe("Provenance only. The counts stay in before and after."),
  })
  .strict();

const runRef = blockText(80, true);

const runSchema = z
  .object({
    ref: runRef.describe("The run number or id, unique in the block. Marks and the span name runs by ref."),
    result: z.enum(RUN_RESULTS),
    sha: blockText(64).optional(),
    at: rfc3339.optional(),
    trigger: blockText(32).optional().describe("What started the run, for example push or schedule"),
    job: blockText(80).optional().describe("The job that failed"),
    url: httpsLink.optional(),
  })
  .strict();

const runMarkSchema = z
  .object({
    between: z
      .tuple([runRef, runRef])
      .describe("Refs of two neighbouring runs, the second right after the first"),
    change_ref: z.enum(RUN_MARK_CHANGES).describe("regression for the change that broke it, fix for the one that fixed it"),
    sha: blockText(64).optional(),
    at: rfc3339.optional(),
    title: blockText(80).optional(),
  })
  .strict();

const runSpanSchema = z
  .object({
    from: runRef,
    to: runRef.describe("Not a run before from"),
    label: blockText(48, true).describe("For example E2E Tests failed"),
  })
  .strict();

const runHistoryBase = z
  .object({
    type: z.literal("run_history"),
    title: blockText(80).optional(),
    repo: repoField.optional(),
    branch: blockText(80).optional(),
    runs: z.array(runSchema).min(2).max(30).describe("2 to 30 runs, oldest first"),
    runs_not_shown: z
      .number()
      .int()
      .min(0)
      .max(MAX_RUNS_NOT_SHOWN)
      .optional()
      .describe("How many runs of a longer history you left out. Only when the server lists figure_extras_v1."),
    marks: z.array(runMarkSchema).max(4).optional().describe("At most four changes between neighbouring runs"),
    span: runSpanSchema.optional().describe("A stretch of runs bracketed under the strip"),
  })
  .strict();

const MAX_DIFF_LINE_NO = 10_000_000;

const diffLineNo = z.number().int().min(1).max(MAX_DIFF_LINE_NO);

const diffLineSchema = z
  .object({
    op: z.enum(["+", "-", "context"]).describe("+ for an added line, - for a removed one, context for an unchanged line (only when the server lists diff_lines_v1)"),
    text: codeLine(160).describe("The line as it is in the change, indentation kept, up to 160 characters"),
    old_no: diffLineNo.optional().describe("Line number in the old file: removed and context lines only. Only with diff_lines_v1, on every line or on none."),
    new_no: diffLineNo.optional().describe("Line number in the new file: added and context lines only. Only with diff_lines_v1, on every line or on none."),
  })
  .strict();

const diffBase = z
  .object({
    type: z.literal("diff"),
    title: blockText(80).optional(),
    path: blockText(200, true).describe("The file the lines are from"),
    repo: repoField.optional(),
    ref: blockText(64, true).describe("The commit sha or ref"),
    at: rfc3339.optional(),
    additions: wholeCount.describe("Added lines in the whole change, from the commit or pull request"),
    deletions: wholeCount.describe("Removed lines in the whole change, from the commit or pull request"),
    hunks: z
      .array(z.array(diffLineSchema).min(1))
      .min(1)
      .max(6)
      .describe("1 to 6 hunks, at most 12 changed lines (+ and -) in all. Send every line of a short change, each removed line next to the line that replaced it."),
  })
  .strict();

/** Exported for the step figure schema of tellagen_complete_investigation. */
export const checksBlockSchema = checksBase;
export const rangeOverlapBlockSchema = rangeOverlapBase;
export const histogramBlockSchema = histogramBase;
export const runHistoryBlockSchema = runHistoryBase;
export const diffBlockSchema = diffBase;

export type FigureRuleIssue = { path: Array<string | number>; message: string };

const formatEdge = (n: number): string => String(n);

/**
 * The rules of a diff's hunks that span lines, with the API's messages: the
 * budget counts changed lines only, a hunk holds at most 2 unchanged lines at
 * each edge and 4 between two changes, and line numbers sit on every line or
 * on none and count up through the diff.
 */
function diffRuleIssues(hunks: DiffLine[][]): FigureRuleIssue[] {
  const issues: FigureRuleIssue[] = [];
  const add = (path: Array<string | number>, message: string) => issues.push({ path, message });
  let changedInAll = 0;
  let numbered = 0;
  let plain = 0;
  let lastOld = 0;
  let lastNew = 0;

  for (const [i, hunk] of hunks.entries()) {
    let context = 0;
    let changed = 0;
    for (const [j, line] of hunk.entries()) {
      if (line.op === "context") {
        context++;
      } else {
        const limit = changed === 0 ? MAX_DIFF_CONTEXT_EDGE : MAX_DIFF_CONTEXT_GAP;
        if (context > limit) {
          const where = changed === 0 ? "before the first changed line" : "between two changed lines";
          add(["hunks", i], `at most ${limit} context lines ${where} of a hunk (got ${context})`);
        }
        context = 0;
        changed++;
        changedInAll++;
      }

      const hasOld = line.old_no !== undefined;
      const hasNew = line.new_no !== undefined;
      let fits = true;
      if (hasOld && line.op === "+") {
        add(["hunks", i, j, "old_no"], "is only for removed and context lines");
        fits = false;
      }
      if (hasNew && line.op === "-") {
        add(["hunks", i, j, "new_no"], "is only for added and context lines");
        fits = false;
      }
      if (line.op === "context" && hasOld !== hasNew) {
        add(["hunks", i, j], "a context line needs old_no and new_no together");
        fits = false;
      }
      if (!fits) continue;
      if (!hasOld && !hasNew) {
        plain++;
        continue;
      }
      numbered++;
      if (hasOld) {
        if (line.old_no! <= lastOld) add(["hunks", i, j, "old_no"], `must be greater than the previous old_no (${lastOld})`);
        lastOld = line.old_no!;
      }
      if (hasNew) {
        if (line.new_no! <= lastNew) add(["hunks", i, j, "new_no"], `must be greater than the previous new_no (${lastNew})`);
        lastNew = line.new_no!;
      }
    }
    if (changed === 0) add(["hunks", i], "needs at least 1 changed line (op + or -)");
    else if (context > MAX_DIFF_CONTEXT_EDGE) {
      add(["hunks", i], `at most ${MAX_DIFF_CONTEXT_EDGE} context lines after the last changed line of a hunk (got ${context})`);
    }
  }
  if (changedInAll > MAX_DIFF_CHANGED_LINES) {
    add(["hunks"], `at most ${MAX_DIFF_CHANGED_LINES} changed lines in all (got ${changedInAll})`);
  }
  if (numbered > 0 && plain > 0) add(["hunks"], "line numbers must be on every line or on none");
  return issues;
}

/**
 * The rules of range_overlap, histogram, run_history and diff that span
 * fields, with the messages the API uses. The block has passed its schema.
 */
export function figureRuleIssues(block: { type: string } & Record<string, unknown>): FigureRuleIssue[] {
  const issues: FigureRuleIssue[] = [];
  const add = (path: Array<string | number>, message: string) => issues.push({ path, message });

  if (block.type === "range_overlap") {
    const b = block as unknown as z.infer<typeof rangeOverlapBase>;
    let bounded = false;
    if (b.min !== undefined && b.max === undefined) add(["max"], "is required when min is set");
    else if (b.max !== undefined && b.min === undefined) add(["min"], "is required when max is set");
    else if (b.min !== undefined && b.max !== undefined) {
      if (b.min >= b.max) add(["max"], "must be greater than min");
      else bounded = true;
    }
    for (const [i, row] of b.rows.entries()) {
      if (row.from > row.to) add(["rows", i, "to"], "must not be below from");
      if (bounded) {
        const within = `must be within min and max (${formatEdge(b.min!)} to ${formatEdge(b.max!)})`;
        if (row.from < b.min! || row.from > b.max!) add(["rows", i, "from"], within);
        if (row.to < b.min! || row.to > b.max!) add(["rows", i, "to"], within);
      }
    }
    if (b.window && b.window[0] >= b.window[1]) add(["window"], "must have from below to");
  }

  if (block.type === "histogram") {
    const b = block as unknown as z.infer<typeof histogramBase>;
    for (const [i, edge] of b.edges.entries()) {
      if (edge < 0) add(["edges", i], "must not be negative");
      else if (i > 0 && edge <= b.edges[i - 1]!) add(["edges", i], "must be greater than the edge before it");
    }
    const buckets = b.edges.length - 1;
    for (const key of ["before", "after"] as const) {
      const counts = b[key];
      if (counts.length !== buckets) {
        add([key], `needs exactly ${buckets} counts (got ${counts.length})`);
        continue;
      }
      let valid = true;
      for (const [i, count] of counts.entries()) {
        if (count < 0) {
          add([key, i], "must not be negative");
          valid = false;
        }
      }
      if (valid && counts.reduce((sum, c) => sum + c, 0) <= 0) add([key], "must add up to more than 0");
    }
  }

  if (block.type === "run_history") {
    const b = block as unknown as z.infer<typeof runHistoryBase>;
    const index = new Map<string, number>();
    for (const [i, run] of b.runs.entries()) {
      const ref = run.ref.trim();
      if (index.has(ref)) add(["runs", i, "ref"], "is already used by another run of this block");
      else index.set(ref, i);
    }
    for (const [k, mark] of (b.marks ?? []).entries()) {
      const at = mark.between.map((ref) => index.get(ref.trim()));
      mark.between.forEach((ref, j) => {
        if (at[j] === undefined) add(["marks", k, "between", j], "is not the ref of a run of this block");
      });
      if (at[0] !== undefined && at[1] !== undefined && at[1] !== at[0] + 1) {
        add(["marks", k, "between"], "must name two neighbouring runs, the second right after the first");
      }
    }
    if (b.span) {
      const from = index.get(b.span.from.trim());
      const to = index.get(b.span.to.trim());
      if (from === undefined) add(["span", "from"], "is not the ref of a run of this block");
      if (to === undefined) add(["span", "to"], "is not the ref of a run of this block");
      if (from !== undefined && to !== undefined && from > to) add(["span", "to"], "must not be a run before from");
    }
  }

  if (block.type === "diff") {
    const b = block as unknown as z.infer<typeof diffBase>;
    issues.push(...diffRuleIssues(b.hunks));
  }
  return issues;
}

/** Where a block sits on a timeline event. Not together. */
const placementFields = {
  slot: z.literal("summary").optional().describe("Draw the block above the note. Not together with anchor."),
  anchor: z.string().max(80).optional().describe("The exact heading text in the note the block sits under. Not together with slot."),
  postmortem: z.boolean().optional().describe("false keeps the block out of the postmortem. Leave out otherwise."),
};

/**
 * One block as the timeline tools accept it. Cross-field rules (a trend's
 * start and step_seconds travel together, a table row has one cell per
 * column) are checked by validateBlock and by the API.
 */
export const timelineBlockSchema = z.discriminatedUnion("type", [
  statsBase.extend(placementFields),
  compareBase.extend(placementFields),
  trendBase.extend(placementFields),
  tableBase.extend(placementFields),
  checksBase.extend(placementFields),
  changesBase.extend(placementFields),
  rangeOverlapBase.extend(placementFields),
  histogramBase.extend(placementFields),
  runHistoryBase.extend(placementFields),
  diffBase.extend(placementFields),
]);

/**
 * The light check the timeline tools apply to `blocks`. The full schema above
 * would add about 8 KB to each tool listing, and the API validates every block
 * itself (400 invalid_block names the field), so the tools only check that the
 * type is one the API accepts. tellagen_build_figure does the full check.
 */
export const timelineBlockRefSchema = z.object({ type: z.enum(TIMELINE_BLOCK_TYPES) }).passthrough();

/** A trend with the extra inputs the builder understands. */
const trendInput = z
  .object({
    type: z.literal("trend"),
    title: z.string().max(80).optional(),
    unit: z.string().max(12).optional(),
    series: z
      .array(number)
      .min(2)
      .max(MAX_TREND_POINTS)
      .optional()
      .describe("Values already on an even grid. Send with start and step_seconds. Or send points instead."),
    start: z.string().datetime().optional(),
    step_seconds: z.number().int().min(1).max(86400).optional(),
    points: z
      .array(
        z
          .object({
            t: z
              .union([z.string(), z.number()])
              .describe("ISO 8601 time, or Unix time in seconds or milliseconds"),
            v: z
              .union([z.number(), z.string()])
              .nullable()
              .describe("The value. A numeric string such as a Prometheus value is accepted; null, NaN and gaps are skipped."),
          })
          .strict(),
      )
      .min(2)
      .max(5000)
      .optional()
      .describe("Raw samples from a range query. Tellagen puts them on an even grid of at most max_points."),
    events: z
      .array(z.object({ at: z.union([z.string(), z.number()]), label: text(1, 48) }).strict())
      .max(10)
      .optional()
      .describe("Events by time, such as a deploy or a rollback. Converted to marks. At most three may fall inside the range."),
    marks: trendBase.shape.marks.describe("Marks by index into series, when you already know the indexes. Use events with points."),
    max_points: z.number().int().min(2).max(MAX_TREND_POINTS).optional().describe("Most points to keep. Default 240."),
    reduce: z
      .enum(["mean", "max", "min", "last"])
      .optional()
      .describe("How samples that share a step combine. Default mean. Use max for error rate or latency spikes so the peak survives."),
    precision: z.number().int().min(1).max(12).optional().describe("Significant digits to keep. Default 4."),
    max: positive.optional(),
    threshold: thresholdSchema.optional(),
    source: trendSourceSchema.optional(),
  })
  .strict();

const tableInput = z
  .object({
    type: z.literal("table"),
    title: z.string().max(80).optional(),
    columns: z.array(z.object({ label: text(1, 80) }).strict()).min(1).max(6),
    rows: z
      .array(z.object({ cells: z.array(z.union([z.string(), z.number()])) }).strict())
      .min(1)
      .max(12),
  })
  .strict();

/** A number as a tool returns it: a JSON number or a numeric string. */
const measured = z.union([z.number(), z.string()]);

/** A histogram, either as the contract has it or as cumulative le buckets. */
const histogramInput = z
  .object({
    type: z.literal("histogram"),
    title: blockText(80).optional(),
    unit: blockText(12).optional(),
    edges: histogramBase.shape.edges.optional().describe("Bucket edges. Send with before and after. Or send buckets instead."),
    before: histogramBase.shape.before.optional(),
    after: histogramBase.shape.after.optional(),
    buckets: z
      .array(
        z
          .object({
            le: measured.describe('The upper bound, as the le label of a Prometheus bucket: a number, or "+Inf" for the last one'),
            before: measured.describe("Cumulative count of the before window at this le (observations <= le)"),
            after: measured.describe("Cumulative count of the after window at this le"),
          })
          .strict(),
      )
      .min(2)
      .max(61)
      .optional()
      .describe("Cumulative bucket counts of two equal windows, one entry per le, as sum by (le) (increase(..._bucket[window])) returns them. Tellagen turns them into edges and one count per bucket."),
    lower_edge: z
      .number()
      .finite()
      .min(0)
      .max(MAX_ABS)
      .optional()
      .describe("With buckets: where the first bucket starts. Default 0."),
    overflow: z
      .enum(["reject", "drop"])
      .optional()
      .describe('With buckets: what to do with observations above the last finite le (the +Inf bucket). A histogram has no open bucket. Default reject; drop leaves them out and says so in notes.'),
    threshold: thresholdSchema.optional(),
    source: trendSourceSchema.optional(),
  })
  .strict();

/** Change roles of change_refs, mapped to the three marks a run history draws. */
const ROLE_TO_MARK: Record<string, (typeof RUN_MARK_CHANGES)[number]> = {
  regression: "regression",
  fix: "fix",
  change: "change",
  regression_source: "regression",
  first_bad: "regression",
  rollback: "change",
  last_good: "change",
  verified_by: "change",
  context: "change",
};

const runMarkInput = z
  .object({
    between: runMarkSchema.shape.between.optional(),
    sha: blockText(64)
      .optional()
      .describe("The commit of the change. Without between, the mark goes before the first run built from this sha."),
    change_ref: z
      .enum(Object.keys(ROLE_TO_MARK) as [string, ...string[]])
      .describe("regression, fix or change. A change_refs role is accepted too: regression_source and first_bad become regression, fix stays fix, any other role becomes change."),
    at: rfc3339.optional(),
    title: blockText(80).optional(),
  })
  .strict();

/** One workflow run as the GitHub Actions REST API or gh run list --json returns it. */
const githubRunInput = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    databaseId: z.union([z.number(), z.string()]).optional(),
    run_number: z.number().int().optional(),
    number: z.number().int().optional(),
    head_sha: z.string().optional(),
    headSha: z.string().optional(),
    conclusion: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    run_started_at: z.string().optional(),
    startedAt: z.string().optional(),
    created_at: z.string().optional(),
    createdAt: z.string().optional(),
    event: z.string().optional(),
    html_url: z.string().optional(),
    url: z.string().optional(),
    job: z.string().optional().describe("The failing job, from the run's jobs list. GitHub's run list does not carry it."),
  })
  .passthrough();

const runHistoryInput = z
  .object({
    type: z.literal("run_history"),
    title: blockText(80).optional(),
    repo: repoField.optional(),
    branch: blockText(80).optional(),
    runs: runHistoryBase.shape.runs.optional().describe("2 to 30 runs, oldest first. Or send github_runs instead."),
    github_runs: z
      .array(githubRunInput)
      .min(2)
      .max(30)
      .optional()
      .describe("Workflow runs exactly as the GitHub Actions list returns them (REST or gh run list --json). Tellagen maps each to a run and puts them oldest first."),
    runs_not_shown: runHistoryBase.shape.runs_not_shown,
    marks: z.array(runMarkInput).max(4).optional(),
    span: runSpanSchema.optional(),
  })
  .strict();

const diffInput = z
  .object({
    type: z.literal("diff"),
    title: blockText(80).optional(),
    path: diffBase.shape.path,
    repo: repoField.optional(),
    ref: diffBase.shape.ref,
    at: rfc3339.optional(),
    additions: diffBase.shape.additions,
    deletions: diffBase.shape.deletions,
    hunks: diffBase.shape.hunks.optional().describe("1 to 6 hunks, at most 12 changed lines in all. Or send patch instead."),
    patch: z
      .string()
      .max(200_000)
      .optional()
      .describe(
        "A unified diff, as the patch of a GitHub commit or pull request file. A change of 12 or fewer changed lines is sent whole. A longer one needs select_hunks.",
      ),
    select_hunks: z
      .array(z.number().int().min(1))
      .max(MAX_SELECTED_HUNKS)
      .optional()
      .describe("With patch: the numbers (1 is the first @@ header) of the hunks the claim cites, in file order, when the change has more than 12 changed lines."),
  })
  .strict();

/** What tellagen_build_figure accepts. */
export const figureInputSchema = z.discriminatedUnion("type", [
  statsBase,
  compareBase,
  trendInput,
  tableInput,
  checksBase,
  changesBase,
  rangeOverlapBase,
  histogramInput,
  runHistoryInput,
  diffInput,
]);

export type FigureInput = z.infer<typeof figureInputSchema>;

/** The four figure types whose fields the tool listing leaves to the guide. */
export const GUIDE_ONLY_FIGURE_TYPES = ["range_overlap", "histogram", "run_history", "diff"] as const;

/**
 * The figure as tellagen_build_figure lists it. The six original types carry
 * their full schema; the four newer ones only their type, so the listing stays
 * small (their fields are in the figure guide). buildFigure checks every type
 * in full with figureInputSchema and names each bad field.
 */
export const figureToolInputSchema = z.discriminatedUnion("type", [
  statsBase,
  compareBase,
  trendInput,
  tableInput,
  checksBase,
  changesBase,
  z
    .object({ type: z.enum(GUIDE_ONLY_FIGURE_TYPES) })
    .passthrough()
    .describe(
      "range_overlap, histogram, run_history or diff, with the fields in resource://tellagen/figure-guide. Checked in full when the tool runs.",
    ),
]);

export type BuildFigureInput = {
  placement: FigurePlacement;
  figure: unknown;
  slot?: "summary";
  anchor?: string;
  postmortem?: boolean;
};

export type BuildFigureResult =
  | {
      ok: true;
      type: string;
      placement: FigurePlacement;
      block: Record<string, unknown>;
      summary: string;
      notes: string[];
      use: string;
    }
  | { ok: false; issues: string[] };

const issuesOf = (error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });

/**
 * Checks one block against the contract, including the rules that span
 * fields. Returns the problems, empty when the block is valid.
 */
export function validateBlock(block: unknown): string[] {
  const parsed = timelineBlockSchema.safeParse(block);
  if (!parsed.success) return issuesOf(parsed.error);
  const b = parsed.data;
  const issues: string[] = [];
  if (b.slot && b.anchor) issues.push("slot: send slot or anchor, not both");
  if (b.type === "trend") {
    if ((b.start === undefined) !== (b.step_seconds === undefined)) {
      issues.push("start: send start and step_seconds together, or neither");
    }
    for (const [k, m] of (b.marks ?? []).entries()) {
      if (m.i >= b.series.length) {
        issues.push(`marks.${k}.i: ${m.i} is past the end of series, which has ${b.series.length} values`);
      }
    }
  }
  if (b.type === "table") {
    for (const [k, row] of b.rows.entries()) {
      if (row.cells.length !== b.columns.length) {
        issues.push(`rows.${k}.cells: ${row.cells.length} cells for ${b.columns.length} columns, one cell per column`);
      }
    }
  }
  if (b.type === "changes") {
    for (const [k, row] of b.rows.entries()) {
      if (row.from === undefined && row.to === undefined) {
        issues.push(`rows.${k}: send from, to, or both`);
      }
    }
  }
  for (const issue of figureRuleIssues(b)) {
    issues.push(`${issue.path.join(".")}: ${issue.message}`);
  }
  return issues;
}

const toSeconds = (t: string | number): number | null => {
  if (typeof t === "number") {
    if (!Number.isFinite(t)) return null;
    return t >= 1e11 ? t / 1000 : t;
  }
  const trimmed = t.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return toSeconds(Number(trimmed));
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms / 1000;
};

const toValue = (v: number | string | null): number | null => {
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const roundSig = (v: number, digits: number): number => Number(v.toPrecision(digits));

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

type TrendInput = z.infer<typeof trendInput>;

function buildTrend(input: TrendInput): { block: Record<string, unknown>; notes: string[] } | { issues: string[] } {
  const notes: string[] = [];
  const digits = input.precision ?? 4;
  const { points, events, series, start, step_seconds, marks, max_points, reduce, precision, ...rest } = input;
  void precision;
  void max_points;
  void reduce;

  if (points && series) {
    return { issues: ["points: send points or series, not both"] };
  }
  if (!points && !series) {
    return { issues: ["points: send points (raw samples with times) or series (values on an even grid)"] };
  }
  if (series) {
    if (events && events.length > 0) {
      return { issues: ["events: events need points to place them in time. With series, send marks by index."] };
    }
    const block: Record<string, unknown> = {
      ...rest,
      series: series.map((v) => roundSig(v, digits)),
      ...(start !== undefined ? { start } : {}),
      ...(step_seconds !== undefined ? { step_seconds } : {}),
      ...(marks ? { marks } : {}),
    };
    return { block, notes };
  }

  // Raw samples: sort, drop what has no usable time or value, then put them on an even grid.
  const raw = points!
    .map((p) => ({ t: toSeconds(p.t), v: toValue(p.v) }))
    .filter((p): p is { t: number; v: number } => p.t !== null && p.v !== null)
    .sort((a, b) => a.t - b.t);
  const dropped = points!.length - raw.length;
  if (dropped > 0) notes.push(`${dropped} sample${dropped === 1 ? "" : "s"} had no usable time or value and were skipped.`);
  if (raw.length < 2) return { issues: ["points: at least two samples with a time and a value are needed"] };

  const t0 = Math.floor(raw[0]!.t);
  const span = raw[raw.length - 1]!.t - t0;
  if (span <= 0) return { issues: ["points: the samples all share one time"] };

  const limit = Math.min(MAX_TREND_POINTS, max_points ?? 240);
  const spacing = Math.max(1, Math.round(median(raw.slice(1).map((p, i) => p.t - raw[i]!.t).filter((d) => d > 0))));
  let step = step_seconds ?? spacing;
  step = Math.max(step, Math.ceil(span / (limit - 1)));
  if (step > 86400) {
    return { issues: [`points: the range is too long for ${limit} points at one day or less per step. Send a shorter range.`] };
  }
  const count = Math.floor(span / step) + 1;

  const buckets: number[][] = Array.from({ length: count }, () => []);
  for (const p of raw) {
    const index = Math.min(count - 1, Math.max(0, Math.round((p.t - t0) / step)));
    buckets[index]!.push(p.v);
  }
  const combine = reduce ?? "mean";
  const values: Array<number | null> = buckets.map((b) => {
    if (b.length === 0) return null;
    if (combine === "max") return Math.max(...b);
    if (combine === "min") return Math.min(...b);
    if (combine === "last") return b[b.length - 1]!;
    return b.reduce((a, c) => a + c, 0) / b.length;
  });

  // Fill empty steps with a straight line between the neighbours that exist.
  let filled = 0;
  let previous = -1;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === null) continue;
    if (previous >= 0 && i - previous > 1) {
      const a = values[previous]!;
      const b = values[i]!;
      for (let k = previous + 1; k < i; k += 1) {
        values[k] = a + ((b - a) * (k - previous)) / (i - previous);
        filled += 1;
      }
    }
    previous = i;
  }
  if (filled > 0) {
    notes.push(`${filled} empty step${filled === 1 ? "" : "s"} were filled with a straight line between neighbours. Say so in the step if it matters.`);
    if (filled / count > 0.2) notes.push("More than a fifth of the steps were filled. Check the query range and step before you rely on this chart.");
  }
  const out = (values as number[]).map((v) => roundSig(v, digits));
  if (raw.length !== out.length) {
    notes.push(`${raw.length} samples became ${out.length} points at ${step} s, combined with ${combine}.`);
  }

  let outMarks = marks;
  if (events && events.length > 0) {
    if (marks && marks.length > 0) return { issues: ["marks: send events or marks, not both"] };
    const placed: Array<{ i: number; label: string }> = [];
    for (const e of events) {
      const at = toSeconds(e.at);
      const i = at === null ? -1 : Math.round((at - t0) / step);
      if (i < 0 || i >= out.length) {
        notes.push(`The event "${e.label}" falls outside the range and was left out.`);
        continue;
      }
      placed.push({ i, label: e.label });
    }
    if (placed.length > 3) {
      return { issues: [`events: ${placed.length} events fall inside the range, and a trend carries at most three marks. Keep the ones that explain the shape.`] };
    }
    outMarks = placed.sort((a, b) => a.i - b.i);
  }

  const block: Record<string, unknown> = {
    ...rest,
    series: out,
    start: new Date(t0 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    step_seconds: step,
    ...(outMarks && outMarks.length > 0 ? { marks: outMarks } : {}),
  };
  return { block, notes };
}

type Built = { block: Record<string, unknown>; notes: string[] } | { issues: string[] };

const toMeasured = (v: number | string): number | null => {
  const n = typeof v === "number" ? v : Number(v.trim());
  return typeof v === "string" && v.trim() === "" ? null : Number.isFinite(n) ? n : null;
};

const toBound = (le: number | string): number | null => {
  if (typeof le === "string" && /^\+?inf$/i.test(le.trim())) return Number.POSITIVE_INFINITY;
  if (le === Number.POSITIVE_INFINITY) return le;
  return toMeasured(le);
};

type HistogramInput = z.infer<typeof histogramInput>;

/**
 * A histogram from cumulative le buckets: the edges are the lower edge and the
 * finite bounds, and the count of a bucket is the cumulative count at its
 * bound less the one below it. Observations above the last finite bound have
 * no bucket to go in; they are rejected unless overflow is drop.
 */
function buildHistogram(input: HistogramInput): Built {
  const { buckets, lower_edge, overflow, edges, before, after, ...rest } = input;
  if (buckets && (edges || before || after)) {
    return { issues: ["buckets: send buckets, or edges with before and after, not both"] };
  }
  if (!buckets) {
    if (!edges || !before || !after) {
      return { issues: ["edges: send edges with before and after (one count per bucket), or send buckets (cumulative counts per le)"] };
    }
    return { block: { ...rest, edges, before, after }, notes: [] };
  }

  const notes: string[] = [];
  const parsed: Array<{ le: number; before: number; after: number; at: number }> = [];
  const issues: string[] = [];
  for (const [i, bucket] of buckets.entries()) {
    const le = toBound(bucket.le);
    const b = toMeasured(bucket.before);
    const a = toMeasured(bucket.after);
    if (le === null) issues.push(`buckets.${i}.le: must be a number or +Inf`);
    if (b === null) issues.push(`buckets.${i}.before: must be a number`);
    if (a === null) issues.push(`buckets.${i}.after: must be a number`);
    if (le !== null && b !== null && a !== null) parsed.push({ le, before: b, after: a, at: i });
  }
  if (issues.length > 0) return { issues };
  parsed.sort((x, y) => x.le - y.le);
  for (let i = 1; i < parsed.length; i += 1) {
    if (parsed[i]!.le === parsed[i - 1]!.le) return { issues: [`buckets.${parsed[i]!.at}.le: ${parsed[i]!.le} is sent twice`] };
  }
  const finite = parsed.filter((p) => Number.isFinite(p.le));
  const open = parsed.find((p) => !Number.isFinite(p.le));
  if (finite.length < 2) return { issues: ["buckets: at least two buckets with a finite le are needed"] };
  if (finite.length > 60) return { issues: [`buckets: ${finite.length} finite buckets; a histogram has at most 60. Query a coarser set of buckets.`] };

  const lower = lower_edge ?? 0;
  if (lower >= finite[0]!.le) {
    return { issues: [`lower_edge: ${lower} must be below the first le (${finite[0]!.le})`] };
  }
  if (lower_edge === undefined) notes.push(`The first bucket starts at 0 (lower_edge) and ends at ${finite[0]!.le}.`);

  const counts = { before: [] as number[], after: [] as number[] };
  for (const key of ["before", "after"] as const) {
    const top = Math.max(1, ...parsed.map((p) => Math.abs(p[key])));
    const noise = top * 1e-9;
    let previous = 0;
    for (const p of finite) {
      let count = p[key] - previous;
      if (count < 0) {
        if (-count > noise) {
          return { issues: [`buckets.${p.at}.${key}: cumulative counts must not go down as le grows (${p[key]} after ${previous})`] };
        }
        count = 0;
      }
      counts[key].push(Number(count.toPrecision(12)));
      previous = p[key];
    }
    if (open) {
      const above = open[key] - previous;
      if (above > noise) {
        if (overflow !== "drop") {
          return {
            issues: [
              `buckets: ${Number(above.toPrecision(12))} ${key} observations are above the last finite le (${finite[finite.length - 1]!.le}), in the +Inf bucket. A histogram has no open bucket: query a higher bucket, or set overflow to drop to leave them out and say so in the step.`,
            ],
          };
        }
        notes.push(`${Number(above.toPrecision(12))} ${key} observations above ${finite[finite.length - 1]!.le} (the +Inf bucket) were left out. Say so in the step.`);
      } else if (above < -noise) {
        return { issues: [`buckets.${open.at}.${key}: the +Inf count is below the count at the last finite le`] };
      }
    }
  }

  const block: Record<string, unknown> = {
    ...rest,
    edges: [lower, ...finite.map((p) => p.le)],
    before: counts.before,
    after: counts.after,
  };
  notes.push(`${buckets.length} cumulative buckets became ${finite.length} bucket counts per window.`);
  return { block, notes };
}

type RunHistoryInput = z.infer<typeof runHistoryInput>;
type GithubRun = z.infer<typeof githubRunInput>;

const GITHUB_RESULTS: Record<string, (typeof RUN_RESULTS)[number]> = {
  success: "success",
  failure: "failure",
  timed_out: "failure",
  startup_failure: "failure",
  cancelled: "cancelled",
};
const GITHUB_UNFINISHED = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

const webUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.hostname.startsWith("api.") ? value : undefined;
  } catch {
    return undefined;
  }
};

function runFromGithub(run: GithubRun, i: number): { run?: Record<string, unknown>; issue?: string; mapped?: string } {
  const number = run.run_number ?? run.number;
  const id = run.id ?? run.databaseId;
  const ref = number !== undefined ? `#${number}` : id !== undefined ? String(id) : "";
  if (!ref) return { issue: `github_runs.${i}: needs run_number or id` };
  const conclusion = (run.conclusion ?? "").trim().toLowerCase();
  const status = (run.status ?? "").trim().toLowerCase();
  let result: string | undefined;
  let mapped: string | undefined;
  if (conclusion === "") {
    if (status === "" || GITHUB_UNFINISHED.has(status)) result = "pending";
  } else {
    result = GITHUB_RESULTS[conclusion];
    if (result && conclusion !== result) mapped = `${ref} ${conclusion} is drawn as ${result}`;
  }
  if (!result) {
    const what = conclusion || status;
    return { issue: `github_runs.${i}.conclusion: "${what}" has no run_history result (success, failure, cancelled, pending). Leave the run out, or send runs yourself.` };
  }
  const out: Record<string, unknown> = { ref, result };
  const sha = run.head_sha ?? run.headSha;
  if (sha) out.sha = sha;
  const at = run.run_started_at ?? run.startedAt ?? run.created_at ?? run.createdAt;
  if (at) out.at = at;
  if (run.event) out.trigger = run.event;
  if (run.job) out.job = run.job;
  const url = webUrl(run.html_url) ?? webUrl(run.url);
  if (url) out.url = url;
  return { run: out, mapped };
}

/** A run history, from runs or from the GitHub Actions run list; marks may be placed by sha. */
function buildRunHistory(input: RunHistoryInput): Built {
  const { github_runs, runs, marks, ...rest } = input;
  if (github_runs && runs) return { issues: ["runs: send runs or github_runs, not both"] };
  if (!github_runs && !runs) return { issues: ["runs: send runs (oldest first) or github_runs (as GitHub lists them)"] };
  const notes: string[] = [];
  let list: Array<Record<string, unknown>>;
  if (github_runs) {
    const issues: string[] = [];
    const mapped: string[] = [];
    list = [];
    for (const [i, run] of github_runs.entries()) {
      const out = runFromGithub(run, i);
      if (out.issue) issues.push(out.issue);
      if (out.mapped) mapped.push(out.mapped);
      if (out.run) list.push(out.run);
    }
    if (issues.length > 0) return { issues };
    if (mapped.length > 0) notes.push(`${mapped.join("; ")}.`);
    if (list.every((run) => typeof run.at === "string" && Number.isFinite(Date.parse(run.at as string)))) {
      const sorted = [...list].sort((a, b) => Date.parse(a.at as string) - Date.parse(b.at as string));
      if (sorted.some((run, i) => run !== list[i])) notes.push("The runs were put oldest first by their start time.");
      list = sorted;
    } else {
      notes.push("Some runs have no start time, so they are kept in the order sent. Runs must be oldest first.");
    }
  } else {
    list = runs!.map((run) => ({ ...run }));
  }

  const outMarks: Array<Record<string, unknown>> = [];
  for (const [k, mark] of (marks ?? []).entries()) {
    const change = ROLE_TO_MARK[mark.change_ref]!;
    if (change !== mark.change_ref) notes.push(`marks.${k}: change_ref ${mark.change_ref} is drawn as ${change}.`);
    let between = mark.between;
    if (!between) {
      const sha = mark.sha?.trim().toLowerCase();
      if (!sha) return { issues: [`marks.${k}: send between (two neighbouring run refs) or the sha of the change`] };
      const first = list.findIndex((run) => {
        const runSha = typeof run.sha === "string" ? run.sha.trim().toLowerCase() : "";
        return runSha !== "" && (runSha.startsWith(sha) || sha.startsWith(runSha));
      });
      if (first <= 0) {
        return {
          issues: [
            first === 0
              ? `marks.${k}.sha: the first run is already built from ${mark.sha}, so there is no run before it. Send between, or add the run before it.`
              : `marks.${k}.sha: no run is built from ${mark.sha}. Send between with the two runs the change falls between.`,
          ],
        };
      }
      between = [String(list[first - 1]!.ref), String(list[first]!.ref)];
    }
    const out: Record<string, unknown> = { between, change_ref: change };
    if (mark.sha) out.sha = mark.sha;
    if (mark.at) out.at = mark.at;
    if (mark.title) out.title = mark.title;
    outMarks.push(out);
  }

  const block: Record<string, unknown> = { ...rest, runs: list };
  if (outMarks.length > 0) block.marks = outMarks;
  return { block, notes };
}

type DiffInput = z.infer<typeof diffInput>;

/** What the server that will take the figure accepts. */
export type FigureOptions = {
  /** The server lists figure_extras_v1: a stats title, more than 4 stats and runs_not_shown. */
  figureExtras?: boolean;
  /** The server lists diff_lines_v1: a diff may carry unchanged lines and line numbers. */
  diffLines?: boolean;
};

/**
 * The hunks of a diff, from a unified patch or as the agent wrote them. A
 * server without diff_lines_v1 gets only + and - lines, with no numbers.
 */
function buildDiff(input: DiffInput, options: FigureOptions): Built {
  const { patch, hunks, select_hunks: selectHunks, ...rest } = input;
  const diffLines = options.diffLines === true;
  if (patch !== undefined && hunks) return { issues: ["patch: send patch or hunks, not both"] };
  if (patch === undefined && selectHunks) return { issues: ["select_hunks: only with patch"] };
  const notes: string[] = [];
  let out: DiffLine[][];
  if (patch === undefined) {
    if (!hunks) return { issues: ["hunks: send hunks (at most 12 changed lines) or patch (a unified diff)"] };
    out = hunks;
    if (!diffLines && hasDiffLineDetail(out)) {
      out = withoutDiffLineDetail(out);
      notes.push("Unchanged lines and line numbers were left out: this Tellagen does not list diff_lines_v1 in server_capabilities.");
    }
  } else {
    if (patch.split(/\r?\n/).filter((line) => line.startsWith("diff --git ")).length > 1) {
      return { issues: [`patch: holds more than one file. Send the patch of ${input.path} only.`] };
    }
    const built = diffHunksFromPatch(patch, { diffLines, selectHunks });
    if ("issues" in built) return built;
    out = built.hunks;
    notes.push(...built.notes);
  }
  notes.push(...diffShapeAdvice(out, input.additions, input.deletions));
  return { block: { ...rest, hunks: out }, notes };
}

/**
 * A diff block as a server without diff_lines_v1 takes it: no unchanged lines
 * and no line numbers. Any other block is returned as it is.
 */
export function withoutDiffLineDetailInBlock(block: unknown): { block: unknown; stripped: boolean } {
  if (typeof block !== "object" || block === null || Array.isArray(block)) return { block, stripped: false };
  const record = block as Record<string, unknown>;
  if (record.type !== "diff" || !Array.isArray(record.hunks)) return { block, stripped: false };
  const hunks = record.hunks.map((hunk) => (Array.isArray(hunk) ? hunk : [])) as DiffLine[][];
  if (!hasDiffLineDetail(hunks)) return { block, stripped: false };
  return { block: { ...record, hunks: withoutDiffLineDetail(hunks) }, stripped: true };
}

/**
 * A stats or run_history block as a server without figure_extras_v1 takes it:
 * no stats title, at most four stats and no runs_not_shown. Any other block is
 * returned as it is. `what` names each thing that was left out.
 */
export function withoutFigureExtrasInBlock(block: unknown): { block: unknown; what: string[] } {
  if (typeof block !== "object" || block === null || Array.isArray(block)) return { block, what: [] };
  const record = { ...(block as Record<string, unknown>) };
  const what: string[] = [];
  if (record.type === "stats") {
    if (record.title !== undefined) {
      delete record.title;
      what.push("the title");
    }
    if (Array.isArray(record.items) && record.items.length > MAX_STATS_TILES) {
      what.push(`${record.items.length - MAX_STATS_TILES} figures after the fourth`);
      record.items = record.items.slice(0, MAX_STATS_TILES);
    }
  } else if (record.type === "run_history" && record.runs_not_shown !== undefined) {
    delete record.runs_not_shown;
    what.push("runs_not_shown");
  }
  return what.length > 0 ? { block: record, what } : { block, what };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const describe = (block: Record<string, unknown>): string => {
  switch (block.type) {
    case "trend": {
      const series = block.series as unknown[];
      const marks = (block.marks as unknown[] | undefined)?.length ?? 0;
      return `trend of ${series.length} points${block.step_seconds ? ` at ${block.step_seconds} s` : ""} with ${marks} mark${marks === 1 ? "" : "s"}`;
    }
    case "compare":
      return `compare with ${(block.rows as unknown[]).length} row${(block.rows as unknown[]).length === 1 ? "" : "s"}`;
    case "stats":
      return `stats with ${(block.items as unknown[]).length} number${(block.items as unknown[]).length === 1 ? "" : "s"}`;
    case "table":
      return `table of ${(block.rows as unknown[]).length} rows by ${(block.columns as unknown[]).length} columns`;
    case "checks":
      return `checks with ${(block.items as unknown[]).length} items`;
    case "range_overlap": {
      // For the agent only: Tellagen computes and draws the overlap itself.
      const rows = block.rows as Array<{ from: number; to: number }>;
      const from = Math.max(...rows.map((r) => r.from));
      const to = Math.min(...rows.map((r) => r.to));
      const unit = typeof block.unit === "string" ? ` ${block.unit}` : "";
      return `range_overlap of ${rows.length} rows; ${from <= to ? `they overlap from ${from} to ${to}${unit}` : "they do not all overlap"}`;
    }
    case "histogram": {
      const total = (key: string) => Number((block[key] as number[]).reduce((a, c) => a + c, 0).toPrecision(12));
      return `histogram of ${(block.edges as unknown[]).length - 1} buckets, ${total("before")} observations before and ${total("after")} after`;
    }
    case "run_history": {
      const runs = block.runs as Array<{ result: string }>;
      const count = (result: string) => runs.filter((r) => r.result === result).length;
      const marks = (block.marks as unknown[] | undefined)?.length ?? 0;
      return `run_history of ${runs.length} runs (${count("success")} passed, ${count("failure")} failed, ${count("cancelled")} cancelled, ${count("pending")} pending) with ${plural(marks, "mark")}`;
    }
    case "diff": {
      const lines = (block.hunks as DiffLine[][]).flat();
      const changed = lines.filter((l) => l.op !== "context").length;
      const context = lines.length - changed;
      const numbered = lines.some((l) => l.old_no !== undefined || l.new_no !== undefined);
      return `diff of ${block.path} at ${block.ref}: +${block.additions} -${block.deletions} in the whole change, ${plural(changed, "changed line")} shown${context > 0 ? ` with ${plural(context, "unchanged line")}` : ""}${numbered ? " and line numbers" : ""}`;
    }
    default:
      return `changes with ${(block.rows as unknown[]).length} rows`;
  }
};

/**
 * Turns the numbers an agent already read from a tool result into a figure
 * Tellagen accepts. It reshapes and checks. It has no data source of its own
 * and never makes up a value.
 */
export function buildFigure(input: BuildFigureInput, options: FigureOptions = {}): BuildFigureResult {
  const parsed = figureInputSchema.safeParse(input.figure);
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
  const figure = parsed.data;

  if (input.placement === "step_figure") {
    if (!(STEP_FIGURE_TYPES as readonly string[]).includes(figure.type)) {
      return {
        ok: false,
        issues: [`type: a step figure is ${STEP_FIGURE_TYPES.join(", ")}. A ${figure.type} block is a timeline block, so use placement "timeline_block" or pick one of those.`],
      };
    }
    if (input.slot || input.anchor || input.postmortem !== undefined) {
      return { ok: false, issues: ["slot: slot, anchor and postmortem place a block on a timeline event. A step figure has no placement."] };
    }
  }

  const notes: string[] = [];
  let block: Record<string, unknown>;
  const take = (built: Built): BuildFigureResult | null => {
    if ("issues" in built) return { ok: false, issues: built.issues };
    block = built.block;
    notes.push(...built.notes);
    return null;
  };
  if (figure.type === "trend") {
    const failed = take(buildTrend(figure));
    if (failed) return failed;
  } else if (figure.type === "histogram") {
    const failed = take(buildHistogram(figure));
    if (failed) return failed;
  } else if (figure.type === "run_history") {
    const failed = take(buildRunHistory(figure));
    if (failed) return failed;
  } else if (figure.type === "diff") {
    const failed = take(buildDiff(figure, options));
    if (failed) return failed;
  } else if (figure.type === "table") {
    block = {
      ...figure,
      rows: figure.rows.map((r) => ({ cells: r.cells.map((c) => (typeof c === "number" ? String(c) : c)) })),
    };
  } else {
    block = { ...figure };
  }
  block = Object.fromEntries(Object.entries(block!).filter(([, v]) => v !== undefined));
  if (options.figureExtras !== true) {
    const stripped = withoutFigureExtrasInBlock(block);
    if (stripped.what.length > 0) {
      block = stripped.block as Record<string, unknown>;
      notes.push(`Left out ${stripped.what.join(" and ")}: this Tellagen does not list ${FIGURE_EXTRAS_CAPABILITY} in server_capabilities.`);
    }
  }

  if (input.placement === "timeline_block") {
    if (input.slot) block.slot = input.slot;
    if (input.anchor) block.anchor = input.anchor;
    if (input.postmortem !== undefined) block.postmortem = input.postmortem;
  }

  const issues = validateBlock(block);
  if (issues.length > 0) return { ok: false, issues };

  if (input.placement === "step_figure") {
    const bytes = new TextEncoder().encode(JSON.stringify(block)).length;
    if (bytes > MAX_STEP_FIGURE_BYTES) {
      return {
        ok: false,
        issues: [`figure: ${bytes} bytes; a step figure holds at most ${MAX_STEP_FIGURE_BYTES}. Send fewer points, runs or rows, or put it on a timeline event.`],
      };
    }
  }

  return {
    ok: true,
    type: String(block.type),
    placement: input.placement,
    block,
    summary: describe(block),
    notes,
    use:
      input.placement === "step_figure"
        ? "Put this object in result_summary.causal_paths[].steps[].figure. One figure per step. It needs the diagnosis structure the pickup advertises as diagnosis_structure_v1. A Tellagen older than these figure types drops a checks, range_overlap, histogram, run_history or diff figure and says so in the completion warnings (figure_invalid)."
        : "Put this object in the blocks array of tellagen_post_timeline_event or tellagen_update_timeline_event. An update replaces the whole array, so send every block you want to keep.",
  };
}
