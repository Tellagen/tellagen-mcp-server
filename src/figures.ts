import { z } from "zod";

/**
 * Figures are the typed widgets Tellagen draws in the Diagnosis tab, on the
 * timeline and in the postmortem. The agent sends data and Tellagen draws it.
 *
 * The limits below mirror the Tellagen API contract,
 * backend/internal/investigationprotocol/contracts/v2/timeline-event-blocks.schema.json
 * in the Tellagen repository, which stays the source of truth. A figure over a
 * limit is rejected with the field named. Nothing is trimmed, because a
 * silently shortened label or a dropped row would misstate the evidence.
 */

/** Types a causal step may carry as its `figure`. */
export const STEP_FIGURE_TYPES = ["stats", "compare", "trend"] as const;

/** Types the API accepts in a timeline event's `blocks`. */
export const TIMELINE_BLOCK_TYPES = [
  "stats",
  "compare",
  "trend",
  "table",
  "checks",
  "changes",
] as const;

/**
 * Widgets designed for Tellagen but not accepted by the API yet. The builder
 * refuses them and points at what to send instead.
 */
export const PLANNED_FIGURE_TYPES = [
  "range_overlap",
  "histogram",
  "run_history",
  "diff",
] as const;

export type FigurePlacement = "step_figure" | "timeline_block";

const MAX_ABS = 1_000_000_000_000;
const MAX_TREND_POINTS = 500;

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
      .max(4)
      .describe("One to four numbers a responder scans for"),
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

/** What tellagen_build_figure accepts. */
export const figureInputSchema = z.discriminatedUnion("type", [
  statsBase,
  compareBase,
  trendInput,
  tableInput,
  checksBase,
  changesBase,
]);

export type FigureInput = z.infer<typeof figureInputSchema>;

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
  return issues;
}

const PLANNED_HINT: Record<(typeof PLANNED_FIGURE_TYPES)[number], string> = {
  range_overlap: "Send a compare block with the two edges as rows, or say it in the step.",
  histogram: "Send a compare block with p50, p95 and p99 as rows (before and after, with the SLO as threshold), or a trend of the percentile.",
  run_history: "Send a table with one row per run (run, commit, result), or a checks block with the failures first.",
  diff: "Link the commit in the step's evidence refs and describe the change in the step. A changes block can show a value that moved from one thing to another.",
};

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
    default:
      return `changes with ${(block.rows as unknown[]).length} rows`;
  }
};

/**
 * Turns the numbers an agent already read from a tool result into a figure
 * Tellagen accepts. It reshapes and checks. It has no data source of its own
 * and never makes up a value.
 */
export function buildFigure(input: BuildFigureInput): BuildFigureResult {
  const raw = input.figure as { type?: unknown } | null;
  const asked = typeof raw?.type === "string" ? raw.type : "";
  if ((PLANNED_FIGURE_TYPES as readonly string[]).includes(asked)) {
    const hint = PLANNED_HINT[asked as (typeof PLANNED_FIGURE_TYPES)[number]];
    return {
      ok: false,
      issues: [`type: "${asked}" is designed but Tellagen does not accept it yet. ${hint}`],
    };
  }

  const parsed = figureInputSchema.safeParse(input.figure);
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
  const figure = parsed.data;

  if (input.placement === "step_figure") {
    if (!(STEP_FIGURE_TYPES as readonly string[]).includes(figure.type)) {
      return {
        ok: false,
        issues: [`type: a step figure is stats, compare or trend. A ${figure.type} block is a timeline block, so use placement "timeline_block" or pick one of those three.`],
      };
    }
    if (input.slot || input.anchor || input.postmortem !== undefined) {
      return { ok: false, issues: ["slot: slot, anchor and postmortem place a block on a timeline event. A step figure has no placement."] };
    }
  }

  const notes: string[] = [];
  let block: Record<string, unknown>;
  if (figure.type === "trend") {
    const built = buildTrend(figure);
    if ("issues" in built) return { ok: false, issues: built.issues };
    block = built.block;
    notes.push(...built.notes);
  } else if (figure.type === "table") {
    block = {
      ...figure,
      rows: figure.rows.map((r) => ({ cells: r.cells.map((c) => (typeof c === "number" ? String(c) : c)) })),
    };
  } else {
    block = { ...figure };
  }
  block = Object.fromEntries(Object.entries(block).filter(([, v]) => v !== undefined));

  if (input.placement === "timeline_block") {
    if (input.slot) block.slot = input.slot;
    if (input.anchor) block.anchor = input.anchor;
    if (input.postmortem !== undefined) block.postmortem = input.postmortem;
  }

  const issues = validateBlock(block);
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    type: String(block.type),
    placement: input.placement,
    block,
    summary: describe(block),
    notes,
    use:
      input.placement === "step_figure"
        ? "Put this object in result_summary.causal_paths[].steps[].figure. One figure per step. It needs the diagnosis structure the pickup advertises as diagnosis_structure_v1."
        : "Put this object in the blocks array of tellagen_post_timeline_event or tellagen_update_timeline_event. An update replaces the whole array, so send every block you want to keep.",
  };
}
