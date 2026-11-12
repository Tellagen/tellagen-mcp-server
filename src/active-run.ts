import { z } from "zod";
import type { TellagenClient } from "./client.js";
import { NoActiveRunError } from "./errors.js";
import { processAlive, type RunState } from "./run-state.js";

/** The run id input of a run tool: optional, because the session remembers the run. */
export const optionalRunIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Investigation run ID. Leave it out to use the run this session picked up.");

/**
 * Whether a text can be a run ID. A run ID becomes part of a request path, so
 * it holds no slash, dot-dot, query, fragment, percent sign, space or control
 * character.
 */
export function isRunId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && !/[\s/\\?#%\u0000-\u001f\u007f]/.test(id) && !id.includes("..");
}

function checkedRunId(id: string): string {
  if (!isRunId(id)) {
    throw new Error(
      "That is not a run ID. A run ID has no slash, space, question mark or percent sign. Copy it from Tellagen or from tellagen_next_investigation.",
    );
  }
  return id;
}

/**
 * The run a tool call is about: the id it was given, else the run this
 * session picked up. With neither it throws an error that says how to get a
 * run, and names tellagen_resume when an earlier session left one behind.
 */
export function resolveRunId(client: TellagenClient, given?: string): string {
  const id = given?.trim();
  if (id) return checkedRunId(id);
  const active = client.session.activeRun();
  if (active) return active.runId;
  const remembered = client.session.state.read();
  if (remembered && isRunId(remembered.run_id)) {
    throw new NoActiveRunError(
      `This session has not picked up a run yet. An earlier session on this computer left run ${remembered.run_id} open: call tellagen_resume to continue it, or pass investigation_run_id for another run.`,
    );
  }
  throw new NoActiveRunError(
    "No run is active in this session. Pick one up with tellagen_pick_up_investigation, or pass investigation_run_id.",
  );
}

/** The active run id when there is one, for tools where the run is only a hint. */
export function activeRunId(client: TellagenClient, given?: string): string | undefined {
  return given?.trim() || client.session.activeRun()?.runId;
}

/**
 * Another MCP server process on this computer that holds the run and is
 * still alive. A process that ended (the client was restarted) holds nothing.
 */
export function otherLiveSession(client: TellagenClient, state: RunState | undefined): RunState | undefined {
  if (!state) return undefined;
  if (state.session_id === client.session.sessionId) return undefined;
  if (state.pid === process.pid) return undefined;
  return processAlive(state.pid) ? state : undefined;
}

/**
 * Who works on the run on this computer, as a plain fact. The caller adds a
 * question for the person, or what the model must do, never both in one text.
 */
export function joinFact(state: RunState): string {
  const who = state.client_name ? `${state.client_name}${state.client_version ? ` ${state.client_version}` : ""}` : "Another client";
  return `${who} on this computer is working on run ${state.run_id} (picked up at ${state.picked_up_at}). Two clients on one run write over each other.`;
}
