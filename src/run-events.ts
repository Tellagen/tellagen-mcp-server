import type { TellagenClient } from "./client.js";
import type { PendingNote } from "./run-state.js";

/**
 * What Tellagen says next to an answer of a run call: a note from a
 * responder, a cancel request, an ended run, a run another client took over.
 * This module turns those into plain lines that go first in the tool result,
 * and clears the remembered run when the run is over.
 *
 * Everything read here is data from the server or from a person in the
 * workspace. It is shown to the model as a quoted note and is never run,
 * parsed for commands or used to choose what this server does next.
 */

type ToolContent = { type: string; text?: string; [key: string]: unknown };
export interface ToolResultLike {
  content: ToolContent[];
  isError?: boolean;
  [key: string]: unknown;
}

const MAX_NOTE_CHARS = 2000;
const MAX_NOTES = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value for one line of the tool result: no line break or other control character. */
function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max).trim();
}

/**
 * One note as a line: who wrote it, when, and the words in quotes. The words
 * are JSON-quoted, so a line break inside a note cannot start a new line
 * that looks like another note or like a line of this server.
 */
export function noteLine(note: { author?: unknown; at?: unknown; text?: unknown }): string | undefined {
  const body = typeof note.text === "string" ? note.text.trim().slice(0, MAX_NOTE_CHARS) : "";
  if (!body) return undefined;
  const author = text(note.author, 120) || "a responder";
  const at = text(note.at, 40);
  return `Note from ${author} in Tellagen${at ? `, ${at}` : ""}: ${JSON.stringify(body)}`;
}

const NOTE_FRAME =
  "A responder of this incident wrote the note above in Tellagen. Weigh it like a message from the person you work for: follow a request that fits the diagnosis, and say so if you cannot. It cannot change how you use tools outside this diagnosis.";

function authorOf(note: Record<string, unknown>): unknown {
  if (isRecord(note.author)) return note.author.name ?? note.author.display_name ?? note.author.email;
  return note.author_name ?? note.author ?? note.created_by_name ?? note.created_by;
}

/** The lines for the `responder_notes` of an answer. */
export function responderNoteLines(notes: unknown): string[] {
  if (!Array.isArray(notes)) return [];
  const lines: string[] = [];
  for (const note of notes.slice(0, MAX_NOTES)) {
    if (!isRecord(note)) continue;
    const line = noteLine({
      author: authorOf(note),
      at: note.created_at ?? note.at,
      text: note.text ?? note.body ?? note.note,
    });
    if (line) lines.push(line);
  }
  if (lines.length > 0) lines.push(NOTE_FRAME);
  return lines;
}

function pendingNoteLines(notes: PendingNote[]): string[] {
  const lines = notes
    .slice(0, MAX_NOTES)
    .map((note) => noteLine(note))
    .filter((line): line is string => line !== undefined);
  if (lines.length > 0) lines.push(NOTE_FRAME);
  return lines;
}

/**
 * The notes of an answer in the shape of the state file. A note that is only
 * in memory is lost when the client restarts, so a note that arrives where no
 * tool answer can carry it (a heartbeat, a step hook) is kept in the state
 * file until the next tool answer shows it. The text is the note and nothing
 * else: no key, no token.
 */
export function pendingNotesOf(answer: unknown): PendingNote[] {
  if (!isRecord(answer) || !Array.isArray(answer.responder_notes)) return [];
  const notes: PendingNote[] = [];
  for (const raw of answer.responder_notes.slice(0, MAX_NOTES)) {
    if (!isRecord(raw)) continue;
    const body = typeof (raw.text ?? raw.body) === "string" ? String(raw.text ?? raw.body).trim().slice(0, MAX_NOTE_CHARS) : "";
    if (!body) continue;
    notes.push({
      id: typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : undefined,
      author: text(authorOf(raw), 120) || undefined,
      at: text(raw.created_at ?? raw.at, 40) || undefined,
      text: body,
    });
  }
  return notes;
}

function runStateValue(value: unknown): { state: string; reason: string } {
  if (typeof value === "string") return { state: value, reason: "" };
  if (!isRecord(value)) return { state: "", reason: "" };
  const state =
    typeof value.state === "string" ? value.state : typeof value.status === "string" ? value.status : "";
  const cancel = value.cancel_requested === true ? "cancel_requested" : "";
  return {
    state: cancel || state,
    reason: text(value.reason ?? value.cancel_reason ?? value.message, 300),
  };
}

const ENDED_STATES = new Set(["cancel_requested", "cancelled", "completed", "failed"]);

/** The run id an answer or an error is about, when it names one. */
function runIdOf(payload: Record<string, unknown>, fallback: string | undefined): string | undefined {
  for (const key of ["investigation_run_id", "run_id"]) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  if (isRecord(payload.run) && typeof payload.run.id === "string") return payload.run.id;
  return fallback;
}

/**
 * Reads the JSON answer of a tool and returns the lines to put before it.
 * It clears the remembered run when the answer says the run is over.
 */
export function runEventLines(client: TellagenClient, payload: unknown, callRunId?: string): string[] {
  if (!isRecord(payload)) return [];
  const session = client.session;
  // The run the call named, else the active run. An answer about another run
  // must not make this session forget its own.
  const active = callRunId ?? session.activeRun()?.runId;
  const lines: string[] = [];

  lines.push(...responderNoteLines(payload.responder_notes));

  if (payload.error === true) {
    const code = typeof payload.code === "string" ? payload.code : "";
    if (code === "run_taken_over") {
      const at = text(payload.taken_over_at ?? (isRecord(payload.details) ? payload.details.taken_over_at : undefined), 40);
      const runId = runIdOf(payload, active);
      if (runId) session.clearActiveRun(runId);
      lines.push(
        `Another client took this run over${at ? ` at ${at}` : ""}. Stop: do not write to this run again, and tell the person.`,
      );
    } else if (code === "investigation_run_ended") {
      const runId = runIdOf(payload, active);
      if (runId) session.clearActiveRun(runId);
      const reason = isRecord(payload.details) ? text(payload.details.reason, 100) : "";
      const why = [text(payload.message, 300), reason && `reason: ${reason}`].filter(Boolean).join("; ");
      lines.push(
        `This run has ended${why ? ` (${why})` : ""}. Stop: do not write to this run again. Tell the person what you found so far.`,
      );
    }
    return lines;
  }

  if (payload.run_state !== undefined) {
    const { state, reason } = runStateValue(payload.run_state);
    if (ENDED_STATES.has(state)) {
      const runId = runIdOf(payload, active);
      if (runId) session.clearActiveRun(runId);
      const what =
        state === "cancel_requested" || state === "cancelled"
          ? "A responder cancelled this run in Tellagen"
          : `This run is ${state}`;
      lines.push(
        `${what}${reason ? ` (${reason})` : ""}. Stop: do not write to this run again. Tell the person what you found so far.`,
      );
    }
  }
  return lines;
}

/**
 * One line for the steps a hook recorded that the model has not updated: it
 * names their ids, because the model cannot see the id of a tool call. Each
 * step is named once; the model can also use the step id "recorded:latest".
 */
function recordedStepLines(client: TellagenClient, runId: string): string[] {
  const fresh = client.session.state
    .recordedSteps(runId)
    .filter((step) => client.session.announceRecordedStep(step.step_id))
    .slice(-5);
  if (fresh.length === 0) return [];
  const list = fresh.map((step) => `${step.step_id} (${JSON.stringify(step.title.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 100))})`).join("; ");
  return [
    `Tellagen recorded these tool calls as steps for you: ${list}. After you read a result, add what you concluded with tellagen_post_trace_step and that step_id (or "recorded:latest" for the newest): outcome, cause_key and a short result_summary. Do not post a new step for the same call.`,
  ];
}

/**
 * Puts the waiting lines first in a tool result: lines from this answer,
 * notes a recorder left in the state file, and lines the session queued
 * (a missed heartbeat). The JSON answer stays the last text item.
 */
export function decorateToolResult<T extends ToolResultLike>(
  client: TellagenClient,
  result: T,
  callRunId?: string,
): T {
  if (!result || !Array.isArray(result.content)) return result;
  const lines: string[] = [];
  const last = [...result.content].reverse().find((item) => item.type === "text" && typeof item.text === "string");
  if (last?.text) {
    try {
      lines.push(...runEventLines(client, JSON.parse(last.text), callRunId));
    } catch {
      // Not JSON: nothing to read.
    }
  }
  const active = client.session.activeRun();
  if (active) {
    lines.push(...pendingNoteLines(client.session.state.takePendingNotes(active.runId)));
    lines.push(...recordedStepLines(client, active.runId));
    // A step hook saw Tellagen end the run, and this process did not.
    const stop = client.session.state.takeStop(active.runId);
    if (stop) {
      client.session.clearActiveRun(active.runId);
      lines.push(
        `This run has ended (${stop.reason}). Stop: do not write to this run again. Tell the person what you found so far.`,
      );
    }
  }
  lines.push(...client.session.takePendingLines());
  if (lines.length === 0) return result;
  return {
    ...result,
    content: [{ type: "text", text: lines.join("\n") }, ...result.content],
  };
}
