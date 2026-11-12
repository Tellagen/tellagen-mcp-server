import { TellagenClient } from "../client.js";
import { type CredentialVault, openVault } from "../credentials.js";
import { TellagenAPIError } from "../errors.js";
import { defaultStateDir, RunStateStore, workspaceKey } from "../run-state.js";
import { pendingNotesOf } from "../run-events.js";
import { SignInIndex } from "../signin-index.js";
import { resolveCredentials } from "../signin.js";
import { mapToolCall, MAX_HOOK_EVENT_BYTES, parseHookEvent, RECORDED_STEPS_CAPABILITY } from "../trace-record.js";
import type { CliIo } from "./io.js";

/** How long the whole hook may take. A tool call is never held longer. */
export const HOOK_TIMEOUT_MS = 2_000;

export interface TraceHookDeps {
  vault?: CredentialVault;
  index?: SignInIndex;
  now?: () => Date;
  timeoutMs?: number;
}

const OFF = new Set(["0", "false", "off", "no", "none"]);

/** Whether step recording was turned off: by the plugin option or by TELLAGEN_RECORD_STEPS. */
export function recordingOff(env: Record<string, string | undefined>): boolean {
  for (const name of ["TELLAGEN_RECORD_STEPS", "CLAUDE_PLUGIN_OPTION_RECORD_STEPS"]) {
    const value = (env[name] ?? "").trim().toLowerCase();
    if (value && OFF.has(value)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noteText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "";
}

/**
 * `trace-hook`: reads the event of a client hook on standard input and
 * records the tool call as one step of the open run.
 *
 * It does nothing, and says nothing, when there is no open run, the tool is
 * not one a diagnosis records, recording is off, the server does not accept
 * recorded steps, or Tellagen cannot be reached within two seconds. It always
 * exits with 0, so it never blocks or fails the tool call it watches.
 */
export async function traceHookCommand(_args: readonly string[], io: CliIo, deps: TraceHookDeps = {}): Promise<number> {
  const timeoutMs = deps.timeoutMs ?? HOOK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  try {
    if (recordingOff(io.env)) return 0;
    const env = io.env;
    const index = deps.index ?? new SignInIndex();
    // Find the run without the keychain: most hook calls have no open run.
    const envUrl = (env.TELLAGEN_API_URL ?? "").trim();
    const apiUrl = envUrl || index.find()?.entry.api_url || "";
    if (!apiUrl) return 0;
    const stateDir = (env.TELLAGEN_STATE_DIR ?? "").trim() || defaultStateDir();
    const store = new RunStateStore(stateDir, workspaceKey(apiUrl));
    const state = store.read();
    if (!state) return 0;
    if (!state.server_capabilities.includes(RECORDED_STEPS_CAPABILITY)) return 0;

    const event = parseHookEvent(await io.readStdin(MAX_HOOK_EVENT_BYTES + 1));
    if (!event) return 0;
    const step = mapToolCall(event, deps.now?.() ?? new Date());
    if (!step) return 0;

    const credentials = await resolveCredentials(env, deps.vault ?? openVault(), index);
    if (!credentials.apiKey || !credentials.apiUrl) return 0;
    const client = new TellagenClient({ apiUrl: credentials.apiUrl, apiKey: credentials.apiKey });
    // Speak as the server that holds the run.
    client.session.adoptSession(state.session_id, state.client_id);

    const left = deadline - Date.now();
    if (left < 100) return 0;
    let answer: unknown;
    try {
      answer = await client.post(
        `/api/v1/investigation-runs/${encodeURIComponent(state.run_id)}/trace`,
        step.body,
        // A repeat is the model's business. The hook tries once.
        { safeToRepeat: false, timeoutMs: left },
      );
    } catch (err) {
      if (err instanceof TellagenAPIError && (err.code === "run_taken_over" || err.code === "investigation_run_ended")) {
        const reason = err.code === "run_taken_over" ? "another client took it over" : noteText((err.payload?.details as Record<string, unknown> | undefined)?.reason, 60) || "it ended";
        store.setStop(state.run_id, reason);
      }
      return 0;
    }
    store.addPendingNotes(state.run_id, pendingNotesOf(answer));
    // Tell the model's side which step this is, unless Tellagen stored nothing.
    const note = isRecord(answer) && isRecord(answer.note) ? answer.note.code : undefined;
    if (note !== "recorded_step_limit" && note !== "step_already_posted") {
      store.addRecordedStep(state.run_id, { step_id: String(step.body.step_id), title: String(step.body.title ?? "") });
    }
    if (isRecord(answer) && answer.run_state === "cancel_requested") {
      store.setStop(state.run_id, "a responder cancelled it in Tellagen");
    }
  } catch {
    // The hook must never fail a tool call.
  }
  return 0;
}
