import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stepFigureSchema } from "../src/diagnosis-structure.js";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "contracts",
  "runbooks",
  "v2",
  "fixtures",
);

type Block = { type: string };
const accepted = JSON.parse(
  readFileSync(join(fixtures, "timeline-event-with-blocks.json"), "utf8"),
) as { blocks: Block[] };
const rejected = JSON.parse(
  readFileSync(join(fixtures, "timeline-event-blocks-rejected.json"), "utf8"),
) as { cases: Array<{ name: string; blocks: Block[]; field: string; message: string }> };

const FIGURE_TYPES = new Set(["stats", "compare", "trend"]);

describe("step figure against the vendored timeline block contract", () => {
  it("accepts every stats, compare and trend block of the accepted fixture", () => {
    const figures = accepted.blocks.filter((block) => FIGURE_TYPES.has(block.type));
    expect(figures.length).toBeGreaterThan(0);
    for (const block of figures) {
      const result = stepFigureSchema.safeParse(block);
      expect(result.success, JSON.stringify(result.success ? "" : result.error.issues)).toBe(true);
    }
  });

  it("refuses the other block types: a figure is stats, compare or trend", () => {
    const others = accepted.blocks.filter((block) => !FIGURE_TYPES.has(block.type));
    for (const block of others) {
      expect(stepFigureSchema.safeParse(block).success, block.type).toBe(false);
    }
  });

  it("refuses every rejected fixture case that concerns a figure type", () => {
    const concerned = rejected.cases.filter((entry) =>
      entry.blocks.every((block) => !["table", "checks", "changes"].includes(block.type)),
    );
    // heatmap, number as text, five stats, mark outside the series, start
    // without step_seconds, colour tone, slot with anchor.
    expect(concerned.length).toBeGreaterThanOrEqual(7);
    for (const entry of concerned) {
      for (const block of entry.blocks) {
        expect(stepFigureSchema.safeParse(block).success, entry.name).toBe(false);
      }
    }
  });
});
