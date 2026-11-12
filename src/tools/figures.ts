import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { activeRunId } from "../active-run.js";
import type { TellagenClient } from "../client.js";
import { supportsDiffLines, supportsFigureExtras } from "../diagnosis-structure.js";
import { buildFigure, figureToolInputSchema, withoutFigureExtrasInBlock } from "../figures.js";

export const FIGURE_GUIDE_URI = "resource://tellagen/figure-guide";

/** Added to the server instructions so every agent knows figures exist. */
export const FIGURE_INSTRUCTIONS = `Figures: Tellagen draws typed widgets (stats, compare, trend, table, checks, changes, range_overlap, histogram, run_history, diff) from data you send, in the Diagnosis tab, on the timeline and in the postmortem. Use tellagen_build_figure to turn the numbers you read from a tool result into a figure Tellagen accepts: it puts a time series on an even grid of at most 500 points, turns deploy, alert and rollback times into marks, turns cumulative histogram buckets into bucket counts, maps a GitHub Actions run list to a run history, and enforces every limit. Attach the result as a causal step's figure or as a block on a timeline event. A figure owns its numbers: never repeat them in prose, never invent one, and keep units in the unit field. Read ${FIGURE_GUIDE_URI} to choose the widget that fits the question and to learn how to plot data on it.`;

export const FIGURE_GUIDE = `# Tellagen figures

A figure is a small typed widget that Tellagen draws for you. You send the data. Tellagen draws it the same way in the Diagnosis tab, on the timeline and in the postmortem, and a responder can pin one from one place to another.

Use tellagen_build_figure to make one. It reshapes the numbers you already read from a tool result and checks them against Tellagen's limits before you send anything. It has no data of its own.

## Rules every figure follows

1. A figure owns its numbers. The sentence next to it says what happened and why. It does not repeat the numbers.
2. Never invent a number. Every value comes from a tool result you can cite. If you do not have the value, leave that row, figure or block out.
3. Units go in the unit field, once. Do not put them inside a number, and do not repeat them in every label.
4. One figure per causal step, under the step it proves. A step with no good figure carries none.
5. Say where the data came from. A trend carries its query in source. For other figures, cite the tool result in the step's evidence refs.
6. A tone is a meaning, not emphasis: good for healthy or recovered, warn for needs attention, bad for failing, neutral for a plain fact.
7. The limits below are enforced. A figure over a limit is rejected with the field named. Shorten the data yourself. Do not expect it to be trimmed.

## Pick the widget by the question

| The question | Widget | Step figure | Timeline block | Limits |
| --- | --- | --- | --- | --- |
| What are the few numbers that matter? | stats | yes | yes | 1 to 8 items (4 or fewer is best), title 80, label 48, value 32, caption 64 |
| Did it get better, and is it inside the line? | compare | yes | yes | 1 to 8 rows, 3 details per row |
| When did it start, and what happened around then? | trend | yes | yes | 2 to 500 points, 3 marks |
| Which items rank highest? | table | no | yes | 1 to 6 columns, 1 to 12 rows, cell 64 |
| Which checks passed, failed or did not run? | checks | yes | yes | 1 to 12 items, label 80, detail 160 |
| What moved from one thing to another? | changes | no | yes | 1 to 8 rows, from and to 80, note 160 |
| Where do two or more ranges meet? | range_overlap | yes | yes | 2 to 4 rows, label 80, unit 12 |
| Did the slow tail move, when the average did not? | histogram | yes | yes | 3 to 61 edges (2 to 60 buckets), one count per bucket |
| Which build broke, and which fixed it? | run_history | yes | yes | 2 to 30 runs, runs_not_shown, 4 marks, ref 80, sha 64, job 80, url 500 |
| What exactly changed in the code? | diff | yes | yes | path 200, ref 64, 1 to 6 hunks, 12 changed lines in all, line 160 |

## How to plot data on each widget

### compare: before and after

Use it for a value measured before and after a deploy, rollback, fix or config change. One row per host, route, query or job, biggest movers first.

1. Pick two windows of the same length, one before the change and one after. Run the same query on both.
2. Take one number per row from each window, for example the p95 over the window.
3. Set unit once. Set better to lower or higher. Add a threshold for the SLO or alert line.

    { "type": "compare", "title": "p95 latency by route", "unit": "ms", "better": "lower",
      "threshold": { "value": 500, "label": "SLO 500 ms" },
      "rows": [ { "label": "POST /checkout", "before": 180, "after": 640 },
                { "label": "GET /cart", "before": 95, "after": 110 } ] }

A distribution is a compare of percentiles: use p50, p95 and p99 as rows, with the SLO as the threshold.

### trend: a series over time

Use it when the evidence is how a value moved. Send the raw samples as points and the times of the events that explain the shape as events.

1. Run a range query. Keep the time and the value of every sample.
2. Send them as points with t and v. t is an ISO time or Unix time in seconds or milliseconds. v may be a numeric string, as Prometheus returns it. A null or NaN is skipped.
3. Tellagen puts the points on an even grid of at most max_points (default 240, most 500) and sets start and step_seconds. Samples that share a step combine with reduce. Use max for error rate and latency so a spike survives, mean for a smooth rate.
4. Add up to three events: a deploy, an alert, a rollback. They become marks at the right index. An event outside the range is left out and reported.
5. Fill source with kind, datasource, query and step.

    { "type": "trend", "title": "5xx share of requests", "unit": "%", "reduce": "max",
      "points": [ { "t": "2026-11-02T14:00:00Z", "v": "0.24" }, { "t": "2026-11-02T14:01:00Z", "v": "0.27" } ],
      "events": [ { "at": "2026-11-02T14:42:00Z", "label": "Deploy" }, { "at": "2026-11-02T15:28:00Z", "label": "Rollback" } ],
      "threshold": { "value": 1, "label": "SLO 1%" },
      "source": { "kind": "promql", "datasource": "prometheus", "query": "sum(rate(...))", "step": "1m" } }

If the values are already on an even grid, send series with start and step_seconds, and marks by index. Empty steps are filled with a straight line and reported, so say so in the step when it matters.

### stats: the few numbers that matter

Aim for four or fewer. Each has a short label, a value, a caption that says what it is measured on, and a tone. The first four are tiles in one row, so put the total first and give a tone only to the exception. Items five to eight are drawn as plain rows under the tiles. When this Tellagen lists figure_extras_v1 in server_capabilities you may also send a title (up to 80 characters) to name the tiles, for example "Tests of the run", and up to eight items. Pass run_id to tellagen_build_figure for this check. Without figure_extras_v1 the builder drops the title and every item after the fourth, and says so in notes, because an older Tellagen rejects them and drops the whole figure.

    { "type": "stats", "items": [ { "label": "Failed e2e tests", "value": "1 of 121", "caption": "master, Oct 30", "tone": "bad" } ] }

A tile caption says what the number is measured on. The name of the source, such as "node --test summary", belongs in a source chip (the step's evidence refs), not in a caption.

### table: a ranked list

Top queries, failing routes, slowest endpoints. Give columns, then one cell per column in every row. Numbers are written as text. Keep each cell under 64 characters.

### checks: pass or fail per check

A recovery checklist or a CI job list. Put failures first. The block holds 12 items, so for a larger list send every failure and the checks that matter, and give the counts of the rest in the step.

    { "type": "checks", "title": "Jobs on run 41289327533",
      "items": [ { "label": "Frontend Tests", "state": "fail", "detail": "1 failed of 13516" }, { "label": "E2E Tests", "state": "pass" } ] }

### changes: a value that moved

A setting, a version, a limit. Each row has a label and a from, a to, or both, with an optional note.

### range_overlap: ranges that meet

Use it when the cause is two ranges meeting: layout offsets, a maintenance window against an error spike, memory or port ranges. Two to four rows, each with a label, a from and a to (from not above to), all in one unit.

1. Read each range from a tool result: the config, the layout, the window times as numbers.
2. Send min and max for the whole range when you want an overview strip, and every row must fall inside them. Leave out window: Tellagen zooms to the overlap.
3. Never send the overlap itself. Tellagen computes it, and the builder tells you what it is in summary.

    { "type": "range_overlap", "title": "Header and sticky bar", "unit": "px",
      "rows": [ { "label": "Header", "from": 0, "to": 153 }, { "label": "Sticky bar", "from": 149, "to": 197 } ] }

### histogram: a distribution before and after

Use it when an average hides a slow tail. Send bucket counts for two equal windows. Tellagen computes p50, p95, p99 and the share over the threshold from the buckets, so never send percentiles.

1. Run the bucket query on a window before the change and on one of the same length after it, for example sum by (le) (increase(http_request_duration_seconds_bucket{service="checkout"}[30m])) at the end of each window.
2. Send the result as buckets: one entry per le with the cumulative before and after counts, as Prometheus returns them, numeric strings and "+Inf" included.
3. The builder turns them into edges (lower_edge, default 0, then every finite le) and one count per bucket. Observations above the last finite le have no bucket: the builder rejects them unless you set overflow to drop, and then you say so in the step.
4. Add the SLO as threshold, in the unit of the le values.

    { "type": "histogram", "title": "Checkout latency", "unit": "s",
      "buckets": [ { "le": "0.1", "before": "820", "after": "610" }, { "le": "0.5", "before": "990", "after": "800" },
                   { "le": "1", "before": "1000", "after": "940" }, { "le": "+Inf", "before": "1000", "after": "940" } ],
      "threshold": { "value": 0.5, "label": "SLO 500 ms" } }

If you already have per-bucket counts, send edges, before and after instead: before and after hold exactly one count per bucket (one fewer than edges), none negative.

### run_history: CI builds, jobs, canaries or deploys

Use it for a regression in CI or a bad deploy. Runs go oldest first, each with a ref, a result (success, failure, cancelled, pending), and the failing job when one failed.

1. List the workflow runs of the branch around the failure: the GitHub Actions REST list, the GitHub MCP list of workflow runs, or gh run list --json number,databaseId,headSha,conclusion,status,createdAt,startedAt,event,url.
2. Send them as github_runs, as they came. The builder maps each run: ref #run_number, the head sha, the start time, the event as trigger, the run page as url, and the conclusion as result (timed_out and startup_failure count as failure). A run whose conclusion is skipped, neutral, stale or action_required has no result: leave it out or send runs yourself. Runs are put oldest first by time.
3. Add job to the failing runs: the name of the job that failed, from the run's jobs list.
4. Add marks for the change that broke it (change_ref regression) and the one that fixed it (fix). Give the sha of the change and the builder places the mark before the first run built from it, or give between with the refs of the two neighbouring runs. change_ref may be a change_refs role: regression_source and first_bad become regression, fix stays fix, others become change.
5. Set repo to owner/name so each run links to its page, and an optional span such as { "from": "#4151", "to": "#4163", "label": "E2E Tests failed" }.
6. A history holds at most 30 runs. If yours has more, send the 30 that matter (the runs around the break and the fix, oldest first) and set runs_not_shown to how many you left out; the strip then says "N more runs not shown." Only when this Tellagen lists figure_extras_v1; without it the builder drops runs_not_shown and says so in notes.

    { "type": "run_history", "title": "E2E on master", "repo": "acme/shop", "branch": "master",
      "github_runs": [ { "run_number": 4150, "head_sha": "9f2c1e0", "conclusion": "success", "created_at": "2026-10-30T08:00:00Z", "event": "push" },
                       { "run_number": 4151, "head_sha": "4b7a2d1", "conclusion": "failure", "created_at": "2026-10-30T09:00:00Z", "event": "push", "job": "E2E Tests" } ],
      "marks": [ { "sha": "4b7a2d1", "change_ref": "regression", "title": "Move the header to a sticky layout" } ] }

### diff: the change that broke or fixed it

Use it for the lines of the change that broke or fixed it. A short change is sent whole.

1. Read the commit or pull request file from GitHub. additions and deletions are the size of the whole change, from the commit or the pull request, never counted by you from a part of it.
2. If the change has 12 or fewer changed lines (in at most 6 hunks), send all of them. Send the file's patch as patch: the builder keeps every line, one hunk per @@ header.
3. If it has more, send the whole hunks the claim cites, in file order, at most 3 hunks and at most 12 changed lines in all: give their numbers in select_hunks (1 is the first @@ header). If one hunk alone is longer than 12 changed lines, the builder cuts it after a complete pair of removed and added lines.
4. Never send a changed line without its counterpart: each removed line comes with the line that replaced it, next to it, as a patch lists them. If you write hunks yourself, keep that order and keep the indentation.
5. When the pickup lists diff_lines_v1 in server_capabilities, a hunk may also carry up to 2 unchanged lines (op context) before and after it, and old_no and new_no (1-based) on every line. The builder adds them from the patch headers when you pass run_id. Never invent a number: if you do not have the real numbers, leave all of them out. Without diff_lines_v1 the builder sends only changed lines and no numbers, and says so in notes.
6. Set path, ref (the commit sha) and repo.

    { "type": "diff", "path": "web/components/Header.tsx", "repo": "acme/shop", "ref": "4b7a2d1", "additions": 1, "deletions": 1,
      "hunks": [ [ { "op": "-", "text": "  position: static;" }, { "op": "+", "text": "  position: sticky;" } ] ] }

With diff_lines_v1 the same change, with the unchanged lines around it and the numbers of the real file:

    { "type": "diff", "path": "web/components/Header.tsx", "repo": "acme/shop", "ref": "4b7a2d1", "additions": 1, "deletions": 1,
      "hunks": [ [ { "op": "context", "text": ".header {", "old_no": 11, "new_no": 11 },
                   { "op": "-", "text": "  position: static;", "old_no": 12 }, { "op": "+", "text": "  position: sticky;", "new_no": 12 },
                   { "op": "context", "text": "}", "old_no": 13, "new_no": 13 } ] ] }

## Where the figure goes

- A causal step: set it as figure on the step in result_summary.causal_paths. Every type except table and changes is allowed there, at most 16 KB. This needs the diagnosis structure, which the pickup advertises as diagnosis_structure_v1. A Tellagen that does not know a figure type yet drops the figure and says so in the completion warnings (figure_invalid).
- A timeline event: put it in blocks on tellagen_post_timeline_event or tellagen_update_timeline_event. Any type is allowed, up to 12 per event. An update replaces the whole array, so send every block you want to keep, and [] clears them. Set slot to summary to draw the block above the note, or anchor to the exact heading text it sits under. Not both. Set postmortem to false to keep a block out of the postmortem.

Call tellagen_build_figure with placement step_figure or timeline_block, and use the block it returns as it is.

## Getting the data from other servers

- Grafana or Prometheus: a range query returns time and value pairs. Send them as points. Run the same query on two equal windows for a compare.
- Loki: a count over time by step is a trend. A count by label over two windows is a compare.
- Prometheus histograms: the _bucket series summed by le over two equal windows are a histogram. Send them as buckets.
- GitHub Actions: failed jobs of one run go in checks, failures first. The runs of a branch are a run_history: send the run list as github_runs.
- GitHub commits and pull requests: the lines that broke or fixed it are a diff. Send the file's patch, and the change's additions and deletions.
- Kubernetes: restarts or ready counts before and after are a compare, a list of pods is a table.

## If Tellagen rejects a figure

The builder names the field. For a timeline block the API answers 400 invalid_block with field and details.errors. Fix exactly those fields and send once more. Do not drop a figure to get past an error unless the data in it is not real.
`;

const isDiff = (figure: unknown): boolean =>
  typeof figure === "object" && figure !== null && (figure as { type?: unknown }).type === "diff";

const usesFigureExtras = (figure: unknown): boolean =>
  withoutFigureExtrasInBlock(figure).what.length > 0;

export function registerFigureTools(server: McpServer, client: TellagenClient): void {
  server.registerTool(
    "tellagen_build_figure",
    {
      title: "Build a figure",
      description:
        "Turn numbers you already read from a tool result into a figure (a typed widget) that Tellagen draws, and check it against Tellagen's limits before you send it. Widgets: stats (headline numbers: aim for 4, up to 8 with figure_extras_v1, and an optional title), compare (before and after per host, route or job, with an SLO line), trend (a series over time with up to 3 marks), table (a ranked list, up to 12 rows), checks (pass or fail per check, up to 12), changes (a value that moved from one thing to another), range_overlap (2 to 4 ranges that meet), histogram (bucket counts before and after), run_history (CI or deploy runs with the regression and fix marks), diff (the changed lines of a code change). For a time series send raw samples as points and the deploy, alert or rollback times as events: the tool puts them on an even grid of at most 500 points and works out the mark positions. For a histogram send Prometheus cumulative le buckets as buckets; for a run history send the GitHub Actions run list as github_runs; for a diff send the patch of one file: a change of 12 or fewer changed lines is sent whole with each removed line next to the line that replaced it, a longer one needs select_hunks (at most 3 hunks). Pass run_id so unchanged lines and line numbers are added only when this Tellagen lists diff_lines_v1, and a stats title, more than 4 stats and runs_not_shown only when it lists figure_extras_v1. It has no data of its own and never invents a value, so send only numbers from a tool result you can cite. placement step_figure is for a causal step (any type except table and changes, one per step). placement timeline_block is for a timeline event (any type). Read resource://tellagen/figure-guide to choose the widget and to see how to plot data on it.",
      inputSchema: {
        placement: z
          .enum(["step_figure", "timeline_block"])
          .describe("step_figure for result_summary.causal_paths[].steps[].figure. timeline_block for the blocks of a timeline event."),
        figure: figureToolInputSchema,
        slot: z.literal("summary").optional().describe("timeline_block only: draw the block above the note. Not together with anchor."),
        anchor: z.string().max(80).optional().describe("timeline_block only: the exact heading text in the note that the block sits under. Not together with slot."),
        postmortem: z.boolean().optional().describe("timeline_block only: false keeps the block out of the postmortem."),
        run_id: z
          .string()
          .min(1)
          .optional()
          .describe("The investigation run you are working on. For a diff, a stats or a run_history figure, Tellagen is asked which features it lists in server_capabilities (diff_lines_v1: unchanged lines and line numbers; figure_extras_v1: a stats title, more than 4 stats, runs_not_shown). Without it the latest pickup of this process decides."),
      },
    },
    async ({ run_id: givenRunId, ...input }) => {
      const run_id = activeRunId(client, givenRunId);
      const diffLines = isDiff(input.figure) ? await supportsDiffLines(client, run_id) : false;
      const figureExtras = usesFigureExtras(input.figure) ? await supportsFigureExtras(client, run_id) : false;
      const result = buildFigure(input, { diffLines, figureExtras });
      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                issues: result.issues,
                next: "Fix exactly these fields and call again. Do not drop the figure unless the data it holds is not real.",
              }),
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );
}

/** Registered from createServer, next to the other resources. */
export function registerFigureResource(server: McpServer): void {
  server.registerResource(
    "figure-guide",
    FIGURE_GUIDE_URI,
    {
      title: "Tellagen Figure Guide",
      description:
        "Which widget fits which question, how to plot data on each one, the limits Tellagen enforces, and where a figure goes in a diagnosis or a timeline event.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: FIGURE_GUIDE }],
    }),
  );
}
