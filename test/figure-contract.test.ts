import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stepFigureSchema } from "../src/diagnosis-structure.js";
import { STEP_FIGURE_TYPES, validateBlock } from "../src/figures.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "contracts", "runbooks", "v2", "fixtures");

type Block = { type: string } & Record<string, unknown>;
const accepted = JSON.parse(
  readFileSync(join(fixtures, "timeline-event-with-blocks.json"), "utf8"),
) as { blocks: Block[] };
const rejected = JSON.parse(
  readFileSync(join(fixtures, "timeline-event-blocks-rejected.json"), "utf8"),
) as { cases: Array<{ name: string; blocks: Block[]; field: string; message: string }> };

/**
 * The Tellagen API's own accepted blocks of the four newer figure types,
 * copied as they are.
 */
const golden = ["range-overlap", "histogram", "run-history", "diff"].map((name) => {
  const [block] = JSON.parse(
    readFileSync(join(here, "fixtures", "figure-blocks", `${name}.json`), "utf8"),
  ) as Block[];
  // The MCP never sends example data (a figure is built from a tool result),
  // so the golden histogram's example flag is left out here.
  const { example: _example, ...rest } = block!;
  return { name, block: rest as Block };
});

const FIGURE_TYPES = new Set<string>(STEP_FIGURE_TYPES);
const NOT_FIGURES = ["table", "changes"];

/** blocks[0].rows[1].to -> rows.1.to */
const localPath = (field: string) =>
  field.replace(/^blocks\[\d+\]\.?/, "").replace(/\[(\d+)\]/g, ".$1");

describe("step figure against the vendored timeline block contract", () => {
  it("accepts every block of the accepted fixture (all of them are figure types)", () => {
    const figures = accepted.blocks.filter((block) => FIGURE_TYPES.has(block.type));
    expect(figures.length).toBe(accepted.blocks.length);
    for (const block of figures) {
      const result = stepFigureSchema.safeParse(block);
      expect(result.success, JSON.stringify(result.success ? "" : result.error.issues)).toBe(true);
    }
  });

  it("refuses table and changes: they are timeline blocks, not figures", () => {
    const table = { type: "table", columns: [{ label: "Route" }], rows: [{ cells: ["/checkout"] }] };
    const changes = { type: "changes", rows: [{ label: "pool size", from: "20", to: "40" }] };
    for (const block of [table, changes]) {
      expect(stepFigureSchema.safeParse(block).success, block.type).toBe(false);
    }
    expect(NOT_FIGURES.some((type) => FIGURE_TYPES.has(type))).toBe(false);
  });

  it("refuses every rejected fixture case that concerns a figure type", () => {
    const concerned = rejected.cases.filter((entry) =>
      entry.blocks.every((block) => !NOT_FIGURES.includes(block.type)),
    );
    // heatmap, number as text, five stats, mark outside the series, start
    // without step_seconds, colour tone, slot with anchor, unknown checks
    // field, and one case for each of the four newer figure types.
    expect(concerned.length).toBeGreaterThanOrEqual(12);
    for (const entry of concerned) {
      for (const block of entry.blocks) {
        expect(stepFigureSchema.safeParse(block).success, entry.name).toBe(false);
      }
    }
  });

  it.each(golden)("accepts the backend's $name block as a step figure and a timeline block", ({ block }) => {
    const result = stepFigureSchema.safeParse(block);
    expect(result.success, JSON.stringify(result.success ? "" : result.error.issues)).toBe(true);
    expect(validateBlock(block)).toEqual([]);
  });

  it("names the same field with the same message as the API for the four new types", () => {
    const cases = rejected.cases.filter((entry) =>
      ["range_overlap", "histogram", "run_history", "diff"].includes(entry.blocks[0]!.type),
    );
    expect(cases).toHaveLength(4);
    for (const entry of cases) {
      expect(validateBlock(entry.blocks[0]), entry.name).toContain(`${localPath(entry.field)}: ${entry.message}`);
      const parsed = stepFigureSchema.safeParse(entry.blocks[0]);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          entry.name,
        ).toContain(`${localPath(entry.field)}: ${entry.message}`);
      }
    }
  });
});
