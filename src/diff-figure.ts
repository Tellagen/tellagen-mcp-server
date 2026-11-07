/**
 * Building the hunks of a diff figure from a unified patch.
 *
 * A diff figure shows the lines that broke or fixed something. Tellagen draws
 * at most 12 changed lines (+ and -), in at most 6 hunks. When the server
 * lists diff_lines_v1 in server_capabilities it also takes unchanged lines
 * (op context, at most 2 at each edge of a hunk and 4 between two changes) and
 * the line numbers old_no and new_no. An older server rejects those fields and
 * drops the whole figure, so without the capability only + and - lines are
 * built, with no numbers.
 */

export const MAX_DIFF_CHANGED_LINES = 12;
export const MAX_DIFF_HUNKS = 6;
export const MAX_DIFF_CONTEXT_EDGE = 2;
export const MAX_DIFF_CONTEXT_GAP = 4;
/** Hunks a patch may be cut down to when the whole change does not fit. */
export const MAX_SELECTED_HUNKS = 3;

export type DiffLine = {
  op: "+" | "-" | "context";
  text: string;
  old_no?: number;
  new_no?: number;
};

const isChange = (line: DiffLine): boolean => line.op !== "context";
const changedIn = (lines: DiffLine[]): number => lines.filter(isChange).length;

type PatchHunk = { lines: DiffLine[]; numbered: boolean };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Reads the hunks of one file's patch, context lines included. A hunk is
 * numbered only when its header parses and the lines add up to the counts in
 * it, so a number is never guessed.
 */
function parsePatch(patch: string): PatchHunk[] {
  const lines = patch.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldSeen = 0;
  let newSeen = 0;
  let declared: [number, number] | null = null;

  const finish = () => {
    if (current && (declared === null || declared[0] !== oldSeen || declared[1] !== newSeen)) {
      current.numbered = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith("@@")) {
      finish();
      const header = HUNK_HEADER.exec(line);
      current = { lines: [], numbered: header !== null };
      hunks.push(current);
      oldNo = header ? Number(header[1]) : 0;
      newNo = header ? Number(header[3]) : 0;
      declared = header ? [header[2] === undefined ? 1 : Number(header[2]), header[4] === undefined ? 1 : Number(header[4])] : null;
      oldSeen = 0;
      newSeen = 0;
      continue;
    }
    // File headers come before the first hunk; "\ No newline at end of file" is not a line.
    if (current === null || line.startsWith("\\")) continue;
    const sign = line[0];
    if (sign === "+") {
      current.lines.push({ op: "+", text: line.slice(1), new_no: newNo });
      newNo++;
      newSeen++;
    } else if (sign === "-") {
      current.lines.push({ op: "-", text: line.slice(1), old_no: oldNo });
      oldNo++;
      oldSeen++;
    } else if (sign === " " || line === "") {
      current.lines.push({ op: "context", text: line.slice(1), old_no: oldNo, new_no: newNo });
      oldNo++;
      newNo++;
      oldSeen++;
      newSeen++;
    } else {
      // A line the patch format does not know: the counts cannot be trusted.
      current.numbered = false;
    }
  }
  finish();
  return hunks;
}

/** The lines of a hunk without unchanged lines and without numbers. */
export function changedLinesOnly(lines: DiffLine[]): DiffLine[] {
  return lines.filter(isChange).map(({ op, text }) => ({ op, text }));
}

/**
 * Cuts a hunk to at most `budget` changed lines. A run of removed and added
 * lines is cut after a complete pair: the first k removed lines come with the
 * first k added lines that replaced them.
 */
function cutHunk(lines: DiffLine[], budget: number): DiffLine[] {
  const out: DiffLine[] = [];
  let remaining = budget;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!isChange(line)) {
      out.push(line);
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && isChange(lines[end]!)) end++;
    const run = lines.slice(i, end);
    if (run.length <= remaining) {
      out.push(...run);
      remaining -= run.length;
      i = end;
      continue;
    }
    const removed = run.filter((l) => l.op === "-");
    const added = run.filter((l) => l.op === "+");
    if (removed.length > 0 && added.length > 0) {
      const pairs = Math.min(removed.length, added.length, Math.floor(remaining / 2));
      out.push(...removed.slice(0, pairs), ...added.slice(0, pairs));
    } else {
      out.push(...run.slice(0, remaining));
    }
    break;
  }
  return out;
}

/**
 * Trims a hunk to 2 unchanged lines at each edge and splits it where it has
 * more than 4 unchanged lines between two changes. The numbers stay true.
 */
function shapeHunk(lines: DiffLine[]): DiffLine[][] {
  const first = lines.findIndex(isChange);
  let last = lines.length - 1;
  while (last > first && !isChange(lines[last]!)) last--;

  const pieces: DiffLine[][] = [];
  let current: DiffLine[] = lines.slice(Math.max(0, first - MAX_DIFF_CONTEXT_EDGE), first);
  let pending: DiffLine[] = [];
  for (const line of lines.slice(first, last + 1)) {
    if (!isChange(line)) {
      pending.push(line);
      continue;
    }
    if (pending.length > MAX_DIFF_CONTEXT_GAP) {
      current.push(...pending.slice(0, MAX_DIFF_CONTEXT_EDGE));
      pieces.push(current);
      current = pending.slice(-MAX_DIFF_CONTEXT_EDGE);
    } else {
      current.push(...pending);
    }
    pending = [];
    current.push(line);
  }
  current.push(...lines.slice(last + 1, last + 1 + MAX_DIFF_CONTEXT_EDGE).filter((l) => !isChange(l)));
  pieces.push(current);
  return pieces;
}

export type PatchOptions = {
  /** The server lists diff_lines_v1: keep unchanged lines and line numbers. */
  diffLines: boolean;
  /** 1-based numbers of the patch's hunks to send, in file order. */
  selectHunks?: number[];
};

export type PatchHunks = { hunks: DiffLine[][]; notes: string[] } | { issues: string[] };

/**
 * The hunks of a figure from one file's unified patch. A change that fits (12
 * changed lines in at most 6 hunks) is sent whole. A longer change needs the
 * hunks the claim cites in selectHunks (at most 3); one hunk that is longer
 * than 12 changed lines is cut after a complete removed and added pair.
 */
export function diffHunksFromPatch(patch: string, options: PatchOptions): PatchHunks {
  const parsed = parsePatch(patch);
  if (parsed.length === 0) return { issues: ["patch: no hunk found. Send the patch as GitHub gives it, from the first @@ line."] };
  const withChanges = parsed.filter((hunk) => changedIn(hunk.lines) > 0);
  const totalChanged = withChanges.reduce((sum, hunk) => sum + changedIn(hunk.lines), 0);
  if (totalChanged === 0) return { issues: ["patch: no added or removed line"] };

  const notes: string[] = [];
  if (parsed.length !== withChanges.length) {
    notes.push(`${parsed.length - withChanges.length} hunks with no + or - line were left out.`);
  }

  let chosen = withChanges;
  const selection = options.selectHunks;
  if (selection !== undefined) {
    const bad = selection.filter((n) => n < 1 || n > parsed.length || changedIn(parsed[n - 1]!.lines) === 0);
    if (bad.length > 0) {
      return { issues: [`select_hunks: ${bad.join(", ")} is not a hunk of the patch with a + or - line. The patch has ${parsed.length} hunks.`] };
    }
    if (selection.some((n, i) => i > 0 && n <= selection[i - 1]!)) {
      return { issues: ["select_hunks: list the hunk numbers in file order, each once."] };
    }
    chosen = selection.map((n) => parsed[n - 1]!);
  }

  const chosenChanged = chosen.reduce((sum, hunk) => sum + changedIn(hunk.lines), 0);
  if (selection !== undefined && selection.length > MAX_SELECTED_HUNKS) {
    return { issues: [`select_hunks: at most ${MAX_SELECTED_HUNKS} hunks. Choose the hunks the claim cites.`] };
  }
  if (selection !== undefined && chosen.length > 1 && chosenChanged > MAX_DIFF_CHANGED_LINES) {
    return {
      issues: [
        `select_hunks: ${chosenChanged} changed lines in the hunks you chose. Choose hunks that add up to at most ${MAX_DIFF_CHANGED_LINES} changed lines, or one hunk to have it cut after a complete removed and added pair.`,
      ],
    };
  }
  if (selection === undefined && chosen.length > 1 && (chosenChanged > MAX_DIFF_CHANGED_LINES || chosen.length > MAX_DIFF_HUNKS)) {
    const sizes = chosen.map((hunk) => `hunk ${parsed.indexOf(hunk) + 1}: ${changedIn(hunk.lines)}`).join(", ");
    return {
      issues: [
        `patch: ${chosenChanged} changed lines in ${chosen.length} hunks (${sizes}). A diff shows at most ${MAX_DIFF_CHANGED_LINES} changed lines in at most ${MAX_DIFF_HUNKS} hunks. Send select_hunks with the numbers of the hunks the claim cites, at most ${MAX_SELECTED_HUNKS}.`,
      ],
    };
  }

  let pieces: DiffLine[][] = [];
  let shown = 0;
  let cut = false;
  const numbered = options.diffLines && chosen.every((hunk) => hunk.numbered);
  for (let lines of chosen.map((hunk) => hunk.lines)) {
    if (changedIn(lines) > MAX_DIFF_CHANGED_LINES) {
      lines = cutHunk(lines, MAX_DIFF_CHANGED_LINES);
      cut = true;
    }
    shown += changedIn(lines);
    if (options.diffLines) {
      pieces.push(...shapeHunk(lines));
    } else {
      pieces.push(changedLinesOnly(lines));
    }
  }
  if (!numbered) {
    pieces = pieces.map((lines) => lines.map(({ op, text }) => ({ op, text })));
  }
  if (pieces.length > MAX_DIFF_HUNKS) {
    return {
      issues: [
        `patch: the hunks come to ${pieces.length} pieces once unchanged lines are trimmed, and a diff shows at most ${MAX_DIFF_HUNKS}. Send select_hunks with the numbers of the hunks the claim cites, at most ${MAX_SELECTED_HUNKS}.`,
      ],
    };
  }
  if (shown < totalChanged) {
    notes.push(
      cut
        ? `The patch has ${totalChanged} changed lines and ${shown} are shown, cut after a complete removed and added pair.`
        : `The patch has ${totalChanged} changed lines and ${shown} are shown, from the hunks you selected.`,
    );
  }
  if (options.diffLines && !numbered) {
    notes.push("The patch headers did not match its lines, so no line numbers were added.");
  }
  return { hunks: pieces, notes };
}

/** Whether some line of the hunks carries an unchanged line or a number. */
export function hasDiffLineDetail(hunks: DiffLine[][]): boolean {
  return hunks.some((hunk) => hunk.some((line) => line.op === "context" || line.old_no !== undefined || line.new_no !== undefined));
}

/**
 * The hunks as an older server takes them: no unchanged lines and no numbers.
 * Hunks left with no changed line are dropped.
 */
export function withoutDiffLineDetail(hunks: DiffLine[][]): DiffLine[][] {
  return hunks.map(changedLinesOnly).filter((hunk) => hunk.length > 0);
}

/**
 * Advice for a diff whose lines do not match the size of the change, worded
 * like the completion warnings. The figure is still valid.
 */
export function diffShapeAdvice(hunks: DiffLine[][], additions: number, deletions: number): string[] {
  const lines = hunks.flat().filter(isChange);
  const added = lines.filter((l) => l.op === "+").length;
  const removed = lines.length - added;
  const advice: string[] = [];
  if (additions > 0 && deletions > 0 && (added === 0 || removed === 0)) {
    advice.push(
      added === 0
        ? `The change adds ${additions} and removes ${deletions} lines, but the figure shows only removed lines. Send each added line next to the line it replaced.`
        : `The change adds ${additions} and removes ${deletions} lines, but the figure shows only added lines. Send each removed line next to the line that replaced it.`,
    );
  }
  const whole = additions + deletions;
  if (whole <= MAX_DIFF_CHANGED_LINES && lines.length < whole) {
    advice.push(`The change has ${whole} changed lines and the figure shows ${lines.length}. Send all ${whole}.`);
  }
  return advice;
}
