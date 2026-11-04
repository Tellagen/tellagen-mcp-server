import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../src/client.js";
import { buildFigure, MAX_STEP_FIGURE_BYTES, validateBlock } from "../src/figures.js";
import { FIGURE_GUIDE } from "../src/tools/figures.js";
import { createServer } from "../src/server.js";
import { registerTimelineTools } from "../src/tools/timeline.js";

const T0 = Date.parse("2026-11-02T14:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const samples = (n: number, value: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({ t: at(i), v: value(i) }));

const trend = (figure: Record<string, unknown>) =>
  buildFigure({ placement: "step_figure", figure: { type: "trend", ...figure } });

const okBlock = (result: ReturnType<typeof buildFigure>) => {
  if (!result.ok) throw new Error(`expected ok, got ${result.issues.join("; ")}`);
  return result.block;
};
const issues = (result: ReturnType<typeof buildFigure>) => {
  if (result.ok) throw new Error("expected issues");
  return result.issues.join("; ");
};

describe("trend from raw samples", () => {
  it("puts samples on an even grid and sets start and step_seconds", () => {
    const block = okBlock(trend({ points: samples(121, (i) => i / 10), unit: "%" }));
    expect(block.series).toHaveLength(121);
    expect(block.start).toBe("2026-11-02T14:00:00Z");
    expect(block.step_seconds).toBe(60);
    expect(block.unit).toBe("%");
    expect(block).not.toHaveProperty("points");
    expect(block).not.toHaveProperty("events");
  });

  it("never exceeds max_points and keeps a spike with reduce max", () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({ t: T0 / 1000 + i * 7.2, v: i === 500 ? 9 : 1 }));
    const withMax = okBlock(trend({ points, max_points: 100, reduce: "max" }));
    const withMean = okBlock(trend({ points, max_points: 100, reduce: "mean" }));
    expect((withMax.series as number[]).length).toBeLessThanOrEqual(100);
    expect(Math.max(...(withMax.series as number[]))).toBe(9);
    expect(Math.max(...(withMean.series as number[]))).toBeLessThan(9);
  });

  it("turns event times into marks by index, in order", () => {
    const block = okBlock(
      trend({
        points: samples(121, () => 1),
        events: [
          { at: at(88), label: "Rollback" },
          { at: at(42), label: "Deploy" },
        ],
      }),
    );
    expect(block.marks).toEqual([
      { i: 42, label: "Deploy" },
      { i: 88, label: "Rollback" },
    ]);
  });

  it("says when an event falls outside the range and leaves it out", () => {
    const result = trend({
      points: samples(30, () => 1),
      events: [
        { at: at(10), label: "Deploy" },
        { at: at(500), label: "Later" },
      ],
    });
    const block = okBlock(result);
    expect(block.marks).toEqual([{ i: 10, label: "Deploy" }]);
    expect(result.ok && result.notes.join(" ")).toContain('"Later" falls outside the range');
  });

  it("rejects more than three marks instead of choosing for the agent", () => {
    const events = [5, 10, 15, 20].map((m) => ({ at: at(m), label: `e${m}` }));
    expect(issues(trend({ points: samples(30, () => 1), events }))).toContain("at most three marks");
  });

  it("accepts ISO, epoch seconds, epoch milliseconds and numeric strings, and skips null and NaN", () => {
    const seconds = T0 / 1000;
    const result = trend({
      points: [
        { t: at(0), v: 1 },
        { t: seconds + 60, v: "2" },
        { t: String(seconds + 120), v: "3.5" },
        { t: T0 + 180_000, v: 4 },
        { t: seconds + 240, v: null },
        { t: seconds + 300, v: "NaN" },
      ],
    });
    const block = okBlock(result);
    expect(block.series).toEqual([1, 2, 3.5, 4]);
    expect(result.ok && result.notes.join(" ")).toContain("2 samples had no usable time or value");
  });

  it("fills empty steps with a straight line and says so", () => {
    const points = [0, 1, 2, 5, 6].map((m) => ({ t: at(m), v: m }));
    const result = trend({ points });
    const block = okBlock(result);
    expect(block.series).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.ok && result.notes.join(" ")).toContain("2 empty steps were filled");
  });

  it("rounds to the asked precision", () => {
    const block = okBlock(trend({ points: samples(5, (i) => 1.23456789 + i), precision: 3 }));
    expect(block.series).toEqual([1.23, 2.23, 3.23, 4.23, 5.23]);
  });

  it("rejects an impossible input with the field named", () => {
    expect(issues(trend({ points: samples(3, () => 1), series: [1, 2] }))).toContain("not both");
    expect(issues(trend({}))).toContain("points");
    expect(issues(trend({ points: [{ t: at(0), v: 1 }, { t: at(0), v: 2 }] }))).toContain("share one time");
    expect(issues(trend({ points: [{ t: "not a time", v: 1 }, { t: at(1), v: 2 }] }))).toContain("at least two samples");
  });
});

describe("trend from an even grid", () => {
  it("passes series, start, step_seconds and marks through", () => {
    const block = okBlock(
      trend({ series: [1, 2, 3, 4], start: "2026-11-02T14:00:00Z", step_seconds: 60, marks: [{ i: 2, label: "Deploy" }] }),
    );
    expect(block).toMatchObject({ series: [1, 2, 3, 4], step_seconds: 60, marks: [{ i: 2, label: "Deploy" }] });
  });

  it("needs start and step_seconds together and marks inside the series", () => {
    expect(issues(trend({ series: [1, 2, 3], start: "2026-11-02T14:00:00Z" }))).toContain("together");
    expect(issues(trend({ series: [1, 2, 3], marks: [{ i: 3, label: "late" }] }))).toContain("past the end");
    expect(issues(trend({ series: [1, 2, 3], events: [{ at: at(1), label: "x" }] }))).toContain("need points");
  });
});

describe("compare, stats, table, checks and changes", () => {
  const compare = {
    type: "compare",
    unit: "ms",
    better: "lower",
    threshold: { value: 500, label: "SLO 500 ms" },
    rows: [{ label: "POST /checkout", before: 180, after: 640 }],
  };

  it("builds a compare as it was given", () => {
    const block = okBlock(buildFigure({ placement: "step_figure", figure: compare }));
    expect(block).toEqual(compare);
  });

  it("rejects nine rows, a string number and an unknown field, naming each", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ label: `r${i}`, before: 1, after: 2 }));
    expect(issues(buildFigure({ placement: "step_figure", figure: { ...compare, rows } }))).toContain("rows");
    expect(issues(buildFigure({ placement: "step_figure", figure: { ...compare, rows: [{ label: "r", before: "1", after: 2 }] } }))).toContain("rows.0.before");
    expect(issues(buildFigure({ placement: "step_figure", figure: { ...compare, color: "red" } }))).toContain("color");
  });

  it("limits stats to four items and known tones", () => {
    const item = { label: "a", value: "1" };
    expect(issues(buildFigure({ placement: "step_figure", figure: { type: "stats", items: Array(5).fill(item) } }))).toContain("items");
    expect(issues(buildFigure({ placement: "step_figure", figure: { type: "stats", items: [{ ...item, tone: "loud" }] } }))).toContain("items.0.tone");
  });

  it("writes table numbers as text and wants one cell per column", () => {
    const table = { type: "table", columns: [{ label: "Route" }, { label: "Errors" }], rows: [{ cells: ["POST /pay", 38] }] };
    const block = okBlock(buildFigure({ placement: "timeline_block", figure: table }));
    expect(block.rows).toEqual([{ cells: ["POST /pay", "38"] }]);
    const bad = { ...table, rows: [{ cells: ["POST /pay", 38] }, { cells: ["GET /cart"] }] };
    expect(issues(buildFigure({ placement: "timeline_block", figure: bad }))).toContain("rows.1.cells");
  });

  it("limits checks to twelve items and wants from or to in changes", () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ label: `job ${i}`, state: "pass" }));
    expect(issues(buildFigure({ placement: "timeline_block", figure: { type: "checks", items } }))).toContain("items");
    expect(
      issues(buildFigure({ placement: "timeline_block", figure: { type: "changes", rows: [{ label: "Pool size" }] } })),
    ).toContain("rows.0: send from, to, or both");
  });
});

describe("placement", () => {
  const table = { type: "table", columns: [{ label: "A" }], rows: [{ cells: ["x"] }] };

  it("keeps table and changes off a step and allows checks there", () => {
    const result = buildFigure({ placement: "step_figure", figure: table });
    expect(issues(result)).toContain("timeline block");
    expect(buildFigure({ placement: "step_figure", figure: { type: "stats", items: [{ label: "a", value: "1" }] } }).ok).toBe(true);
    expect(buildFigure({ placement: "step_figure", figure: { type: "checks", items: [{ label: "E2E Tests", state: "fail" }] } }).ok).toBe(true);
  });

  it("gives a step figure no timeline placement", () => {
    const stats = { type: "stats", items: [{ label: "a", value: "1" }] };
    expect(issues(buildFigure({ placement: "step_figure", figure: stats, slot: "summary" }))).toContain("no placement");
  });

  it("adds slot and postmortem to a timeline block, and refuses slot with anchor", () => {
    const block = okBlock(buildFigure({ placement: "timeline_block", figure: table, slot: "summary", postmortem: false }));
    expect(block).toMatchObject({ slot: "summary", postmortem: false });
    expect(issues(buildFigure({ placement: "timeline_block", figure: table, slot: "summary", anchor: "Verified outcome" }))).toContain("slot or anchor, not both");
  });

  it("rejects a histogram with too few edges, naming the field", () => {
    const result = buildFigure({ placement: "step_figure", figure: { type: "histogram", edges: [1, 2], before: [1], after: [2] } });
    expect(issues(result)).toContain("edges");
  });

  it.each(["range_overlap", "histogram", "run_history", "diff"])("takes %s as a step figure now", (type) => {
    const result = buildFigure({ placement: "step_figure", figure: { type } });
    expect(issues(result)).not.toContain("does not accept it yet");
    expect(issues(result)).not.toContain("timeline block");
  });

  it("checks a finished block the way the API does", () => {
    expect(validateBlock({ type: "trend", series: [1, 2], start: "2026-11-02T14:00:00Z" })).toEqual([
      "start: send start and step_seconds together, or neither",
    ]);
    expect(validateBlock({ type: "heatmap", cells: [[1]] })[0]).toContain("type");
  });
});

describe("through the MCP server", () => {
  async function connect() {
    const server = createServer(new TellagenClient({ apiUrl: "https://test.api.tellagen.com", apiKey: "tllg_test" }));
    const client = new Client({ name: "test", version: "0.0.1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it("tells every agent that figures exist and where to read more", async () => {
    const client = await connect();
    const text = client.getInstructions() ?? "";
    expect(text).toContain("tellagen_build_figure");
    expect(text).toContain("resource://tellagen/figure-guide");
    expect(text).toContain("Tellagen MCP server");
  });

  it("serves the guide as a resource", async () => {
    const client = await connect();
    const list = await client.listResources();
    expect(list.resources.map((r) => r.uri)).toContain("resource://tellagen/figure-guide");
    const guide = await client.readResource({ uri: "resource://tellagen/figure-guide" });
    const body = String(guide.contents[0]?.text);
    for (const type of ["stats", "compare", "trend", "table", "checks", "changes", "range_overlap", "histogram", "run_history", "diff"]) {
      expect(body).toContain(`### ${type}`);
    }
    expect(body).not.toContain("Designed but not accepted yet");
  });

  it("lists the tool with a readable schema and builds a figure", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "tellagen_build_figure");
    expect(tool?.description).toContain("compare");
    expect(JSON.stringify(tool?.inputSchema)).toContain("reduce");

    const result = await client.callTool({
      name: "tellagen_build_figure",
      arguments: {
        placement: "step_figure",
        figure: {
          type: "trend",
          title: "5xx share of requests",
          unit: "%",
          points: samples(121, (i) => (i > 42 && i < 88 ? 3 : 0.2)),
          events: [{ at: at(42), label: "Deploy" }],
          threshold: { value: 1, label: "SLO 1%" },
        },
      },
    });
    const out = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(result.isError).toBeFalsy();
    expect(out.ok).toBe(true);
    expect(out.block).toMatchObject({ type: "trend", step_seconds: 60, marks: [{ i: 42, label: "Deploy" }] });
  });

  it("answers a bad figure with the fields to fix", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "tellagen_build_figure",
      arguments: {
        placement: "step_figure",
        figure: { type: "changes", rows: [{ label: "pool size", from: "20", to: "40" }] },
      },
    });
    const out = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(result.isError).toBe(true);
    expect(out.issues.join(" ")).toContain("timeline block");
    expect(out.next).toContain("Fix exactly these fields");
  });
});

describe("timeline tools carry blocks", () => {
  function harness() {
    const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const client = {
      post: vi.fn(async (path: string, body: Record<string, unknown>) => {
        calls.push({ method: "POST", path, body });
        return { id: 1 };
      }),
      patch: vi.fn(async (path: string, body: Record<string, unknown>) => {
        calls.push({ method: "PATCH", path, body });
        return { id: 1 };
      }),
    } as unknown as TellagenClient;
    const tools = new Map<string, { config: { inputSchema: Record<string, z.ZodTypeAny> }; handler: (i: Record<string, unknown>) => Promise<unknown> }>();
    const server = {
      registerTool: (name: string, config: never, handler: never) => tools.set(name, { config, handler }),
    } as unknown as McpServer;
    registerTimelineTools(server, client);
    return { calls, tools };
  }

  const block = { type: "compare", unit: "ms", rows: [{ label: "POST /checkout", before: 180, after: 640 }], slot: "summary" };

  it("sends blocks on create and update", async () => {
    const { calls, tools } = harness();
    await tools.get("tellagen_post_timeline_event")!.handler({ incident_id: 7, title: "p95 moved", blocks: [block] });
    await tools.get("tellagen_update_timeline_event")!.handler({ timeline_event_id: 9, blocks: [] });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/incidents/7/timeline", body: { blocks: [block] } });
    expect(calls[1]).toMatchObject({ method: "PATCH", path: "/api/v1/timeline/9", body: { blocks: [] } });
  });

  it("accepts a valid block in the tool schema and rejects an unknown type or more than twelve", () => {
    const { tools } = harness();
    const schema = z.object(tools.get("tellagen_post_timeline_event")!.config.inputSchema);
    const base = { incident_id: 7, title: "t" };
    expect(schema.safeParse({ ...base, blocks: [block] }).success).toBe(true);
    expect(schema.safeParse({ ...base, blocks: [{ type: "heatmap", cells: [[1]] }] }).success).toBe(false);
    expect(schema.safeParse({ ...base, blocks: Array(13).fill(block) }).success).toBe(false);
  });
});

describe("range_overlap", () => {
  const rows = [
    { label: "Tab bar", from: 105, to: 153 },
    { label: "Impact table", from: 149, to: 385 },
  ];

  it("builds as given and reports the overlap without sending it", () => {
    const result = buildFigure({ placement: "step_figure", figure: { type: "range_overlap", unit: "px", min: 0, max: 393, rows } });
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(result.block).toEqual({ type: "range_overlap", unit: "px", min: 0, max: 393, rows });
    expect(result.summary).toContain("overlap from 149 to 153 px");
    expect(result.block).not.toHaveProperty("overlap");
  });

  it("names every broken rule", () => {
    const build = (extra: Record<string, unknown>) =>
      issues(buildFigure({ placement: "timeline_block", figure: { type: "range_overlap", rows, ...extra } }));
    expect(build({ rows: [{ label: "a", from: 5, to: 1 }, rows[1]] })).toContain("rows.0.to: must not be below from");
    expect(build({ min: 0 })).toContain("max: is required when min is set");
    expect(build({ min: 10, max: 10 })).toContain("max: must be greater than min");
    expect(build({ min: 0, max: 200 })).toContain("rows.1.to: must be within min and max (0 to 200)");
    expect(build({ window: [160, 140] })).toContain("window: must have from below to");
    expect(build({ rows: [rows[0]] })).toContain("rows");
    expect(build({ rows: Array(5).fill(rows[0]) })).toContain("rows");
    expect(build({ rows: [{ label: "x".repeat(81), from: 1, to: 2 }, rows[1]] })).toContain("rows.0.label: at most 80 characters (got 81)");
    expect(build({ rows: [{ label: "a‮b", from: 1, to: 2 }, rows[1]] })).toContain("rows.0.label");
  });
});

describe("histogram", () => {
  const buckets = [
    { le: "0.1", before: "820", after: "610" },
    { le: "0.5", before: "990", after: "800" },
    { le: "1", before: "1000", after: "940" },
    { le: "+Inf", before: "1000", after: "940" },
  ];

  it("turns cumulative le buckets into edges and one count per bucket", () => {
    const result = buildFigure({
      placement: "step_figure",
      figure: { type: "histogram", unit: "s", buckets, threshold: { value: 0.5, label: "SLO 500 ms" } },
    });
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(result.block).toEqual({
      type: "histogram",
      unit: "s",
      edges: [0, 0.1, 0.5, 1],
      before: [820, 170, 10],
      after: [610, 190, 140],
      threshold: { value: 0.5, label: "SLO 500 ms" },
    });
    expect(result.notes.join(" ")).toContain("starts at 0");
    expect(result.summary).toBe("histogram of 3 buckets, 1000 observations before and 940 after");
  });

  it("sorts buckets, takes numbers and a lower edge", () => {
    const block = okBlock(
      buildFigure({
        placement: "timeline_block",
        figure: {
          type: "histogram",
          lower_edge: 0.05,
          buckets: [
            { le: 0.5, before: 9, after: 5 },
            { le: 0.1, before: 4, after: 1 },
          ],
        },
      }),
    );
    expect(block).toMatchObject({ edges: [0.05, 0.1, 0.5], before: [4, 5], after: [1, 4] });
  });

  it("refuses observations above the last finite le unless told to drop them", () => {
    const open = [...buckets.slice(0, 3), { le: "+Inf", before: "1004", after: "940" }];
    const refused = issues(buildFigure({ placement: "step_figure", figure: { type: "histogram", buckets: open } }));
    expect(refused).toContain("4 before observations are above the last finite le (1)");
    expect(refused).toContain("overflow");
    const dropped = buildFigure({ placement: "step_figure", figure: { type: "histogram", buckets: open, overflow: "drop" } });
    if (!dropped.ok) throw new Error(dropped.issues.join("; "));
    expect(dropped.block).toMatchObject({ before: [820, 170, 10] });
    expect(dropped.notes.join(" ")).toContain("4 before observations above 1 (the +Inf bucket) were left out");
  });

  it("names a bucket whose cumulative count goes down, a repeated le and a bad lower edge", () => {
    const down = [{ le: 1, before: 10, after: 5 }, { le: 2, before: 7, after: 6 }];
    expect(issues(buildFigure({ placement: "step_figure", figure: { type: "histogram", buckets: down } }))).toContain(
      "buckets.1.before: cumulative counts must not go down as le grows (7 after 10)",
    );
    const twice = [{ le: 1, before: 1, after: 1 }, { le: "1", before: 2, after: 2 }, { le: 2, before: 3, after: 3 }];
    expect(issues(buildFigure({ placement: "step_figure", figure: { type: "histogram", buckets: twice } }))).toContain("is sent twice");
    expect(
      issues(buildFigure({ placement: "step_figure", figure: { type: "histogram", lower_edge: 1, buckets: buckets.slice(0, 3) } })),
    ).toContain("lower_edge: 1 must be below the first le (0.1)");
    expect(
      issues(buildFigure({ placement: "step_figure", figure: { type: "histogram", buckets: [{ le: "x", before: 1, after: 1 }, buckets[1]] } })),
    ).toContain("buckets.0.le: must be a number or +Inf");
  });

  it("checks per-bucket counts the way the API does", () => {
    const build = (figure: Record<string, unknown>) => buildFigure({ placement: "timeline_block", figure: { type: "histogram", ...figure } });
    expect(okBlock(build({ edges: [10, 100, 1000], before: [5, 1], after: [2, 8] }))).toMatchObject({ edges: [10, 100, 1000] });
    expect(issues(build({ edges: [10, 100, 1000], before: [5], after: [2, 8] }))).toContain("before: needs exactly 2 counts (got 1)");
    expect(issues(build({ edges: [10, 10, 1000], before: [5, 1], after: [2, 8] }))).toContain("edges.1: must be greater than the edge before it");
    expect(issues(build({ edges: [-1, 10, 1000], before: [5, 1], after: [2, 8] }))).toContain("edges.0: must not be negative");
    expect(issues(build({ edges: [10, 100, 1000], before: [0, 0], after: [2, -8] }))).toContain("before: must add up to more than 0");
    expect(issues(build({ edges: [10, 100, 1000], before: [0, 0], after: [2, -8] }))).toContain("after.1: must not be negative");
    expect(issues(build({ edges: Array.from({ length: 62 }, (_, i) => i), before: [], after: [] }))).toContain("edges");
    expect(issues(build({ edges: [10, 100, 1000], before: [5, 1], after: [2, 8], buckets }))).toContain("not both");
    expect(issues(build({ edges: [10, 100, 1000], before: [5, 1] }))).toContain("edges: send edges with before and after");
  });

  it("refuses example data: a figure is built from a tool result", () => {
    expect(
      issues(buildFigure({ placement: "timeline_block", figure: { type: "histogram", example: true, edges: [1, 2, 3], before: [1, 1], after: [1, 1] } })),
    ).toContain("example");
  });
});

describe("run_history", () => {
  // As the GitHub Actions REST list returns them: newest first.
  const restRuns = [
    { id: 903, run_number: 4152, head_sha: "c0ffee1", conclusion: "success", status: "completed", created_at: "2026-10-30T10:00:00Z", event: "push", html_url: "https://github.com/acme/shop/actions/runs/903", url: "https://api.github.com/repos/acme/shop/actions/runs/903", name: "E2E" },
    { id: 902, run_number: 4151, head_sha: "4b7a2d1", conclusion: "timed_out", status: "completed", created_at: "2026-10-30T09:00:00Z", event: "push", html_url: "https://github.com/acme/shop/actions/runs/902", job: "E2E Tests" },
    { id: 901, run_number: 4150, head_sha: "9f2c1e0", conclusion: "success", status: "completed", created_at: "2026-10-30T08:00:00Z", event: "schedule", html_url: "https://github.com/acme/shop/actions/runs/901" },
  ];

  it("maps the GitHub Actions list to runs oldest first and places marks by sha", () => {
    const result = buildFigure({
      placement: "step_figure",
      figure: {
        type: "run_history",
        repo: "acme/shop",
        branch: "master",
        github_runs: restRuns,
        marks: [
          { sha: "4b7a2d1", change_ref: "regression_source", title: "Sticky header" },
          { sha: "c0ffee1", change_ref: "fix" },
        ],
      },
    });
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(result.block).toEqual({
      type: "run_history",
      repo: "acme/shop",
      branch: "master",
      runs: [
        { ref: "#4150", result: "success", sha: "9f2c1e0", at: "2026-10-30T08:00:00Z", trigger: "schedule", url: "https://github.com/acme/shop/actions/runs/901" },
        { ref: "#4151", result: "failure", sha: "4b7a2d1", at: "2026-10-30T09:00:00Z", trigger: "push", job: "E2E Tests", url: "https://github.com/acme/shop/actions/runs/902" },
        { ref: "#4152", result: "success", sha: "c0ffee1", at: "2026-10-30T10:00:00Z", trigger: "push", url: "https://github.com/acme/shop/actions/runs/903" },
      ],
      marks: [
        { between: ["#4150", "#4151"], change_ref: "regression", sha: "4b7a2d1", title: "Sticky header" },
        { between: ["#4151", "#4152"], change_ref: "fix", sha: "c0ffee1" },
      ],
    });
    const notes = result.notes.join(" ");
    expect(notes).toContain("#4151 timed_out is drawn as failure");
    expect(notes).toContain("oldest first");
    expect(notes).toContain("regression_source is drawn as regression");
    expect(result.summary).toBe("run_history of 3 runs (2 passed, 1 failed, 0 cancelled, 0 pending) with 2 marks");
  });

  it("reads gh run list --json, keeps a running run as pending and never links the API address", () => {
    const block = okBlock(
      buildFigure({
        placement: "timeline_block",
        figure: {
          type: "run_history",
          github_runs: [
            { databaseId: 11, number: 7, headSha: "aaaaaaa", conclusion: "", status: "in_progress", startedAt: "2026-10-30T09:00:00Z", url: "https://api.github.com/repos/a/b/actions/runs/11" },
            { databaseId: 10, number: 6, headSha: "bbbbbbb", conclusion: "cancelled", status: "completed", startedAt: "2026-10-30T08:00:00Z", url: "https://github.com/a/b/actions/runs/10" },
          ],
        },
      }),
    );
    expect(block.runs).toEqual([
      { ref: "#6", result: "cancelled", sha: "bbbbbbb", at: "2026-10-30T08:00:00Z", url: "https://github.com/a/b/actions/runs/10" },
      { ref: "#7", result: "pending", sha: "aaaaaaa", at: "2026-10-30T09:00:00Z" },
    ]);
  });

  it("refuses a conclusion with no result instead of guessing", () => {
    const skipped = [restRuns[0], { ...restRuns[1], conclusion: "skipped" }];
    expect(issues(buildFigure({ placement: "step_figure", figure: { type: "run_history", github_runs: skipped } }))).toContain(
      'github_runs.1.conclusion: "skipped" has no run_history result',
    );
  });

  it("names a mark it cannot place and the rules the API checks", () => {
    const runs = [
      { ref: "1", result: "success", sha: "aaaaaaa" },
      { ref: "2", result: "failure", sha: "bbbbbbb" },
      { ref: "3", result: "failure" },
    ];
    const build = (extra: Record<string, unknown>) =>
      buildFigure({ placement: "timeline_block", figure: { type: "run_history", runs, ...extra } });
    expect(issues(build({ marks: [{ sha: "ccccccc", change_ref: "fix" }] }))).toContain("marks.0.sha: no run is built from ccccccc");
    expect(issues(build({ marks: [{ sha: "aaaaaaa", change_ref: "regression" }] }))).toContain("there is no run before it");
    expect(issues(build({ marks: [{ change_ref: "fix" }] }))).toContain("marks.0: send between");
    expect(issues(build({ marks: [{ between: ["1", "3"], change_ref: "regression" }] }))).toContain(
      "marks.0.between: must name two neighbouring runs, the second right after the first",
    );
    expect(issues(build({ marks: [{ between: ["1", "9"], change_ref: "regression" }] }))).toContain("marks.0.between.1: is not the ref of a run of this block");
    expect(issues(build({ span: { from: "3", to: "1", label: "E2E failed" } }))).toContain("span.to: must not be a run before from");
    expect(issues(build({ runs: [...runs, { ref: "2", result: "success" }] }))).toContain("runs.3.ref: is already used by another run of this block");
    expect(issues(build({ runs: [{ ...runs[0], url: "http://ci.example/1" }, runs[1]] }))).toContain("runs.0.url: must be an https:// link without spaces");
    expect(issues(build({ runs: [{ ...runs[0], result: "skipped" }, runs[1]] }))).toContain("runs.0.result");
    expect(issues(build({ repo: "acme" }))).toContain("repo: must look like owner/name");
    expect(issues(build({ runs: Array.from({ length: 31 }, (_, i) => ({ ref: String(i), result: "success" })) }))).toContain("runs");
    expect(issues(build({ marks: Array(5).fill({ between: ["1", "2"], change_ref: "fix" }) }))).toContain("marks");
    expect(issues(build({ github_runs: restRuns }))).toContain("not both");
  });

  it("keeps a step figure under 16 KB and says so when it is not", () => {
    const runs = Array.from({ length: 30 }, (_, i) => ({
      ref: `run-${i}`,
      result: "success",
      job: "j".repeat(80),
      url: `https://ci.example/${"x".repeat(470)}/${i}`,
    }));
    const step = buildFigure({ placement: "step_figure", figure: { type: "run_history", runs } });
    expect(issues(step)).toContain(`a step figure holds at most ${MAX_STEP_FIGURE_BYTES}`);
    expect(buildFigure({ placement: "timeline_block", figure: { type: "run_history", runs } }).ok).toBe(true);
  });
});

describe("diff", () => {
  const base = { type: "diff", path: "web/Header.tsx", repo: "acme/shop", ref: "4b7a2d1", additions: 14, deletions: 3 };
  const patch = [
    "diff --git a/web/Header.tsx b/web/Header.tsx",
    "--- a/web/Header.tsx",
    "+++ b/web/Header.tsx",
    "@@ -10,3 +10,3 @@ export function Header() {",
    " const header = {",
    "-  position: static;",
    "+  position: sticky;",
    "+\ttop: 0;",
    "@@ -40,2 +40,2 @@",
    "   unchanged();",
    "@@ -60,2 +60,2 @@",
    "-const bottom = 1",
    "\\ No newline at end of file",
  ].join("\n");

  it("keeps the + and - lines of a patch, one hunk per @@, indentation and tabs kept", () => {
    const result = buildFigure({ placement: "step_figure", figure: { ...base, patch } });
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(result.block).toEqual({
      ...base,
      hunks: [
        [
          { op: "-", text: "  position: static;" },
          { op: "+", text: "  position: sticky;" },
          { op: "+", text: "\ttop: 0;" },
        ],
        [{ op: "-", text: "const bottom = 1" }],
      ],
    });
    expect(result.notes.join(" ")).toContain("1 hunks with no + or - line were left out");
    expect(result.summary).toBe("diff of web/Header.tsx at 4b7a2d1: +14 -3 in the whole change, 4 lines shown");
  });

  it("refuses a long patch instead of choosing lines, and never counts the change size itself", () => {
    const long = ["@@ -1 +1 @@", ...Array.from({ length: 13 }, (_, i) => `+line ${i}`)].join("\n");
    expect(issues(buildFigure({ placement: "step_figure", figure: { ...base, patch: long } }))).toContain(
      "patch: 13 changed lines in 1 hunks",
    );
    const { additions: _a, ...noCount } = base;
    expect(issues(buildFigure({ placement: "step_figure", figure: { ...noCount, patch } }))).toContain("additions");
    expect(issues(buildFigure({ placement: "step_figure", figure: { ...base, patch: "+x" } }))).toContain("no hunk found");
    const twoFiles = `diff --git a/x b/x\n@@ -1 +1 @@\n+a\ndiff --git a/y b/y\n@@ -1 +1 @@\n+b`;
    expect(issues(buildFigure({ placement: "step_figure", figure: { ...base, patch: twoFiles } }))).toContain(
      "patch: holds more than one file. Send the patch of web/Header.tsx only.",
    );
  });

  it("checks hunks the way the API does", () => {
    const line = (text: string) => ({ op: "+", text });
    const build = (hunks: unknown) => buildFigure({ placement: "timeline_block", figure: { ...base, hunks } });
    expect(okBlock(build([[line("    indented  ")]]))).toMatchObject({ hunks: [[{ op: "+", text: "    indented  " }]] });
    expect(okBlock(build([[line("")]]))).toMatchObject({ hunks: [[{ op: "+", text: "" }]] });
    expect(issues(build([Array.from({ length: 13 }, (_, i) => line(String(i)))]))).toContain("hunks: at most 12 lines in all (got 13)");
    expect(issues(build([[line("x".repeat(161))]]))).toContain("hunks.0.0.text: at most 160 characters (got 161)");
    expect(issues(build([[line("a\u0007b")]]))).toContain("hunks.0.0.text: must not contain control characters other than tabs");
    expect(issues(build([[{ op: "~", text: "x" }]]))).toContain("hunks.0.0.op");
    expect(issues(build([[]]))).toContain("hunks.0");
    expect(issues(build(Array(7).fill([line("x")])))).toContain("hunks");
    expect(issues(buildFigure({ placement: "timeline_block", figure: { ...base, path: " ", hunks: [[line("x")]] } }))).toContain("path: is required");
    expect(issues(buildFigure({ placement: "timeline_block", figure: { ...base, additions: 1.5, hunks: [[line("x")]] } }))).toContain("additions");
  });
});

describe("the guide's examples", () => {
  // Every indented JSON example in the guide is a figure the builder accepts.
  const examples = FIGURE_GUIDE.split(/\n\s*\n/)
    .map((paragraph) => paragraph.split("\n"))
    .filter((lines) => lines.every((l) => l.startsWith("    ")) && lines[0]!.trim().startsWith('{ "type"'))
    .map((lines) => JSON.parse(lines.join("\n")) as { type: string });

  it("has one for every new type", () => {
    const types = examples.map((example) => example.type);
    for (const type of ["range_overlap", "histogram", "run_history", "diff"]) expect(types).toContain(type);
  });

  it.each(examples.map((example) => [example.type, example] as const))("builds the %s example", (_type, example) => {
    const result = buildFigure({ placement: "timeline_block", figure: example });
    expect(result.ok, result.ok ? "" : result.issues.join("; ")).toBe(true);
  });
});

describe("the four newer types in the tool listing", () => {
  it("lists them by type only and still names every bad field when the tool runs", async () => {
    const server = createServer(new TellagenClient({ apiUrl: "https://test.api.tellagen.com", apiKey: "tllg_test" }));
    const client = new Client({ name: "test", version: "0.0.1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = await client.listTools();
    const listed = JSON.stringify(tools.tools.find((t) => t.name === "tellagen_build_figure")?.inputSchema);
    expect(listed).toContain("range_overlap");
    expect(listed).not.toContain("hunks");
    const complete = JSON.stringify(tools.tools.find((t) => t.name === "tellagen_complete_investigation")?.inputSchema);
    expect(complete).toContain("run_history");
    expect(complete).not.toContain("github_runs");

    const result = await client.callTool({
      name: "tellagen_build_figure",
      arguments: { placement: "step_figure", figure: { type: "histogram", edges: [10, 100, 1000], before: [5], after: [2, 8] } },
    });
    const out = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(result.isError).toBe(true);
    expect(out.issues).toContain("before: needs exactly 2 counts (got 1)");
  });
});
