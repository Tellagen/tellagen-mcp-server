import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../src/client.js";
import { buildFigure, validateBlock } from "../src/figures.js";
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

  it("keeps step figures to stats, compare and trend", () => {
    const result = buildFigure({ placement: "step_figure", figure: table });
    expect(issues(result)).toContain("timeline block");
    expect(buildFigure({ placement: "step_figure", figure: { type: "stats", items: [{ label: "a", value: "1" }] } }).ok).toBe(true);
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

  it("refuses a planned widget and points at what to send", () => {
    const result = buildFigure({ placement: "step_figure", figure: { type: "histogram", edges: [1, 2], before: [1], after: [2] } });
    expect(issues(result)).toContain("does not accept it yet");
    expect(issues(result)).toContain("compare");
  });

  it.each(["range_overlap", "histogram", "run_history", "diff"])("names %s as designed but not accepted yet", (type) => {
    expect(issues(buildFigure({ placement: "step_figure", figure: { type } }))).toContain(`"${type}" is designed but Tellagen does not accept it yet`);
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
    for (const type of ["stats", "compare", "trend", "table", "checks", "changes"]) expect(body).toContain(type);
    expect(body).toContain("Designed but not accepted yet");
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
        figure: { type: "checks", items: [{ label: "E2E Tests", state: "fail" }] },
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
