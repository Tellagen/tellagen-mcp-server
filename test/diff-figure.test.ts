import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFigure, validateBlock } from "../src/figures.js";
import { FIGURE_GUIDE } from "../src/tools/figures.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";
import { structuredSummary } from "./helpers/diagnosis-fixtures.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type Line = { op: "+" | "-" | "context"; text: string; old_no?: number; new_no?: number };

const base = { type: "diff", path: "web/Header.tsx", repo: "acme/shop", ref: "4b7a2d1", additions: 6, deletions: 6 };
const ctx = (text: string, old_no?: number, new_no?: number): Line => ({ op: "context", text, old_no, new_no });
const add = (text: string, new_no?: number): Line => ({ op: "+", text, new_no });
const del = (text: string, old_no?: number): Line => ({ op: "-", text, old_no });
const clean = (line: Line): Line => Object.fromEntries(Object.entries(line).filter(([, v]) => v !== undefined)) as Line;
const withHunks = (hunks: Line[][]) => ({ ...base, hunks: hunks.map((hunk) => hunk.map(clean)) });
const problems = (hunks: Line[][]) => validateBlock(withHunks(hunks));

/** A unified patch hunk: `lines` as a patch writes them, with a correct @@ header. */
function hunk(oldStart: number, newStart: number, lines: string[]): string[] {
  const old = lines.filter((l) => !l.startsWith("+")).length;
  const next = lines.filter((l) => !l.startsWith("-")).length;
  return [`@@ -${oldStart},${old} +${newStart},${next} @@`, ...lines];
}
const patchOf = (...hunks: string[][]) => ["diff --git a/web/Header.tsx b/web/Header.tsx", "--- a/web/Header.tsx", "+++ b/web/Header.tsx", ...hunks.flat()].join("\n");

const built = (figure: Record<string, unknown>, diffLines: boolean) => {
  const result = buildFigure({ placement: "step_figure", figure: { ...base, ...figure } }, { diffLines });
  if (!result.ok) throw new Error(result.issues.join("; "));
  expect(validateBlock(result.block), "the built block must pass the contract").toEqual([]);
  return result;
};
const hunksOf = (result: { block: Record<string, unknown> }) => result.block.hunks as Line[][];
const failed = (figure: Record<string, unknown>, diffLines: boolean) => {
  const result = buildFigure({ placement: "step_figure", figure: { ...base, ...figure } }, { diffLines });
  if (result.ok) throw new Error("expected issues");
  return result.issues.join("; ");
};

describe("diff rules: changed lines, unchanged lines and numbers", () => {
  it("counts changed lines only against the budget of 12", () => {
    const changed = (n: number) => Array.from({ length: n }, (_, i) => add(`line ${i}`));
    expect(problems([[ctx("a"), ctx("b"), ...changed(12), ctx("c"), ctx("d")]])).toEqual([]);
    expect(problems([changed(13)])).toContain("hunks: at most 12 changed lines in all (got 13)");
    expect(problems([[...changed(7)], [...changed(6)]])).toContain("hunks: at most 12 changed lines in all (got 13)");
  });

  it("holds unchanged lines to 2 at each edge and 4 between two changes", () => {
    expect(problems([[ctx("1"), ctx("2"), ctx("3"), add("x")]])).toContain(
      "hunks.0: at most 2 context lines before the first changed line of a hunk (got 3)",
    );
    expect(problems([[add("x"), ctx("1"), ctx("2"), ctx("3")]])).toContain(
      "hunks.0: at most 2 context lines after the last changed line of a hunk (got 3)",
    );
    expect(problems([[add("x"), ctx("1"), ctx("2"), ctx("3"), ctx("4"), ctx("5"), add("y")]])).toContain(
      "hunks.0: at most 4 context lines between two changed lines of a hunk (got 5)",
    );
    expect(problems([[add("x"), ctx("1"), ctx("2"), ctx("3"), ctx("4"), add("y")]])).toEqual([]);
    expect(problems([[ctx("1"), ctx("2")]])).toContain("hunks.0: needs at least 1 changed line (op + or -)");
  });

  it("accepts numbers on every line, and numbers that skip", () => {
    expect(problems([[ctx("a", 10, 10), del("b", 11), add("c", 11), ctx("d", 12, 12)], [del("e", 40), add("f", 45)]])).toEqual([]);
  });

  it("refuses numbers on only some lines", () => {
    expect(problems([[del("a", 3), add("b")]])).toContain("hunks: line numbers must be on every line or on none");
  });

  it("refuses a number on the wrong side, one number on a context line, and a column that does not count up", () => {
    expect(problems([[del("a", 3), { ...add("b", 3), old_no: 3 }]])).toContain("hunks.0.1.old_no: is only for removed and context lines");
    expect(problems([[{ ...del("a", 3), new_no: 3 }, add("b", 3)]])).toContain("hunks.0.0.new_no: is only for added and context lines");
    expect(problems([[ctx("a", 3), add("b", 4)]])).toContain("hunks.0.0: a context line needs old_no and new_no together");
    expect(problems([[del("a", 5), del("b", 5)]])).toContain("hunks.0.1.old_no: must be greater than the previous old_no (5)");
    expect(problems([[add("a", 5)], [add("b", 2)]])).toContain("hunks.1.0.new_no: must be greater than the previous new_no (5)");
  });

  it("refuses a number that is not a whole number from 1 to 10000000", () => {
    for (const bad of [0, -1, 1.5, 10_000_001]) {
      expect(problems([[add("a", bad)]]).join(";"), String(bad)).toContain("hunks.0.0.new_no");
    }
    expect(problems([[add("a", 10_000_000)]])).toEqual([]);
  });

  it("refuses an unknown op", () => {
    expect(validateBlock({ ...base, hunks: [[{ op: "~", text: "x" }]] }).join(";")).toContain("hunks.0.0.op");
  });
});

describe("a diff from a patch", () => {
  // The screenshot case: 6 lines removed and 6 added, with unchanged lines around them.
  const removed = Array.from({ length: 6 }, (_, i) => `-  old ${i}`);
  const added = Array.from({ length: 6 }, (_, i) => `+  new ${i}`);
  const around = hunk(20, 20, [" a", " b", " c", ...removed, ...added, " d", " e", " f"]);

  it("sends all 12 changed lines of a short change, each removed line next to its replacement", () => {
    const out = hunksOf(built({ patch: patchOf(around) }, false));
    expect(out).toHaveLength(1);
    expect(out[0]!.map((l) => l.op).join("")).toBe("------++++++");
    expect(out[0]!.map((l) => l.text)).toEqual([...removed, ...added].map((l) => l.slice(1)));
  });

  it("sends only changed lines and no numbers to a server without diff_lines_v1", () => {
    const out = hunksOf(built({ patch: patchOf(around) }, false));
    expect(JSON.stringify(out)).not.toMatch(/context|old_no|new_no/);
  });

  it("adds at most 2 unchanged lines each side and true numbers when the server lists diff_lines_v1", () => {
    const [first] = hunksOf(built({ patch: patchOf(around) }, true));
    expect(first!.map((l) => l.op)).toEqual(["context", "context", ...Array(12).fill(null).map((_, i) => (i < 6 ? "-" : "+")), "context", "context"]);
    expect(first![0]).toEqual({ op: "context", text: "b", old_no: 21, new_no: 21 });
    expect(first![2]).toEqual({ op: "-", text: "  old 0", old_no: 23 });
    expect(first![8]).toEqual({ op: "+", text: "  new 0", new_no: 23 });
    expect(first!.at(-1)).toEqual({ op: "context", text: "e", old_no: 30, new_no: 30 });
  });

  it("numbers every line of every hunk, counting up in file order", () => {
    const second = hunk(100, 104, [" x", "-gone", "+here", "+more", " y"]);
    const out = hunksOf(built({ patch: patchOf(hunk(10, 10, [" a", "-b", "+c", " d"]), second), additions: 3, deletions: 2 }, true));
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual([
      { op: "context", text: "x", old_no: 100, new_no: 104 },
      { op: "-", text: "gone", old_no: 101 },
      { op: "+", text: "here", new_no: 105 },
      { op: "+", text: "more", new_no: 106 },
      { op: "context", text: "y", old_no: 102, new_no: 107 },
    ]);
  });

  it("splits a hunk where more than 4 unchanged lines lie between two changes", () => {
    const gap = Array.from({ length: 7 }, (_, i) => ` g${i}`);
    const out = hunksOf(built({ patch: patchOf(hunk(1, 1, ["-a", "+b", ...gap, "-c", "+d"])), additions: 2, deletions: 2 }, true));
    expect(out).toHaveLength(2);
    expect(out[0]!.map((l) => l.text)).toEqual(["a", "b", "g0", "g1"]);
    expect(out[1]!.map((l) => l.text)).toEqual(["g5", "g6", "c", "d"]);
    expect(out[1]![0]).toMatchObject({ old_no: 7, new_no: 7 });
  });

  it("keeps a gap of 4 unchanged lines in one hunk", () => {
    const gap = Array.from({ length: 4 }, (_, i) => ` g${i}`);
    const out = hunksOf(built({ patch: patchOf(hunk(1, 1, ["-a", "+b", ...gap, "-c", "+d"])), additions: 2, deletions: 2 }, true));
    expect(out).toHaveLength(1);
  });

  it("leaves numbers out when the patch headers do not match its lines, and says so", () => {
    const result = built({ patch: ["@@ -10,9 +10,9 @@", " a", "-b", "+c"].join("\n"), additions: 1, deletions: 1 }, true);
    expect(JSON.stringify(hunksOf(result))).not.toMatch(/old_no|new_no/);
    expect(JSON.stringify(hunksOf(result))).toContain("context");
    expect(result.notes.join(" ")).toContain("no line numbers were added");
  });

  it("ignores the end-of-file marker and the trailing newline", () => {
    const patch = `${patchOf(hunk(1, 1, ["-a", "+b"]))}\n\\ No newline at end of file\n`;
    expect(hunksOf(built({ patch, additions: 1, deletions: 1 }, true))).toEqual([
      [
        { op: "-", text: "a", old_no: 1 },
        { op: "+", text: "b", new_no: 1 },
      ],
    ]);
  });

  describe("a change of more than 12 changed lines", () => {
    const pair = (n: number) => [...Array.from({ length: n }, (_, i) => `-o${i}`), ...Array.from({ length: n }, (_, i) => `+n${i}`)];

    it("cuts one long hunk after a complete pair of removed and added lines", () => {
      const result = built({ patch: patchOf(hunk(1, 1, [" a", ...pair(9), " z"])), additions: 9, deletions: 9 }, true);
      const [only] = hunksOf(result);
      expect(only!.filter((l) => l.op === "-")).toHaveLength(6);
      expect(only!.filter((l) => l.op === "+")).toHaveLength(6);
      expect(only!.map((l) => l.text)).toEqual(["a", "o0", "o1", "o2", "o3", "o4", "o5", "n0", "n1", "n2", "n3", "n4", "n5"]);
      expect(result.notes.join(" ")).toContain("18 changed lines and 12 are shown, cut after a complete removed and added pair");
    });

    it("asks for select_hunks when several hunks do not fit, and names their sizes", () => {
      const patch = patchOf(hunk(1, 1, pair(4)), hunk(50, 50, pair(4)));
      const message = failed({ patch, additions: 8, deletions: 8 }, true);
      expect(message).toContain("select_hunks");
      expect(message).toContain("hunk 1: 8, hunk 2: 8");
    });

    it("sends the whole hunks that select_hunks names, in file order", () => {
      const patch = patchOf(hunk(1, 1, pair(4)), hunk(50, 50, ["-keep", "+kept"]), hunk(90, 90, pair(4)));
      const result = built({ patch, select_hunks: [2, 3], additions: 12, deletions: 12 }, true);
      expect(hunksOf(result)).toHaveLength(2);
      expect(hunksOf(result)[0]!.map((l) => l.text)).toEqual(["keep", "kept"]);
      expect(result.notes.join(" ")).toContain("from the hunks you selected");
    });

    it("refuses a selection that is out of order, repeats, is too long or is not a hunk", () => {
      const patch = patchOf(hunk(1, 1, ["-a", "+b"]), hunk(20, 20, ["-c", "+d"]), hunk(30, 30, ["-e", "+f"]), hunk(40, 40, ["-g", "+h"]));
      expect(failed({ patch, select_hunks: [2, 1] }, false)).toContain("file order");
      expect(failed({ patch, select_hunks: [9] }, false)).toContain("9 is not a hunk");
      expect(failed({ patch, select_hunks: [1, 2, 3, 4] }, false)).toContain("select_hunks");
      expect(failed({ select_hunks: [1], hunks: [[add("x")]] }, false)).toContain("select_hunks: only with patch");
    });

    it("refuses chosen hunks that still do not fit", () => {
      const patch = patchOf(hunk(1, 1, pair(4)), hunk(50, 50, pair(4)));
      expect(failed({ patch, select_hunks: [1, 2] }, false)).toContain("Choose hunks that add up to at most 12 changed lines");
    });
  });
});

describe("a diff written as hunks", () => {
  const withDetail = [[ctx("a", 4, 4), del("b", 5), add("c", 5), ctx("d", 6, 6)]];

  it("keeps unchanged lines and numbers for a server that lists diff_lines_v1", () => {
    const result = built({ hunks: withDetail, additions: 1, deletions: 1 }, true);
    expect(result.block.hunks).toEqual(withDetail);
    expect(result.summary).toContain("2 changed lines shown with 2 unchanged lines and line numbers");
  });

  it("sends only the changed lines, without numbers, to an older server, and says so", () => {
    const result = built({ hunks: withDetail, additions: 1, deletions: 1 }, false);
    expect(result.block.hunks).toEqual([[{ op: "-", text: "b" }, { op: "+", text: "c" }]]);
    expect(result.notes.join(" ")).toContain("diff_lines_v1");
  });

  it("is checked against the contract when the server lists diff_lines_v1", () => {
    expect(failed({ hunks: [[ctx("1"), ctx("2"), ctx("3"), add("x")]], additions: 1, deletions: 0 }, true)).toContain(
      "at most 2 context lines before the first changed line",
    );
  });

  it("advises when a change that adds and removes lines shows only one side", () => {
    const only = built({ hunks: [Array.from({ length: 6 }, (_, i) => add(`l${i}`)).map(clean)] }, false);
    expect(only.notes.join(" ")).toContain("shows only added lines. Send each removed line next to the line that replaced it.");
    const removedOnly = built({ hunks: [[del("x")]], additions: 1, deletions: 1 }, false);
    expect(removedOnly.notes.join(" ")).toContain("shows only removed lines. Send each added line next to the line it replaced.");
  });

  it("advises when a change of 12 or fewer changed lines is not sent whole", () => {
    const result = built({ hunks: [[del("a"), add("b")]] }, false);
    expect(result.notes.join(" ")).toContain("The change has 12 changed lines and the figure shows 2. Send all 12.");
    expect(built({ hunks: [[del("a"), add("b")]], additions: 1, deletions: 1 }, false).notes).toEqual([]);
  });
});

describe("what the senders do against an older server", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });
  const sent = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));
  const pickup = (capabilities: string[]) =>
    jsonResponse({ run: { id: "run-1" }, request: {}, server_capabilities: capabilities });
  const detailed = { ...base, additions: 1, deletions: 1, hunks: [[ctx("a", 4, 4), del("b", 5), add("c", 5), ctx("d", 6, 6)]] };
  const summaryWith = (figure: unknown) => {
    const summary = structuredSummary();
    (summary.causal_paths[0]!.steps[0] as Record<string, unknown>).figure = figure;
    return summary;
  };
  const figureSent = (index: number) => sent(index).result_summary.causal_paths[0].steps[0].figure;

  it("completes with the unchanged lines and numbers when the pickup lists diff_lines_v1", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1", "diff_lines_v1"]))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: summaryWith(detailed),
    });
    expect(figureSent(1)).toEqual(detailed);
    expect(harness.json(result).mcp_notice).toBeUndefined();
  });

  it("completes with only the changed lines, and a notice, when the pickup does not list it", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1"]))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: summaryWith(detailed),
    });
    expect(figureSent(1).hunks).toEqual([[{ op: "-", text: "b" }, { op: "+", text: "c" }]]);
    expect(harness.json(result).mcp_notice).toContain("diff_lines_v1");
    expect(harness.json(result).mcp_notice).toContain("causal_paths[0].steps[0].figure");
  });

  it("sends a diff of only changed lines without a notice or an extra request", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(pickup(["diagnosis_structure_v1"]))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" } }));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const plain = { ...base, additions: 1, deletions: 1, hunks: [[{ op: "-", text: "b" }, { op: "+", text: "c" }]] };
    const result = await harness.callTool("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: summaryWith(plain),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(figureSent(1)).toEqual(plain);
    expect(harness.json(result).mcp_notice).toBeUndefined();
  });

  it("strips a timeline block unless the latest pickup listed diff_lines_v1", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 1 })).mockResolvedValueOnce(pickup(["diff_lines_v1"])).mockResolvedValueOnce(jsonResponse({ id: 2 }));
    const before = await harness.callTool("tellagen_post_timeline_event", { incident_id: 7, title: "t", body: "b", blocks: [detailed] });
    expect(sent(0).blocks[0].hunks).toEqual([[{ op: "-", text: "b" }, { op: "+", text: "c" }]]);
    expect(harness.json(before).mcp_notice).toContain("blocks[0]");
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    const after = await harness.callTool("tellagen_post_timeline_event", { incident_id: 7, title: "t", body: "b", blocks: [detailed] });
    expect(sent(2).blocks[0]).toEqual(detailed);
    expect(harness.json(after).mcp_notice).toBeUndefined();
  });

  it("builds a diff with unchanged lines for a run whose context lists diff_lines_v1", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(pickup(["diff_lines_v1"]));
    const patch = patchOf(hunk(10, 10, [" a", "-b", "+c", " d"]));
    const result = await harness.callTool("tellagen_build_figure", {
      placement: "step_figure",
      run_id: "run-1",
      figure: { ...base, additions: 1, deletions: 1, patch },
    });
    const out = harness.json(result);
    expect(out.ok).toBe(true);
    expect(out.block.hunks[0]).toHaveLength(4);
    expect(out.block.hunks[0][1]).toEqual({ op: "-", text: "b", old_no: 11 });
  });

  it("builds a diff of changed lines only when the run's context does not list it, or cannot be read", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(pickup(["diagnosis_structure_v1"])).mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const patch = patchOf(hunk(10, 10, [" a", "-b", "+c", " d"]));
    for (const run_id of ["run-1", "run-2"]) {
      const out = harness.json(
        await harness.callTool("tellagen_build_figure", {
          placement: "step_figure",
          run_id,
          figure: { ...base, additions: 1, deletions: 1, patch },
        }),
      );
      expect(out.block.hunks, run_id).toEqual([[{ op: "-", text: "b" }, { op: "+", text: "c" }]]);
    }
  });

  it("builds a diff of changed lines only when no run id is given and nothing was picked up", async () => {
    const harness = createToolHarness();
    const out = harness.json(
      await harness.callTool("tellagen_build_figure", {
        placement: "step_figure",
        figure: { ...base, additions: 1, deletions: 1, patch: patchOf(hunk(10, 10, [" a", "-b", "+c"])) },
      }),
    );
    expect(out.block.hunks).toEqual([[{ op: "-", text: "b" }, { op: "+", text: "c" }]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the written rule", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  it("no longer tells the agent not to send the whole diff", () => {
    for (const path of ["SKILL.md", "README.md", "src/figures.ts", "src/tools/figures.ts", "contracts/runbooks/v2/timeline-event-blocks.schema.json"]) {
      expect(read(path), path).not.toContain("Do not send the whole diff");
      expect(read(path), path).not.toContain("not the whole diff");
    }
  });

  it("states the excerpt rule in the figure guide", () => {
    const section = FIGURE_GUIDE.slice(FIGURE_GUIDE.indexOf("### diff:"), FIGURE_GUIDE.indexOf("## Where the figure goes"));
    expect(section).toContain("12 or fewer changed lines (in at most 6 hunks), send all of them");
    expect(section).toContain("the whole hunks the claim cites, in file order, at most 3 hunks and at most 12 changed lines in all");
    expect(section).toContain("cuts it after a complete pair of removed and added lines");
    expect(section).toContain("each removed line comes with the line that replaced it, next to it");
    expect(section).toContain("additions and deletions are the size of the whole change");
    expect(section).toContain("diff_lines_v1");
    expect(section).toContain("Never invent a number");
  });

  it("puts a source name in a source chip, not in a tile caption", () => {
    expect(FIGURE_GUIDE).toContain('"node --test summary", belongs in a source chip');
    expect(read("SKILL.md")).toContain('"node --test summary", belongs in a source chip');
  });

  it("says the same in the skill text", () => {
    const skill = read("SKILL.md");
    expect(skill).toContain("send all of them");
    expect(skill).toContain("each removed line comes with the line that replaced it, next to it");
    expect(skill).toContain("`diff_lines_v1`");
  });

  it("describes the builder's diff input", async () => {
    const harness = createToolHarness();
    const description = (harness.getTool("tellagen_build_figure") as unknown as { config: { description: string } }).config.description;
    expect(description).toContain("12 or fewer changed lines is sent whole");
    expect(description).toContain("select_hunks");
    expect(description).toContain("diff_lines_v1");
  });
});
