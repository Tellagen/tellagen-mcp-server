import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildFigure, figureInputSchema } from "../figures.js";

export const FIGURE_GUIDE_URI = "resource://tellagen/figure-guide";

/** Added to the server instructions so every agent knows figures exist. */
export const FIGURE_INSTRUCTIONS = `Figures: Tellagen draws typed widgets (stats, compare, trend, table, checks, changes) from data you send, in the Diagnosis tab, on the timeline and in the postmortem. Use tellagen_build_figure to turn the numbers you read from a tool result into a figure Tellagen accepts: it puts a time series on an even grid of at most 500 points, turns deploy, alert and rollback times into marks, and enforces every limit. Attach the result as a causal step's figure or as a block on a timeline event. A figure owns its numbers: never repeat them in prose, never invent one, and keep units in the unit field. Read ${FIGURE_GUIDE_URI} to choose the widget that fits the question and to learn how to plot data on it.`;

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
| What are the few numbers that matter? | stats | yes | yes | 1 to 4 items, label 48, value 32, caption 64 |
| Did it get better, and is it inside the line? | compare | yes | yes | 1 to 8 rows, 3 details per row |
| When did it start, and what happened around then? | trend | yes | yes | 2 to 500 points, 3 marks |
| Which items rank highest? | table | no | yes | 1 to 6 columns, 1 to 12 rows, cell 64 |
| Which checks passed, failed or did not run? | checks | no | yes | 1 to 12 items, label 80, detail 160 |
| What moved from one thing to another? | changes | no | yes | 1 to 8 rows, from and to 80, note 160 |

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

Up to four. Each has a short label, a value, a caption that says what it is measured on, and a tone.

    { "type": "stats", "items": [ { "label": "Failed e2e tests", "value": "1 of 121", "caption": "master, Oct 30", "tone": "bad" } ] }

### table: a ranked list

Top queries, failing routes, slowest endpoints. Give columns, then one cell per column in every row. Numbers are written as text. Keep each cell under 64 characters.

### checks: pass or fail per check

A recovery checklist or a CI job list. Put failures first. The block holds 12 items, so for a larger list send every failure and the checks that matter, and give the counts of the rest in the step.

    { "type": "checks", "title": "Jobs on run 41289327533",
      "items": [ { "label": "Frontend Tests", "state": "fail", "detail": "1 failed of 13516" }, { "label": "E2E Tests", "state": "pass" } ] }

### changes: a value that moved

A setting, a version, a limit. Each row has a label and a from, a to, or both, with an optional note.

## Where the figure goes

- A causal step: set it as figure on the step in result_summary.causal_paths. Only stats, compare and trend are allowed there. This needs the diagnosis structure, which the pickup advertises as diagnosis_structure_v1.
- A timeline event: put it in blocks on tellagen_post_timeline_event or tellagen_update_timeline_event. Any type is allowed, up to 12 per event. An update replaces the whole array, so send every block you want to keep, and [] clears them. Set slot to summary to draw the block above the note, or anchor to the exact heading text it sits under. Not both. Set postmortem to false to keep a block out of the postmortem.

Call tellagen_build_figure with placement step_figure or timeline_block, and use the block it returns as it is.

## Getting the data from other servers

- Grafana or Prometheus: a range query returns time and value pairs. Send them as points. Run the same query on two equal windows for a compare.
- Loki: a count over time by step is a trend. A count by label over two windows is a compare.
- GitHub Actions: failed jobs go in checks, failures first. A run history is a table with one row per run: run, commit, result.
- Kubernetes: restarts or ready counts before and after are a compare, a list of pods is a table.

## Designed but not accepted yet

Do not send these. Tellagen rejects them today. Send the alternative.

- range_overlap, two ranges that overlap: say it in the step, or send a compare with the two edges as rows.
- histogram, a distribution before and after: send a compare with p50, p95 and p99 as rows.
- run_history, the pass and fail of many runs: send a table or a checks block.
- diff, a code change: link the commit in the evidence refs and describe the change in the step.

## If Tellagen rejects a figure

The builder names the field. For a timeline block the API answers 400 invalid_block with field and details.errors. Fix exactly those fields and send once more. Do not drop a figure to get past an error unless the data in it is not real.
`;

export function registerFigureTools(server: McpServer): void {
  server.registerTool(
    "tellagen_build_figure",
    {
      title: "Build a figure",
      description:
        "Turn numbers you already read from a tool result into a figure (a typed widget) that Tellagen draws, and check it against Tellagen's limits before you send it. Widgets: stats (up to 4 headline numbers), compare (before and after per host, route or job, with an SLO line), trend (a series over time with up to 3 marks), table (a ranked list, up to 12 rows), checks (pass or fail per check, up to 12), changes (a value that moved from one thing to another). For a time series send raw samples as points and the deploy, alert or rollback times as events: the tool puts them on an even grid of at most 500 points and works out the mark positions. It has no data of its own and never invents a value, so send only numbers from a tool result you can cite. placement step_figure is for a causal step (stats, compare or trend, one per step). placement timeline_block is for a timeline event (any type). Read resource://tellagen/figure-guide to choose the widget and to see how to plot data on it.",
      inputSchema: {
        placement: z
          .enum(["step_figure", "timeline_block"])
          .describe("step_figure for result_summary.causal_paths[].steps[].figure. timeline_block for the blocks of a timeline event."),
        figure: figureInputSchema,
        slot: z.literal("summary").optional().describe("timeline_block only: draw the block above the note. Not together with anchor."),
        anchor: z.string().max(80).optional().describe("timeline_block only: the exact heading text in the note that the block sits under. Not together with slot."),
        postmortem: z.boolean().optional().describe("timeline_block only: false keeps the block out of the postmortem."),
      },
    },
    async (input) => {
      const result = buildFigure(input);
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
